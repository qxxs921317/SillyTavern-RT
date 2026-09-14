import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const EXT_ID = 'lorebook-translator';
const EXT_NAME = 'Cherry&Solti Lorebook Translator';
const EXT_TAG = 'CSLT';

console.log(`[${EXT_TAG}] script file loaded (v0.7)`);

const defaultSettings = {
    profileId: '',
    translateUnit: 'all',
    targetLang: '한국어',
    autoAddKoreanKeys: true,
    maxTokens: 8192,
    bulkSkipTranslated: true,
    bulkDelayMs: 500,
    // v0.8: cache/addedKeys는 settings가 아니라 /user/files 에 로어북별 파일로 저장됨.
    // 레거시 키(cache, addedKeys)는 기존 유저 데이터라 여기서 재생성하지 않음.
    fileIndex: {},   // { "로어북이름": { file, updatedAt } }
    storageMode: 'file',
};

let appReady = false;
let observerActive = false;
let scopedObserver = null;

let bulkState = {
    running: false, paused: false, cancelled: false,
    total: 0, done: 0, failed: 0,
};

let savedSaveWorldInfo = null;

// ---------- Settings ----------
function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = structuredClone(defaultSettings);
    }
    for (const k of Object.keys(defaultSettings)) {
        if (extension_settings[EXT_ID][k] === undefined) {
            extension_settings[EXT_ID][k] = structuredClone(defaultSettings[k]);
        }
    }
    // Migration: copy old pendingKeys data into addedKeys (one-time)
    if (extension_settings[EXT_ID].pendingKeys && typeof extension_settings[EXT_ID].pendingKeys === 'object') {
        for (const k of Object.keys(extension_settings[EXT_ID].pendingKeys)) {
            if (!extension_settings[EXT_ID].addedKeys[k]) {
                extension_settings[EXT_ID].addedKeys[k] = extension_settings[EXT_ID].pendingKeys[k];
            }
        }
        delete extension_settings[EXT_ID].pendingKeys;
        console.log(`[${EXT_TAG}] migrated pendingKeys → addedKeys`);
    }

    return extension_settings[EXT_ID];
}

function getConnectionProfiles() {
    const cm = extension_settings.connectionManager;
    if (!cm || !Array.isArray(cm.profiles)) return [];
    return cm.profiles;
}

async function resolveCMRS() {
    if (window.ConnectionManagerRequestService) return window.ConnectionManagerRequestService;
    try {
        const ctx = getContext?.();
        if (ctx?.ConnectionManagerRequestService) return ctx.ConnectionManagerRequestService;
    } catch {}
    try {
        const mod = await import('/scripts/extensions/shared.js');
        if (mod?.ConnectionManagerRequestService) {
            window.ConnectionManagerRequestService = mod.ConnectionManagerRequestService;
            return mod.ConnectionManagerRequestService;
        }
    } catch (e) {
        console.warn(`[${EXT_TAG}] CMRS import failed:`, e?.message);
    }
    return null;
}

async function resolveSaveWorldInfo() {
    if (savedSaveWorldInfo) return savedSaveWorldInfo;
    try {
        const ctx = getContext?.();
        if (typeof ctx?.saveWorldInfo === 'function') {
            savedSaveWorldInfo = ctx.saveWorldInfo;
            console.log(`[${EXT_TAG}] saveWorldInfo found via getContext`);
            return savedSaveWorldInfo;
        }
    } catch {}
    const candidates = ['/scripts/world-info.js', '../../../world-info.js', '../../../../scripts/world-info.js'];
    for (const path of candidates) {
        try {
            const mod = await import(path);
            if (typeof mod?.saveWorldInfo === 'function') {
                savedSaveWorldInfo = mod.saveWorldInfo;
                console.log(`[${EXT_TAG}] saveWorldInfo found via ${path}`);
                return savedSaveWorldInfo;
            }
        } catch {}
    }
    return null;
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Identity ----------
function getCurrentWorldName() {
    try {
        const sel = document.querySelector('#world_editor_select');
        if (sel) {
            const opt = sel.selectedOptions?.[0];
            if (opt?.textContent) return opt.textContent.trim();
        }
        const moveBtn = document.querySelector('#world_popup .move_entry_button[data-current-world]');
        if (moveBtn) return moveBtn.getAttribute('data-current-world') || 'unknown';
    } catch {}
    return 'unknown';
}

function getEntryUid($entry) {
    try {
        const uidAttr = $entry.attr('uid');
        if (uidAttr) return String(uidAttr);
        const moveBtn = $entry.find('.move_entry_button[data-uid]').first();
        if (moveBtn.length) return String(moveBtn.attr('data-uid'));
    } catch {}
    return null;
}

function makeKey(worldName, uid) { return `${worldName}::${uid}`; }


/* ===================================================================
 * 파일 기반 저장소 (v0.8)
 *
 * 번역 캐시 / 추가된 키워드는 settings.json이 아니라
 * /user/files/cslt_<해시>.json 에 "로어북 1개당 파일 1개"로 저장됨.
 * settings에는 인덱스만 남음.
 *
 * 기존 유저 보호:
 *  - 읽기는 캐시 → 파일 → 레거시(settings) 순으로 폴백
 *  - 레거시 데이터는 자동으로 지우지 않음 (이전 버튼으로만)
 *  - 파일 API가 없거나 실패하면 레거시 모드로 자동 강등
 * =================================================================== */

const FILE_UPLOAD_URL = '/api/files/upload';
const FILE_DELETE_URL = '/api/files/delete';
const FILE_DIR = '/user/files';
const PERSIST_DELAY = 1200;     // 연속 작업 시 쓰기 병합
const PERSIST_MAX_WAIT = 15000; // 전체 번역 중에도 최소 이 주기로는 저장

// 런타임 데이터 — extension_settings 바깥. 키 형식은 기존과 동일한 "world::uid"
const rtData = { cache: {}, addedKeys: {} };

const loadedWorlds = new Set();
const worldTimers = new Map();   // world -> { timer, since }
let storageFailed = false;
let storageWarned = false;

/**
 * FNV-1a 32bit — crypto.subtle은 LAN(http) 접속에서 못 쓰므로 순수 JS
 */
function fnv1a(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h = Math.imul(h ^ (c & 0xff), 0x01000193) >>> 0;
        h = Math.imul(h ^ ((c >>> 8) & 0xff), 0x01000193) >>> 0;
    }
    return h >>> 0;
}

function keyHash(str) {
    const a = fnv1a(str, 0x811c9dc5);
    const b = fnv1a(`${str}\u0001cslt`, 0x9e3779b1);
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// 서버가 한글/공백/슬래시 파일명을 거부하므로 해시 필수
function worldFileName(world) { return `cslt_${keyHash(world)}.json`; }

function reqHeaders() {
    try {
        const ctx = getContext?.();
        if (typeof ctx?.getRequestHeaders === 'function') return ctx.getRequestHeaders();
    } catch { /* noop */ }
    return { 'Content-Type': 'application/json' };
}

function toBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

async function readWorldFile(fileName) {
    const res = await fetch(`${FILE_DIR}/${fileName}`, { headers: reqHeaders(), cache: 'no-store' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`읽기 실패 (${res.status})`);
    return await res.json();
}

async function writeWorldFile(fileName, payload) {
    const res = await fetch(FILE_UPLOAD_URL, {
        method: 'POST',
        headers: reqHeaders(),
        body: JSON.stringify({ name: fileName, data: toBase64(JSON.stringify(payload)) }),
    });
    if (!res.ok) throw new Error(`저장 실패 (${res.status})`);
    return true;
}

/**
 * 이 로어북에 속한 항목만 추려내기
 */
function collectWorldData(world) {
    const prefix = `${world}::`;
    const cache = {};
    const addedKeys = {};
    for (const [k, v] of Object.entries(rtData.cache)) if (k.startsWith(prefix)) cache[k] = v;
    for (const [k, v] of Object.entries(rtData.addedKeys)) if (k.startsWith(prefix)) addedKeys[k] = v;
    return { v: 1, world, cache, addedKeys, updatedAt: Date.now() };
}

function legacyWorldData(world) {
    const raw = extension_settings[EXT_ID] || {};
    const prefix = `${world}::`;
    const cache = {};
    const addedKeys = {};
    for (const [k, v] of Object.entries(raw.cache || {})) if (k.startsWith(prefix)) cache[k] = v;
    for (const [k, v] of Object.entries(raw.addedKeys || {})) if (k.startsWith(prefix)) addedKeys[k] = v;
    const count = Object.keys(cache).length + Object.keys(addedKeys).length;
    return count ? { cache, addedKeys, count } : null;
}

/**
 * 로어북 데이터 로드 — 캐시 → 파일 → 레거시
 * 파일 인덱스가 있으면 레거시는 아예 안 봄 (지운 항목이 되살아나지 않도록)
 */
async function ensureWorld(world) {
    if (!world || world === 'unknown' || loadedWorlds.has(world)) return;

    const settings = getSettings();
    const indexed = settings.fileIndex?.[world];

    if (indexed?.file && !storageFailed) {
        try {
            const file = await readWorldFile(indexed.file);
            if (file && file.world === world) {
                Object.assign(rtData.cache, file.cache || {});
                Object.assign(rtData.addedKeys, file.addedKeys || {});
                loadedWorlds.add(world);
                return;
            }
            if (file) console.warn(`[${EXT_TAG}] 파일 로어북명 불일치:`, file.world, '≠', world);
        } catch (err) {
            console.warn(`[${EXT_TAG}] 파일 읽기 실패:`, err);
        }
    }

    const legacy = legacyWorldData(world);
    loadedWorlds.add(world);
    if (legacy) {
        Object.assign(rtData.cache, legacy.cache);
        Object.assign(rtData.addedKeys, legacy.addedKeys);
        console.log(`[${EXT_TAG}] 레거시에서 ${legacy.count}개 항목 로드 → 파일로 이관`);
        scheduleWorldPersist(world, 0);   // 레거시 원본은 그대로 둠
    }
}

/**
 * 저장 예약. 전체 번역처럼 연속 호출될 때는 병합하되,
 * PERSIST_MAX_WAIT 보다 오래 밀리면 강제로 한 번 쓴다 (중간에 죽어도 손실 최소화)
 */
function scheduleWorldPersist(world, delay = PERSIST_DELAY) {
    if (!world || world === 'unknown') return;
    let st = worldTimers.get(world);
    if (!st) {
        st = { timer: null, since: Date.now() };
        worldTimers.set(world, st);
    }
    if (Date.now() - st.since > PERSIST_MAX_WAIT) {
        flushWorld(world);
        return;
    }
    clearTimeout(st.timer);
    st.timer = setTimeout(() => flushWorld(world), delay);
}

function flushWorld(world) {
    if (!world || world === 'unknown') return;
    const st = worldTimers.get(world);
    if (st) {
        clearTimeout(st.timer);
        worldTimers.delete(world);
    }
    persistWorld(world).catch(err => console.error(`[${EXT_TAG}] 저장 실패:`, err));
}

function flushAllWorlds() {
    for (const world of [...worldTimers.keys()]) flushWorld(world);
}

async function persistWorld(world) {
    if (!world || world === 'unknown') return;
    loadedWorlds.add(world);

    if (storageFailed) {
        persistLegacyWorld(world);
        return;
    }

    const settings = getSettings();
    const payload = collectWorldData(world);
    const fileName = worldFileName(world);

    try {
        // 비어 있어도 파일은 남겨둔다 — 인덱스가 사라지면 레거시가 되살아나므로
        await writeWorldFile(fileName, payload);
        if (!settings.fileIndex) settings.fileIndex = {};
        settings.fileIndex[world] = { file: fileName, updatedAt: payload.updatedAt };
        settings.storageMode = 'file';
        saveSettingsDebounced();
    } catch (err) {
        console.error(`[${EXT_TAG}] 파일 저장 실패 — 레거시 모드로 전환:`, err);
        storageFailed = true;
        getSettings().storageMode = 'legacy';
        if (!storageWarned) {
            storageWarned = true;
            toastr.warning('파일 저장에 실패해서 기존 방식(설정 저장)으로 전환했어. 데이터는 안 날아가.', EXT_NAME);
        }
        persistLegacyWorld(world);
    }
}

/**
 * 레거시 모드 — 예전처럼 settings에 직접 씀
 */
function persistLegacyWorld(world) {
    const raw = getSettings();
    if (!raw.cache) raw.cache = {};
    if (!raw.addedKeys) raw.addedKeys = {};
    const prefix = `${world}::`;
    for (const k of Object.keys(raw.cache)) if (k.startsWith(prefix)) delete raw.cache[k];
    for (const k of Object.keys(raw.addedKeys)) if (k.startsWith(prefix)) delete raw.addedKeys[k];
    for (const [k, v] of Object.entries(rtData.cache)) if (k.startsWith(prefix)) raw.cache[k] = v;
    for (const [k, v] of Object.entries(rtData.addedKeys)) if (k.startsWith(prefix)) raw.addedKeys[k] = v;
    saveSettingsDebounced();
}

// ---------- Cache (translation results) ----------
function getCachedTranslation($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return null;
    return rtData.cache[makeKey(getCurrentWorldName(), uid)] || null;
}

function setCachedTranslation($entry, data) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    rtData.cache[makeKey(getCurrentWorldName(), uid)] = {
        keys: Array.isArray(data.keys) ? data.keys : undefined,
        content: typeof data.content === 'string' ? data.content : undefined,
        truncated: !!data._truncated,
        savedAt: Date.now(),
    };
    scheduleWorldPersist(getCurrentWorldName());
}

function deleteCachedTranslation($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    delete rtData.cache[makeKey(getCurrentWorldName(), uid)];
    scheduleWorldPersist(getCurrentWorldName());
}

function deleteAllCachedForCurrentWorld() {
    const world = getCurrentWorldName();
    const prefix = `${world}::`;
    let count = 0;
    for (const k of Object.keys(rtData.cache)) {
        if (k.startsWith(prefix)) { delete rtData.cache[k]; count++; }
    }
    flushWorld(world);
    return count;
}

// ---------- Added keys (Korean keys we injected — kept even after save) ----------
function setAddedKeys($entry, koreanKeys) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    rtData.addedKeys[makeKey(getCurrentWorldName(), uid)] = koreanKeys;
    scheduleWorldPersist(getCurrentWorldName());
}

function getAddedKeys($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return [];
    return rtData.addedKeys[makeKey(getCurrentWorldName(), uid)] || [];
}

function clearAddedKeys($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    delete rtData.addedKeys[makeKey(getCurrentWorldName(), uid)];
    scheduleWorldPersist(getCurrentWorldName());
}

function clearAllAddedKeysForCurrentWorld() {
    const world = getCurrentWorldName();
    const prefix = `${world}::`;
    for (const k of Object.keys(rtData.addedKeys)) {
        if (k.startsWith(prefix)) delete rtData.addedKeys[k];
    }
    flushWorld(world);
}

// ---------- Save logic ----------
async function saveEntryKeysPermanently($entry, opts = {}) {
    const silent = !!opts.silent;
    try {
        const expanded = await ensureEntryExpanded($entry);
        if (!expanded) {
            if (!silent) toastr.error('항목을 펼칠 수 없어 저장 실패', EXT_NAME);
            return false;
        }

        const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
        if (!$keyInput.length) {
            if (!silent) toastr.error('키워드 입력란을 찾을 수 없습니다', EXT_NAME);
            return false;
        }

        // Make sure added Korean keys are in the input
        const added = getAddedKeys($entry);
        if (added.length > 0) {
            const current = String($keyInput.val() ?? '').split(',').map(s => s.trim()).filter(Boolean);
            const merged = Array.from(new Set([...current, ...added]));
            $keyInput.val(merged.join(', '));
        }

        $keyInput[0].dispatchEvent(new Event('input', { bubbles: true }));
        $keyInput[0].dispatchEvent(new Event('change', { bubbles: true }));
        $keyInput[0].dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(80);

        const saveFn = await resolveSaveWorldInfo();
        if (!saveFn) {
            if (!silent) toastr.error('저장 함수를 찾을 수 없습니다', EXT_NAME);
            return false;
        }
        await saveFn(getCurrentWorldName());
        // NOTE: we do NOT clear addedKeys here — we keep tracking them
        // so 🧹 cleanup and 🗑️ delete still work correctly afterwards
        if (!silent) toastr.success('저장 완료 ✓', EXT_NAME, { timeOut: 2000 });
        return true;
    } catch (err) {
        console.error(`[${EXT_TAG}] saveEntryKeysPermanently error`, err);
        if (!silent) toastr.error(`저장 실패: ${err?.message ?? err}`, EXT_NAME);
        return false;
    }
}

// Remove our added Korean keys from input AND persist the removal to ST
async function cleanupEntryKeys($entry, opts = {}) {
    const silent = !!opts.silent;
    const persist = opts.persist !== false; // default true
    try {
        const added = getAddedKeys($entry);
        if (added.length === 0) {
            if (!silent) toastr.info('제거할 한글 키워드가 없습니다', EXT_NAME);
            return false;
        }

        const expanded = await ensureEntryExpanded($entry);
        if (!expanded) {
            if (!silent) toastr.error('항목을 펼칠 수 없습니다', EXT_NAME);
            return false;
        }

        const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
        if (!$keyInput.length) return false;

        // Remove ONLY the keys we added — never touch user's English keys
        const current = String($keyInput.val() ?? '').split(',').map(s => s.trim()).filter(Boolean);
        const addedSet = new Set(added);
        const filtered = current.filter(k => !addedSet.has(k));
        $keyInput.val(filtered.join(', '));

        $keyInput[0].dispatchEvent(new Event('input', { bubbles: true }));
        $keyInput[0].dispatchEvent(new Event('change', { bubbles: true }));
        $keyInput[0].dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(80);

        // Persist removal so it survives reload
        if (persist) {
            const saveFn = await resolveSaveWorldInfo();
            if (saveFn) {
                try {
                    await saveFn(getCurrentWorldName());
                } catch (err) {
                    console.warn(`[${EXT_TAG}] cleanup save failed`, err);
                }
            }
        }

        clearAddedKeys($entry);
        if (!silent) toastr.success('한글 키워드 제거됨', EXT_NAME, { timeOut: 2000 });
        return true;
    } catch (err) {
        console.error(`[${EXT_TAG}] cleanupEntryKeys error`, err);
        if (!silent) toastr.error('키워드 제거 실패', EXT_NAME);
        return false;
    }
}

// Bulk save
async function bulkSaveAll() {
    try {
        const popup = document.getElementById('world_popup');
        if (!popup) return;
        const allEntries = Array.from(popup.querySelectorAll('.world_entry'));
        const entriesToSave = allEntries.filter(el => getAddedKeys($(el)).length > 0);

        if (entriesToSave.length === 0) {
            toastr.info('저장할 한글 키워드가 있는 항목이 없습니다', EXT_NAME);
            return;
        }
        if (!confirm(`${entriesToSave.length}개 항목의 한글 키워드를 저장합니다.\n계속하시겠습니까?`)) return;

        const saveFn = await resolveSaveWorldInfo();
        if (!saveFn) { toastr.error('저장 함수를 찾을 수 없습니다', EXT_NAME); return; }

        const $btn = $('#cslt-bulk-save');
        const origText = $btn.text();
        $btn.text(`💾 저장 중... (0/${entriesToSave.length})`).prop('disabled', true);

        let saved = 0, failed = 0;
        try {
            for (let i = 0; i < entriesToSave.length; i++) {
                const $entry = $(entriesToSave[i]);
                const expanded = await ensureEntryExpanded($entry);
                if (!expanded) { failed++; continue; }

                const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
                if (!$keyInput.length) { failed++; continue; }

                const added = getAddedKeys($entry);
                if (added.length > 0) {
                    const current = String($keyInput.val() ?? '').split(',').map(s => s.trim()).filter(Boolean);
                    const merged = Array.from(new Set([...current, ...added]));
                    $keyInput.val(merged.join(', '));
                }
                $keyInput[0].dispatchEvent(new Event('input', { bubbles: true }));
                $keyInput[0].dispatchEvent(new Event('change', { bubbles: true }));
                $keyInput[0].dispatchEvent(new Event('blur', { bubbles: true }));
                saved++;
                $btn.text(`💾 저장 중... (${saved}/${entriesToSave.length})`);
                await sleep(50);
            }
            await sleep(200);
            await saveFn(getCurrentWorldName());
            // Keep addedKeys — don't clear them
            flushAllWorlds();
            toastr.success(`✓ ${saved}개 항목 저장 완료${failed ? ` (실패 ${failed})` : ''}`, EXT_NAME, { timeOut: 4000 });
        } finally {
            $btn.text(origText).prop('disabled', false);
        }
    } catch (err) {
        console.error(`[${EXT_TAG}] bulkSaveAll error`, err);
        toastr.error(`전체 저장 실패: ${err?.message ?? err}`, EXT_NAME);
    }
}

// Bulk cleanup — remove all added Korean keys from all entries
async function bulkCleanupKeys() {
    try {
        const popup = document.getElementById('world_popup');
        if (!popup) return;
        const allEntries = Array.from(popup.querySelectorAll('.world_entry'));
        const entriesWithAdded = allEntries.filter(el => getAddedKeys($(el)).length > 0);

        if (entriesWithAdded.length === 0) {
            toastr.info('제거할 한글 키워드가 있는 항목이 없습니다', EXT_NAME);
            return;
        }
        if (!confirm(`${entriesWithAdded.length}개 항목에서 한글 키워드만 제거합니다.\n(번역 결과 패널은 그대로 유지됩니다)\n계속하시겠습니까?`)) return;

        const $btn = $('#cslt-bulk-cleanup');
        const origText = $btn.text();
        $btn.text(`🧹 제거 중... (0/${entriesWithAdded.length})`).prop('disabled', true);

        let done = 0, failed = 0;
        try {
            for (let i = 0; i < entriesWithAdded.length; i++) {
                const $entry = $(entriesWithAdded[i]);
                // persist=false here — we'll save once at end for efficiency
                const ok = await cleanupEntryKeys($entry, { silent: true, persist: false });
                if (ok) done++; else failed++;
                $btn.text(`🧹 제거 중... (${done}/${entriesWithAdded.length})`);
                await sleep(40);
            }
            // Single save at the end
            await sleep(200);
            const saveFn = await resolveSaveWorldInfo();
            if (saveFn) {
                try {
                    await saveFn(getCurrentWorldName());
                } catch (err) {
                    console.warn(`[${EXT_TAG}] bulk cleanup final save failed`, err);
                }
            }
            flushAllWorlds();
            toastr.success(`✓ ${done}개 항목에서 한글 키워드 제거됨${failed ? ` (실패 ${failed})` : ''}`, EXT_NAME, { timeOut: 4000 });
        } finally {
            $btn.text(origText).prop('disabled', false);
        }
    } catch (err) {
        console.error(`[${EXT_TAG}] bulkCleanupKeys error`, err);
        toastr.error(`키워드 일괄 제거 실패: ${err?.message ?? err}`, EXT_NAME);
    }
}

// ---------- UI ----------

/* ===================================================================
 * 백업 / 복원 / 레거시 이전
 * =================================================================== */

const BACKUP_FORMAT = 'cslt-backup';

function legacySizeKB() {
    const raw = extension_settings[EXT_ID] || {};
    return JSON.stringify({ cache: raw.cache || {}, addedKeys: raw.addedKeys || {} }).length / 1024;
}

/**
 * 인덱스 + 레거시에서 알고 있는 모든 로어북 이름
 */
function allWorldNames() {
    const settings = getSettings();
    const raw = extension_settings[EXT_ID] || {};
    const names = new Set(Object.keys(settings.fileIndex || {}));
    for (const section of ['cache', 'addedKeys']) {
        for (const k of Object.keys(raw[section] || {})) {
            const i = k.indexOf('::');
            if (i > 0) names.add(k.slice(0, i));
        }
    }
    for (const section of ['cache', 'addedKeys']) {
        for (const k of Object.keys(rtData[section])) {
            const i = k.indexOf('::');
            if (i > 0) names.add(k.slice(0, i));
        }
    }
    return [...names];
}

async function loadAllWorlds() {
    const names = allWorldNames();
    for (let i = 0; i < names.length; i += 3) {
        await Promise.all(names.slice(i, i + 3).map(w => ensureWorld(w).catch(() => {})));
    }
    return names;
}

async function buildBackupObject() {
    flushAllWorlds();
    await loadAllWorlds();
    const settings = getSettings();
    const raw = extension_settings[EXT_ID] || {};
    const data = { cache: structuredClone(rtData.cache), addedKeys: structuredClone(rtData.addedKeys) };

    // 파일로 안 옮겨진 레거시 잔여분 합치기 (이미 파일이 있는 로어북은 제외 — 지운 항목 부활 방지)
    const hasFile = new Set(Object.keys(settings.fileIndex || {}));
    for (const section of ['cache', 'addedKeys']) {
        for (const [k, v] of Object.entries(raw[section] || {})) {
            if (data[section][k] !== undefined) continue;
            const world = k.slice(0, k.indexOf('::'));
            if (hasFile.has(world)) continue;
            data[section][k] = structuredClone(v);
        }
    }
    return { format: BACKUP_FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), data };
}

function backupTimestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportData(silent = false, suffix = '') {
    try {
        if (!silent) toastr.info('데이터 수집 중...', EXT_NAME);
        const backup = await buildBackupObject();
        downloadJson(backup, `cslt-backup-${backupTimestamp()}${suffix}.json`);
        if (!silent) {
            const n = Object.keys(backup.data.cache).length;
            const kb = JSON.stringify(backup).length / 1024;
            toastr.success(`백업 저장됨 (번역 ${n}개 · ${kb.toFixed(0)}KB)`, EXT_NAME);
        }
        return true;
    } catch (err) {
        console.error(`[${EXT_TAG}] 내보내기 실패:`, err);
        toastr.error('내보내기 실패: ' + err.message, EXT_NAME);
        return false;
    }
}

function parseBackup(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('JSON 파싱 실패 — 올바른 백업 파일이 아니야');
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('내용이 비어있어');
    if (parsed.format === BACKUP_FORMAT && parsed.data) return parsed.data;
    if (parsed.cache || parsed.addedKeys) return parsed;   // settings 덤프도 받아줌
    throw new Error('로어북 번역기 백업 파일이 아닌 것 같아');
}

async function importData(file, overwrite) {
    let data;
    try {
        data = parseBackup(await file.text());
    } catch (err) {
        toastr.error(err.message, EXT_NAME);
        return;
    }

    const cacheCount = Object.keys(data.cache || {}).length;
    const keyCount = Object.keys(data.addedKeys || {}).length;
    const worlds = new Set();
    for (const section of ['cache', 'addedKeys']) {
        for (const k of Object.keys(data[section] || {})) {
            const i = k.indexOf('::');
            if (i > 0) worlds.add(k.slice(0, i));
        }
    }

    const mode = overwrite ? '덮어쓰기 (같은 항목은 파일 내용으로 교체)' : '병합 (기존 항목 유지, 없는 것만 추가)';
    if (!confirm(`이 백업을 불러올까?\n\n• 번역 결과: ${cacheCount}개\n• 추가된 키워드: ${keyCount}개\n• 로어북: ${worlds.size}개\n\n모드: ${mode}\n\n진행 전에 현재 상태를 자동 백업할게.`)) return;

    if (!await exportData(true, '-before-import')) {
        toastr.error('사전 백업 실패 — 가져오기를 중단했어', EXT_NAME);
        return;
    }

    // 병합 판단이 정확하려면 대상 로어북을 먼저 메모리에 올려야 함
    for (const w of worlds) await ensureWorld(w).catch(() => {});

    let added = 0, replaced = 0, skipped = 0;
    for (const section of ['cache', 'addedKeys']) {
        for (const [k, v] of Object.entries(data[section] || {})) {
            if (rtData[section][k] === undefined) { rtData[section][k] = structuredClone(v); added++; }
            else if (overwrite) { rtData[section][k] = structuredClone(v); replaced++; }
            else skipped++;
        }
    }

    let saved = 0;
    for (const w of worlds) {
        try {
            await persistWorld(w);
            saved++;
        } catch (err) {
            console.error(`[${EXT_TAG}] 가져오기 저장 실패:`, w, err);
        }
    }

    updateDataSizeDisplay();
    restoreCachedTranslations().catch(() => {});
    toastr.success(`가져오기 완료 (추가 ${added}${replaced ? ` · 교체 ${replaced}` : ''}${skipped ? ` · 유지 ${skipped}` : ''}) · 로어북 ${saved}개 저장됨`, EXT_NAME);
}

/**
 * 레거시(settings) → 파일 이전 + 검증 후 정리
 */
async function migrateLegacyToFiles() {
    const settings = getSettings();
    const raw = extension_settings[EXT_ID] || {};

    const worlds = new Set();
    for (const section of ['cache', 'addedKeys']) {
        for (const k of Object.keys(raw[section] || {})) {
            const i = k.indexOf('::');
            if (i > 0) worlds.add(k.slice(0, i));
        }
    }
    if (worlds.size === 0) {
        toastr.info('이전할 레거시 데이터가 없어', EXT_NAME);
        return;
    }
    if (storageFailed) {
        toastr.error('파일 저장이 동작하지 않는 상태라 이전할 수 없어', EXT_NAME);
        return;
    }

    const kb = legacySizeKB();
    if (!confirm(`settings에 남아있는 로어북 ${worlds.size}개 (${kb.toFixed(0)}KB)를 파일로 옮길까?\n\n① 자동 백업 → ② 파일로 쓰기 → ③ 다시 읽어서 검증 → ④ 전부 통과하면 삭제 여부를 다시 물어봄\n\n검증에 하나라도 실패하면 기존 데이터는 그대로 둘게.`)) return;

    if (!await exportData(true, '-before-migrate')) {
        toastr.error('사전 백업 실패 — 이전을 중단했어', EXT_NAME);
        return;
    }

    const list = [...worlds];
    const failures = [];
    let done = 0;
    const $status = $('#cslt-data-size');

    for (const world of list) {
        try {
            await ensureWorld(world);
            await persistWorld(world);

            const entry = getSettings().fileIndex?.[world];
            if (!entry?.file) throw new Error('인덱스 없음');
            const back = await readWorldFile(entry.file);
            if (!back || back.world !== world) throw new Error('로어북명 불일치');

            const expect = collectWorldData(world);
            const norm = (o) => JSON.stringify({ c: o.cache || {}, a: o.addedKeys || {} });
            if (norm(back) !== norm(expect)) throw new Error('내용 불일치');
        } catch (err) {
            console.error(`[${EXT_TAG}] 이전 실패:`, world, err);
            failures.push(`${world} (${err.message})`);
        }
        done++;
        if ($status.length) $status.text(`이전 중... ${done}/${list.length}`);
    }

    updateDataSizeDisplay();

    if (failures.length) {
        toastr.error(`${failures.length}개 실패 — 기존 데이터는 그대로 뒀어. 콘솔 확인해줘`, EXT_NAME);
        console.error(`[${EXT_TAG}] 실패 목록:`, failures);
        return;
    }

    if (!confirm(`로어북 ${list.length}개 전부 파일로 옮기고 검증까지 통과했어.\n\n이제 settings에 남은 옛 데이터(${kb.toFixed(0)}KB)를 지울까?\n\n백업 파일은 이미 받아놨고, 지워도 번역은 파일에서 그대로 읽혀.`)) {
        toastr.info('이전은 끝났어. 정리는 나중에 해도 돼', EXT_NAME);
        return;
    }

    delete extension_settings[EXT_ID].cache;
    delete extension_settings[EXT_ID].addedKeys;
    saveSettingsDebounced();
    updateDataSizeDisplay();
    toastr.success(`정리 완료 — settings에서 ${kb.toFixed(0)}KB 줄었어`, EXT_NAME);
}

function updateDataSizeDisplay() {
    const $el = $('#cslt-data-size');
    if ($el.length === 0) return;
    const settings = getSettings();
    const fileCount = Object.keys(settings.fileIndex || {}).length;
    const legacyKB = legacySizeKB();
    const settingsKB = JSON.stringify(settings).length / 1024;

    let text = `파일 ${fileCount}개 · settings 사용량 ${settingsKB.toFixed(1)}KB`;
    if (storageFailed) text += ' · ⚠ 레거시 모드';
    $el.text(text);

    const $btn = $('#cslt-migrate');
    if ($btn.length) {
        if (legacyKB > 1) $btn.show().html(`<i class="fa-solid fa-right-left"></i> 기존 데이터 이전 (${legacyKB.toFixed(0)}KB)`);
        else $btn.hide();
    }
}

function renderSettings() {
    const settings = getSettings();
    const profiles = getConnectionProfiles();
    const profileOptions = profiles
        .map(p => `<option value="${p.id}" ${p.id === settings.profileId ? 'selected' : ''}>${p.name}</option>`)
        .join('');

    const html = `
    <div class="cslt-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>🍒 Cherry&Solti Lorebook Translator</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <label for="cslt-profile">연결 프로필 (Connection Profile)</label>
          <select id="cslt-profile" class="text_pole">
            <option value="">— 선택 —</option>
            ${profileOptions}
          </select>
          <small style="opacity:.7;">프로필이 안 보이면 Connection Manager에서 먼저 만들어주세요.</small>

          <label for="cslt-unit" style="margin-top:10px;">번역 단위</label>
          <select id="cslt-unit" class="text_pole">
            <option value="all"     ${settings.translateUnit === 'all' ? 'selected' : ''}>항목 전체 (키워드 + 본문)</option>
            <option value="keys"    ${settings.translateUnit === 'keys' ? 'selected' : ''}>키워드만</option>
            <option value="content" ${settings.translateUnit === 'content' ? 'selected' : ''}>본문만</option>
          </select>

          <label for="cslt-target" style="margin-top:10px;">번역 대상 언어</label>
          <input id="cslt-target" type="text" class="text_pole" value="${settings.targetLang}">

          <label for="cslt-maxtokens" style="margin-top:10px;">최대 응답 토큰</label>
          <input id="cslt-maxtokens" type="number" class="text_pole" min="512" max="32768" step="512" value="${settings.maxTokens}">

          <label class="checkbox_label" style="margin-top:10px;">
            <input id="cslt-autoadd" type="checkbox" ${settings.autoAddKoreanKeys ? 'checked' : ''}>
            <span>키워드 번역 결과를 자동으로 keys에 추가</span>
          </label>

          <hr style="margin: 12px 0; opacity: .3;">

          <b style="display:block; margin-bottom:6px;">전체 번역 옵션</b>

          <label class="checkbox_label">
            <input id="cslt-bulk-skip" type="checkbox" ${settings.bulkSkipTranslated ? 'checked' : ''}>
            <span>이미 번역된 항목은 건너뛰기</span>
          </label>

          <label for="cslt-bulk-delay" style="margin-top:6px;">호출 간격 (ms)</label>
          <input id="cslt-bulk-delay" type="number" class="text_pole" min="0" max="10000" step="100" value="${settings.bulkDelayMs}">

          <hr style="margin: 12px 0; opacity: .3;">

          <b style="display:block; margin-bottom:6px;">데이터 백업</b>
          <small style="opacity:.75; display:block;">번역 데이터는 <code>/user/files</code>에 로어북별 파일로 저장돼.</small>
          <div id="cslt-data-size" style="font-size:.85em; opacity:.7; margin:6px 0;"></div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <div class="menu_button" id="cslt-export" style="flex:1 1 auto; min-width:110px; margin:0;">
              <i class="fa-solid fa-download"></i> 내보내기
            </div>
            <div class="menu_button" id="cslt-import" style="flex:1 1 auto; min-width:110px; margin:0;">
              <i class="fa-solid fa-upload"></i> 가져오기
            </div>
            <input type="file" id="cslt-import-file" accept=".json,application/json" style="display:none;">
          </div>
          <div class="menu_button" id="cslt-migrate" style="display:none; margin-top:6px;">
            <i class="fa-solid fa-right-left"></i> 기존 데이터 이전
          </div>
          <label class="checkbox_label" style="margin-top:6px;">
            <input id="cslt-import-overwrite" type="checkbox">
            <span>가져올 때 덮어쓰기 <small style="opacity:.6;">(끄면 없는 것만 추가)</small></span>
          </label>

          <hr style="margin: 12px 0; opacity: .3;">

          <small style="opacity:.7; display:block; margin-top:8px;">
            💾 저장: 한글 키워드 영구 저장<br>
            🧹 제거: 한글 키워드만 제거 (영문 유지)<br>
            🗑️ 삭제: 번역 결과 패널 삭제 (input 그대로)
          </small>
        </div>
      </div>
    </div>`;

    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if ($target.length === 0) return false;
    if ($target.find('.cslt-settings').length > 0) return true;
    $target.append(html);

    $('#cslt-profile').on('change', function () { getSettings().profileId = String($(this).val() || ''); saveSettingsDebounced(); });
    $('#cslt-unit').on('change', function () { getSettings().translateUnit = String($(this).val() || 'all'); saveSettingsDebounced(); });
    $('#cslt-target').on('input', function () { getSettings().targetLang = String($(this).val() || '한국어'); saveSettingsDebounced(); });
    $('#cslt-maxtokens').on('input', function () {
        const v = parseInt($(this).val(), 10);
        if (Number.isFinite(v) && v >= 512) { getSettings().maxTokens = v; saveSettingsDebounced(); }
    });
    $('#cslt-autoadd').on('change', function () { getSettings().autoAddKoreanKeys = $(this).is(':checked'); saveSettingsDebounced(); });
    $('#cslt-bulk-skip').on('change', function () { getSettings().bulkSkipTranslated = $(this).is(':checked'); saveSettingsDebounced(); });
    $('#cslt-bulk-delay').on('input', function () {
        const v = parseInt($(this).val(), 10);
        if (Number.isFinite(v) && v >= 0) { getSettings().bulkDelayMs = v; saveSettingsDebounced(); }
    });

    $('#cslt-export').on('click', () => { exportData(); });
    $('#cslt-import').on('click', () => { $('#cslt-import-file').val('').trigger('click'); });
    $('#cslt-import-file').on('change', async function () {
        const file = this.files?.[0];
        if (!file) return;
        await importData(file, $('#cslt-import-overwrite').is(':checked'));
        this.value = '';
    });
    $('#cslt-migrate').on('click', () => { migrateLegacyToFiles(); });

    updateDataSizeDisplay();
    return true;
}

function refreshProfileDropdown() {
    const settings = getSettings();
    const profiles = getConnectionProfiles();
    const $sel = $('#cslt-profile');
    if ($sel.length === 0) return;
    const current = String($sel.val() || settings.profileId || '');
    $sel.empty().append('<option value="">— 선택 —</option>');
    for (const p of profiles) {
        const opt = $('<option>').val(p.id).text(p.name);
        if (p.id === current) opt.attr('selected', 'selected');
        $sel.append(opt);
    }
}

function buildPrompt(payload, targetLang) {
    return `You are a translator. Translate the given JSON values into ${targetLang}.
- Preserve the JSON structure and keys EXACTLY.
- Translate ONLY the values.
- For arrays of keywords, return an array of translated single-word/short-phrase keywords (no explanations).
- Output ONLY the JSON. No prose, no code fences.
- Keep the translation as concise as possible while remaining accurate.

INPUT:
${JSON.stringify(payload, null, 2)}`;
}

function recoverPartialJson(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return { data: JSON.parse(t), truncated: false }; } catch {}
    const braceMatch = t.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try { return { data: JSON.parse(braceMatch[0]), truncated: false }; } catch {}
    }
    const recovered = {};
    const keysMatch = t.match(/"keys"\s*:\s*\[([\s\S]*?)\](?=\s*[,}])/);
    if (keysMatch) {
        try { recovered.keys = JSON.parse('[' + keysMatch[1] + ']'); }
        catch {
            const strs = keysMatch[1].match(/"((?:[^"\\]|\\.)*)"/g);
            if (strs) recovered.keys = strs.map(s => JSON.parse(s));
        }
    }
    const contentStart = t.search(/"content"\s*:\s*"/);
    if (contentStart !== -1) {
        const afterKey = t.indexOf('"', t.indexOf(':', contentStart) + 1) + 1;
        let endQuote = -1;
        for (let i = afterKey; i < t.length; i++) {
            if (t[i] === '\\') { i++; continue; }
            if (t[i] === '"') { endQuote = i; break; }
        }
        const raw = endQuote === -1 ? t.slice(afterKey) : t.slice(afterKey, endQuote);
        try { recovered.content = JSON.parse('"' + raw.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'); }
        catch { recovered.content = raw; }
    }
    if (Object.keys(recovered).length > 0) return { data: recovered, truncated: true };
    return null;
}

async function callProfile(prompt, maxTokens) {
    const settings = getSettings();
    if (!settings.profileId) { toastr.warning('연결 프로필을 먼저 선택하세요.', EXT_NAME); return null; }
    const CMRS = await resolveCMRS();
    if (!CMRS) { toastr.error('ConnectionManagerRequestService를 찾을 수 없습니다.', EXT_NAME); return null; }
    const result = await CMRS.sendRequest(settings.profileId, prompt, maxTokens);
    if (typeof result === 'string') return result;
    if (result?.content) return result.content;
    return String(result ?? '');
}

async function ensureEntryExpanded($entry) {
    try {
        const $drawerContent = $entry.find('.inline-drawer-content').first();
        const $drawerToggle = $entry.find('.inline-drawer-toggle').first();
        const isOpen = $drawerContent.is(':visible') && $entry.find('textarea[name="content"]').length > 0;
        if (isOpen) return true;
        if ($drawerToggle.length) {
            $drawerToggle.trigger('click');
            for (let i = 0; i < 20; i++) {
                await sleep(50);
                if ($entry.find('textarea[name="content"]').length > 0) return true;
            }
        }
    } catch (err) {
        console.error(`[${EXT_TAG}] ensureEntryExpanded error`, err);
    }
    return false;
}

async function translateEntry(entryEl, opts = {}) {
    const settings = getSettings();
    const $entry = $(entryEl);
    const silent = !!opts.silent;
    const $btn = $entry.find('.cslt-translate-btn');
    if (!silent) $btn.addClass('cslt-loading').attr('title', '번역 중...');

    try {
        const expanded = await ensureEntryExpanded($entry);
        if (!expanded) {
            if (!silent) {
                toastr.error('항목을 펼칠 수 없습니다.', EXT_NAME);
                $btn.removeClass('cslt-loading').attr('title', '이 항목 번역');
            }
            return { success: false, truncated: false };
        }

        const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
        const $contentInput = $entry.find('textarea[name="content"]').first();
        const keysRaw = String($keyInput.val() ?? '');
        const content = String($contentInput.val() ?? '');
        const originalKeys = keysRaw.split(',').map(s => s.trim()).filter(Boolean);
        const originalKeysSet = new Set(originalKeys);

        let payload;
        if (settings.translateUnit === 'keys') payload = { keys: originalKeys };
        else if (settings.translateUnit === 'content') payload = { content };
        else payload = { keys: originalKeys, content };

        let raw;
        try {
            raw = await callProfile(buildPrompt(payload, settings.targetLang), settings.maxTokens);
        } catch (err) {
            console.error(`[${EXT_TAG}] request failed`, err);
            if (!silent) {
                toastr.error(`번역 요청 실패: ${err?.message ?? err}`, EXT_NAME);
                $btn.removeClass('cslt-loading').attr('title', '이 항목 번역');
            }
            return { success: false, truncated: false };
        }
        if (!silent) $btn.removeClass('cslt-loading').attr('title', '이 항목 번역');
        if (!raw) return { success: false, truncated: false };

        const result = recoverPartialJson(raw);
        if (!result) {
            if (!silent) toastr.error('JSON 파싱 실패', EXT_NAME);
            showResultPanel($entry, { rawText: raw });
            return { success: false, truncated: false };
        }
        const { data, truncated } = result;
        if (truncated && !silent) toastr.warning(`응답이 잘렸습니다. (현재 ${settings.maxTokens})`, EXT_NAME, { timeOut: 7000 });

        if ((settings.translateUnit === 'keys' || settings.translateUnit === 'all')
            && Array.isArray(data.keys) && settings.autoAddKoreanKeys) {
            // SAFETY: only count keys that aren't already in the original — prevents touching English keys
            const addedKeys = data.keys
                .map(s => String(s).trim())
                .filter(Boolean)
                .filter(k => !originalKeysSet.has(k));

            if (addedKeys.length > 0) {
                const merged = Array.from(new Set([...originalKeys, ...addedKeys]));
                $keyInput.val(merged.join(', '));
                $keyInput[0].dispatchEvent(new Event('input', { bubbles: true }));
                // Merge with existing addedKeys (in case translated multiple times)
                const existingAdded = getAddedKeys($entry);
                const allAdded = Array.from(new Set([...existingAdded, ...addedKeys]));
                setAddedKeys($entry, allAdded);
            }
        }

        const panelData = { ...data, _truncated: truncated };
        showResultPanel($entry, panelData);
        setCachedTranslation($entry, panelData);
        return { success: true, truncated };
    } catch (err) {
        console.error(`[${EXT_TAG}] translateEntry error`, err);
        if (!silent) {
            toastr.error('번역 처리 중 오류', EXT_NAME);
            $btn.removeClass('cslt-loading').attr('title', '이 항목 번역');
        }
        return { success: false, truncated: false };
    }
}

function showResultPanel($entry, data) {
    let $panel = $entry.find('.cslt-result-panel');
    if ($panel.length === 0) {
        $panel = $(`
            <div class="cslt-result-panel">
              <div class="cslt-result-header">
                <b>🍒 번역 결과</b>
                <div class="cslt-result-actions">
                  <span class="cslt-result-save" title="한글 키워드 영구 저장">💾</span>
                  <span class="cslt-result-cleanup" title="한글 키워드만 제거 (번역 결과 유지)">🧹</span>
                  <span class="cslt-result-delete" title="번역 결과 삭제 (한글 키워드 유지)">🗑️</span>
                  <span class="cslt-result-toggle" title="접기/펼치기">접기</span>
                </div>
              </div>
              <div class="cslt-result-body"></div>
            </div>
        `);
        $entry.append($panel);

        $panel.find('.cslt-result-toggle').on('click', () => {
            const $b = $panel.find('.cslt-result-body');
            $b.toggle();
            $panel.find('.cslt-result-toggle').text($b.is(':visible') ? '접기' : '펼치기');
        });

        $panel.find('.cslt-result-save').on('click', async (e) => {
            e.stopPropagation();
            const $btn = $panel.find('.cslt-result-save');
            $btn.text('⏳').css('opacity', 0.5);
            await saveEntryKeysPermanently($entry);
            $btn.text('💾').css('opacity', '');
        });

        $panel.find('.cslt-result-cleanup').on('click', async (e) => {
            e.stopPropagation();
            if (!confirm('이 항목에 추가된 한글 키워드만 제거하시겠습니까?\n(번역 결과 패널은 유지되고, 영문 키워드는 안전합니다)')) return;
            const $btn = $panel.find('.cslt-result-cleanup');
            $btn.text('⏳').css('opacity', 0.5);
            await cleanupEntryKeys($entry);
            $btn.text('🧹').css('opacity', '');
        });

        $panel.find('.cslt-result-delete').on('click', (e) => {
            e.stopPropagation();
            if (!confirm('번역 결과 패널만 삭제하시겠습니까?\n(input의 한글 키워드는 유지됩니다)')) return;
            deleteCachedTranslation($entry);
            $panel.remove();
            toastr.success('번역 결과 삭제됨', EXT_NAME, { timeOut: 2000 });
        });
    }
    const $body = $panel.find('.cslt-result-body').empty();

    if (data._truncated) $('<div class="cslt-warning">⚠️ 응답이 잘려서 일부만 복구됨</div>').appendTo($body);
    if (data.rawText) { $('<pre>').text(data.rawText).appendTo($body); return; }
    if (Array.isArray(data.keys)) {
        $('<div class="cslt-result-section"><b>키워드</b></div>').appendTo($body);
        $('<div class="cslt-result-keys">').text(data.keys.join(', ')).appendTo($body);
    }
    if (typeof data.content === 'string') {
        $('<div class="cslt-result-section"><b>본문</b></div>').appendTo($body);
        $('<div class="cslt-result-content">').text(data.content).appendTo($body);
    }
}

let lastWorld = null;

async function restoreCachedTranslations() {
    const popup = document.getElementById('world_popup');
    if (!popup) return;

    const world = getCurrentWorldName();
    if (lastWorld && lastWorld !== world) flushWorld(lastWorld);   // 다른 로어북으로 전환 → 즉시 저장
    lastWorld = world;

    if (!loadedWorlds.has(world)) {
        $(popup).addClass('cslt-loading');
        try {
            await ensureWorld(world);
        } finally {
            $(popup).removeClass('cslt-loading');
        }
        if (getCurrentWorldName() !== world) return;   // 그새 로어북이 바뀜
    }

    popup.querySelectorAll('.world_entry').forEach(entryEl => {
        const $entry = $(entryEl);
        if ($entry.find('.cslt-result-panel').length > 0) return;
        const cached = getCachedTranslation($entry);
        if (cached) {
            showResultPanel($entry, { keys: cached.keys, content: cached.content, _truncated: cached.truncated });
            // If user hasn't saved yet, re-add Korean keys to input (drawer must be open to see effect)
            const added = getAddedKeys($entry);
            if (added.length > 0) {
                const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
                if ($keyInput.length) {
                    const current = String($keyInput.val() ?? '').split(',').map(s => s.trim()).filter(Boolean);
                    const currentSet = new Set(current);
                    const missing = added.filter(k => !currentSet.has(k));
                    if (missing.length > 0) {
                        const merged = [...current, ...missing];
                        $keyInput.val(merged.join(', '));
                    }
                }
            }
        }
    });
}

function injectButton(entryEl) {
    const $entry = $(entryEl);
    if ($entry.find('.cslt-translate-btn').length > 0) return;
    const $btn = $(`<i class="menu_button cslt-translate-btn fa-solid interactable"
                       title="이 항목 번역 (Cherry&Solti)" tabindex="0" role="button">🍒</i>`);
    $btn.on('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        translateEntry(entryEl);
    });
    const $moveBtn = $entry.find('.move_entry_button').first();
    if ($moveBtn.length) $moveBtn.before($btn);
    else {
        const $header = $entry.find('.inline-drawer-header').first();
        if ($header.length) $header.append($btn);
        else $entry.prepend($btn);
    }
}

function getAllEntries() {
    const popup = document.getElementById('world_popup');
    if (!popup) return [];
    return Array.from(popup.querySelectorAll('.world_entry'));
}

function entryAlreadyTranslated($entry) {
    if ($entry.find('.cslt-result-panel').length > 0) return true;
    if (getCachedTranslation($entry)) return true;
    return false;
}

function buildBulkOverlay() {
    if ($('#cslt-bulk-overlay').length) return $('#cslt-bulk-overlay');
    const $overlay = $(`
        <div id="cslt-bulk-overlay">
          <div class="cslt-bulk-modal">
            <div class="cslt-bulk-header">🍒 전체 번역 진행 중</div>
            <div class="cslt-bulk-progress-wrap"><div class="cslt-bulk-progress-bar"></div></div>
            <div class="cslt-bulk-stats"><span class="cslt-bulk-status">준비 중...</span></div>
            <div class="cslt-bulk-actions">
              <button class="menu_button cslt-bulk-pause">일시정지</button>
              <button class="menu_button cslt-bulk-cancel">취소</button>
            </div>
          </div>
        </div>
    `);
    $('body').append($overlay);
    $overlay.find('.cslt-bulk-pause').on('click', () => {
        bulkState.paused = !bulkState.paused;
        $overlay.find('.cslt-bulk-pause').text(bulkState.paused ? '재개' : '일시정지');
    });
    $overlay.find('.cslt-bulk-cancel').on('click', () => {
        bulkState.cancelled = true; bulkState.paused = false;
    });
    return $overlay;
}

function updateBulkOverlay() {
    const $overlay = $('#cslt-bulk-overlay');
    if (!$overlay.length) return;
    const pct = bulkState.total ? Math.round((bulkState.done / bulkState.total) * 100) : 0;
    $overlay.find('.cslt-bulk-progress-bar').css('width', pct + '%');
    $overlay.find('.cslt-bulk-status').text(
        `${bulkState.done} / ${bulkState.total} 완료 ` +
        (bulkState.failed ? `(실패 ${bulkState.failed}) ` : '') +
        (bulkState.paused ? '⏸ 일시정지됨' : '')
    );
}

async function startBulkTranslate() {
    if (bulkState.running) { toastr.info('이미 진행 중입니다.', EXT_NAME); return; }
    const settings = getSettings();
    if (!settings.profileId) { toastr.warning('연결 프로필을 먼저 선택하세요.', EXT_NAME); return; }

    let entries = getAllEntries();
    if (settings.bulkSkipTranslated) entries = entries.filter(el => !entryAlreadyTranslated($(el)));
    if (entries.length === 0) { toastr.info('번역할 항목이 없습니다.', EXT_NAME); return; }

    const estSec = Math.ceil(entries.length * (1.5 + settings.bulkDelayMs / 1000));
    if (!confirm(`${entries.length}개 항목 번역\n예상 소요: 약 ${estSec}초\n계속하시겠습니까?`)) return;

    bulkState = { running: true, paused: false, cancelled: false, total: entries.length, done: 0, failed: 0 };
    const $overlay = buildBulkOverlay();
    $overlay[0].style.removeProperty('display');
    updateBulkOverlay();

    try {
        for (let i = 0; i < entries.length; i++) {
            while (bulkState.paused && !bulkState.cancelled) await sleep(200);
            if (bulkState.cancelled) break;
            const entryEl = entries[i];
            if (!document.body.contains(entryEl)) { bulkState.done++; updateBulkOverlay(); continue; }
            try {
                const res = await translateEntry(entryEl, { silent: true });
                if (!res.success) bulkState.failed++;
            } catch (err) {
                console.error(`[${EXT_TAG}] bulk item failed`, err); bulkState.failed++;
            }
            bulkState.done++;
            updateBulkOverlay();
            if (i < entries.length - 1 && settings.bulkDelayMs > 0) await sleep(settings.bulkDelayMs);
        }
    } finally {
        flushAllWorlds();   // 미뤄둔 저장 즉시 반영
        const finalMsg = bulkState.cancelled
            ? `취소됨: ${bulkState.done}/${bulkState.total} (실패 ${bulkState.failed})`
            : `완료: ${bulkState.done}/${bulkState.total} (실패 ${bulkState.failed})`;
        toastr.success(finalMsg, EXT_NAME, { timeOut: 5000 });
        bulkState.running = false;
        setTimeout(() => {
            const el = document.getElementById('cslt-bulk-overlay');
            if (el) el.remove();
        }, 1500);
    }
}

// Bulk delete — only translation panels (not Korean keys)
async function deleteAllTranslations() {
    const world = getCurrentWorldName();
    if (!confirm(`현재 로어북(${world})의 모든 번역 결과 패널을 삭제하시겠습니까?\n(추가된 한글 키워드는 유지됩니다 — 같이 지우려면 🧹 키워드 제거를 먼저 사용하세요)`)) return;
    try {
        const count = deleteAllCachedForCurrentWorld();
        document.querySelectorAll('#world_popup .cslt-result-panel').forEach(el => el.remove());
        toastr.success(`${count}개 번역 결과 삭제됨`, EXT_NAME, { timeOut: 3000 });
    } catch (err) {
        console.error(`[${EXT_TAG}] deleteAllTranslations error`, err);
        toastr.error('삭제 실패', EXT_NAME);
    }
}

// Smart collapse-all toggle — if any expanded, collapse all; else expand all
function toggleAllPanels() {
    const $panels = $('#world_popup .cslt-result-panel');
    if ($panels.length === 0) {
        toastr.info('번역 결과가 없습니다', EXT_NAME);
        return;
    }
    // Check if any body is visible
    let anyOpen = false;
    $panels.each((_, el) => {
        const $body = $(el).find('.cslt-result-body');
        if ($body.is(':visible')) { anyOpen = true; return false; }
    });
    const $btn = $('#cslt-bulk-collapse');
    if (anyOpen) {
        $panels.find('.cslt-result-body').hide();
        $panels.find('.cslt-result-toggle').text('펼치기');
        $btn.addClass('cslt-collapsed-state').attr('title', '모두 펼치기');
    } else {
        $panels.find('.cslt-result-body').show();
        $panels.find('.cslt-result-toggle').text('접기');
        $btn.removeClass('cslt-collapsed-state').attr('title', '모두 접기');
    }
}

function injectBulkButtons() {
    const popup = document.getElementById('world_popup');
    if (!popup) return;
    if (popup.querySelector('#cslt-bulk-bar')) return;

    const $bar = $(`
        <div id="cslt-bulk-bar">
          <button id="cslt-bulk-translate" class="menu_button" title="현재 로어북의 모든 항목 번역">🍒 전체 번역</button>
          <button id="cslt-bulk-save" class="menu_button" title="저장 안 된 모든 한글 키워드 일괄 저장">💾 전체 저장</button>
          <button id="cslt-bulk-cleanup" class="menu_button" title="추가된 한글 키워드만 일괄 제거 (영문 키워드 유지)">🧹 키워드 제거</button>
          <button id="cslt-bulk-delete" class="menu_button" title="번역 결과 패널 일괄 삭제 (한글 키워드 유지)">🗑️ 번역 삭제</button>
          <button id="cslt-bulk-collapse" class="menu_button" title="모두 접기/펼치기">^</button>
        </div>
    `);
    $bar.find('#cslt-bulk-translate').on('click', startBulkTranslate);
    $bar.find('#cslt-bulk-save').on('click', bulkSaveAll);
    $bar.find('#cslt-bulk-cleanup').on('click', bulkCleanupKeys);
    $bar.find('#cslt-bulk-delete').on('click', deleteAllTranslations);
    $bar.find('#cslt-bulk-collapse').on('click', toggleAllPanels);
    $(popup).prepend($bar);
}

const scanAndInjectDebounced = debounce(() => {
    if (!appReady) return;
    try {
        const popup = document.getElementById('world_popup');
        if (!popup) return;
        popup.querySelectorAll('.world_entry').forEach(injectButton);
        injectBulkButtons();
        restoreCachedTranslations().catch(err => console.error(`[${EXT_TAG}] restore error`, err));
    } catch (err) {
        console.error(`[${EXT_TAG}] scanAndInject error`, err);
    }
}, 150);

function startScopedObserver() {
    if (observerActive) return;
    const popup = document.getElementById('world_popup');
    if (!popup) return;
    scopedObserver = new MutationObserver(() => scanAndInjectDebounced());
    scopedObserver.observe(popup, { childList: true, subtree: true });
    observerActive = true;
    scanAndInjectDebounced();
}

function watchForWIPopup() {
    $(document).on('click', '#WIDrawerIcon, #WI-management, [data-extension-name="world-info"]', () => {
        setTimeout(startScopedObserver, 300);
    });
    let tries = 0;
    const interval = setInterval(() => {
        tries++;
        if (observerActive || tries > 60) { clearInterval(interval); return; }
        if (document.getElementById('world_popup')) { startScopedObserver(); clearInterval(interval); }
    }, 500);
}

function onAppReady() {
    if (appReady) return;
    appReady = true;
    window.addEventListener('beforeunload', flushAllWorlds);
    $(document).on('click', '#world_popup_close, #WI-management-close', () => setTimeout(flushAllWorlds, 100));
    console.log(`[${EXT_TAG}] APP_READY received`);
    if (!renderSettings()) setTimeout(renderSettings, 500);
    $(document).on('click', '#extensionsMenuButton', () => setTimeout(refreshProfileDropdown, 200));
    watchForWIPopup();
    resolveSaveWorldInfo().then(fn => {
        if (!fn) console.warn(`[${EXT_TAG}] saveWorldInfo not available — 💾 button may not work`);
    });
}

jQuery(() => {
    console.log(`[${EXT_TAG}] jQuery ready, waiting for APP_READY...`);
    try {
        if (eventSource && event_types?.APP_READY) eventSource.on(event_types.APP_READY, onAppReady);
        else setTimeout(onAppReady, 2000);
    } catch (e) {
        console.warn(`[${EXT_TAG}] event hook failed`, e);
        setTimeout(onAppReady, 2000);
    }
});
