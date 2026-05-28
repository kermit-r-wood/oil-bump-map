// Web Worker 入口：接收来自 main.js 的 message，调度 runner.js 的 runPipeline，
// 通过 Transferable 把结果零拷贝送回主线程。
//
// 协议：
//   ← main.js postMessage:
//     {
//       cmd: 'run',
//       id: number,                         // 请求 id (用于回包匹配)
//       rgba: ArrayBuffer,                  // RGBA8 像素 (Transferred)
//       W: number, H: number,
//       seed: number,
//       bitDepth: 8 | 16,
//       backend: 'auto' | 'cpu' | 'webgl',
//     }
//   → main.js postMessage:
//     成功 -> { id, ok: true, bumpFloat: ArrayBuffer, bumpInt: ArrayBuffer, intDtype: 'u8'|'u16', backend, timings }
//     进度 -> { id, ok: true, progress: stage }
//     失败 -> { id, ok: false, error: string }
//
//   ← main.js postMessage:
//     { cmd: 'probe' }
//   → main.js postMessage:
//     { ok: true, probe: { cpu, webgl } }

import { runPipeline, probeBackends } from './runner.js';

self.addEventListener('message', async (e) => {
    const msg = e.data;
    if (!msg || !msg.cmd) return;

    if (msg.cmd === 'probe') {
        try {
            const probe = await probeBackends();
            self.postMessage({ ok: true, probe });
        } catch (err) {
            self.postMessage({ ok: false, error: String(err && err.message || err) });
        }
        return;
    }

    if (msg.cmd === 'run') {
        const { id, rgba, W, H, seed, bitDepth, backend } = msg;
        try {
            const rgbaView = new Uint8Array(rgba);

            const onProgress = (stage) => {
                self.postMessage({ id, ok: true, progress: stage });
            };
            const result = await runPipeline(rgbaView, W, H, {
                seed, bitDepth, backend,
                onProgress,
            });
            // bumpFloat 作为 Transferable 送回（让主线程能继续做 sim σ 预览）
            const transfers = [
                result.bumpFloat.buffer,
                result.bumpInt.buffer,
            ];
            self.postMessage({
                id,
                ok: true,
                bumpFloat: result.bumpFloat.buffer,
                bumpInt: result.bumpInt.buffer,
                intDtype: result.bumpInt instanceof Uint16Array ? 'u16' : 'u8',
                W: result.W, H: result.H,
                backend: result.backend,
                timings: result.timings,
            }, transfers);
        } catch (err) {
            self.postMessage({
                id,
                ok: false,
                error: String(err && err.stack || err && err.message || err),
            });
        }
        return;
    }
});
