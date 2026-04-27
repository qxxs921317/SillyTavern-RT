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
    cache: {},
    addedKeys: {}, // renamed from pendingKeys; persists even after save
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
    if (typeof extension_settings[EXT_ID].cache !== 'object') extension_settings[EXT_ID].cache = {};
    if (typeof extension_settings[EXT_ID].addedKeys !== 'object') extension_settings[EXT_ID].addedKeys = {};

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

// ---------- Cache (translation results) ----------
function getCachedTranslation($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return null;
    return getSettings().cache[makeKey(getCurrentWorldName(), uid)] || null;
}

function setCachedTranslation($entry, data) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    getSettings().cache[makeKey(getCurrentWorldName(), uid)] = {
        keys: Array.isArray(data.keys) ? data.keys : undefined,
        content: typeof data.content === 'string' ? data.content : undefined,
        truncated: !!data._truncated,
        savedAt: Date.now(),
    };
    saveSettingsDebounced();
}

function deleteCachedTranslation($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    delete getSettings().cache[makeKey(getCurrentWorldName(), uid)];
    saveSettingsDebounced();
}

function deleteAllCachedForCurrentWorld() {
    const settings = getSettings();
    const prefix = `${getCurrentWorldName()}::`;
    let count = 0;
    for (const k of Object.keys(settings.cache)) {
        if (k.startsWith(prefix)) { delete settings.cache[k]; count++; }
    }
    saveSettingsDebounced();
    return count;
}

// ---------- Added keys (Korean keys we injected — kept even after save) ----------
function setAddedKeys($entry, koreanKeys) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    getSettings().addedKeys[makeKey(getCurrentWorldName(), uid)] = koreanKeys;
    saveSettingsDebounced();
}

function getAddedKeys($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return [];
    return getSettings().addedKeys[makeKey(getCurrentWorldName(), uid)] || [];
}

function clearAddedKeys($entry) {
    const uid = getEntryUid($entry);
    if (!uid) return;
    delete getSettings().addedKeys[makeKey(getCurrentWorldName(), uid)];
    saveSettingsDebounced();
}

function clearAllAddedKeysForCurrentWorld() {
    const settings = getSettings();
    const prefix = `${getCurrentWorldName()}::`;
    for (const k of Object.keys(settings.addedKeys)) {
        if (k.startsWith(prefix)) delete settings.addedKeys[k];
    }
    saveSettingsDebounced();
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

function restoreCachedTranslations() {
    const popup = document.getElementById('world_popup');
    if (!popup) return;
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
        restoreCachedTranslations();
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
