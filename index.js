import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const EXT_ID = 'lorebook-translator';
const EXT_NAME = 'Cherry&Solti Lorebook Translator';
const EXT_TAG = 'CSLT'; // for console logs

console.log(`[${EXT_TAG}] script file loaded`);

const defaultSettings = {
    profileId: '',
    translateUnit: 'all',
    targetLang: '한국어',
    autoAddKoreanKeys: true,
    maxTokens: 8192,
    bulkSkipTranslated: true,
    bulkDelayMs: 500,
};

let appReady = false;
let observerActive = false;
let scopedObserver = null;

// Bulk translation state
let bulkState = {
    running: false,
    paused: false,
    cancelled: false,
    total: 0,
    done: 0,
    failed: 0,
};

function getSettings() {
    if (!extension_settings[EXT_ID]) {
        extension_settings[EXT_ID] = structuredClone(defaultSettings);
    }
    for (const k of Object.keys(defaultSettings)) {
        if (extension_settings[EXT_ID][k] === undefined) {
            extension_settings[EXT_ID][k] = defaultSettings[k];
        }
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

function debounce(fn, ms) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ---------- Settings UI ----------
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
          <small style="opacity:.7;">긴 항목은 8192 이상 권장. 응답이 잘리면 더 늘리세요.</small>

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
          <small style="opacity:.7;">레이트 리밋 방지용. Flash는 보통 500ms 정도로 충분.</small>

          <small style="opacity:.7; display:block; margin-top:8px;">
            본문 번역은 항목 아래 패널에 표시되고 실제 content는 변경되지 않습니다.
          </small>
        </div>
      </div>
    </div>`;

    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if ($target.length === 0) {
        console.warn(`[${EXT_TAG}] no extensions_settings target yet`);
        return false;
    }
    if ($target.find('.cslt-settings').length > 0) return true;

    $target.append(html);
    console.log(`[${EXT_TAG}] settings UI appended`);

    $('#cslt-profile').on('change', function () {
        getSettings().profileId = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#cslt-unit').on('change', function () {
        getSettings().translateUnit = String($(this).val() || 'all');
        saveSettingsDebounced();
    });
    $('#cslt-target').on('input', function () {
        getSettings().targetLang = String($(this).val() || '한국어');
        saveSettingsDebounced();
    });
    $('#cslt-maxtokens').on('input', function () {
        const v = parseInt($(this).val(), 10);
        if (Number.isFinite(v) && v >= 512) {
            getSettings().maxTokens = v;
            saveSettingsDebounced();
        }
    });
    $('#cslt-autoadd').on('change', function () {
        getSettings().autoAddKoreanKeys = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#cslt-bulk-skip').on('change', function () {
        getSettings().bulkSkipTranslated = $(this).is(':checked');
        saveSettingsDebounced();
    });
    $('#cslt-bulk-delay').on('input', function () {
        const v = parseInt($(this).val(), 10);
        if (Number.isFinite(v) && v >= 0) {
            getSettings().bulkDelayMs = v;
            saveSettingsDebounced();
        }
    });
    return true;
}

function refreshProfileDropdown() {
    const settings = getSettings();
    const profiles = getConnectionProfiles();
    const $sel = $('#cslt-profile');
    if ($sel.length === 0) return;
    const current = String($sel.val() || settings.profileId || '');
    $sel.empty();
    $sel.append('<option value="">— 선택 —</option>');
    for (const p of profiles) {
        const opt = $('<option>').val(p.id).text(p.name);
        if (p.id === current) opt.attr('selected', 'selected');
        $sel.append(opt);
    }
}

// ---------- Translation core ----------
function buildPrompt(payload, targetLang) {
    const instr = `You are a translator. Translate the given JSON values into ${targetLang}.
- Preserve the JSON structure and keys EXACTLY.
- Translate ONLY the values.
- For arrays of keywords, return an array of translated single-word/short-phrase keywords (no explanations).
- Output ONLY the JSON. No prose, no code fences.
- Keep the translation as concise as possible while remaining accurate.`;
    return `${instr}\n\nINPUT:\n${JSON.stringify(payload, null, 2)}`;
}

function recoverPartialJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    try { return { data: JSON.parse(t), truncated: false }; } catch {}

    const braceMatch = t.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try { return { data: JSON.parse(braceMatch[0]), truncated: false }; } catch {}
    }

    const recovered = {};
    const keysMatch = t.match(/"keys"\s*:\s*\[([\s\S]*?)\](?=\s*[,}])/);
    if (keysMatch) {
        try {
            recovered.keys = JSON.parse('[' + keysMatch[1] + ']');
        } catch {
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
        try {
            recovered.content = JSON.parse('"' + raw.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"');
        } catch {
            recovered.content = raw;
        }
    }

    if (Object.keys(recovered).length > 0) {
        return { data: recovered, truncated: true };
    }
    return null;
}

async function callProfile(prompt, maxTokens) {
    const settings = getSettings();
    if (!settings.profileId) {
        toastr.warning('연결 프로필을 먼저 선택하세요.', EXT_NAME);
        return null;
    }
    const CMRS = await resolveCMRS();
    if (!CMRS) {
        toastr.error('ConnectionManagerRequestService를 찾을 수 없습니다.', EXT_NAME);
        return null;
    }
    try {
        const result = await CMRS.sendRequest(settings.profileId, prompt, maxTokens);
        if (typeof result === 'string') return result;
        if (result?.content) return result.content;
        return String(result ?? '');
    } catch (err) {
        console.error(`[${EXT_TAG}] profile request failed`, err);
        throw err;
    }
}

// Translate a single entry. Returns {success, truncated} for bulk reporting.
async function translateEntry(entryEl, opts = {}) {
    const settings = getSettings();
    const $entry = $(entryEl);
    const silent = !!opts.silent;

    const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
    const $contentInput = $entry.find('textarea[name="content"]').first();

    const keysRaw = String($keyInput.val() ?? '');
    const content = String($contentInput.val() ?? '');
    const keys = keysRaw.split(',').map(s => s.trim()).filter(Boolean);

    let payload;
    if (settings.translateUnit === 'keys') payload = { keys };
    else if (settings.translateUnit === 'content') payload = { content };
    else payload = { keys, content };

    const $btn = $entry.find('.cslt-translate-btn');
    if (!silent) $btn.addClass('cslt-loading').attr('title', '번역 중...');

    let raw;
    try {
        raw = await callProfile(buildPrompt(payload, settings.targetLang), settings.maxTokens);
    } catch (err) {
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
        if (!silent) toastr.error('JSON 파싱 실패. 원본을 패널에 표시합니다.', EXT_NAME);
        showResultPanel($entry, { rawText: raw });
        return { success: false, truncated: false };
    }

    const { data, truncated } = result;

    if (truncated && !silent) {
        toastr.warning(
            `응답이 잘렸습니다. 복구된 부분만 표시. 토큰을 늘려보세요. (현재 ${settings.maxTokens})`,
            EXT_NAME, { timeOut: 7000 }
        );
    }

    if ((settings.translateUnit === 'keys' || settings.translateUnit === 'all')
        && Array.isArray(data.keys) && settings.autoAddKoreanKeys) {
        const merged = Array.from(new Set([
            ...keys,
            ...data.keys.map(s => String(s).trim()).filter(Boolean),
        ]));
        $keyInput.val(merged.join(', ')).trigger('input');
    }

    showResultPanel($entry, { ...data, _truncated: truncated });
    return { success: true, truncated };
}

function showResultPanel($entry, data) {
    let $panel = $entry.find('.cslt-result-panel');
    if ($panel.length === 0) {
        $panel = $(`
            <div class="cslt-result-panel">
              <div class="cslt-result-header">
                <b>🍒 번역 결과</b>
                <span class="cslt-result-toggle">접기</span>
              </div>
              <div class="cslt-result-body"></div>
            </div>
        `);
        // append at end of the entry form (after the drawer content)
        $entry.append($panel);
        $panel.find('.cslt-result-toggle').on('click', () => {
            const $b = $panel.find('.cslt-result-body');
            $b.toggle();
            $panel.find('.cslt-result-toggle').text($b.is(':visible') ? '접기' : '펼치기');
        });
    }
    const $body = $panel.find('.cslt-result-body').empty();

    if (data._truncated) {
        $('<div class="cslt-warning">⚠️ 응답이 잘려서 일부만 복구됨 (최대 토큰 늘려서 재시도 권장)</div>').appendTo($body);
    }

    if (data.rawText) {
        $('<pre>').text(data.rawText).appendTo($body);
        return;
    }
    if (Array.isArray(data.keys)) {
        $('<div class="cslt-result-section"><b>키워드</b></div>').appendTo($body);
        $('<div class="cslt-result-keys">').text(data.keys.join(', ')).appendTo($body);
    }
    if (typeof data.content === 'string') {
        $('<div class="cslt-result-section"><b>본문</b></div>').appendTo($body);
        $('<div class="cslt-result-content">').text(data.content).appendTo($body);
    }
}

// ---------- Per-entry button injection ----------
// Place button next to delete_entry_button to match other header icons
function injectButton(entryEl) {
    const $entry = $(entryEl);
    if ($entry.find('.cslt-translate-btn').length > 0) return;

    const $btn = $(`<i class="menu_button cslt-translate-btn fa-solid interactable"
                       title="이 항목 번역 (Cherry&Solti)"
                       tabindex="0" role="button">🍒</i>`);
    $btn.on('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        translateEntry(entryEl);
    });

    // Try to insert before move_entry_button (so order: 🍒 ↔ 📋 🗑️)
    const $moveBtn = $entry.find('.move_entry_button').first();
    if ($moveBtn.length) {
        $moveBtn.before($btn);
    } else {
        // Fallback: append to header
        const $header = $entry.find('.inline-drawer-header').first();
        if ($header.length) $header.append($btn);
        else $entry.prepend($btn);
    }
}

// ---------- Bulk translation ----------
function getAllEntries() {
    const popup = document.getElementById('world_popup');
    if (!popup) return [];
    return Array.from(popup.querySelectorAll('.world_entry'));
}

function entryAlreadyTranslated($entry) {
    return $entry.find('.cslt-result-panel').length > 0;
}

function buildBulkOverlay() {
    if ($('#cslt-bulk-overlay').length) return $('#cslt-bulk-overlay');
    const $overlay = $(`
        <div id="cslt-bulk-overlay">
          <div class="cslt-bulk-modal">
            <div class="cslt-bulk-header">
              🍒 전체 번역 진행 중
            </div>
            <div class="cslt-bulk-progress-wrap">
              <div class="cslt-bulk-progress-bar"></div>
            </div>
            <div class="cslt-bulk-stats">
              <span class="cslt-bulk-status">준비 중...</span>
            </div>
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
        bulkState.cancelled = true;
        bulkState.paused = false; // unfreeze loop so it can exit
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
    if (bulkState.running) {
        toastr.info('이미 진행 중입니다.', EXT_NAME);
        return;
    }
    const settings = getSettings();
    if (!settings.profileId) {
        toastr.warning('연결 프로필을 먼저 선택하세요.', EXT_NAME);
        return;
    }

    let entries = getAllEntries();
    if (settings.bulkSkipTranslated) {
        entries = entries.filter(el => !entryAlreadyTranslated($(el)));
    }

    if (entries.length === 0) {
        toastr.info('번역할 항목이 없습니다.', EXT_NAME);
        return;
    }

    if (!confirm(`${entries.length}개 항목을 번역합니다.\n호출 간격 ${settings.bulkDelayMs}ms, 예상 소요 약 ${Math.ceil(entries.length * (1.5 + settings.bulkDelayMs / 1000))}초.\n계속하시겠습니까?`)) {
        return;
    }

    bulkState = {
        running: true, paused: false, cancelled: false,
        total: entries.length, done: 0, failed: 0,
    };

    const $overlay = buildBulkOverlay();
    $overlay.show();
    updateBulkOverlay();

    for (let i = 0; i < entries.length; i++) {
        // Wait while paused (and bail if cancelled)
        while (bulkState.paused && !bulkState.cancelled) {
            await sleep(200);
        }
        if (bulkState.cancelled) break;

        const entryEl = entries[i];
        if (!document.body.contains(entryEl)) {
            // entry was removed from DOM; skip
            bulkState.done++;
            updateBulkOverlay();
            continue;
        }

        try {
            const res = await translateEntry(entryEl, { silent: true });
            if (!res.success) bulkState.failed++;
        } catch (err) {
            console.error(`[${EXT_TAG}] bulk item failed`, err);
            bulkState.failed++;
        }

        bulkState.done++;
        updateBulkOverlay();

        if (i < entries.length - 1 && settings.bulkDelayMs > 0) {
            await sleep(settings.bulkDelayMs);
        }
    }

    const finalMsg = bulkState.cancelled
        ? `취소됨: ${bulkState.done}/${bulkState.total} 완료, 실패 ${bulkState.failed}`
        : `완료: ${bulkState.done}/${bulkState.total} (실패 ${bulkState.failed})`;
    toastr.success(finalMsg, EXT_NAME, { timeOut: 5000 });

    bulkState.running = false;
    setTimeout(() => $overlay.hide(), 1500);
}

// ---------- Bulk button injection (top of WI popup) ----------
function injectBulkButton() {
    const popup = document.getElementById('world_popup');
    if (!popup) return;
    if (popup.querySelector('#cslt-bulk-btn')) return;

    // Find a sensible host. Try common WI toolbar locations, fallback to popup header.
    const candidates = [
        '#world_popup_entries_list', // entries container
        '.world_entry_form_control',
        '#WIEntryListHeader',
    ];
    let host = null;
    for (const sel of candidates) {
        const el = popup.querySelector(sel);
        if (el) { host = el; break; }
    }
    // Use a floating button anchored to top-right of #world_popup
    const $btn = $(`<div id="cslt-bulk-btn" class="menu_button" title="🍒 전체 항목 번역 (Cherry&Solti)">🍒 전체 번역</div>`);
    $btn.on('click', startBulkTranslate);
    $(popup).prepend($btn);
}

// ---------- Observer setup ----------
const scanAndInjectDebounced = debounce(() => {
    if (!appReady) return;
    const popup = document.getElementById('world_popup');
    if (!popup) return;
    popup.querySelectorAll('.world_entry').forEach(injectButton);
    injectBulkButton();
}, 150);

function startScopedObserver() {
    if (observerActive) return;
    const popup = document.getElementById('world_popup');
    if (!popup) return;

    scopedObserver = new MutationObserver(() => scanAndInjectDebounced());
    scopedObserver.observe(popup, { childList: true, subtree: true });
    observerActive = true;
    console.log(`[${EXT_TAG}] scoped observer attached`);
    scanAndInjectDebounced();
}

function watchForWIPopup() {
    $(document).on('click', '#WIDrawerIcon, #WI-management, [data-extension-name="world-info"]', () => {
        setTimeout(startScopedObserver, 300);
    });

    let tries = 0;
    const interval = setInterval(() => {
        tries++;
        if (observerActive || tries > 60) {
            clearInterval(interval);
            return;
        }
        if (document.getElementById('world_popup')) {
            startScopedObserver();
            clearInterval(interval);
        }
    }, 500);
}

function onAppReady() {
    if (appReady) return;
    appReady = true;
    console.log(`[${EXT_TAG}] APP_READY received`);

    if (!renderSettings()) {
        setTimeout(renderSettings, 500);
    }

    $(document).on('click', '#extensionsMenuButton', () => {
        setTimeout(refreshProfileDropdown, 200);
    });

    watchForWIPopup();
}

jQuery(() => {
    console.log(`[${EXT_TAG}] jQuery ready, waiting for APP_READY...`);
    try {
        if (eventSource && event_types?.APP_READY) {
            eventSource.on(event_types.APP_READY, onAppReady);
        } else {
            setTimeout(onAppReady, 2000);
        }
    } catch (e) {
        console.warn(`[${EXT_TAG}] event hook failed`, e);
        setTimeout(onAppReady, 2000);
    }
});
