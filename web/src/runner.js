// Backend dispatcher。
//
// 两个后端实现 IBackend 接口：
//   { name, label, isAvailable() => Promise<boolean>, run(rgba, W, H, opts), dispose() }
// run 返回 { bumpFloat: Float32Array, timings: Record<string, number> }。
//
// 选择策略：
//   'auto'   → webgl → cpu
//   'cpu' / 'webgl' → 强制使用对应后端，不可用就抛错
//
// 后端只负责"得到 bumpFloat"。luminance DC offset 已经合并进 backend 内部，
// 但 quantize + PNG 编码留给 main.js / worker.js 在 backend 之外完成。

import { cpuBackend } from './backends/cpu.js';
import { webglBackend } from './backends/webgl.js';
import { quantizeToArray } from './postprocess.js';

const BACKENDS = {
    cpu: cpuBackend,
    webgl: webglBackend,
};

/**
 * @param {'auto' | 'cpu' | 'webgl'} kind
 * @returns {Promise<object>} 选中的 backend 对象
 */
export async function selectBackend(kind = 'auto') {
    if (kind !== 'auto') {
        const b = BACKENDS[kind];
        if (!b) throw new Error(`unknown backend: ${kind}`);
        if (!(await b.isAvailable())) {
            throw new Error(`${kind} backend not available in this environment`);
        }
        return b;
    }
    // auto: webgl → cpu
    for (const name of ['webgl', 'cpu']) {
        const b = BACKENDS[name];
        try {
            if (await b.isAvailable()) return b;
        } catch (_) {
            /* 探测失败 → 下一档 */
        }
    }
    return cpuBackend;
}

/**
 * @returns {Promise<Record<string, boolean>>}  各后端可用性
 */
export async function probeBackends() {
    const out = {};
    for (const [name, b] of Object.entries(BACKENDS)) {
        try {
            out[name] = await b.isAvailable();
        } catch (_) {
            out[name] = false;
        }
    }
    return out;
}

/**
 * 端到端便捷封装：选后端 → 跑 → 量化。
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba
 * @param {number} W
 * @param {number} H
 * @param {object} [opts]
 * @param {'auto' | 'cpu' | 'webgl'} [opts.backend='auto']
 * @param {number} [opts.seed=1234]
 * @param {8 | 16} [opts.bitDepth=16]
 * @param {(stage: string) => void} [opts.onProgress]
 * @returns {Promise<{bumpFloat: Float32Array, bumpInt: Uint8Array | Uint16Array, W: number, H: number, backend: string, timings: object}>}
 */
export async function runPipeline(rgba, W, H, opts = {}) {
    const backendKind = opts.backend ?? 'auto';
    const seed = opts.seed ?? 1234;
    const bitDepth = opts.bitDepth ?? 16;
    const onProgress = opts.onProgress ?? (() => {});

    const backend = await selectBackend(backendKind);
    onProgress(`backend=${backend.name}`);

    const t0 = performance.now();
    const { bumpFloat, timings } = await backend.run(rgba, W, H, { seed, onProgress });
    const tBackend = performance.now() - t0;

    onProgress('quantize');
    const t1 = performance.now();
    const bumpInt = quantizeToArray(bumpFloat, bitDepth);
    const tQuantize = performance.now() - t1;

    return {
        bumpFloat,
        bumpInt,
        W, H,
        backend: backend.name,
        timings: { ...timings, quantize: tQuantize, total: tBackend + tQuantize },
    };
}

/**
 * 用同一份 quantize 把 float bump 重新量化（用于改 bitDepth 时不重算整管线）。
 *
 * @param {Float32Array} bumpFloat
 * @param {8 | 16} bitDepth
 */
export function requantize(bumpFloat, bitDepth) {
    return quantizeToArray(bumpFloat, bitDepth);
}
