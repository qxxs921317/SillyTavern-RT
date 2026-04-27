import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const EXT_ID = 'lorebook-translator';
const EXT_NAME = 'Lorebook Translator';

console.log(`[${EXT_NAME}] script file loaded`); // top-level marker

const defaultSettings = {
    profileId: '',
    translateUnit: 'all',
    targetLang: '한국어',
    autoAddKoreanKeys: true,
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

// Lazy resolve at call time so a missing path doesn't kill the whole extension at load
async function resolveCMRS() {
    if (window.ConnectionManagerRequestService) return window.ConnectionManagerRequestService;
    try {
        const ctx = getContext?.();
        if (ctx?.ConnectionManagerRequestService) return ctx.ConnectionManagerRequestService;
    } catch {}
    const candidates = [
        '/scripts/extensions/shared.js',
        '../../shared.js',
        '../../../shared.js',
        '../../../scripts/extensions/shared.js',
    ];
    for (const path of candidates) {
        try {
            const mod = await import(path);
            if (mod?.ConnectionManagerRequestService) {
                window.ConnectionManagerRequestService = mod.ConnectionManagerRequestService;
                console.log(`[${EXT_NAME}] resolved CMRS via ${path}`);
                return mod.ConnectionManagerRequestService;
            }
        } catch {}
    }
    return null;
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
        console.warn(`[${EXT_NAME}] no #extensions_settings target found`);
        return;
    }
    $target.append(html);
    console.log(`[${EXT_NAME}] settings UI appended to`, $target.attr('id'));

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
    $('#lbt-autoadd').on('change', function () {
        getSettings().autoAddKoreanKeys = $(this).is(':checked');
        saveSettingsDebounced();
    });
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
- Output ONLY the JSON. No prose, no code fences.`;
    return `${instr}\n\nINPUT:\n${JSON.stringify(payload, null, 2)}`;
}

function safeParseJson(text) {
    if (!text) return null;
    let t = String(text).trim();
    t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try { return JSON.parse(t); } catch {}
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
        try { return JSON.parse(m[0]); } catch {}
    }
    return null;
}

async function callProfile(prompt) {
    const settings = getSettings();
    if (!settings.profileId) {
        toastr.warning('연결 프로필을 먼저 선택하세요.', EXT_NAME);
        return null;
    }
    const CMRS = await resolveCMRS();
    if (!CMRS) {
        toastr.error('ConnectionManagerRequestService를 찾을 수 없습니다. 콘솔을 확인하세요.', EXT_NAME);
        return null;
    }
    try {
        const result = await CMRS.sendRequest(settings.profileId, prompt, 1024);
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
    const raw = await callProfile(prompt);
    $btn.prop('disabled', false).text('🌐 번역');

    if (!raw) return;

    const parsed = safeParseJson(raw);
    if (!parsed) {
        toastr.error('JSON 파싱 실패. 원본을 패널에 표시합니다.', EXT_NAME);
        showResultPanel($entry, { rawText: raw });
        return;
    }

    if ((settings.translateUnit === 'keys' || settings.translateUnit === 'all')
        && Array.isArray(parsed.keys) && settings.autoAddKoreanKeys) {
        const merged = Array.from(new Set([
            ...keys,
            ...parsed.keys.map(s => String(s).trim()).filter(Boolean),
        ]));
        $keyInput.val(merged.join(', ')).trigger('input');
    }

    showResultPanel($entry, parsed);
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

function scanAndInject() {
    const entries = document.querySelectorAll('.world_entry');
    entries.forEach(injectButton);
    refreshProfileDropdown();
}

jQuery(async () => {
    console.log(`[${EXT_NAME}] init starting...`);
    try {
        renderSettings();
    } catch (e) {
        console.error(`[${EXT_NAME}] renderSettings failed`, e);
    }

    const obs = new MutationObserver(() => scanAndInject());
    obs.observe(document.body, { childList: true, subtree: true });
    scanAndInject();

    console.log(`[${EXT_NAME}] loaded ✓`);
});
