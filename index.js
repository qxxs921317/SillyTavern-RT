import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const EXT_ID = 'lorebook-translator';
const EXT_NAME = 'Lorebook Translator';

console.log(`[${EXT_NAME}] script file loaded`);

const defaultSettings = {
    profileId: '',
    translateUnit: 'all',
    targetLang: '한국어',
    autoAddKoreanKeys: true,
    maxTokens: 8192,
};

let appReady = false;
let observerActive = false;
let scopedObserver = null;

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
        console.warn(`[${EXT_NAME}] CMRS import failed:`, e?.message);
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

function renderSettings() {
    const settings = getSettings();
    const profiles = getConnectionProfiles();

    const profileOptions = profiles
        .map(p => `<option value="${p.id}" ${p.id === settings.profileId ? 'selected' : ''}>${p.name}</option>`)
        .join('');

    const html = `
    <div class="lbt-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>📖 Lorebook Translator</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <label for="lbt-profile">연결 프로필 (Connection Profile)</label>
          <select id="lbt-profile" class="text_pole">
            <option value="">— 선택 —</option>
            ${profileOptions}
          </select>
          <small style="opacity:.7;">프로필이 안 보이면 Connection Manager에서 먼저 만들어주세요.</small>

          <label for="lbt-unit" style="margin-top:10px;">번역 단위</label>
          <select id="lbt-unit" class="text_pole">
            <option value="all"     ${settings.translateUnit === 'all' ? 'selected' : ''}>항목 전체 (키워드 + 본문)</option>
            <option value="keys"    ${settings.translateUnit === 'keys' ? 'selected' : ''}>키워드만</option>
            <option value="content" ${settings.translateUnit === 'content' ? 'selected' : ''}>본문만</option>
          </select>

          <label for="lbt-target" style="margin-top:10px;">번역 대상 언어</label>
          <input id="lbt-target" type="text" class="text_pole" value="${settings.targetLang}">

          <label for="lbt-maxtokens" style="margin-top:10px;">최대 응답 토큰 (max output tokens)</label>
          <input id="lbt-maxtokens" type="number" class="text_pole" min="512" max="32768" step="512" value="${settings.maxTokens}">
          <small style="opacity:.7;">긴 로어북은 8192 이상 권장. 응답이 잘리면 더 늘리세요.</small>

          <label class="checkbox_label" style="margin-top:10px;">
            <input id="lbt-autoadd" type="checkbox" ${settings.autoAddKoreanKeys ? 'checked' : ''}>
            <span>키워드 번역 결과를 자동으로 keys에 추가</span>
          </label>

          <small style="opacity:.7; display:block; margin-top:8px;">
            본문 번역은 항목 아래 패널에 표시되고 실제 content는 변경되지 않습니다.
          </small>
        </div>
      </div>
    </div>`;

    const $target = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    if ($target.length === 0) {
        console.warn(`[${EXT_NAME}] no extensions_settings target yet`);
        return false;
    }
    if ($target.find('.lbt-settings').length > 0) return true;

    $target.append(html);
    console.log(`[${EXT_NAME}] settings UI appended`);

    $('#lbt-profile').on('change', function () {
        getSettings().profileId = String($(this).val() || '');
        saveSettingsDebounced();
    });
    $('#lbt-unit').on('change', function () {
        getSettings().translateUnit = String($(this).val() || 'all');
        saveSettingsDebounced();
    });
    $('#lbt-target').on('input', function () {
        getSettings().targetLang = String($(this).val() || '한국어');
        saveSettingsDebounced();
    });
    $('#lbt-maxtokens').on('input', function () {
        const v = parseInt($(this).val(), 10);
        if (Number.isFinite(v) && v >= 512) {
            getSettings().maxTokens = v;
            saveSettingsDebounced();
        }
    });
    $('#lbt-autoadd').on('change', function () {
        getSettings().autoAddKoreanKeys = $(this).is(':checked');
        saveSettingsDebounced();
    });
    return true;
}

function refreshProfileDropdown() {
    const settings = getSettings();
    const profiles = getConnectionProfiles();
    const $sel = $('#lbt-profile');
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

function buildPrompt(payload, targetLang) {
    const instr = `You are a translator. Translate the given JSON values into ${targetLang}.
- Preserve the JSON structure and keys EXACTLY.
- Translate ONLY the values.
- For arrays of keywords, return an array of translated single-word/short-phrase keywords (no explanations).
- Output ONLY the JSON. No prose, no code fences.
- Keep the translation as concise as possible while remaining accurate.`;
    return `${instr}\n\nINPUT:\n${JSON.stringify(payload, null, 2)}`;
}

// Try to recover partial data even from truncated JSON
function recoverPartialJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

    // 1. Try strict parse first
    try { return { data: JSON.parse(t), truncated: false }; } catch {}

    // 2. Find {...} block and try strict
    const braceMatch = t.match(/\{[\s\S]*\}/);
    if (braceMatch) {
        try { return { data: JSON.parse(braceMatch[0]), truncated: false }; } catch {}
    }

    // 3. Recovery mode — partial JSON. Extract what we can.
    const recovered = {};

    // Extract keys array (even if cut off mid-content later)
    const keysMatch = t.match(/"keys"\s*:\s*\[([\s\S]*?)\](?=\s*[,}])/);
    if (keysMatch) {
        try {
            recovered.keys = JSON.parse('[' + keysMatch[1] + ']');
        } catch {
            // Try to salvage individual strings
            const strs = keysMatch[1].match(/"((?:[^"\\]|\\.)*)"/g);
            if (strs) recovered.keys = strs.map(s => JSON.parse(s));
        }
    }

    // Extract content string (handle truncation)
    const contentStart = t.search(/"content"\s*:\s*"/);
    if (contentStart !== -1) {
        const afterKey = t.indexOf('"', t.indexOf(':', contentStart) + 1) + 1;
        let endQuote = -1;
        for (let i = afterKey; i < t.length; i++) {
            if (t[i] === '\\') { i++; continue; }
            if (t[i] === '"') { endQuote = i; break; }
        }
        const raw = endQuote === -1
            ? t.slice(afterKey)            // truncated — take rest
            : t.slice(afterKey, endQuote); // complete
        try {
            // Decode escapes by wrapping in quotes for JSON.parse
            recovered.content = JSON.parse('"' + raw.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"');
        } catch {
            recovered.content = raw; // last resort: raw text
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
        console.error(`[${EXT_NAME}] profile request failed`, err);
        toastr.error(`번역 요청 실패: ${err?.message ?? err}`, EXT_NAME);
        return null;
    }
}

async function translateEntry(entryEl) {
    const settings = getSettings();
    const $entry = $(entryEl);

    const $keyInput = $entry.find('textarea[name="key"], input[name="key"]').first();
    const $contentInput = $entry.find('textarea[name="content"]').first();

    const keysRaw = String($keyInput.val() ?? '');
    const content = String($contentInput.val() ?? '');
    const keys = keysRaw.split(',').map(s => s.trim()).filter(Boolean);

    let payload;
    if (settings.translateUnit === 'keys') payload = { keys };
    else if (settings.translateUnit === 'content') payload = { content };
    else payload = { keys, content };

    const $btn = $entry.find('.lbt-translate-btn');
    $btn.prop('disabled', true).text('번역 중...');

    const prompt = buildPrompt(payload, settings.targetLang);
    const raw = await callProfile(prompt, settings.maxTokens);
    $btn.prop('disabled', false).text('🌐 번역');

    if (!raw) return;

    const result = recoverPartialJson(raw);
    if (!result) {
        toastr.error('JSON 파싱 실패. 원본을 패널에 표시합니다.', EXT_NAME);
        showResultPanel($entry, { rawText: raw });
        return;
    }

    const { data, truncated } = result;

    if (truncated) {
        toastr.warning(
            `응답이 잘렸습니다. 복구된 부분만 표시합니다. 설정에서 최대 토큰을 늘려보세요. (현재 ${settings.maxTokens})`,
            EXT_NAME,
            { timeOut: 7000 }
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
}

function showResultPanel($entry, data) {
    let $panel = $entry.find('.lbt-result-panel');
    if ($panel.length === 0) {
        $panel = $(`
            <div class="lbt-result-panel">
              <div class="lbt-result-header">
                <b>번역 결과</b>
                <span class="lbt-result-toggle">접기</span>
              </div>
              <div class="lbt-result-body"></div>
            </div>
        `);
        $entry.append($panel);
        $panel.find('.lbt-result-toggle').on('click', () => {
            const $b = $panel.find('.lbt-result-body');
            $b.toggle();
            $panel.find('.lbt-result-toggle').text($b.is(':visible') ? '접기' : '펼치기');
        });
    }
    const $body = $panel.find('.lbt-result-body').empty();

    if (data._truncated) {
        $('<div class="lbt-warning">⚠️ 응답이 잘려서 일부만 복구됨 (최대 토큰 늘려서 재시도 권장)</div>').appendTo($body);
    }

    if (data.rawText) {
        $('<pre>').text(data.rawText).appendTo($body);
        return;
    }
    if (Array.isArray(data.keys)) {
        $('<div class="lbt-result-section"><b>키워드</b></div>').appendTo($body);
        $('<div class="lbt-result-keys">').text(data.keys.join(', ')).appendTo($body);
    }
    if (typeof data.content === 'string') {
        $('<div class="lbt-result-section"><b>본문</b></div>').appendTo($body);
        $('<div class="lbt-result-content">').text(data.content).appendTo($body);
    }
}

function injectButton(entryEl) {
    const $entry = $(entryEl);
    if ($entry.find('.lbt-translate-btn').length > 0) return;

    const $btn = $('<div class="menu_button lbt-translate-btn" title="이 항목 번역">🌐 번역</div>');
    $btn.on('click', (e) => {
        e.stopPropagation();
        translateEntry(entryEl);
    });
    $entry.prepend($btn);
}

const scanAndInjectDebounced = debounce(() => {
    if (!appReady) return;
    const popup = document.getElementById('world_popup');
    if (!popup) return;
    popup.querySelectorAll('.world_entry').forEach(injectButton);
}, 150);

function startScopedObserver() {
    if (observerActive) return;
    const popup = document.getElementById('world_popup');
    if (!popup) return;

    scopedObserver = new MutationObserver(() => scanAndInjectDebounced());
    scopedObserver.observe(popup, { childList: true, subtree: true });
    observerActive = true;
    console.log(`[${EXT_NAME}] scoped observer attached to #world_popup`);
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
    console.log(`[${EXT_NAME}] APP_READY received`);

    if (!renderSettings()) {
        setTimeout(renderSettings, 500);
    }

    $(document).on('click', '#extensionsMenuButton', () => {
        setTimeout(refreshProfileDropdown, 200);
    });

    watchForWIPopup();
}

jQuery(() => {
    console.log(`[${EXT_NAME}] jQuery ready, waiting for APP_READY...`);
    try {
        if (eventSource && event_types?.APP_READY) {
            eventSource.on(event_types.APP_READY, onAppReady);
        } else {
            setTimeout(onAppReady, 2000);
        }
    } catch (e) {
        console.warn(`[${EXT_NAME}] event hook failed`, e);
        setTimeout(onAppReady, 2000);
    }
});
