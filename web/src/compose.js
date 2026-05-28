// Paint-density 厚度 mask + 简单 bump 合成器。
//
// 移植自 pipeline/compose.py。

import { boxFilter, gaussianBlur, percentileAbs, mean } from './filters.js';

/**
 * paint_density_mask: 基于局部方差检测 "哪里有颜料堆积"。
 *
 * @param {Float32Array} luminanceNorm  ∈ [0, 1]
 * @param {number} W
 * @param {number} H
 * @param {object} [opts]
 * @param {number} [opts.gamma=1.5]
 * @param {number} [opts.floor=0.0]
 * @returns {Float32Array}
 */
export function paintDensityMask(luminanceNorm, W, H, opts = {}) {
    const gamma = opts.gamma ?? 1.5;
    const floor = opts.floor ?? 0.0;
    const N = W * H;

    // clip 到 [0, 1]
    const lum = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        const v = luminanceNorm[i];
        lum[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    // 局部方差：mean & E[x^2]，box filter (radius=25, win=51)
    const varRadius = 25;
    const lumSq = new Float32Array(N);
    for (let i = 0; i < N; i++) lumSq[i] = lum[i] * lum[i];

    const meanArr = boxFilter(lum, W, H, varRadius);
    const sqMean = boxFilter(lumSq, W, H, varRadius);
    const density = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        let varVal = sqMean[i] - meanArr[i] * meanArr[i];
        if (varVal < 0) varVal = 0;
        density[i] = Math.sqrt(varVal); // std-dev：与对比度幅度线性
    }

    // 轻微空间平滑，让 mask 局部稳定。Python: GaussianBlur(17, 17, 5.0)
    const densitySmooth = gaussianBlur(density, W, H, 5.0);

    // 用第 95 百分位归一化到 [0, 1]
    const p95 = percentileAbs(densitySmooth, 95);
    const out = new Float32Array(N);
    if (p95 > 1e-8) {
        for (let i = 0; i < N; i++) {
            let v = densitySmooth[i] / p95;
            if (v < 0) v = 0;
            else if (v > 1) v = 1;
            out[i] = v;
        }
    }
    // 否则全 0

    // luminance 加权 (亮的 ×1.5, 暗的 ×0.5)，再 clip 到 [0, 1]
    for (let i = 0; i < N; i++) {
        let v = out[i] * (0.5 + lum[i]);
        if (v < 0) v = 0;
        else if (v > 1) v = 1;
        out[i] = v;
    }

    // gamma
    const g = Math.max(gamma, 1e-3);
    if (g !== 1.0) {
        for (let i = 0; i < N; i++) out[i] = Math.pow(out[i], g);
    }

    // floor
    if (floor > 0.0) {
        const f = floor;
        const span = 1.0 - f;
        for (let i = 0; i < N; i++) out[i] = f + span * out[i];
    }

    return out;
}

/**
 * compose_bump: bump = stroke * thickness, 居中并按第 99 百分位重缩放到 outputAmplitude。
 *
 * @param {Float32Array} strokeField
 * @param {Float32Array} thickness
 * @param {number} W
 * @param {number} H
 * @param {object} [opts]
 * @param {number} [opts.outputAmplitude=0.5]
 * @param {boolean} [opts.recenter=true]
 * @returns {Float32Array}
 */
export function composeBump(strokeField, thickness, W, H, opts = {}) {
    const outputAmplitude = opts.outputAmplitude ?? 0.5;
    const recenter = opts.recenter ?? true;
    const N = W * H;
    if (strokeField.length !== N || thickness.length !== N) {
        throw new Error('strokeField / thickness shape mismatch');
    }

    const bump = new Float32Array(N);
    for (let i = 0; i < N; i++) bump[i] = strokeField[i] * thickness[i];

    if (!recenter) return bump;

    const m = mean(bump);
    for (let i = 0; i < N; i++) bump[i] -= m;

    const p99 = percentileAbs(bump, 99);
    const target = Math.max(outputAmplitude, 1e-6);
    if (p99 > 1e-8) {
        const s = target / p99;
        for (let i = 0; i < N; i++) bump[i] *= s;
    }
    // clip
    for (let i = 0; i < N; i++) {
        const v = bump[i];
        bump[i] = v < -target ? -target : (v > target ? target : v);
    }
    return bump;
}
