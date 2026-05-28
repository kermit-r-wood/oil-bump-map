// 前端 UI 胶水（worker 版 + i18n）。
//
// 流程：
//   1. 文件输入 → ImageBitmap → 缩到 maxSide → ImageData
//   2. 把 RGBA Uint8 的 ArrayBuffer transfer 给 worker，附带后端选择
//   3. worker 走 runner.js → backend.run → 返回 bumpFloat + bumpInt (Transferable)
//   4. encodeGrayPng → Blob → <img>.src + 下载链接
//   5. Sim σ：对收到的 bumpFloat 在主线程再做一次 Gaussian 模糊 + 重新量化 + 编码

import { gaussianBlur } from './filters.js';
import { quantizeToArray } from './postprocess.js';
import { encodeGrayPngBlob } from './png.js';
import { t, getLang, setLang, applyTranslations, SUPPORTED_LANGS } from './i18n.js';

const $ = (id) => document.getElementById(id);
const imageInput = $('imageInput');
const recalcBtn = $('recalcBtn');
const originalBox = $('originalBox');
const originalImage = $('originalImage');
const depthBox = $('depthBox');
const depthImage = $('depthImage');
const depthDownload = $('depthDownload');
const status = $('status');
const statusText = $('statusText');
const errorBox = $('errorBox');
const timingsBox = $('timingsBox');
const bitDepthSelect = $('bitDepth');
const simSigmaInput = $('simSigma');
const maxSideSelect = $('maxSide');
const backendSelect = $('backend');
const simBox = $('simBox');
const simImage = $('simImage');
const simDesc = $('simDesc');

let currentFile = null;
/** @type {{bumpFloat: Float32Array, W: number, H: number} | null} */
let lastResult = null;
let lastDepthUrl = null;
let lastSimUrl = null;
let nextRequestId = 1;
const pending = new Map(); // id → {resolve, reject, onProgress}
let inFlight = false;

// 当前 UI 状态：用 i18n key + vars 的形式存，语言切换时可以重渲染。
let currentStatus = null;     // { key, vars } | { kind: 'stage', stage }
let currentTimingsState = null; // { backend, timings }
let currentSimState = null;   // { sigma, step }
let currentErrorMsg = null;

/* -------------------------------------------------------------------- *
 *  i18n 初始化 + 语言切换器                                             *
 * -------------------------------------------------------------------- */

applyTranslations();

const langSwitcher = document.querySelector('.lang-switcher');
function refreshLangSwitcherActive() {
    const cur = getLang();
    for (const btn of langSwitcher.querySelectorAll('button[data-lang]')) {
        btn.classList.toggle('active', btn.getAttribute('data-lang') === cur);
    }
}
refreshLangSwitcherActive();
langSwitcher.addEventListener('click', (e) => {
    const lang = e.target.getAttribute?.('data-lang');
    if (!lang || !SUPPORTED_LANGS.includes(lang)) return;
    setLang(lang); // 内部会触发 'i18nchange'
});
document.addEventListener('i18nchange', () => {
    refreshLangSwitcherActive();
    rerenderDynamic();
});

/* -------------------------------------------------------------------- *
 *  动态文本（依赖语言）                                                  *
 * -------------------------------------------------------------------- */

function setStatusText(translatedText) {
    status.style.display = 'block';
    statusText.textContent = translatedText;
}
function setStatusKey(key, vars) {
    currentStatus = { key, vars };
    setStatusText(t(key, vars));
}
function setStatusStage(stage) {
    currentStatus = { kind: 'stage', stage };
    const k = `stage.${stage}`;
    setStatusText(t(k));
}
function hideStatus() {
    currentStatus = null;
    status.style.display = 'none';
}

function showError(rawMsg) {
    currentErrorMsg = rawMsg;
    errorBox.style.display = 'block';
    errorBox.textContent = rawMsg;
}
function clearError() {
    currentErrorMsg = null;
    errorBox.style.display = 'none';
    errorBox.textContent = '';
}

function showTimings(backendName, timings) {
    currentTimingsState = { backend: backendName, timings };
    const lines = [`${t('timings.backend')}: ${backendName}`];
    const order = ['luminance', 'orientation', 'strokes', 'paintDensity', 'compose', 'unsharp', 'quantize', 'total'];
    for (const k of order) {
        if (timings[k] != null) {
            const label = t(`timings.${k}`);
            lines.push(`  ${label.padEnd(14)} ${(timings[k]).toFixed(1)} ms`);
        }
    }
    timingsBox.style.display = 'block';
    timingsBox.textContent = lines.join('\n');
}

function showSimDesc(sigma, step) {
    currentSimState = { sigma, step };
    simDesc.textContent = t('status.simDesc', { sigma: sigma.toFixed(1), step });
}

function rerenderDynamic() {
    // 语言切换后把当前 UI 状态用新语言重画一遍
    if (currentStatus) {
        if (currentStatus.kind === 'stage') setStatusStage(currentStatus.stage);
        else setStatusKey(currentStatus.key, currentStatus.vars);
    }
    if (currentTimingsState) showTimings(currentTimingsState.backend, currentTimingsState.timings);
    if (currentSimState && simBox.style.display !== 'none') showSimDesc(currentSimState.sigma, currentSimState.step);
    // backend probe 的 'unavailable' 后缀也得重刷
    refreshBackendOptionLabels();
}

function revokeUrl(u) {
    if (u) try { URL.revokeObjectURL(u); } catch (_) {}
}

/* -------------------------------------------------------------------- *
 *  Worker 通信                                                          *
 * -------------------------------------------------------------------- */

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
worker.addEventListener('error', (e) => {
    showError(t('status.workerError', { message: e.message, file: e.filename, line: e.lineno }));
});
worker.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.probe) {
        applyProbe(msg.probe);
        return;
    }
    const id = msg.id;
    const entry = pending.get(id);
    if (!entry) return;

    if (msg.ok && msg.progress) {
        entry.onProgress?.(msg.progress);
        return;
    }
    pending.delete(id);
    if (!msg.ok) entry.reject(new Error(msg.error || 'worker error'));
    else entry.resolve(msg);
});

function callWorker({ rgbaBuffer, W, H, seed, bitDepth, backend, onProgress }) {
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        worker.postMessage({
            cmd: 'run', id, rgba: rgbaBuffer, W, H, seed, bitDepth, backend,
        }, [rgbaBuffer]);
    });
}

function probeWorker() {
    return new Promise((resolve) => {
        const handler = (e) => {
            if (e.data && e.data.probe) {
                worker.removeEventListener('message', handler);
                resolve(e.data.probe);
            }
        };
        worker.addEventListener('message', handler);
        worker.postMessage({ cmd: 'probe' });
    });
}

let lastProbe = null;
function applyProbe(probe) {
    lastProbe = probe;
    refreshBackendOptionLabels();
}
function refreshBackendOptionLabels() {
    if (!lastProbe) return;
    for (const opt of backendSelect.options) {
        const v = opt.value;
        if (v === 'auto') {
            opt.textContent = t('control.backend.auto');
            continue;
        }
        const baseLabel = { webgl: 'WebGL2', cpu: 'CPU (JS)' }[v] ?? v;
        if (lastProbe[v] === false) {
            opt.disabled = true;
            opt.textContent = `${baseLabel} — ${t('status.unavailable')}`;
        } else if (lastProbe[v] === true) {
            opt.disabled = false;
            opt.textContent = baseLabel;
        }
    }
}

/* -------------------------------------------------------------------- *
 *  图像 IO                                                              *
 * -------------------------------------------------------------------- */

async function fileToImageData(file, maxSidePx) {
    const bitmap = await createImageBitmap(file);
    let { width: W, height: H } = bitmap;
    const longest = Math.max(W, H);
    if (longest > maxSidePx) {
        const s = maxSidePx / longest;
        W = Math.max(1, Math.round(W * s));
        H = Math.max(1, Math.round(H * s));
    }
    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(W, H);
    } else {
        canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, W, H);
    bitmap.close?.();
    return ctx.getImageData(0, 0, W, H);
}

/* -------------------------------------------------------------------- *
 *  主流程                                                               *
 * -------------------------------------------------------------------- */

async function generate() {
    if (!currentFile || inFlight) return;
    inFlight = true;
    clearError();
    depthBox.style.display = 'none';
    simBox.style.display = 'none';
    timingsBox.style.display = 'none';

    try {
        setStatusKey('status.decoding');
        await new Promise((r) => requestAnimationFrame(r));

        const maxSidePx = parseInt(maxSideSelect.value, 10) || 2048;
        const imageData = await fileToImageData(currentFile, maxSidePx);
        const W = imageData.width;
        const H = imageData.height;
        const bitDepth = parseInt(bitDepthSelect.value, 10) === 8 ? 8 : 16;
        const backend = backendSelect.value;

        setStatusKey('status.pipeline', { W, H, bitDepth, backend });
        await new Promise((r) => requestAnimationFrame(r));

        const rgbaBuffer = imageData.data.buffer;

        const t0 = performance.now();
        const result = await callWorker({
            rgbaBuffer, W, H,
            seed: 1234, bitDepth, backend,
            onProgress: (s) => setStatusStage(s),
        });
        const dt = performance.now() - t0;

        const bumpFloat = new Float32Array(result.bumpFloat);
        const bumpInt = result.intDtype === 'u16'
            ? new Uint16Array(result.bumpInt)
            : new Uint8Array(result.bumpInt);
        lastResult = { bumpFloat, W, H };

        setStatusKey('status.encoding');
        await new Promise((r) => requestAnimationFrame(r));
        const blob = await encodeGrayPngBlob(bumpInt, W, H, bitDepth);
        revokeUrl(lastDepthUrl);
        lastDepthUrl = URL.createObjectURL(blob);
        depthImage.src = lastDepthUrl;
        depthDownload.href = lastDepthUrl;
        depthDownload.download = `bump_scan_replica_${result.backend}_${bitDepth}bit.png`;
        depthBox.style.display = 'flex';

        await refreshSimPreview();

        showTimings(result.backend, { ...result.timings });
        setStatusKey('status.done', { dt: (dt / 1000).toFixed(2), backend: result.backend });
        setTimeout(hideStatus, 2500);
    } catch (e) {
        console.error(e);
        showError(t('status.fail', { msg: e.message ?? e }) + '\n' + (e.stack ?? ''));
        hideStatus();
    } finally {
        inFlight = false;
    }
}

async function refreshSimPreview() {
    if (!lastResult) return;
    const sigma = parseFloat(simSigmaInput.value);
    if (!Number.isFinite(sigma) || sigma <= 0) {
        simBox.style.display = 'none';
        currentSimState = null;
        return;
    }
    try {
        const { bumpFloat, W, H } = lastResult;
        const blurred = gaussianBlur(bumpFloat, W, H, sigma);
        const bitDepth = parseInt(bitDepthSelect.value, 10) === 8 ? 8 : 16;
        const intArr = quantizeToArray(blurred, bitDepth);
        const blob = await encodeGrayPngBlob(intArr, W, H, bitDepth);
        revokeUrl(lastSimUrl);
        lastSimUrl = URL.createObjectURL(blob);
        simImage.src = lastSimUrl;
        const step = Math.max(1, Math.round(sigma));
        showSimDesc(sigma, step);
        simBox.style.display = 'flex';
    } catch (e) {
        console.warn('sim preview failed:', e);
    }
}

/* -------------------------------------------------------------------- *
 *  事件绑定                                                             *
 * -------------------------------------------------------------------- */

imageInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    currentFile = file;
    if (originalImage.src && originalImage.src.startsWith('blob:')) revokeUrl(originalImage.src);
    originalImage.src = URL.createObjectURL(file);
    originalBox.style.display = 'flex';
    recalcBtn.style.display = 'inline-block';
    generate();
});
recalcBtn.addEventListener('click', generate);
bitDepthSelect.addEventListener('change', generate);
maxSideSelect.addEventListener('change', generate);
backendSelect.addEventListener('change', generate);
simSigmaInput.addEventListener('change', refreshSimPreview);

probeWorker().then(applyProbe).catch((e) => console.warn('probe failed:', e));
