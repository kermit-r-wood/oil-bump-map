// CPU 后端：纯 JS pipeline。
//
// 实现 IBackend 接口：
//   isAvailable(): Promise<boolean>
//   run(rgba, W, H, opts): Promise<{bumpFloat, timings}>
//
// 这个文件就是早先 runner.js 里的算法核心，被搬出来作为众多后端中的一个。

import { rgbaToLuminance, structureTensorOrientation } from '../orientation.js';
import { directionalStrokeField } from '../strokes.js';
import { paintDensityMask, composeBump } from '../compose.js';
import { precompensateForPrinter } from '../postprocess.js';
import { PRESET } from '../presets.js';

export const cpuBackend = {
    name: 'cpu',
    label: 'CPU (pure JS)',

    async isAvailable() {
        return true; // CPU 兜底，恒可用
    },

    /**
     * @param {Uint8ClampedArray | Uint8Array} rgba
     * @param {number} W
     * @param {number} H
     * @param {object} opts
     * @param {number} [opts.seed=1234]
     * @param {(stage: string) => void} [opts.onProgress]
     * @returns {Promise<{bumpFloat: Float32Array, timings: Record<string, number>}>}
     */
    async run(rgba, W, H, opts = {}) {
        const seed = opts.seed ?? 1234;
        const onProgress = opts.onProgress ?? (() => {});
        const preset = PRESET;
        const timings = {};
        const yieldTick = () => new Promise((r) => setTimeout(r, 0));
        const tic = () => performance.now();
        const toc = (start) => performance.now() - start;

        let t = tic();
        onProgress('luminance');
        const lum = rgbaToLuminance(rgba, W, H);
        timings.luminance = toc(t);
        await yieldTick();

        t = tic();
        onProgress('orientation');
        const { theta, coherence } = structureTensorOrientation(lum, W, H, {
            sigma: 2.0,
            preHighpassSigma: preset.orientationHighpassSigma,
        });
        timings.orientation = toc(t);
        await yieldTick();

        t = tic();
        onProgress('strokes');
        const stroke = directionalStrokeField(theta, coherence, W, H, {
            length: preset.strokeLength,
            thickness: preset.strokeThickness,
            seed,
            directionStrength: preset.directionStrength,
            isoWeight: preset.isoWeight,
        });
        timings.strokes = toc(t);
        await yieldTick();

        t = tic();
        onProgress('paint-density');
        const thickness = paintDensityMask(lum, W, H, {
            gamma: preset.thicknessGamma,
            floor: preset.thicknessFloor,
        });
        timings.paintDensity = toc(t);
        await yieldTick();

        t = tic();
        onProgress('compose');
        let bump = composeBump(stroke, thickness, W, H, {
            outputAmplitude: preset.outputAmplitude,
            recenter: true,
        });

        // luminance-driven DC offset
        if (preset.luminanceHeightBias > 0) {
            const k = preset.luminanceHeightBias;
            for (let i = 0; i < bump.length; i++) {
                bump[i] += (lum[i] - 0.5) * 2.0 * thickness[i] * k;
            }
        }
        timings.compose = toc(t);
        await yieldTick();

        t = tic();
        onProgress('unsharp');
        bump = precompensateForPrinter(bump, W, H, {
            sigma: preset.unsharpSigma,
            alpha: preset.unsharpAlpha,
        });
        timings.unsharp = toc(t);

        return { bumpFloat: bump, timings };
    },

    dispose() {
        // CPU 后端无 GPU 资源
    },
};
