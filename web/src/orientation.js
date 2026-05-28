// RGB 结构张量 → 每像素 (theta, coherence)。
//
// 移植自 pipeline/orientation.py。算法：
//   1. RGB → Rec.601 luminance。
//   2. (可选) 对 luminance 做 Gaussian 高通：lum = lum - blur(lum, σ_hp)。
//      这样大尺度的 silhouette 边缘不会主导方向场。
//   3. Sobel 求 Ix, Iy。
//   4. 对 Ix*Ix, Iy*Iy, Ix*Iy 做 Gaussian smoothing (σ)。
//   5. 解 2x2 特征值得到主方向 θ（边缘切线，与梯度垂直）以及 coherence。

import { gaussianBlur, sobelX, sobelY } from './filters.js';

/**
 * RGBA Uint8 缓冲（来自 ImageData）→ 行主序 Float32Array luminance ∈ [0, 1]。
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba  长度 = W*H*4
 * @param {number} W
 * @param {number} H
 * @returns {Float32Array}
 */
export function rgbaToLuminance(rgba, W, H) {
    const N = W * H;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const r = rgba[i * 4];
        const g = rgba[i * 4 + 1];
        const b = rgba[i * 4 + 2];
        out[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
    }
    return out;
}

/**
 * @param {Float32Array} lumIn  luminance ∈ [0, 1]
 * @param {number} W
 * @param {number} H
 * @param {object} opts
 * @param {number} [opts.sigma=2.0]
 * @param {number} [opts.preHighpassSigma=0.0]
 * @returns {{theta: Float32Array, coherence: Float32Array}}
 */
export function structureTensorOrientation(lumIn, W, H, opts = {}) {
    const sigma = opts.sigma ?? 2.0;
    const preHighpassSigma = opts.preHighpassSigma ?? 0.0;

    let lum = lumIn;
    if (preHighpassSigma > 0.0) {
        const blurred = gaussianBlur(lum, W, H, preHighpassSigma);
        const hp = new Float32Array(lum.length);
        for (let i = 0; i < lum.length; i++) hp[i] = lum[i] - blurred[i];
        lum = hp;
    }

    const Ix = sobelX(lum, W, H);
    const Iy = sobelY(lum, W, H);

    const N = W * H;
    const Jxx_raw = new Float32Array(N);
    const Jyy_raw = new Float32Array(N);
    const Jxy_raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const ix = Ix[i];
        const iy = Iy[i];
        Jxx_raw[i] = ix * ix;
        Jyy_raw[i] = iy * iy;
        Jxy_raw[i] = ix * iy;
    }

    const Jxx = gaussianBlur(Jxx_raw, W, H, sigma);
    const Jyy = gaussianBlur(Jyy_raw, W, H, sigma);
    const Jxy = gaussianBlur(Jxy_raw, W, H, sigma);

    const theta = new Float32Array(N);
    const coherence = new Float32Array(N);
    const eps = 1e-8;
    const HALF_PI = Math.PI / 2;
    const PI = Math.PI;

    for (let i = 0; i < N; i++) {
        const xx = Jxx[i];
        const yy = Jyy[i];
        const xy = Jxy[i];
        const trace = xx + yy;
        const diff = xx - yy;
        const delta = Math.sqrt(diff * diff + 4.0 * xy * xy);
        const lam1 = 0.5 * (trace + delta);
        const lam2 = 0.5 * (trace - delta);
        let coh = (lam1 - lam2) / (lam1 + lam2 + eps);
        if (coh < 0) coh = 0;
        else if (coh > 1) coh = 1;
        coherence[i] = coh;

        // gradient angle = 0.5 * atan2(2*Jxy, Jxx-Jyy)
        // tangent angle = gradient + π/2，最后 mod π 落到 [0, π)
        let t = 0.5 * Math.atan2(2.0 * xy, diff) + HALF_PI;
        t = t % PI;
        if (t < 0) t += PI;
        theta[i] = t;
    }

    return { theta, coherence };
}
