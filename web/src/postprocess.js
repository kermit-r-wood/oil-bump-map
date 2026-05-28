// Unsharp 预补偿 + 8/16-bit 量化（PNG 数据生产侧）。
//
// 移植自 pipeline/postprocess.py。
// 输入约定：bump 是 float，居中在 0，大致在 [-0.5, 0.5]。

import { gaussianBlur } from './filters.js';

/**
 * Y = X + α (X − Gauss_σ(X))
 *
 * @param {Float32Array} bump
 * @param {number} W
 * @param {number} H
 * @param {object} [opts]
 * @param {number} [opts.sigma=1.0]
 * @param {number} [opts.alpha=0.5]
 * @returns {Float32Array}
 */
export function precompensateForPrinter(bump, W, H, opts = {}) {
    const sigma = opts.sigma ?? 1.0;
    const alpha = opts.alpha ?? 0.5;
    if (alpha === 0.0 || sigma <= 0.0) return bump.slice();

    const blurred = gaussianBlur(bump, W, H, sigma);
    const N = bump.length;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        out[i] = bump[i] + alpha * (bump[i] - blurred[i]);
    }
    return out;
}

/**
 * 把居中 float bump → uint16 / uint8 整数数组（用于 PNG 编码）。
 * 输入先 clip 到 [-0.5, 0.5]，平移到 [0, 1]，再缩放到目标位深。
 *
 * @param {Float32Array} bump
 * @param {8 | 16} bitDepth
 * @returns {Uint8Array | Uint16Array}
 */
export function quantizeToArray(bump, bitDepth = 16) {
    if (bitDepth !== 8 && bitDepth !== 16) {
        throw new Error(`bitDepth must be 8 or 16, got ${bitDepth}`);
    }
    const N = bump.length;
    const max = bitDepth === 16 ? 65535 : 255;
    const out = bitDepth === 16 ? new Uint16Array(N) : new Uint8Array(N);
    for (let i = 0; i < N; i++) {
        let v = bump[i];
        if (v < -0.5) v = -0.5;
        else if (v > 0.5) v = 0.5;
        const shifted = v + 0.5; // [0, 1]
        let q = (shifted * max + 0.5) | 0;
        if (q < 0) q = 0;
        else if (q > max) q = max;
        out[i] = q;
    }
    return out;
}
