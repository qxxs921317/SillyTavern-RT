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

// ---------- Small helpers (v0.9) ----------
function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normText(s) { return String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function splitKeys(s) { return String(s ?? '').split(',').map(x => x.trim()).filter(Boolean); }
function uniq(arr) { return Array.from(new Set(arr)); }

/**
 * 원문 지문 — 가져오기 매칭 / "원문 바뀜" 감지용
 * c: 본문, k: 원래 키(우리가 넣은 한글키 제외, 정렬), t: 제목
 */
function srcInfo(content, keys, comment) {
    const c = normText(content);
    const k = uniq((keys || []).map(normText).filter(Boolean)).sort().join('|');
    const t = normText(comment);
    return { c: c ? keyHash(c) : '', k: k ? keyHash(k) : '', t: t ? keyHash(t) : '' };
}

/* ---------- ST world-info API (loadWorldInfo / saveWorldInfo / reloadEditor) ---------- */
let wiApi = null;
async function resolveWI() {
    if (wiApi) return wiApi;
    const api = { load: null, save: null, reload: null };
    try {
        const ctx = getContext?.();
        if (typeof ctx?.loadWorldInfo === 'function') api.load = ctx.loadWorldInfo;
        if (typeof ctx?.saveWorldInfo === 'function') api.save = ctx.saveWorldInfo;
        if (typeof ctx?.reloadWorldInfoEditor === 'function') api.reload = ctx.reloadWorldInfoEditor;
    } catch { /* noop */ }
    if (!api.load || !api.save || !api.reload) {
        for (const path of ['/scripts/world-info.js', '../../../world-info.js']) {
            try {
                const mod = await import(path);
                api.load ??= typeof mod?.loadWorldInfo === 'function' ? mod.loadWorldInfo : null;
                api.save ??= typeof mod?.saveWorldInfo === 'function' ? mod.saveWorldInfo : null;
                api.reload ??= typeof mod?.reloadEditor === 'function' ? mod.reloadEditor : null;
                if (api.load) break;
            } catch { /* noop */ }
        }
    }
    wiApi = api;
    return api;
}

function worldExists(name) {
    const opts = document.querySelectorAll('#world_editor_select option, #world_info option');
    for (const o of opts) if (o.textContent?.trim() === name) return true;
    return false;
}

/** 로어북 항목을 데이터에서 직접 읽음 (페이지에 안 보이는 항목까지) */
async function loadWorldEntries(world) {
    const wi = await resolveWI();
    if (!wi.load) return null;
    try {
        const data = await wi.load(world);
        if (!data?.entries) return null;
        return Object.values(data.entries).map(e => ({
            uid: String(e.uid),
            comment: String(e.comment ?? ''),
            keys: Array.isArray(e.key) ? e.key.map(String) : [],
            content: String(e.content ?? ''),
        }));
    } catch (err) {
        console.warn(`[${EXT_TAG}] loadWorldEntries failed:`, world, err);
        return null;
    }
}

function setBtnLabel($btn, text) {
    const $s = $btn.find('span').first();
    if ($s.length) $s.text(text); else $btn.text(text);
}
function getBtnLabel($btn) {
    const $s = $btn.find('span').first();
    return $s.length ? $s.text() : $btn.text();
}

// Pretendard (dynamic subset — 필요한 글자만 받아옴, 오프라인이면 시스템 폰트로 폴백)
function loadFont() {
    if (document.getElementById('cslt-font')) return;
    const l = document.createElement('link');
    l.id = 'cslt-font';
    l.rel = 'stylesheet';
    l.href = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css';
    document.head.appendChild(l);
}


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
    const p = persistWorld(world).catch(err => console.error(`[${EXT_TAG}] 저장 실패:`, err));
    inflight.set(world, p);
    p.finally(() => { if (inflight.get(world) === p) inflight.delete(world); });
}

function flushAllWorlds() {
    for (const world of [...worldTimers.keys()]) flushWorld(world);
}

/* ---------- 로어북 단위 이동/삭제 (이름 변경 대응, v0.10) ---------- */
const inflight = new Map();   // world -> 진행 중인 저장 Promise

async function deleteWorldFile(fileName) {
    try {
        const res = await fetch(FILE_DELETE_URL, {
            method: 'POST',
            headers: reqHeaders(),
            body: JSON.stringify({ path: `${FILE_DIR}/${fileName}` }),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** 이 로어북 이름으로 된 번역 데이터를 흔적 없이 지움 (런타임 + 파일 + 인덱스 + 레거시) */
async function purgeWorld(world) {
    const st = worldTimers.get(world);
    if (st) { clearTimeout(st.timer); worldTimers.delete(world); }
    await inflight.get(world)?.catch(() => {});

    const prefix = `${world}::`;
    for (const section of ['cache', 'addedKeys']) {
        for (const k of Object.keys(rtData[section])) if (k.startsWith(prefix)) delete rtData[section][k];
    }
    const settings = getSettings();
    const idx = settings.fileIndex?.[world];
    if (idx?.file && !storageFailed) await deleteWorldFile(idx.file);
    if (settings.fileIndex) delete settings.fileIndex[world];
    // 레거시 잔여분도 같이 — 안 지우면 다음에 다시 "주인 없는 번역"으로 살아남
    const raw = extension_settings[EXT_ID] || {};
    for (const section of ['cache', 'addedKeys']) {
        for (const k of Object.keys(raw[section] || {})) if (k.startsWith(prefix)) delete raw[section][k];
    }
    loadedWorlds.delete(world);
    saveSettingsDebounced();
}

function worldUids(world) {
    const prefix = `${world}::`;
    const uids = new Set();
    for (const section of ['cache', 'addedKeys']) {
        for (const k of Object.keys(rtData[section])) if (k.startsWith(prefix)) uids.add(k.slice(prefix.length));
    }
    return [...uids];
}

/**
 * from 데이터를 to 로어북에 대 보기 — 같은 로어북인지 판단용
 * uidHit: to에 같은 uid가 있는 수 / srcHit: 원문 지문까지 같은 수 / conflicts: to에 이미 번역 있는 수
 */
async function compareWorlds(from, to) {
    await ensureWorld(from);
    await ensureWorld(to);
    const uids = worldUids(from);
    const entries = await loadWorldEntries(to);
    const map = new Map((entries || []).map(e => [e.uid, e]));
    let uidHit = 0, srcHit = 0, srcTotal = 0, conflicts = 0, translations = 0;
    for (const uid of uids) {
        const e = map.get(uid);
        if (e) uidHit++;
        const tr = rtData.cache[makeKey(from, uid)];
        if (hasTranslation(tr)) translations++;
        if (tr?.src?.c) {
            srcTotal++;
            if (e && keyHash(normText(e.content)) === tr.src.c) srcHit++;
        }
        if (hasTranslation(rtData.cache[makeKey(to, uid)])) conflicts++;
    }
    return { total: uids.length, translations, uidHit, srcHit, srcTotal, conflicts, entries: entries?.length ?? 0 };
}

/**
 * from → to 로 키 앞부분만 바꿔서 옮김 (uid 그대로)
 * 수정본·한글키 기록·가져옴 표시까지 전부 유지
 */
async function migrateWorld(from, to, { overwrite = false } = {}) {
    await ensureWorld(from);
    await ensureWorld(to);
    await inflight.get(from)?.catch(() => {});
    const prefix = `${from}::`;
    let moved = 0, skipped = 0;
    for (const section of ['cache', 'addedKeys']) {
        for (const [k, v] of Object.entries(rtData[section])) {
            if (!k.startsWith(prefix)) continue;
            const nk = makeKey(to, k.slice(prefix.length));
            if (rtData[section][nk] === undefined || overwrite) {
                rtData[section][nk] = structuredClone(v);
                if (section === 'cache') moved++;
            } else if (section === 'cache') skipped++;
        }
    }
    // 새 쪽을 먼저 확실히 저장한 뒤에 옛 쪽을 지움
    const st = worldTimers.get(to);
    if (st) { clearTimeout(st.timer); worldTimers.delete(to); }
    await persistWorld(to);
    await purgeWorld(from);
    return { moved, skipped };
}

/** 현재 열린 로어북의 패널 다시 그리기 */
async function refreshPanels() {
    document.querySelectorAll('#world_popup .cslt-result-panel').forEach(el => el.remove());
    await restoreCachedTranslations().catch(() => {});
    updateDataSizeDisplay?.();
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

function setCachedTranslation($entry, data, extra = {}) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    rtData.cache[makeKey(getCurrentWorldName(), uid)] = {
        keys: Array.isArray(data.keys) ? data.keys : undefined,
        content: typeof data.content === 'string' ? data.content : undefined,
        truncated: !!data._truncated,
        savedAt: Date.now(),
        ...extra,
    };
    scheduleWorldPersist(getCurrentWorldName());
}

/** 캐시 레코드 → 패널 표시용 데이터 */
function cacheToPanel(c, stale = false) {
    return {
        keys: c.keys, content: c.content, _truncated: c.truncated,
        edited: !!c.edited, importedFrom: c.importedFrom || '', stale,
    };
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
    const k = makeKey(getCurrentWorldName(), uid);
    if (Array.isArray(koreanKeys) && koreanKeys.length) rtData.addedKeys[k] = koreanKeys;
    else delete rtData.addedKeys[k];
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
        const origText = getBtnLabel($btn);
        setBtnLabel($btn, `0/${entriesToSave.length}`);
        $btn.prop('disabled', true);

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
                setBtnLabel($btn, `${saved}/${entriesToSave.length}`);
                await sleep(50);
            }
            await sleep(200);
            await saveFn(getCurrentWorldName());
            // Keep addedKeys — don't clear them
            flushAllWorlds();
            toastr.success(`✓ ${saved}개 항목 저장 완료${failed ? ` (실패 ${failed})` : ''}`, EXT_NAME, { timeOut: 4000 });
        } finally {
            setBtnLabel($btn, origText); $btn.prop('disabled', false);
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
        const origText = getBtnLabel($btn);
        setBtnLabel($btn, `0/${entriesWithAdded.length}`);
        $btn.prop('disabled', true);

        let done = 0, failed = 0;
        try {
            for (let i = 0; i < entriesWithAdded.length; i++) {
                const $entry = $(entriesWithAdded[i]);
                // persist=false here — we'll save once at end for efficiency
                const ok = await cleanupEntryKeys($entry, { silent: true, persist: false });
                if (ok) done++; else failed++;
                setBtnLabel($btn, `${done}/${entriesWithAdded.length}`);
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
            setBtnLabel($btn, origText); $btn.prop('disabled', false);
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

          <small class="cslt-help">
            <i class="fa-solid fa-pen"></i> 수정: 번역 결과 직접 고치기 (저장하면 한글 키워드도 반영)<br>
            <i class="fa-solid fa-floppy-disk"></i> 저장: 한글 키워드 영구 저장<br>
            <i class="fa-solid fa-eraser"></i> 키 제거: 한글 키워드만 제거 (영문 유지)<br>
            <i class="fa-solid fa-trash-can"></i> 번역 삭제: 번역 결과만 삭제 (키워드 그대로)<br>
            <i class="fa-solid fa-file-import"></i> 가져오기: 다른 로어북의 같은/비슷한 항목 번역을 한 번에 가져오기
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
    if (!silent && getCachedTranslation($entry)?.edited) {
        if (!confirm('직접 수정한 번역이 있어.\n다시 번역해서 덮어쓸까?')) return { success: false, truncated: false };
    }
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
        const originalKeys = splitKeys(keysRaw);
        const originalKeysSet = new Set(originalKeys);
        // 이전에 우리가 넣은 한글 키는 다시 번역 보내지 않음
        const prevAdded = new Set(getAddedKeys($entry));
        const sourceKeys = originalKeys.filter(k => !prevAdded.has(k));
        const comment = String($entry.find('textarea[name="comment"], input[name="comment"]').first().val() ?? '');
        const src = srcInfo(content, sourceKeys, comment);

        let payload;
        if (settings.translateUnit === 'keys') payload = { keys: sourceKeys };
        else if (settings.translateUnit === 'content') payload = { content };
        else payload = { keys: sourceKeys, content };

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
        setCachedTranslation($entry, panelData, { src, edited: false });
        showResultPanel($entry, panelData);
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

/* ===================================================================
 * 번역 결과 패널 (v0.9) — 보기 / 편집
 * =================================================================== */

const PANEL_HTML = `
<div class="cslt-result-panel">
  <div class="cslt-result-header">
    <div class="cslt-result-title">
      <i class="fa-solid fa-language"></i><span>번역</span><span class="cslt-badges"></span>
    </div>
    <div class="cslt-result-actions">
      <button type="button" class="cslt-act" data-act="edit" title="번역 수정"><i class="fa-solid fa-pen"></i></button>
      <button type="button" class="cslt-act" data-act="save" title="한글 키워드 영구 저장"><i class="fa-solid fa-floppy-disk"></i></button>
      <button type="button" class="cslt-act" data-act="cleanup" title="한글 키워드만 제거 (번역 결과 유지)"><i class="fa-solid fa-eraser"></i></button>
      <button type="button" class="cslt-act cslt-act-danger" data-act="delete" title="번역 결과 삭제 (한글 키워드 유지)"><i class="fa-solid fa-trash-can"></i></button>
      <button type="button" class="cslt-act cslt-act-toggle" data-act="toggle" title="접기/펼치기"><i class="fa-solid fa-chevron-up"></i></button>
    </div>
  </div>
  <div class="cslt-result-body"></div>
</div>`;

function showResultPanel($entry, data) {
    let $panel = $entry.find('.cslt-result-panel');
    if ($panel.length === 0) {
        $panel = $(PANEL_HTML);
        $entry.append($panel);
        $panel.on('click', '.cslt-act', (e) => {
            e.stopPropagation(); e.preventDefault();
            onPanelAction($entry, $panel, $(e.currentTarget).data('act'));
        });
        // 편집 영역 클릭이 ST 드로어 토글로 새지 않게
        $panel.on('click', (e) => e.stopPropagation());
    }
    $panel.data('cslt', data);
    $panel.removeClass('cslt-editing');
    renderPanelView($entry, $panel);
}

function renderPanelBadges($panel, data) {
    const $b = $panel.find('.cslt-badges').empty();
    if (data.edited) $b.append('<span class="cslt-badge cslt-badge-edited">수정됨</span>');
    if (data.importedFrom) $b.append($('<span class="cslt-badge cslt-badge-import">가져옴</span>').attr('title', `출처: ${data.importedFrom}`));
    if (data.stale) $b.append('<span class="cslt-badge cslt-badge-stale" title="번역한 뒤에 원문이 바뀌었어">원문 변경</span>');
}

function renderPanelView($entry, $panel) {
    const data = $panel.data('cslt') || {};
    renderPanelBadges($panel, data);
    const $body = $panel.find('.cslt-result-body').empty();

    if (data._truncated) $('<div class="cslt-warning"><i class="fa-solid fa-triangle-exclamation"></i> 응답이 잘려서 일부만 복구됨</div>').appendTo($body);
    if (data.rawText) { $('<pre class="cslt-raw">').text(data.rawText).appendTo($body); return; }

    if (Array.isArray(data.keys) && data.keys.length) {
        const added = new Set(getAddedKeys($entry));
        $('<div class="cslt-cap">키워드</div>').appendTo($body);
        const $chips = $('<div class="cslt-chips">').appendTo($body);
        for (const k of data.keys) {
            const t = String(k).trim();
            if (!t) continue;
            $('<span class="cslt-chip">').toggleClass('cslt-chip-added', added.has(t))
                .attr('title', added.has(t) ? '로어북 키에 추가됨' : '')
                .text(t).appendTo($chips);
        }
    }
    if (typeof data.content === 'string') {
        $('<div class="cslt-cap">본문</div>').appendTo($body);
        $('<div class="cslt-result-content">').text(data.content).appendTo($body);
    }
}

function renderPanelEdit($entry, $panel) {
    const data = $panel.data('cslt') || {};
    $panel.addClass('cslt-editing').removeClass('cslt-collapsed');
    const $body = $panel.find('.cslt-result-body').empty();

    if (Array.isArray(data.keys)) {
        $('<div class="cslt-cap">키워드 <small>쉼표로 구분</small></div>').appendTo($body);
        $('<input type="text" class="text_pole cslt-edit-keys">').val(data.keys.join(', ')).appendTo($body);
    }
    if (typeof data.content === 'string') {
        $('<div class="cslt-cap">본문</div>').appendTo($body);
        const lines = data.content.split('\n').length + Math.ceil(data.content.length / 60);
        $('<textarea class="text_pole cslt-edit-content">')
            .attr('rows', Math.min(16, Math.max(4, lines)))
            .val(data.content).appendTo($body);
    }
    const $foot = $(`
      <div class="cslt-edit-foot">
        <button type="button" class="cslt-btn cslt-edit-cancel">취소</button>
        <button type="button" class="cslt-btn cslt-btn-primary cslt-edit-save"><i class="fa-solid fa-check"></i><span>저장</span></button>
      </div>`).appendTo($body);

    $foot.find('.cslt-edit-cancel').on('click', (e) => {
        e.stopPropagation();
        $panel.removeClass('cslt-editing');
        renderPanelView($entry, $panel);
    });
    $foot.find('.cslt-edit-save').on('click', async (e) => {
        e.stopPropagation();
        const $btn = $(e.currentTarget).prop('disabled', true);
        const $k = $body.find('.cslt-edit-keys');
        const $c = $body.find('.cslt-edit-content');
        const newKeys = $k.length ? uniq(splitKeys($k.val())) : undefined;
        const newContent = $c.length ? String($c.val() ?? '') : undefined;
        try {
            await saveEditedTranslation($entry, newKeys, newContent);
        } finally {
            $btn.prop('disabled', false);
        }
    });
    $body.find('textarea, input').first().trigger('focus');
}

async function onPanelAction($entry, $panel, act) {
    const $btn = $panel.find(`.cslt-act[data-act="${act}"]`);
    switch (act) {
        case 'toggle':
            $panel.toggleClass('cslt-collapsed');
            break;
        case 'edit':
            if ($panel.hasClass('cslt-editing')) { $panel.removeClass('cslt-editing'); renderPanelView($entry, $panel); }
            else renderPanelEdit($entry, $panel);
            break;
        case 'save':
            $btn.addClass('cslt-busy');
            await saveEntryKeysPermanently($entry);
            $btn.removeClass('cslt-busy');
            renderPanelView($entry, $panel);
            break;
        case 'cleanup':
            if (!confirm('이 항목에 추가된 한글 키워드만 제거할까?\n(번역 결과는 그대로, 영문 키워드는 안전해)')) return;
            $btn.addClass('cslt-busy');
            await cleanupEntryKeys($entry);
            $btn.removeClass('cslt-busy');
            if (!$panel.hasClass('cslt-editing')) renderPanelView($entry, $panel);
            break;
        case 'delete':
            if (!confirm('번역 결과를 삭제할까?\n(키워드 입력란의 한글 키워드는 그대로야)')) return;
            deleteCachedTranslation($entry);
            $panel.remove();
            toastr.success('번역 결과 삭제됨', EXT_NAME, { timeOut: 2000 });
            break;
    }
}

/**
 * 키 입력란의 "우리가 넣은 한글 키"를 새 목록으로 교체
 * 원래 키(영문 등)는 건드리지 않음
 */
async function syncAddedKeys($entry, translatedKeys) {
    const expanded = await ensureEntryExpanded($entry);
    if (!expanded) return false;
    const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
    if (!$keyInput.length) return false;

    const current = splitKeys($keyInput.val());
    const oldAdded = new Set(getAddedKeys($entry));
    const originals = current.filter(k => !oldAdded.has(k));
    const origSet = new Set(originals);
    const newAdded = uniq(translatedKeys.map(s => String(s).trim()).filter(k => k && !origSet.has(k)));

    $keyInput.val([...originals, ...newAdded].join(', '));
    for (const ev of ['input', 'change', 'blur']) $keyInput[0].dispatchEvent(new Event(ev, { bubbles: true }));
    setAddedKeys($entry, newAdded);
    await sleep(80);

    const saveFn = await resolveSaveWorldInfo();
    if (saveFn) { try { await saveFn(getCurrentWorldName()); } catch { /* 입력 이벤트로 이미 저장됨 */ } }
    return true;
}

async function saveEditedTranslation($entry, newKeys, newContent) {
    const uid = getEntryUid($entry);
    if (!uid) { toastr.error('항목 ID를 못 찾았어', EXT_NAME); return; }
    const world = getCurrentWorldName();
    const key = makeKey(world, uid);
    const prev = rtData.cache[key] || {};
    const next = { ...prev, savedAt: Date.now(), edited: true };
    if (newKeys !== undefined) next.keys = newKeys;
    if (newContent !== undefined) next.content = newContent;
    next.truncated = false;
    rtData.cache[key] = next;
    flushWorld(world);

    let keyNote = '';
    const settings = getSettings();
    if (newKeys !== undefined && (settings.autoAddKoreanKeys || getAddedKeys($entry).length > 0)) {
        const ok = await syncAddedKeys($entry, newKeys);
        keyNote = ok ? ' · 키워드 반영됨' : ' · 키워드 반영 실패';
    }
    showResultPanel($entry, cacheToPanel(next));
    toastr.success(`수정 저장됨${keyNote}`, EXT_NAME, { timeOut: 2500 });
}

let lastWorld = null;

async function restoreCachedTranslations() {
    const popup = document.getElementById('world_popup');
    if (!popup) return;

    const world = getCurrentWorldName();
    if (lastWorld && lastWorld !== world) {
        flushWorld(lastWorld);   // 다른 로어북으로 전환 → 즉시 저장
        const from = lastWorld;
        checkRename(from, world).catch(err => console.warn(`[${EXT_TAG}] checkRename`, err));
    }
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

    const pending = [];
    popup.querySelectorAll('.world_entry').forEach(entryEl => {
        const $entry = $(entryEl);
        if ($entry.find('.cslt-result-panel').length > 0) return;
        const cached = getCachedTranslation($entry);
        if (cached) pending.push({ $entry, cached });
    });
    if (!pending.length) return;

    // "원문 변경" 감지 — 원문 지문이 있는 번역만
    let current = null;
    if (pending.some(p => p.cached.src?.c)) {
        const entries = await loadWorldEntries(world);
        if (getCurrentWorldName() !== world) return;
        if (entries) current = new Map(entries.map(e => [e.uid, e]));
    }

    for (const { $entry, cached } of pending) {
        if ($entry.find('.cslt-result-panel').length > 0) continue;
        let stale = false;
        const uid = getEntryUid($entry);
        const cur = current?.get(String(uid));
        if (cur && cached.src?.c) {
            const nowC = normText(cur.content);
            stale = !!nowC && keyHash(nowC) !== cached.src.c;
        }
        showResultPanel($entry, cacheToPanel(cached, stale));

        // If user hasn't saved yet, re-add Korean keys to input (drawer must be open to see effect)
        const added = getAddedKeys($entry);
        if (added.length > 0) {
            const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
            if ($keyInput.length) {
                const current = splitKeys($keyInput.val());
                const currentSet = new Set(current);
                const missing = added.filter(k => !currentSet.has(k));
                if (missing.length > 0) $keyInput.val([...current, ...missing].join(', '));
            }
        }
    }
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

/* ===================================================================
 * 공용 모달
 * =================================================================== */
function openModal({ id, title, icon = 'fa-language', wide = false, closable = true }) {
    $(`#${id}`).remove();
    const $ov = $(`
      <div id="${id}" class="cslt-overlay">
        <div class="cslt-modal${wide ? ' cslt-modal-wide' : ''}" role="dialog" aria-modal="true">
          <div class="cslt-modal-head">
            <div class="cslt-modal-title"><i class="fa-solid ${icon}"></i><span></span></div>
            ${closable ? '<button type="button" class="cslt-act cslt-modal-x" title="닫기"><i class="fa-solid fa-xmark"></i></button>' : ''}
          </div>
          <div class="cslt-modal-body"></div>
        </div>
      </div>`);
    $ov.find('.cslt-modal-title span').text(title);
    if (closable) {
        $ov.find('.cslt-modal-x').on('click', () => $ov.remove());
        $ov.on('mousedown', (e) => { if (e.target === $ov[0]) $ov.data('downOnBg', true); });
        $ov.on('click', (e) => { if (e.target === $ov[0] && $ov.data('downOnBg')) $ov.remove(); $ov.data('downOnBg', false); });
    }
    $('body').append($ov);
    return $ov;
}

/* ===================================================================
 * 전체 번역 진행 모달
 * =================================================================== */
function buildBulkOverlay() {
    if ($('#cslt-bulk-overlay').length) return $('#cslt-bulk-overlay');
    const $overlay = openModal({ id: 'cslt-bulk-overlay', title: '전체 번역 중', closable: false });
    $overlay.find('.cslt-modal-body').html(`
        <div class="cslt-bulk-progress-wrap"><div class="cslt-bulk-progress-bar"></div></div>
        <div class="cslt-bulk-stats"><span class="cslt-bulk-status">준비 중...</span></div>
        <div class="cslt-modal-foot cslt-center">
          <button type="button" class="cslt-btn cslt-bulk-pause"><i class="fa-solid fa-pause"></i><span>일시정지</span></button>
          <button type="button" class="cslt-btn cslt-btn-danger cslt-bulk-cancel"><i class="fa-solid fa-stop"></i><span>취소</span></button>
        </div>`);
    $overlay.find('.cslt-bulk-pause').on('click', function () {
        bulkState.paused = !bulkState.paused;
        $(this).find('i').attr('class', bulkState.paused ? 'fa-solid fa-play' : 'fa-solid fa-pause');
        $(this).find('span').text(bulkState.paused ? '재개' : '일시정지');
        updateBulkOverlay();
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
        `${bulkState.done} / ${bulkState.total} 완료` +
        (bulkState.failed ? ` · 실패 ${bulkState.failed}` : '') +
        (bulkState.paused ? ' · 일시정지됨' : ''),
    );
}

async function startBulkTranslate() {
    if (bulkState.running) { toastr.info('이미 진행 중이야', EXT_NAME); return; }
    const settings = getSettings();
    if (!settings.profileId) { toastr.warning('연결 프로필을 먼저 선택해줘', EXT_NAME); return; }

    let entries = getAllEntries();
    // 직접 수정한 번역은 전체 번역에서 항상 보호
    const before = entries.length;
    entries = entries.filter(el => !getCachedTranslation($(el))?.edited);
    const protectedCount = before - entries.length;
    if (settings.bulkSkipTranslated) entries = entries.filter(el => !entryAlreadyTranslated($(el)));
    if (entries.length === 0) { toastr.info('번역할 항목이 없어', EXT_NAME); return; }

    const estSec = Math.ceil(entries.length * (1.5 + settings.bulkDelayMs / 1000));
    const note = protectedCount ? `\n(직접 수정한 ${protectedCount}개는 건너뜀)` : '';
    if (!confirm(`${entries.length}개 항목 번역\n예상 소요: 약 ${estSec}초${note}\n계속할까?`)) return;

    bulkState = { running: true, paused: false, cancelled: false, total: entries.length, done: 0, failed: 0 };
    buildBulkOverlay();
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
        setTimeout(() => $('#cslt-bulk-overlay').remove(), 1200);
    }
}

// Bulk delete — only translation panels (not Korean keys)
async function deleteAllTranslations() {
    const world = getCurrentWorldName();
    if (!confirm(`현재 로어북(${world})의 번역 결과를 전부 삭제할까?\n(한글 키워드는 그대로야 — 같이 지우려면 "키 제거"를 먼저 눌러줘)`)) return;
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
    if ($panels.length === 0) { toastr.info('번역 결과가 없어', EXT_NAME); return; }
    const anyOpen = $panels.not('.cslt-collapsed').length > 0;
    const $btn = $('#cslt-bulk-collapse');
    if (anyOpen) {
        $panels.not('.cslt-editing').addClass('cslt-collapsed');
        $btn.addClass('cslt-collapsed-state').attr('title', '모두 펼치기');
    } else {
        $panels.removeClass('cslt-collapsed');
        $btn.removeClass('cslt-collapsed-state').attr('title', '모두 접기');
    }
}

function injectBulkButtons() {
    const popup = document.getElementById('world_popup');
    if (!popup) return;
    if (popup.querySelector('#cslt-bulk-bar')) return;

    const $bar = $(`
        <div id="cslt-bulk-bar">
          <button type="button" id="cslt-bulk-translate" class="cslt-btn cslt-btn-primary" title="현재 로어북의 모든 항목 번역">
            <i class="fa-solid fa-language"></i><span>전체 번역</span>
          </button>
          <div class="cslt-seg">
            <button type="button" id="cslt-bulk-save" title="한글 키워드 일괄 영구 저장"><i class="fa-solid fa-floppy-disk"></i><span>저장</span></button>
            <button type="button" id="cslt-bulk-cleanup" title="추가된 한글 키워드만 일괄 제거 (영문 키워드 유지)"><i class="fa-solid fa-eraser"></i><span>키 제거</span></button>
            <button type="button" id="cslt-bulk-delete" class="cslt-seg-danger" title="번역 결과 일괄 삭제 (한글 키워드 유지)"><i class="fa-solid fa-trash-can"></i><span>번역 삭제</span></button>
            <button type="button" id="cslt-bulk-import" title="다른 로어북의 번역 가져오기"><i class="fa-solid fa-file-import"></i><span>가져오기</span></button>
          </div>
          <button type="button" id="cslt-bulk-collapse" class="cslt-btn cslt-btn-icon" title="모두 접기"><i class="fa-solid fa-angles-up"></i></button>
        </div>
    `);
    $bar.find('#cslt-bulk-translate').on('click', startBulkTranslate);
    $bar.find('#cslt-bulk-save').on('click', bulkSaveAll);
    $bar.find('#cslt-bulk-cleanup').on('click', bulkCleanupKeys);
    $bar.find('#cslt-bulk-delete').on('click', deleteAllTranslations);
    $bar.find('#cslt-bulk-import').on('click', openImportModal);
    $bar.find('#cslt-bulk-collapse').on('click', toggleAllPanels);
    $(popup).prepend($bar);
}

/* ===================================================================
 * 다른 로어북에서 번역 가져오기 (v0.9)
 *
 * 매칭 순서:
 *   1) 본문 일치 (공백·대소문자 무시)           → 확실
 *   2) 제목 + 원래 키 일치                       → 확실
 *   3) 제목이나 키가 겹치고 본문 유사도 ≥ 75%   → 확인 필요
 *
 * 원본 로어북이 남아 있으면 원문을 직접 읽고,
 * 지워졌으면 번역 때 저장해둔 원문 지문(src)으로만 매칭함.
 * =================================================================== */

const SIMILAR_MIN = 0.75;

function bigrams(text) {
    const t = text.replace(/\s+/g, '');
    const m = new Map();
    for (let i = 0; i < t.length - 1; i++) {
        const b = t.substr(i, 2);
        m.set(b, (m.get(b) || 0) + 1);
    }
    return { m, n: Math.max(0, t.length - 1) };
}

function dice(a, b) {
    if (!a.n || !b.n) return 0;
    const [s, l] = a.m.size < b.m.size ? [a, b] : [b, a];
    let inter = 0;
    for (const [k, v] of s.m) {
        const w = l.m.get(k);
        if (w) inter += Math.min(v, w);
    }
    return (2 * inter) / (a.n + b.n);
}

function hasTranslation(tr) {
    return tr && (typeof tr.content === 'string' || (Array.isArray(tr.keys) && tr.keys.length > 0));
}

function stripAdded(world, uid, keys) {
    const added = new Set(rtData.addedKeys[makeKey(world, uid)] || []);
    return keys.filter(k => !added.has(k));
}

/**
 * 순수 매칭 로직 — 테스트하기 쉽게 DOM/네트워크와 분리
 * targets: [{uid, comment, keys, content}]  (한글 추가키 제거된 원래 키)
 * cands:   [{world, uid, tr, info, text, titleN, keySet}]
 */
function matchEntries(targets, cands, selfWorld = '') {
    const byContent = new Map();
    const byTK = new Map();
    const byKey = new Map();
    const byTitle = new Map();
    const push = (map, k, v) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    for (const c of cands) {
        push(byContent, c.info.c, c);
        if (c.info.t && c.info.k) push(byTK, `${c.info.t}|${c.info.k}`, c);
        if (c.text) {
            for (const k of c.keySet) push(byKey, k, c);
            push(byTitle, c.titleN, c);
        }
    }
    const newest = (list) => list.reduce((a, b) => ((b.tr.savedAt || 0) > (a.tr.savedAt || 0) ? b : a));

    const rows = [];
    let unmatched = 0;
    for (const t of targets) {
        const ti = srcInfo(t.content, t.keys, t.comment);
        // 같은 로어북에서 가져올 때 자기 자신과 매칭되는 건 제외
        const isSelf = (c) => c.world === selfWorld && c.uid === t.uid;
        const notSelf = (list) => (list || []).filter(c => !isSelf(c));
        const sameBody = ti.c ? notSelf(byContent.get(ti.c)) : [];
        const sameTK = ti.t && ti.k ? notSelf(byTK.get(`${ti.t}|${ti.k}`)) : [];
        let row = null;
        if (sameBody.length) {
            row = { type: 'exact', reason: '본문 일치', cand: newest(sameBody) };
        } else if (sameTK.length) {
            // 여기까지 왔으면 본문은 다름 → 무조건 확인 필요
            const cand = newest(sameTK);
            const tText = normText(t.content);
            let reason = '제목·키 일치 · 본문 다름';
            let score;
            if (cand.text && tText) {
                cand._bg ??= bigrams(cand.text);
                score = dice(bigrams(tText), cand._bg);
                reason = `제목·키 일치 · 본문 ${Math.round(score * 100)}%`;
            }
            row = { type: 'similar', reason, cand, score };
        } else {
            const tText = normText(t.content);
            if (tText.length >= 10) {
                const pool = new Set();
                const titleN = normText(t.comment);
                if (titleN) for (const c of byTitle.get(titleN) || []) pool.add(c);
                for (const k of t.keys) for (const c of byKey.get(normText(k)) || []) pool.add(c);
                let best = null, bestScore = 0;
                const tb = bigrams(tText);
                for (const c of pool) {
                    if (isSelf(c)) continue;
                    const ratio = c.text.length / tText.length;
                    if (ratio < 0.5 || ratio > 2) continue;
                    c._bg ??= bigrams(c.text);
                    const sc = dice(tb, c._bg);
                    if (sc > bestScore) { bestScore = sc; best = c; }
                }
                if (best && bestScore >= SIMILAR_MIN) {
                    row = { type: 'similar', reason: `유사 ${Math.round(bestScore * 100)}%`, cand: best, score: bestScore };
                }
            }
        }
        if (row) { row.target = t; row.targetInfo = ti; rows.push(row); } else unmatched++;
    }
    return { rows, unmatched };
}

async function collectCandidates(sourceWorlds) {
    const cands = [];
    let noInfo = 0;
    for (const src of sourceWorlds) {
        await ensureWorld(src).catch(() => {});
        const entries = worldExists(src) ? await loadWorldEntries(src) : null;
        const byUid = new Map((entries || []).map(e => [e.uid, e]));
        const prefix = `${src}::`;
        for (const [k, tr] of Object.entries(rtData.cache)) {
            if (!k.startsWith(prefix) || !hasTranslation(tr)) continue;
            const uid = k.slice(prefix.length);
            const orig = byUid.get(uid);
            let info = tr.src || null;
            let text = '', titleN = '', keySet = new Set();
            if (orig) {
                const keys = stripAdded(src, uid, orig.keys);
                info ??= srcInfo(orig.content, keys, orig.comment);
                text = normText(orig.content);
                titleN = normText(orig.comment);
                keySet = new Set(keys.map(normText).filter(Boolean));
            }
            if (!info) { noInfo++; continue; }
            cands.push({ world: src, uid, tr, info, text, titleN, keySet, origText: orig?.content || '', origTitle: orig?.comment || '' });
        }
    }
    return { cands, noInfo };
}

function importBody($ov) {
    const $t = $ov.find('.cslt-tab-body');
    return $t.length ? $t : $ov.find('.cslt-modal-body');
}

async function openImportModal() {
    const target = getCurrentWorldName();
    if (!target || target === 'unknown') { toastr.warning('로어북을 먼저 열어줘', EXT_NAME); return; }

    const $ov = openModal({ id: 'cslt-import-overlay', title: '번역 가져오기', icon: 'fa-file-import', wide: true });
    const $mb = $ov.find('.cslt-modal-body').html('<div class="cslt-muted cslt-pad">번역 데이터 불러오는 중...</div>');

    flushAllWorlds();
    await loadAllWorlds();

    const names = allWorldNames();
    if (!names.includes(target)) names.push(target);
    const sources = names.map(w => {
        const prefix = `${w}::`;
        let n = 0;
        for (const [k, v] of Object.entries(rtData.cache)) if (k.startsWith(prefix) && hasTranslation(v)) n++;
        return { name: w, count: n, exists: worldExists(w), self: w === target };
    }).filter(s => s.count > 0)
        .sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name));
    const orphans = findOrphans();

    $mb.empty().append(`
      <div class="cslt-seg cslt-tabs">
        <button type="button" data-tab="import" class="active"><i class="fa-solid fa-file-import"></i><span>로어북에서 가져오기</span></button>
        <button type="button" data-tab="orphan"><i class="fa-solid fa-link-slash"></i><span>주인 없는 번역</span><b class="cslt-tab-count"></b></button>
      </div>
      <div class="cslt-tab-body"></div>`);
    const setCount = (n) => $mb.find('.cslt-tab-count').text(n ? n : '').toggle(!!n);
    setCount(orphans.length);

    const showImport = () => {
        if (!sources.length) {
            importBody($ov).html('<div class="cslt-empty"><i class="fa-solid fa-box-open"></i><div>가져올 번역이 있는 로어북이 없어</div></div>');
            return;
        }
        renderImportStep1($ov, target, sources);
    };
    $mb.find('.cslt-tabs').on('click', 'button', function () {
        $mb.find('.cslt-tabs button').removeClass('active');
        $(this).addClass('active');
        if ($(this).data('tab') === 'orphan') renderOrphanTab($ov, target, orphans, setCount);
        else showImport();
    });
    // 가져올 게 없고 주인 없는 번역만 있으면 그 탭부터
    if (!sources.length && orphans.length) $mb.find('.cslt-tabs [data-tab="orphan"]').trigger('click');
    else showImport();
}

function renderImportStep1($ov, target, sources) {
    const picked = new Set();
    const $body = importBody($ov).empty();
    $body.append($('<div class="cslt-modal-sub">').html(`어느 로어북에서 가져올까? → <b>${esc(target)}</b>`));
    const $search = $('<input type="search" class="text_pole cslt-search" placeholder="로어북 이름 검색">').appendTo($body);
    const $list = $('<div class="cslt-list">').appendTo($body);
    const $foot = $(`
      <div class="cslt-modal-foot">
        <span class="cslt-muted cslt-pick-count">0개 선택</span>
        <button type="button" class="cslt-btn cslt-btn-primary cslt-go" disabled><i class="fa-solid fa-magnifying-glass"></i><span>매칭 찾기</span></button>
      </div>`).appendTo($body);

    const draw = () => {
        const q = normText($search.val());
        const html = sources.filter(s => !q || normText(s.name).includes(q)).map(s => `
          <label class="cslt-row cslt-row-src">
            <input type="checkbox" data-name="${esc(s.name)}" ${picked.has(s.name) ? 'checked' : ''}>
            <div class="cslt-row-main">
              <div class="cslt-row-top"><span class="cslt-row-title">${s.self ? '이 로어북' : esc(s.name)}</span>
                ${s.self ? '<span class="cslt-tag cslt-tag-ok">같은 로어북 중복 항목</span>' : ''}
                ${s.exists ? '' : '<span class="cslt-tag cslt-tag-warn" title="원본 로어북이 없어서 원문 지문이 있는 번역만 매칭돼">원본 없음</span>'}
              </div>
              <div class="cslt-row-sub">번역 ${s.count}개</div>
            </div>
          </label>`).join('');
        $list.html(html || '<div class="cslt-muted cslt-pad">검색 결과 없음</div>');
    };
    const sync = () => {
        $foot.find('.cslt-pick-count').text(`${picked.size}개 선택`);
        $foot.find('.cslt-go').prop('disabled', picked.size === 0);
    };
    $list.on('change', 'input[type=checkbox]', function () {
        const n = String($(this).data('name'));
        if (this.checked) picked.add(n); else picked.delete(n);
        sync();
    });
    $search.on('input', debounce(draw, 120));
    $foot.find('.cslt-go').on('click', async () => {
        const $go = $foot.find('.cslt-go').prop('disabled', true);
        setBtnLabel($go, '찾는 중...');
        try {
            await runImportMatch($ov, target, [...picked], () => renderImportStep1($ov, target, sources));
        } catch (err) {
            console.error(`[${EXT_TAG}] import match failed`, err);
            toastr.error(`매칭 실패: ${err?.message ?? err}`, EXT_NAME);
            setBtnLabel($go, '매칭 찾기');
            $go.prop('disabled', false);
        }
    });
    draw();
    sync();
}

async function runImportMatch($ov, target, sourceWorlds, onBack) {
    const tEntries = await loadWorldEntries(target);
    if (!tEntries) throw new Error('현재 로어북 항목을 못 읽었어');
    const targets = tEntries.map(e => ({ ...e, keys: stripAdded(target, e.uid, e.keys) }));
    const { cands, noInfo } = await collectCandidates(sourceWorlds);
    const matched = matchEntries(targets, cands, target);
    // 같은 로어북끼리는 "번역 없는 항목 채우기"만 — 이미 번역된 항목끼리 서로 덮어쓰지 않게
    const rows = matched.rows.filter(r => !(r.cand.world === target && hasTranslation(rtData.cache[makeKey(target, r.target.uid)])));
    const unmatched = matched.unmatched;

    for (const r of rows) {
        const existing = rtData.cache[makeKey(target, r.target.uid)];
        r.existing = hasTranslation(existing) ? existing : null;
        r.checked = r.type === 'exact' && !r.existing;
        const tr = r.cand.tr;
        r.title = r.target.comment || r.target.content.slice(0, 40) || `#${r.target.uid}`;
        r.snippet = (typeof tr.content === 'string' ? tr.content : (tr.keys || []).join(', ')).replace(/\s+/g, ' ').slice(0, 120);
        r.hay = normText([r.title, r.target.content, tr.content, (tr.keys || []).join(' '), r.target.keys.join(' '), r.cand.world].join(' '));
    }
    renderImportStep2($ov, target, rows, { unmatched, noInfo, total: targets.length }, onBack);
}

function renderImportStep2($ov, target, rows, stats, onBack) {
    const $body = importBody($ov).empty();
    const nExact = rows.filter(r => r.type === 'exact').length;
    const nSimilar = rows.length - nExact;
    const nExisting = rows.filter(r => r.existing).length;

    $body.append(`
      <div class="cslt-stats">
        <span class="cslt-stat cslt-stat-exact"><b>${nExact}</b> 확실</span>
        <span class="cslt-stat cslt-stat-similar"><b>${nSimilar}</b> 확인 필요</span>
        <span class="cslt-stat"><b>${stats.unmatched}</b> 못 찾음</span>
        ${stats.noInfo ? `<span class="cslt-stat" title="원본 로어북이 없고 예전 버전에서 번역해서 원문 지문이 없는 번역"><b>${stats.noInfo}</b> 원문 정보 없음</span>` : ''}
      </div>`);

    if (!rows.length) {
        $body.append('<div class="cslt-empty"><i class="fa-solid fa-face-meh"></i><div>매칭되는 항목이 없어</div></div>');
        $('<div class="cslt-modal-foot"><button type="button" class="cslt-btn cslt-back"><i class="fa-solid fa-arrow-left"></i><span>뒤로</span></button></div>')
            .appendTo($body).find('.cslt-back').on('click', onBack);
        return;
    }

    const $search = $('<input type="search" class="text_pole cslt-search" placeholder="제목·원문·번역문 검색">').appendTo($body);
    const $tools = $(`
      <div class="cslt-tools">
        <div class="cslt-seg cslt-seg-sm cslt-filter">
          <button type="button" data-f="all" class="active">전체 ${rows.length}</button>
          <button type="button" data-f="exact">확실 ${nExact}</button>
          <button type="button" data-f="similar">확인 필요 ${nSimilar}</button>
          ${nExisting ? `<button type="button" data-f="existing">덮어씀 ${nExisting}</button>` : ''}
        </div>
        <div class="cslt-tools-right">
          <button type="button" class="cslt-link" data-sel="1">보이는 것 선택</button>
          <button type="button" class="cslt-link" data-sel="0">해제</button>
        </div>
      </div>`).appendTo($body);
    const $list = $('<div class="cslt-list cslt-list-tall">').appendTo($body);
    const $foot = $(`
      <div class="cslt-modal-foot">
        <label class="checkbox_label cslt-opt"><input type="checkbox" class="cslt-with-keys" ${getSettings().autoAddKoreanKeys ? 'checked' : ''}><span>한글 키워드도 넣기</span></label>
        <div class="cslt-foot-right">
          <button type="button" class="cslt-btn cslt-back"><i class="fa-solid fa-arrow-left"></i><span>뒤로</span></button>
          <button type="button" class="cslt-btn cslt-btn-primary cslt-apply"><i class="fa-solid fa-check"></i><span>적용</span></button>
        </div>
      </div>`).appendTo($body);

    let filter = 'all';
    let visible = [];
    const passes = (r) => filter === 'all' || (filter === 'existing' ? !!r.existing : r.type === filter);

    const draw = () => {
        const q = normText($search.val());
        visible = rows.map((r, i) => i).filter(i => passes(rows[i]) && (!q || rows[i].hay.includes(q)));
        const html = visible.map(i => {
            const r = rows[i];
            const compare = r.type === 'similar' ? `
              <details class="cslt-compare"><summary>원문 비교</summary>
                <div class="cslt-compare-grid">
                  <div><div class="cslt-cap">지금 로어북</div><div class="cslt-compare-text">${esc(r.target.content.slice(0, 600))}</div></div>
                  <div><div class="cslt-cap">${r.cand.world === target ? esc(r.cand.origTitle || `#${r.cand.uid}`) : esc(r.cand.world)}</div><div class="cslt-compare-text">${esc(r.cand.origText.slice(0, 600))}</div></div>
                </div>
              </details>` : '';
            return `
              <div class="cslt-row${r.checked ? ' is-checked' : ''}" data-i="${i}">
                <input type="checkbox" ${r.checked ? 'checked' : ''}>
                <div class="cslt-row-main">
                  <div class="cslt-row-top">
                    <span class="cslt-row-title">${esc(r.title)}</span>
                    <span class="cslt-tag ${r.type === 'exact' ? 'cslt-tag-ok' : 'cslt-tag-warn'}">${esc(r.reason)}</span>
                    ${r.existing ? `<span class="cslt-tag cslt-tag-danger" title="이미 번역이 있어서 덮어써짐">${r.existing.edited ? '수정본 덮어씀' : '덮어씀'}</span>` : ''}
                  </div>
                  <div class="cslt-row-sub">${esc(r.snippet)}</div>
                  <div class="cslt-row-src-name"><i class="fa-solid fa-arrow-right-to-bracket"></i> ${r.cand.world === target ? `이 로어북 · ${esc(r.cand.origTitle || `#${r.cand.uid}`)}` : esc(r.cand.world)}</div>
                  ${compare}
                </div>
              </div>`;
        }).join('');
        $list.html(html || '<div class="cslt-muted cslt-pad">검색 결과 없음</div>');
        syncCount();
    };
    const syncCount = () => {
        const n = rows.filter(r => r.checked).length;
        setBtnLabel($foot.find('.cslt-apply'), `적용 ${n}`);
        $foot.find('.cslt-apply').prop('disabled', n === 0);
    };

    $list.on('click', '.cslt-row', function (e) {
        if ($(e.target).closest('details').length) return;
        const i = Number($(this).data('i'));
        const r = rows[i];
        r.checked = e.target.type === 'checkbox' ? e.target.checked : !r.checked;
        $(this).toggleClass('is-checked', r.checked).children('input').prop('checked', r.checked);
        syncCount();
    });
    $tools.on('click', '.cslt-filter button', function () {
        filter = String($(this).data('f'));
        $tools.find('.cslt-filter button').removeClass('active');
        $(this).addClass('active');
        draw();
    });
    $tools.on('click', '[data-sel]', function () {
        const on = $(this).data('sel') === 1;
        for (const i of visible) rows[i].checked = on;
        draw();
    });
    $search.on('input', debounce(draw, 120));
    $foot.find('.cslt-back').on('click', onBack);
    $foot.find('.cslt-apply').on('click', async () => {
        const chosen = rows.filter(r => r.checked);
        const over = chosen.filter(r => r.existing).length;
        if (over && !confirm(`${chosen.length}개를 가져올게.\n그중 ${over}개는 기존 번역을 덮어써. 괜찮아?`)) return;
        const $btn = $foot.find('.cslt-apply').prop('disabled', true);
        setBtnLabel($btn, '적용 중...');
        try {
            await applyImport(target, chosen, $foot.find('.cslt-with-keys').is(':checked'));
            $ov.remove();
        } catch (err) {
            console.error(`[${EXT_TAG}] import apply failed`, err);
            toastr.error(`가져오기 실패: ${err?.message ?? err}`, EXT_NAME);
            syncCount();
        }
    });
    draw();
}

async function applyImport(world, chosen, withKeys) {
    if (getCurrentWorldName() !== world) throw new Error('그새 로어북이 바뀌었어. 다시 열어줘');
    const keyChanges = [];   // { uid, merged }
    for (const r of chosen) {
        const tr = r.cand.tr;
        const k = makeKey(world, r.target.uid);
        rtData.cache[k] = {
            keys: Array.isArray(tr.keys) ? [...tr.keys] : undefined,
            content: typeof tr.content === 'string' ? tr.content : undefined,
            truncated: !!tr.truncated,
            edited: !!tr.edited,
            importedFrom: r.cand.world,
            src: r.targetInfo,
            savedAt: Date.now(),
        };
        if (withKeys && Array.isArray(tr.keys)) {
            const originals = r.target.keys;   // 이미 우리 한글키 제거된 원래 키
            const origSet = new Set(originals);
            const newAdded = uniq(tr.keys.map(s => String(s).trim()).filter(x => x && !origSet.has(x)));
            if (newAdded.length) rtData.addedKeys[k] = newAdded; else delete rtData.addedKeys[k];
            keyChanges.push({ uid: r.target.uid, merged: [...originals, ...newAdded] });
        }
    }
    flushWorld(world);

    let keyNote = '';
    if (keyChanges.length) {
        const wi = await resolveWI();
        if (wi.load && wi.save) {
            const data = await wi.load(world);
            let n = 0;
            for (const { uid, merged } of keyChanges) {
                const e = data?.entries?.[uid];
                if (e) { e.key = merged; n++; }
            }
            await wi.save(world, data, true);
            if (wi.reload) { try { wi.reload(world); } catch { /* noop */ } }
            keyNote = ` · 키워드 ${n}개 반영`;
        } else {
            keyNote = ' · 키워드는 "저장" 버튼으로 반영해줘';
        }
    }

    document.querySelectorAll('#world_popup .cslt-result-panel').forEach(el => el.remove());
    await restoreCachedTranslations().catch(() => {});
    updateDataSizeDisplay();
    toastr.success(`${chosen.length}개 가져옴${keyNote}`, EXT_NAME, { timeOut: 4000 });
}

/* ===================================================================
 * 이름 변경 감지 (v0.10)
 *  - ST의 "이름 변경" 버튼을 누르는 순간 지금 이름을 기억
 *  - 그 뒤 에디터가 새 이름으로 바뀌고 옛 이름이 목록에서 사라지면 → 확인 받고 옮김
 *  - 놓친 경우는 가져오기 → "주인 없는 번역" 탭에서 처리
 * =================================================================== */
let renameHint = null;   // { from, at }
const RENAME_BTN_SEL = '#world_popup_name_button, #world_popup [title="Rename World Info"], #world_popup [data-i18n*="Rename World Info"]';

function installRenameWatcher() {
    document.addEventListener('click', (e) => {
        if (!(e.target instanceof Element) || !e.target.closest(RENAME_BTN_SEL)) return;
        const from = getCurrentWorldName();
        if (from && from !== 'unknown') renameHint = { from, at: Date.now() };
    }, true);
}

async function checkRename(from, to) {
    if (!renameHint || renameHint.from !== from || Date.now() - renameHint.at > 180000) return;
    renameHint = null;

    // ST가 목록을 갱신할 때까지 잠깐 기다림
    for (let i = 0; i < 15 && worldExists(from); i++) await sleep(200);
    if (worldExists(from)) return;   // 옛 이름이 남아 있음 → 이름 변경 아님

    await ensureWorld(from);
    const stats = await compareWorlds(from, to);
    if (!stats.total) return;

    const lines = [
        '로어북 이름이 바뀐 것 같아',
        `${from}  →  ${to}`,
        '',
        `번역 ${stats.translations}개 · uid 일치 ${stats.uidHit}/${stats.total}` + (stats.srcTotal ? ` · 원문 일치 ${stats.srcHit}/${stats.srcTotal}` : ''),
    ];
    if (stats.conflicts) lines.push(`(새 이름 쪽에 이미 번역 ${stats.conflicts}개 있음 — 그건 안 덮어씀)`);
    lines.push('', '새 이름으로 옮길까?');
    if (!confirm(lines.join('\n'))) {
        toastr.info('나중에 가져오기 → "주인 없는 번역" 탭에서 옮길 수 있어', EXT_NAME, { timeOut: 5000 });
        return;
    }
    try {
        const { moved, skipped } = await migrateWorld(from, to);
        if (getCurrentWorldName() === to) await refreshPanels();
        toastr.success(`번역 ${moved}개 옮김${skipped ? ` (겹쳐서 건너뜀 ${skipped})` : ''}`, EXT_NAME, { timeOut: 4000 });
    } catch (err) {
        console.error(`[${EXT_TAG}] rename migrate failed`, err);
        toastr.error(`옮기기 실패: ${err?.message ?? err}`, EXT_NAME);
    }
}

/* ===================================================================
 * 주인 없는 번역 탭 (v0.10)
 * =================================================================== */
function existingWorldNames() {
    const out = [];
    document.querySelectorAll('#world_editor_select option').forEach(o => {
        const name = o.textContent?.trim();
        if (o.value !== '' && name) out.push(name);
    });
    return out;
}

function countWorld(world) {
    const prefix = `${world}::`;
    let n = 0, keysOnly = 0;
    for (const [k, v] of Object.entries(rtData.cache)) if (k.startsWith(prefix) && hasTranslation(v)) n++;
    for (const k of Object.keys(rtData.addedKeys)) if (k.startsWith(prefix) && !rtData.cache[k]) keysOnly++;
    return { n, keysOnly };
}

function findOrphans() {
    const existing = existingWorldNames();
    if (!existing.length) return [];   // 목록을 못 읽으면 전부 주인 없음으로 보이니까 아예 안 띄움
    const set = new Set(existing);
    return allWorldNames().filter(w => !set.has(w)).map(w => {
        const { n, keysOnly } = countWorld(w);
        return { name: w, count: n, keysOnly, updatedAt: getSettings().fileIndex?.[w]?.updatedAt || 0 };
    }).filter(o => o.count + o.keysOnly > 0).sort((a, b) => b.updatedAt - a.updatedAt);
}

function fmtDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderOrphanTab($ov, target, orphans, onCountChange) {
    const $body = importBody($ov).empty();
    if (!orphans.length) {
        $body.html('<div class="cslt-empty"><i class="fa-solid fa-circle-check"></i><div>주인 없는 번역이 없어</div></div>');
        return;
    }
    $body.append('<div class="cslt-modal-sub">로어북 이름이 바뀌었거나 지워져서 연결이 끊긴 번역이야. 원래 로어북에 다시 연결하면 수정본까지 그대로 돌아와.</div>');
    const $list = $('<div class="cslt-list cslt-list-tall">').appendTo($body);
    const worlds = existingWorldNames();

    const draw = () => {
        $list.html(orphans.map((o, i) => `
          <div class="cslt-orphan" data-i="${i}">
            <div class="cslt-orphan-head">
              <div class="cslt-row-main">
                <div class="cslt-row-top"><span class="cslt-row-title">${esc(o.name)}</span></div>
                <div class="cslt-row-sub">번역 ${o.count}개${o.keysOnly ? ` · 한글키 기록 ${o.keysOnly}개` : ''}${o.updatedAt ? ` · ${fmtDate(o.updatedAt)}` : ''}</div>
              </div>
              <div class="cslt-orphan-btns">
                <button type="button" class="cslt-btn cslt-btn-primary cslt-o-link"><i class="fa-solid fa-link"></i><span>연결</span></button>
                <button type="button" class="cslt-act cslt-act-danger cslt-o-del" title="이 번역 데이터 삭제"><i class="fa-solid fa-trash-can"></i></button>
              </div>
            </div>
            <div class="cslt-orphan-link" hidden>
              <div class="cslt-orphan-row">
                <span class="cslt-muted">연결할 로어북</span>
                <select class="text_pole cslt-o-target">
                  ${worlds.map(w => `<option value="${esc(w)}" ${w === target ? 'selected' : ''}>${esc(w)}</option>`).join('')}
                </select>
              </div>
              <div class="cslt-o-stats cslt-muted">확인 중...</div>
              <div class="cslt-orphan-row cslt-orphan-foot">
                <label class="checkbox_label cslt-opt cslt-o-over-wrap" hidden><input type="checkbox" class="cslt-o-over"><span>겹치는 번역 덮어쓰기</span></label>
                <button type="button" class="cslt-btn cslt-btn-primary cslt-o-go"><i class="fa-solid fa-check"></i><span>옮기기</span></button>
              </div>
            </div>
          </div>`).join(''));
    };

    const showStats = async ($o, o) => {
        const to = String($o.find('.cslt-o-target').val());
        const $s = $o.find('.cslt-o-stats').text('확인 중...');
        const st = await compareWorlds(o.name, to);
        const pct = st.total ? Math.round((st.uidHit / st.total) * 100) : 0;
        const good = pct >= 90 && (!st.srcTotal || st.srcHit / st.srcTotal >= 0.8);
        $s.html(`
          <span class="cslt-tag ${good ? 'cslt-tag-ok' : 'cslt-tag-warn'}">${good ? '같은 로어북 같아' : '확인 필요'}</span>
          uid 일치 <b>${st.uidHit}/${st.total}</b>${st.srcTotal ? ` · 원문 일치 <b>${st.srcHit}/${st.srcTotal}</b>` : ''}${st.conflicts ? ` · 이미 번역 있음 <b>${st.conflicts}</b>` : ''}`);
        $o.find('.cslt-o-over-wrap').prop('hidden', !st.conflicts);
        $o.data('stats', st);
    };

    $list.on('click', '.cslt-o-link', function () {
        const $o = $(this).closest('.cslt-orphan');
        const $l = $o.find('.cslt-orphan-link');
        const open = $l.prop('hidden');
        $l.prop('hidden', !open);
        if (open) showStats($o, orphans[Number($o.data('i'))]);
    });
    $list.on('change', '.cslt-o-target', function () {
        const $o = $(this).closest('.cslt-orphan');
        showStats($o, orphans[Number($o.data('i'))]);
    });
    $list.on('click', '.cslt-o-go', async function () {
        const $o = $(this).closest('.cslt-orphan');
        const i = Number($o.data('i'));
        const o = orphans[i];
        const to = String($o.find('.cslt-o-target').val());
        const st = $o.data('stats');
        if (st && st.total && st.uidHit / st.total < 0.5
            && !confirm(`uid가 ${st.uidHit}/${st.total}개만 맞아. 다른 로어북일 수도 있어.\n그래도 옮길까?`)) return;
        const $btn = $(this).prop('disabled', true);
        setBtnLabel($btn, '옮기는 중...');
        try {
            const { moved, skipped } = await migrateWorld(o.name, to, { overwrite: $o.find('.cslt-o-over').is(':checked') });
            toastr.success(`${o.name} → ${to}: 번역 ${moved}개 옮김${skipped ? ` (겹쳐서 건너뜀 ${skipped})` : ''}`, EXT_NAME, { timeOut: 4000 });
            orphans.splice(i, 1);
            onCountChange(orphans.length);
            if (getCurrentWorldName() === to) await refreshPanels();
            renderOrphanTab($ov, target, orphans, onCountChange);
        } catch (err) {
            console.error(`[${EXT_TAG}] orphan migrate failed`, err);
            toastr.error(`옮기기 실패: ${err?.message ?? err}`, EXT_NAME);
            setBtnLabel($btn, '옮기기');
            $btn.prop('disabled', false);
        }
    });
    $list.on('click', '.cslt-o-del', async function () {
        const $o = $(this).closest('.cslt-orphan');
        const i = Number($o.data('i'));
        const o = orphans[i];
        if (!confirm(`"${o.name}"의 번역 ${o.count}개를 완전히 삭제할까?\n(되돌릴 수 없어 — 필요하면 설정에서 먼저 내보내기)`)) return;
        await purgeWorld(o.name);
        orphans.splice(i, 1);
        onCountChange(orphans.length);
        updateDataSizeDisplay?.();
        toastr.success('삭제됨', EXT_NAME, { timeOut: 2000 });
        renderOrphanTab($ov, target, orphans, onCountChange);
    });
    draw();
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
    loadFont();
    installRenameWatcher();
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
