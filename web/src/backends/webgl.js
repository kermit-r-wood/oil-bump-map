// WebGL2 后端：所有 GPU 友好算子在 fragment shader 里跑。
//
// stage 链：
//   rgbaToLuminance        : Uint8 RGBA → R32F lum
//   gaussianBlur           : 可分离两 pass
//   sobel                  : 一次 fetch 输出 RGBA32F (Ix, Iy, Ix*Iy, Ix^2)
//   structureTensorEigen   : 解 2x2 → R32F theta + R32F coherence (RG32F 一张)
//   licStreamline          : 沿 dx,dy 累计采样 noise → R32F
//   licThickness           : 垂直方向高斯 → R32F
//   normalizeAndBlend      : LIC 输出 + 噪声混合（coherence 加权）
//   paintDensity           : 局部方差 box filter → 平滑 → R32F
//   compose                : stroke * thickness → 在 CPU recenter+rescale（需要 percentile）
//   unsharp                : Gaussian + (x - blurred)*alpha → R32F
//
// 输出：bump float Float32Array。percentile / luminance DC offset / 量化 / PNG 都留 CPU。

import { makeContext } from '../gl/context.js';
import { runWebgl } from '../gl/pipeline.js';

export const webglBackend = {
    name: 'webgl',
    label: 'WebGL2 (fragment shader)',

    async isAvailable() {
        try {
            return makeContext().ok;
        } catch (_) {
            return false;
        }
    },

    /**
     * @returns {Promise<{bumpFloat: Float32Array, timings: Record<string, number>}>}
     */
    async run(rgba, W, H, opts = {}) {
        return runWebgl(rgba, W, H, opts);
    },

    dispose() {
        // GL 资源在 runWebgl 内部 per-call 释放
    },
};
