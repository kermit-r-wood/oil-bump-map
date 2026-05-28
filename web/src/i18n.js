// 极简 i18n：字典 + 占位符替换 + localStorage 持久化。
//
// 使用：
//   import { t, getLang, setLang, applyTranslations } from './i18n.js';
//   t('btn.upload');                                     // → 'Upload image' or '上传图片'
//   t('status.done', { dt: '1.23', backend: 'webgl' });
//   setLang('zh');                                       // 切语言（同步触发 applyTranslations）
//
// HTML 端约定：
//   <h1 data-i18n="page.title">Oil-Texture ...</h1>      // 文本走 textContent
//   <input data-i18n-title="tooltip.bitdepth" ...>       // tooltip 走 title 属性
//   <a data-i18n-aria-label="btn.download" ...>          // 任意属性按 data-i18n-attr-* 处理
// applyTranslations() 时一并扫一遍。

const STORAGE_KEY = 'depth_map.lang';
const DEFAULT_LANG = 'en';
const SUPPORTED = ['en', 'zh'];

/** @type {Record<string, Record<string, string>>} */
const LOCALES = {
    en: {
        // <head>
        'page.htmlTitle': 'Oil-Texture Bump Map (UV-Print Ready) — Pure Frontend',
        'page.h1': 'Oil-Texture Bump Map (UV-Print Ready)',
        'page.subtitle': 'Upload an image; a UV-print-ready 16-bit grayscale height map is generated locally. <strong>All computation runs in your browser; the image never leaves your device.</strong>',
        'preset.desc': 'Mode: <strong>scan_replica</strong> — paint-density driven brush field + luminance-driven height bias. Bright textured regions = raised paint, dark textured regions = recessed, smooth regions stay mid-gray.',

        // controls
        'control.output': 'Output:',
        'control.bitdepth.16': '16-bit PNG',
        'control.bitdepth.8': '8-bit PNG',
        'control.simSigma': 'Sim σ:',
        'control.maxSide': 'Max side:',
        'control.backend': 'Backend:',
        'control.backend.auto': 'auto',

        // tooltips
        'tooltip.bitdepth': 'Output bit depth. 16-bit gives smoother gradients in the slicer.',
        'tooltip.simSigma': 'Simulated E1 smoothing σ in pixels. Default 1.0 ≈ smoothing-1. Set 0 to skip preview.',
        'tooltip.maxSide': 'Cap on input long edge. Larger = slower / more memory.',
        'tooltip.backend': 'Compute backend. auto picks WebGL → CPU; unsupported backends are disabled automatically.',

        // buttons
        'btn.upload': 'Upload image',
        'btn.recalc': 'Re-generate',
        'btn.download': 'Download PNG',

        // boxes
        'box.original': 'Original',
        'box.bumpMap': 'Bump map',
        'box.simulated': 'Simulated print',
        'box.simDesc.default': 'Approximation of E1 slicing smoothing.',

        // dynamic status
        'status.processing': 'Processing…',
        'status.decoding': 'Decoding image…',
        'status.encoding': 'Encoding PNG…',
        'status.pipeline': 'pipeline: {W}×{H} @ {bitDepth}-bit · backend={backend}',
        'status.done': 'Done ✓  end-to-end {dt} s · backend={backend}',
        'status.fail': 'Generation failed: {msg}',
        'status.simDesc': 'Simulated E1 smoothing σ={sigma} px (≈ smoothing-{step})',
        'status.workerError': 'Worker error: {message}\n{file}:{line}',
        'status.unavailable': 'unavailable',

        // pipeline stage labels
        'stage.luminance': 'Extracting luminance',
        'stage.orientation': 'Structure tensor',
        'stage.strokes': 'LIC stroke field',
        'stage.paint-density': 'Paint-density mask',
        'stage.compose': 'Composing bump',
        'stage.unsharp': 'Unsharp pre-comp',
        'stage.quantize': 'Quantizing',

        // timings panel
        'timings.backend': 'backend',
        'timings.luminance': 'luminance',
        'timings.orientation': 'orientation',
        'timings.strokes': 'strokes',
        'timings.paintDensity': 'paintDensity',
        'timings.compose': 'compose',
        'timings.unsharp': 'unsharp',
        'timings.quantize': 'quantize',
        'timings.total': 'total',

        // footer
        'footer.note': 'Pure-frontend ES modules · 16-bit PNG via CompressionStream + builtin encoder · Modern Chromium / Firefox / Safari 16.4+',

        // language switcher
        'lang.label': 'Language',
        'lang.en': 'English',
        'lang.zh': '中文',
    },
    zh: {
        'page.htmlTitle': '油画肌理高度图（UV 打印就绪）— 纯前端',
        'page.h1': '油画肌理高度图（UV 打印就绪）',
        'page.subtitle': '上传一张图片，本地生成 UV 打印机用 16-bit 灰度高度图。<strong>所有计算都在你的浏览器里完成，图片不会上传到任何服务器。</strong>',
        'preset.desc': '模式: <strong>scan_replica</strong> — paint-density driven brush field + luminance-driven height bias。亮且有纹理的区域 = 抬升的颜料堆积，暗且有纹理的区域 = 凹陷，平滑区域保持中灰。',

        'control.output': '输出:',
        'control.bitdepth.16': '16-bit PNG',
        'control.bitdepth.8': '8-bit PNG',
        'control.simSigma': 'Sim σ:',
        'control.maxSide': '最大边:',
        'control.backend': '后端:',
        'control.backend.auto': '自动',

        'tooltip.bitdepth': '输出位深，16-bit 在打印机切片软件里有更平滑的过渡。',
        'tooltip.simSigma': '模拟 E1 切片平滑的 σ（像素）。默认 1.0 ≈ smoothing-1。设 0 则跳过预览。',
        'tooltip.maxSide': '输入分辨率上限。超过则按长边缩放，避免内存爆掉/耗时过长。',
        'tooltip.backend': '计算后端。auto 优先 WebGL → CPU；浏览器不支持的会自动禁用。',

        'btn.upload': '上传图片',
        'btn.recalc': '重新生成',
        'btn.download': '下载 PNG',

        'box.original': '原图',
        'box.bumpMap': '高度图',
        'box.simulated': '模拟打印效果',
        'box.simDesc.default': 'E1 切片平滑近似预览。',

        'status.processing': '处理中…',
        'status.decoding': '解码图像…',
        'status.encoding': '编码 PNG…',
        'status.pipeline': 'pipeline: {W}×{H} @ {bitDepth}-bit · backend={backend}',
        'status.done': '完成 ✓  端到端 {dt} s · backend={backend}',
        'status.fail': '生成失败: {msg}',
        'status.simDesc': '模拟 E1 平滑 σ={sigma} px (≈ smoothing-{step})',
        'status.workerError': 'Worker 错误: {message}\n{file}:{line}',
        'status.unavailable': '不可用',

        'stage.luminance': '提取 luminance',
        'stage.orientation': '结构张量',
        'stage.strokes': 'LIC 笔触场',
        'stage.paint-density': 'paint-density mask',
        'stage.compose': '合成 bump',
        'stage.unsharp': 'unsharp 反平滑',
        'stage.quantize': '量化',

        'timings.backend': '后端',
        'timings.luminance': 'luminance',
        'timings.orientation': 'orientation',
        'timings.strokes': 'strokes',
        'timings.paintDensity': 'paintDensity',
        'timings.compose': 'compose',
        'timings.unsharp': 'unsharp',
        'timings.quantize': 'quantize',
        'timings.total': 'total',

        'footer.note': '纯前端 ES modules · 16-bit PNG 通过 CompressionStream + 内置编码器输出 · 现代 Chromium / Firefox / Safari 16.4+ 支持',

        'lang.label': '语言',
        'lang.en': 'English',
        'lang.zh': '中文',
    },
};

/** @returns {string} 'en' or 'zh' */
export function getLang() {
    try {
        const v = localStorage.getItem(STORAGE_KEY);
        if (v && SUPPORTED.includes(v)) return v;
    } catch (_) { /* localStorage 可能被禁 */ }
    return DEFAULT_LANG;
}

/**
 * 设置语言并立即更新 DOM。会触发 'languagechange' CustomEvent on document
 * 让动态 UI（status、timings 面板等）重新渲染。
 *
 * @param {string} lang
 */
export function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
    if (typeof document !== 'undefined') {
        applyTranslations();
        document.dispatchEvent(new CustomEvent('i18nchange', { detail: { lang } }));
    }
}

/**
 * @param {string} key
 * @param {Record<string, string | number>} [vars]
 * @param {string} [lang]   显式指定语言（用于测试或非当前语言查询）；不传则用 getLang()
 * @returns {string}
 */
export function t(key, vars, lang) {
    const targetLang = lang ?? getLang();
    const tmpl = LOCALES[targetLang]?.[key] ?? LOCALES[DEFAULT_LANG][key] ?? key;
    if (!vars) return tmpl;
    return tmpl.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/**
 * 列出指定 lang 下定义的所有 key。给测试 / 调试用。
 * @param {string} lang
 * @returns {string[]}
 */
export function listKeys(lang) {
    return Object.keys(LOCALES[lang] ?? {});
}

/**
 * 扫描 [data-i18n] / [data-i18n-title] / [data-i18n-html] 等属性，更新文案。
 * - data-i18n         → textContent
 * - data-i18n-html    → innerHTML（用于含 <strong> 等标签的字符串）
 * - data-i18n-title   → title 属性（tooltip）
 * - data-i18n-aria-label → aria-label 属性
 */
export function applyTranslations() {
    if (typeof document === 'undefined') return;
    const lang = getLang();
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

    const titleKey = document.documentElement.getAttribute('data-i18n-document-title');
    if (titleKey) document.title = t(titleKey);

    for (const el of document.querySelectorAll('[data-i18n]')) {
        el.textContent = t(el.getAttribute('data-i18n'));
    }
    for (const el of document.querySelectorAll('[data-i18n-html]')) {
        el.innerHTML = t(el.getAttribute('data-i18n-html'));
    }
    for (const el of document.querySelectorAll('[data-i18n-title]')) {
        el.title = t(el.getAttribute('data-i18n-title'));
    }
    for (const el of document.querySelectorAll('[data-i18n-aria-label]')) {
        el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
    }
}

export const SUPPORTED_LANGS = SUPPORTED;
