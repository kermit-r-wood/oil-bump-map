// 各向异性 stroke field（Line Integral Convolution）。
//
// 移植自 pipeline/strokes.py。算法：
//   1. 白噪声 noise(H, W) = N(0, 1)。
//   2. 沿切线方向 (cos θ, sin θ) 在 [-length/2, +length/2] 取整数步长采样并平均
//      → 平滑出 "笔触" 形状。
//   3. 沿垂直方向做 Gaussian 加权采样 → 笔触厚度。
//   4. 与各向同性噪声按 coherence 做混合：低 coherence 区域回退到平滑。
//
// 性能要点：把双线性采样 inline 进双层循环，避免每个 step 分配 O(N) 临时数组。

import { standardNormalArray } from './rng.js';
import { percentileAbs } from './filters.js';

/* BORDER_REFLECT_101 索引 (重复一份，避免跨模块函数调用的开销) */
function reflect101(i, n) {
    if (n <= 1) return 0;
    const period = 2 * (n - 1);
    let m = i % period;
    if (m < 0) m += period;
    return m < n ? m : period - m;
}

/* 把 99 百分位 |x| 归一化到 1，并 clip 到 [-1, 1] */
function normalizeUnit(arr) {
    const p99 = percentileAbs(arr, 99);
    if (p99 < 1e-8) return arr;
    const s = 1.0 / p99;
    for (let i = 0; i < arr.length; i++) {
        let v = arr[i] * s;
        if (v < -1) v = -1;
        else if (v > 1) v = 1;
        arr[i] = v;
    }
    return arr;
}

/**
 * @param {Float32Array} theta      切线方向 (rad)
 * @param {Float32Array} coherence  各向异性强度 [0, 1]
 * @param {number} W
 * @param {number} H
 * @param {object} opts
 * @param {number} opts.length              streamline 长度 (px)
 * @param {number} opts.thickness           perpendicular 厚度 (px)
 * @param {number} [opts.seed=0]
 * @param {number} [opts.directionStrength=1.0]
 * @param {number} [opts.isoWeight=1.0]
 * @returns {Float32Array}                  stroke field, 大致 [-1, 1]，均值 ≈ 0
 */
export function directionalStrokeField(theta, coherence, W, H, opts) {
    const length = opts.length;
    const thickness = opts.thickness;
    const seed = opts.seed ?? 0;
    const directionStrength = opts.directionStrength ?? 1.0;
    const isoWeight = opts.isoWeight ?? 1.0;

    if (theta.length !== W * H || coherence.length !== W * H) {
        throw new Error('theta / coherence size mismatch with W*H');
    }

    const N = W * H;

    // 1. 白噪声
    const noise = standardNormalArray(N, seed);

    // 2. dx, dy
    const dx = new Float32Array(N);
    const dy = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        dx[i] = Math.cos(theta[i]);
        dy[i] = Math.sin(theta[i]);
    }

    // 3. Streamline integration
    let stroked;
    if (length >= 1.0) {
        let nSteps = Math.max(3, Math.round(length));
        if (nSteps % 2 === 0) nSteps += 1;
        const half = (nSteps - 1) >> 1;
        const invSteps = 1.0 / nSteps;
        stroked = new Float32Array(N);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const dxi = dx[i];
                const dyi = dy[i];
                let acc = 0.0;
                for (let k = -half; k <= half; k++) {
                    const sy = y + k * dyi;
                    const sx = x + k * dxi;
                    // inline bilinear sample with reflect101
                    const y0f = Math.floor(sy);
                    const x0f = Math.floor(sx);
                    const fy = sy - y0f;
                    const fx = sx - x0f;
                    const y0 = reflect101(y0f, H);
                    const y1 = reflect101(y0f + 1, H);
                    const x0 = reflect101(x0f, W);
                    const x1 = reflect101(x0f + 1, W);
                    const v00 = noise[y0 * W + x0];
                    const v01 = noise[y0 * W + x1];
                    const v10 = noise[y1 * W + x0];
                    const v11 = noise[y1 * W + x1];
                    const top = v00 * (1 - fx) + v01 * fx;
                    const bot = v10 * (1 - fx) + v11 * fx;
                    acc += top * (1 - fy) + bot * fy;
                }
                stroked[i] = acc * invSteps;
            }
        }
    } else {
        stroked = noise.slice();
    }

    // 4. Perpendicular Gaussian thickness blur
    if (thickness >= 1.0) {
        let nThick = Math.max(3, Math.round(thickness));
        if (nThick % 2 === 0) nThick += 1;
        const thalf = (nThick - 1) >> 1;
        const sigmaT = Math.max(thickness / 2.0, 0.5);
        const ks = new Float32Array(nThick);
        const weights = new Float32Array(nThick);
        let wsum = 0.0;
        for (let i = 0; i < nThick; i++) {
            const k = i - thalf;
            ks[i] = k;
            const w = Math.exp(-0.5 * (k / sigmaT) * (k / sigmaT));
            weights[i] = w;
            wsum += w;
        }
        for (let i = 0; i < nThick; i++) weights[i] /= wsum;

        const thickened = new Float32Array(N);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                const dxi = dx[i];
                const dyi = dy[i];
                let acc = 0.0;
                for (let kk = 0; kk < nThick; kk++) {
                    const k = ks[kk];
                    // 垂直方向旋转 90°: (-sin θ, cos θ) = (-dy, dx)
                    const sy = y + k * dxi;       // perp y = +cos θ = +dx
                    const sx = x + k * (-dyi);    // perp x = -sin θ = -dy
                    const y0f = Math.floor(sy);
                    const x0f = Math.floor(sx);
                    const fy = sy - y0f;
                    const fx = sx - x0f;
                    const y0 = reflect101(y0f, H);
                    const y1 = reflect101(y0f + 1, H);
                    const x0 = reflect101(x0f, W);
                    const x1 = reflect101(x0f + 1, W);
                    const v00 = stroked[y0 * W + x0];
                    const v01 = stroked[y0 * W + x1];
                    const v10 = stroked[y1 * W + x0];
                    const v11 = stroked[y1 * W + x1];
                    const top = v00 * (1 - fx) + v01 * fx;
                    const bot = v10 * (1 - fx) + v11 * fx;
                    acc += weights[kk] * (top * (1 - fy) + bot * fy);
                }
                thickened[i] = acc;
            }
        }
        stroked = thickened;
    }

    // 5. 归一化两路
    const strokedN = normalizeUnit(stroked);
    const isoN = normalizeUnit(noise.slice());

    // 6. 按 coherence 混合
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
        let b = coherence[i] * directionStrength;
        if (b < 0) b = 0;
        else if (b > 1) b = 1;
        out[i] = b * strokedN[i] + (1 - b) * isoN[i] * isoWeight;
    }
    return out;
}
