// Node 烟雾测试：合成 RGB → 跑端到端 pipeline → 校验 uint16 输出统计 + 写出一张 PNG。
//
// 用法: node web/test_node.mjs

import { runPipeline } from './src/runner.js';
import { encodeGrayPng } from './src/png.js';
import { writeFileSync } from 'node:fs';

function mulberry32(seed) {
    let a = (seed | 0) >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function syntheticRgb(W, H, seed) {
    const rand = mulberry32(seed);
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const noise = (rand() - 0.5) * 16;
            const r = 128 + 80 * Math.sin(2 * Math.PI * x / 32.0) + 30 * Math.cos(2 * Math.PI * y / 18.0) + noise;
            const g = 128 + 60 * Math.cos(2 * Math.PI * (x + y) / 24.0) + 20 * Math.sin(2 * Math.PI * y / 12.0) + noise;
            const b = 128 + 70 * Math.sin(2 * Math.PI * (x - y) / 20.0) + 25 * Math.cos(2 * Math.PI * x / 16.0) + noise;
            const i = (y * W + x) * 4;
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
            rgba[i + 3] = 255;
        }
    }
    return rgba;
}

function flatRgb(W, H, gray) {
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        rgba[i * 4] = gray;
        rgba[i * 4 + 1] = gray;
        rgba[i * 4 + 2] = gray;
        rgba[i * 4 + 3] = 255;
    }
    return rgba;
}

function brightDarkSplitRgb(W, H, seed) {
    // 左半暗+纹理，右半亮+纹理。验证 luminance_height_bias 极性。
    const rand = mulberry32(seed);
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const baseGray = x < W / 2 ? 0.15 : 0.85;
            const v = baseGray + (rand() - 0.5) * 0.1;
            const u8 = Math.max(0, Math.min(255, Math.round(v * 255)));
            const i = (y * W + x) * 4;
            rgba[i] = u8;
            rgba[i + 1] = u8;
            rgba[i + 2] = u8;
            rgba[i + 3] = 255;
        }
    }
    return rgba;
}

function stats(arr) {
    let minV = Infinity, maxV = -Infinity, sum = 0;
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
        sum += v;
    }
    const mean = sum / arr.length;
    let sq = 0;
    for (let i = 0; i < arr.length; i++) {
        const d = arr[i] - mean;
        sq += d * d;
    }
    return { min: minV, max: maxV, mean, std: Math.sqrt(sq / arr.length) };
}

function meanOf(arr, x0, y0, x1, y1, W) {
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            s += arr[y * W + x];
            n++;
        }
    }
    return s / n;
}

function assert(cond, msg) {
    if (!cond) {
        console.error('ASSERT FAIL:', msg);
        process.exitCode = 1;
    } else {
        console.log('  ok:', msg);
    }
}

async function main() {
    console.log('=== Test 1: 合成纹理图 (256x256) 端到端 ===');
    {
        const W = 256, H = 256;
        const rgba = syntheticRgb(W, H, 7);
        const t0 = performance.now();
        const result = await runPipeline(rgba, W, H, {
            seed: 42, bitDepth: 16,
            onProgress: (s) => process.stdout.write(`  · ${s}\n`),
        });
        const dt = ((performance.now() - t0) / 1000).toFixed(2);
        console.log(`  pipeline 用时 ${dt}s`);
        const s = stats(result.bumpInt);
        console.log(`  bumpInt: min=${s.min} max=${s.max} mean=${s.mean.toFixed(1)} std=${s.std.toFixed(1)}`);
        assert(result.bumpInt instanceof Uint16Array, '16-bit 模式输出 Uint16Array');
        assert(result.bumpInt.length === W * H, `输出大小 = W*H (${result.bumpInt.length})`);
        assert(s.max - s.min > 1000, '动态范围 > 1000 (uint16)');
        // PNG 编码
        const png = await encodeGrayPng(result.bumpInt, W, H, 16);
        writeFileSync('web/test_node_out.png', png);
        console.log(`  写出 web/test_node_out.png (${png.length} bytes)`);
        // PNG 签名校验
        assert(png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4E && png[3] === 0x47,
            'PNG 签名正确');
    }

    console.log('\n=== Test 2: 平坦灰图 → 中灰输出 ===');
    {
        const W = 128, H = 128;
        const rgba = flatRgb(W, H, 128);
        const result = await runPipeline(rgba, W, H, { seed: 0, bitDepth: 16 });
        const s = stats(result.bumpInt);
        console.log(`  bumpInt: mean=${s.mean.toFixed(1)} std=${s.std.toFixed(1)}`);
        assert(Math.abs(s.mean - 32767) < 1500, `平坦输入 mean ≈ 32767 (got ${s.mean.toFixed(1)})`);
        assert(s.std < 1500, `平坦输入 std < 1500 (got ${s.std.toFixed(1)})`);
    }

    console.log('\n=== Test 3: 极性 — 亮纹理 > 暗纹理 ===');
    {
        const W = 256, H = 64;
        const rgba = brightDarkSplitRgb(W, H, 0);
        const result = await runPipeline(rgba, W, H, { seed: 0, bitDepth: 16 });
        // 看左右四分之一
        const darkMean = meanOf(result.bumpInt, 0, 0, W / 4, H, W);
        const brightMean = meanOf(result.bumpInt, W * 3 / 4, 0, W, H, W);
        console.log(`  暗区 mean=${darkMean.toFixed(1)}  亮区 mean=${brightMean.toFixed(1)}`);
        assert(brightMean > darkMean, '亮纹理区 > 暗纹理区 (luminance_height_bias 极性)');
    }

    console.log('\n=== Test 4: 同 seed 确定性 ===');
    {
        const W = 128, H = 128;
        const rgba = syntheticRgb(W, H, 11);
        const a = await runPipeline(rgba, W, H, { seed: 99, bitDepth: 16 });
        const b = await runPipeline(rgba, W, H, { seed: 99, bitDepth: 16 });
        let same = true;
        for (let i = 0; i < a.bumpInt.length; i++) {
            if (a.bumpInt[i] !== b.bumpInt[i]) { same = false; break; }
        }
        assert(same, '同 seed → 字节级一致');
    }

    console.log('\n=== Test 5: 8-bit PNG 编码 ===');
    {
        const W = 64, H = 64;
        const rgba = syntheticRgb(W, H, 3);
        const result = await runPipeline(rgba, W, H, { seed: 1, bitDepth: 8 });
        assert(result.bumpInt instanceof Uint8Array, '8-bit 模式输出 Uint8Array');
        const png = await encodeGrayPng(result.bumpInt, W, H, 8);
        assert(png[0] === 0x89, '8-bit PNG 签名 OK');
        assert(png.length > 100, '8-bit PNG 非空');
    }

    console.log('\n=== Test 6: backend probe (Node 环境) ===');
    {
        const { probeBackends } = await import('./src/runner.js');
        const probe = await probeBackends();
        console.log(`  probe = ${JSON.stringify(probe)}`);
        assert(probe.cpu === true, 'CPU 后端在 Node 环境可用');
        assert(probe.webgl === false, 'WebGL 后端在 Node 环境不可用 (无 OffscreenCanvas)');
        assert(probe.webgpu === undefined, '不再有 webgpu 后端');
    }

    console.log('\n=== Test 7: 显式选择 CPU 后端 ===');
    {
        const W = 64, H = 64;
        const rgba = syntheticRgb(W, H, 5);
        const r = await runPipeline(rgba, W, H, { seed: 1, bitDepth: 16, backend: 'cpu' });
        assert(r.backend === 'cpu', `backend 字段 = 'cpu' (got ${r.backend})`);
        assert(typeof r.timings.total === 'number', 'timings.total 是数字');
    }

    console.log('\n=== Test 8: 强制选择不可用后端 → 抛错 ===');
    {
        let threw = false;
        try {
            const W = 32, H = 32;
            await runPipeline(syntheticRgb(W, H, 0), W, H, { backend: 'webgl' });
        } catch (e) {
            threw = true;
            console.log(`  正确抛错: ${e.message}`);
        }
        assert(threw, '强制 webgl 在 Node 抛错');
    }

    console.log('\n=== Test 9: WebGL shader 源码语法初步检查 ===');
    {
        const gl = await import('./src/gl/shaders.js');
        const allGlSrc = Object.values(gl).filter((v) => typeof v === 'string').join('\n');
        assert(allGlSrc.length > 1000, 'WebGL shaders 总源码 > 1000 字符');
        assert(allGlSrc.includes('#version 300 es'), '所有 WebGL shader 都是 ES 3.00');
        assert(!allGlSrc.includes('${'), '没有未替换的模板占位符 (WebGL)');
    }

    console.log('\n=== Test 10: i18n 字典 + t() 占位符替换 ===');
    {
        const { t, getLang, listKeys, SUPPORTED_LANGS } = await import('./src/i18n.js');
        // Node 没有 localStorage → getLang() 应该回到默认 'en'
        assert(getLang() === 'en', `Node 默认语言 = 'en' (got ${getLang()})`);

        // 基本翻译
        assert(t('btn.upload') === 'Upload image', `t('btn.upload') = 'Upload image'`);
        assert(t('btn.download') === 'Download PNG', `t('btn.download') = 'Download PNG'`);

        // 显式 lang 覆盖
        assert(t('btn.upload', undefined, 'zh') === '上传图片', `t('btn.upload', _, 'zh') = '上传图片'`);
        assert(t('btn.download', undefined, 'zh') === '下载 PNG', `t('btn.download', _, 'zh') = '下载 PNG'`);

        // 占位符替换
        const s = t('status.done', { dt: '1.23', backend: 'webgl' });
        assert(s.includes('1.23') && s.includes('webgl'),
            `占位符替换 → "${s}"`);

        // 字典 key parity：所有 en key 必须在 zh 里也有定义（防漏翻）
        const enKeys = listKeys('en');
        const zhKeys = new Set(listKeys('zh'));
        const missing = enKeys.filter((k) => !zhKeys.has(k));
        assert(missing.length === 0, `所有 en key 在 zh 里也有 (missing: ${missing.join(', ') || 'none'})`);
        const enSet = new Set(enKeys);
        const extra = listKeys('zh').filter((k) => !enSet.has(k));
        assert(extra.length === 0, `zh 没有 en 里没有的多余 key (extra: ${extra.join(', ') || 'none'})`);
        console.log(`  字典共 ${enKeys.length} 个 key，双语完全对齐`);

        assert(SUPPORTED_LANGS.length === 2 && SUPPORTED_LANGS.includes('en') && SUPPORTED_LANGS.includes('zh'),
            'SUPPORTED_LANGS = [en, zh]');
    }

    console.log('\n所有测试结束');
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
