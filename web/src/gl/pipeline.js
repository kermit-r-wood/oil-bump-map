// WebGL2 backend orchestrator: 端到端 stage 链。
//
// 大致流程（CPU 与 GPU 之间最小化往返）：
//   noise/RGBA 上传 → GPU(lum, hp, sobel→J, blur J, eigen→thetaCoh) → GPU(LIC streamline + thickness)
//   readback stroked → CPU p99 → GPU normalize stroked + isoN → blend → strokeField
//   GPU(lum→box mean+sqMean→density→gaussian) → readback density → CPU p95
//   GPU(finalize density: lum factor/gamma/floor) → GPU(multiply stroke·density) → readback
//   CPU(mean & p99 of bump_raw) → GPU(compose finalize w/ DC offset) → GPU(unsharp via gauss)
//   readback bumpFloat → return.

import { makeWebglContext } from './helpers.js';
import {
    FS_RGBA_TO_LUM, FS_SUBTRACT, FS_GAUSSIAN_R, FS_GAUSSIAN_RGBA, FS_BOXBLUR_R,
    FS_SOBEL_TO_J, FS_TENSOR_EIGEN,
    FS_LIC_STREAM, FS_LIC_THICK, FS_NORMALIZE_UNIT, FS_BLEND_STROKE,
    FS_SQUARE, FS_VARIANCE_TO_DENSITY, FS_FINALIZE_DENSITY,
    FS_MULTIPLY, FS_COMPOSE_FINALIZE, FS_UNSHARP,
} from './shaders.js';
import { PRESET } from '../presets.js';
import { standardNormalArray } from '../rng.js';
import { percentileAbs, mean as arrMean } from '../filters.js';

/* -------------------------------------------------------------------- *
 *  Kernel helpers                                                       *
 * -------------------------------------------------------------------- */

function gaussianKernel(sigma) {
    const radius = Math.max(1, Math.ceil(3 * sigma));
    if (radius > 32) throw new Error(`gaussian radius ${radius} > 32 (shader cap)`);
    const size = 2 * radius + 1;
    const k = new Float32Array(65); // 着色器固定 65 长度
    const inv2s2 = 1 / (2 * sigma * sigma);
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
        const v = Math.exp(-i * i * inv2s2);
        k[i + radius] = v;
        sum += v;
    }
    for (let i = 0; i < size; i++) k[i] /= sum;
    return { kernel: k, radius };
}

/* -------------------------------------------------------------------- *
 *  Main runner                                                          *
 * -------------------------------------------------------------------- */

export async function runWebgl(rgba, W, H, opts = {}) {
    const seed = opts.seed ?? 1234;
    const onProgress = opts.onProgress ?? (() => {});
    const preset = PRESET;
    const timings = {};
    const tic = () => performance.now();
    const toc = (s) => performance.now() - s;

    const ctx = makeWebglContext(W, H);
    const gl = ctx.gl;
    const texelXY = [1 / W, 1 / H];

    // Compile programs lazily (cached by source)
    const PROG = {
        lum: ctx.makeProgram(FS_RGBA_TO_LUM),
        sub: ctx.makeProgram(FS_SUBTRACT),
        gaussR: ctx.makeProgram(FS_GAUSSIAN_R),
        gaussRGBA: ctx.makeProgram(FS_GAUSSIAN_RGBA),
        boxR: ctx.makeProgram(FS_BOXBLUR_R),
        sobelJ: ctx.makeProgram(FS_SOBEL_TO_J),
        eigen: ctx.makeProgram(FS_TENSOR_EIGEN),
        licStream: ctx.makeProgram(FS_LIC_STREAM),
        licThick: ctx.makeProgram(FS_LIC_THICK),
        normalize: ctx.makeProgram(FS_NORMALIZE_UNIT),
        blend: ctx.makeProgram(FS_BLEND_STROKE),
        square: ctx.makeProgram(FS_SQUARE),
        var2dens: ctx.makeProgram(FS_VARIANCE_TO_DENSITY),
        finalDens: ctx.makeProgram(FS_FINALIZE_DENSITY),
        mul: ctx.makeProgram(FS_MULTIPLY),
        composeF: ctx.makeProgram(FS_COMPOSE_FINALIZE),
        unsharp: ctx.makeProgram(FS_UNSHARP),
    };

    // 预分配的 ping-pong R32F 池（任何 stage 临时输出都用它）
    let texPoolR32F = [];
    function takeR() {
        return texPoolR32F.pop() ?? ctx.makeTexR32F();
    }
    function giveR(t) {
        if (t) texPoolR32F.push(t);
    }
    function gaussianBlurR(srcTex, dstTex, sigma) {
        const { kernel, radius } = gaussianKernel(sigma);
        const tmp = takeR();
        ctx.runPass({
            entry: PROG.gaussR,
            inputs: { u_src: srcTex },
            output: tmp,
            uniforms: {
                u_texel: ['2f', ...texelXY],
                u_dir: ['2f', 1, 0],
                u_radius: ['1i', radius],
                u_kernel: ['1fv', kernel],
            },
        });
        ctx.runPass({
            entry: PROG.gaussR,
            inputs: { u_src: tmp },
            output: dstTex,
            uniforms: {
                u_texel: ['2f', ...texelXY],
                u_dir: ['2f', 0, 1],
                u_radius: ['1i', radius],
                u_kernel: ['1fv', kernel],
            },
        });
        giveR(tmp);
    }
    function boxBlurR(srcTex, dstTex, radius) {
        const tmp = takeR();
        ctx.runPass({
            entry: PROG.boxR,
            inputs: { u_src: srcTex },
            output: tmp,
            uniforms: {
                u_texel: ['2f', ...texelXY],
                u_dir: ['2f', 1, 0],
                u_radius: ['1i', radius],
            },
        });
        ctx.runPass({
            entry: PROG.boxR,
            inputs: { u_src: tmp },
            output: dstTex,
            uniforms: {
                u_texel: ['2f', ...texelXY],
                u_dir: ['2f', 0, 1],
                u_radius: ['1i', radius],
            },
        });
        giveR(tmp);
    }

    try {
        /* ============================================================ *
         *  1. 上传 RGBA → lum                                            *
         * ============================================================ */
        let t = tic();
        onProgress('luminance');
        const texRgba = ctx.makeTexRGBA8();
        ctx.uploadRGBA8ToTex(texRgba, rgba);
        let texLum = takeR();
        ctx.runPass({
            entry: PROG.lum,
            inputs: { u_rgba: texRgba },
            output: texLum,
        });

        /* ============================================================ *
         *  2. high-pass lum (可选)                                       *
         * ============================================================ */
        if (preset.orientationHighpassSigma > 0) {
            const texLumBlur = takeR();
            gaussianBlurR(texLum, texLumBlur, preset.orientationHighpassSigma);
            const texHp = takeR();
            ctx.runPass({
                entry: PROG.sub,
                inputs: { u_a: texLum, u_b: texLumBlur },
                output: texHp,
            });
            giveR(texLumBlur);
            // 注意：texLum 还要在后面 finalDens / composeF 中用（原始 luminance），不要释放
            // 用 texHp 作为 Sobel 的输入
            var texLumForSobel = texHp;
        } else {
            var texLumForSobel = texLum;
        }
        timings.luminance = toc(t);

        /* ============================================================ *
         *  3. Sobel → J packed → Gaussian smooth → eigen                *
         * ============================================================ */
        t = tic();
        onProgress('orientation');
        const texJ = ctx.makeTexRGBA32F();
        ctx.runPass({
            entry: PROG.sobelJ,
            inputs: { u_src: texLumForSobel },
            output: texJ,
            uniforms: { u_texel: ['2f', ...texelXY] },
        });
        if (texLumForSobel !== texLum) giveR(texLumForSobel);

        // Gaussian blur J (RGBA 4ch)
        const texJTmp = ctx.makeTexRGBA32F();
        const texJSmooth = ctx.makeTexRGBA32F();
        {
            const { kernel, radius } = gaussianKernel(2.0);
            ctx.runPass({
                entry: PROG.gaussRGBA,
                inputs: { u_src: texJ },
                output: texJTmp,
                uniforms: {
                    u_texel: ['2f', ...texelXY],
                    u_dir: ['2f', 1, 0],
                    u_radius: ['1i', radius],
                    u_kernel: ['1fv', kernel],
                },
            });
            ctx.runPass({
                entry: PROG.gaussRGBA,
                inputs: { u_src: texJTmp },
                output: texJSmooth,
                uniforms: {
                    u_texel: ['2f', ...texelXY],
                    u_dir: ['2f', 0, 1],
                    u_radius: ['1i', radius],
                    u_kernel: ['1fv', kernel],
                },
            });
        }
        // eigen → (theta, coherence)
        const texThetaCoh = ctx.makeTexRG32F();
        ctx.runPass({
            entry: PROG.eigen,
            inputs: { u_J: texJSmooth },
            output: texThetaCoh,
        });
        // J 系列已不再需要
        timings.orientation = toc(t);

        /* ============================================================ *
         *  4. LIC streamline + thickness                                *
         * ============================================================ */
        t = tic();
        onProgress('strokes');
        const N = W * H;
        const noiseArr = standardNormalArray(N, seed);
        const texNoise = takeR();
        ctx.uploadFloat32ToTex(texNoise, noiseArr);

        let texStroked = takeR();
        let nSteps = Math.max(3, Math.round(preset.strokeLength));
        if (nSteps % 2 === 0) nSteps += 1;
        const half = (nSteps - 1) >> 1;
        if (half > 64) throw new Error(`stroke length ${preset.strokeLength} too long for shader cap`);
        ctx.runPass({
            entry: PROG.licStream,
            inputs: { u_thetaCoh: texThetaCoh, u_noise: texNoise },
            output: texStroked,
            uniforms: {
                u_size: ['2f', W, H],
                u_invSize: ['2f', 1 / W, 1 / H],
                u_half: ['1i', half],
            },
        });

        // perpendicular thickness
        if (preset.strokeThickness >= 1.0) {
            let nThick = Math.max(3, Math.round(preset.strokeThickness));
            if (nThick % 2 === 0) nThick += 1;
            const thalf = (nThick - 1) >> 1;
            if (thalf > 32) throw new Error(`thickness ${preset.strokeThickness} too thick`);
            const sigmaT = Math.max(preset.strokeThickness / 2.0, 0.5);
            const weights = new Float32Array(65);
            let wsum = 0;
            for (let i = 0; i < nThick; i++) {
                const k = i - thalf;
                const w = Math.exp(-0.5 * (k / sigmaT) ** 2);
                weights[i] = w;
                wsum += w;
            }
            for (let i = 0; i < nThick; i++) weights[i] /= wsum;

            const texThick = takeR();
            ctx.runPass({
                entry: PROG.licThick,
                inputs: { u_stroked: texStroked, u_thetaCoh: texThetaCoh },
                output: texThick,
                uniforms: {
                    u_size: ['2f', W, H],
                    u_invSize: ['2f', 1 / W, 1 / H],
                    u_thalf: ['1i', thalf],
                    u_weights: ['1fv', weights],
                },
            });
            giveR(texStroked);
            texStroked = texThick;
        }

        /* ============================================================ *
         *  5. Normalize stroked / iso noise → blend                     *
         * ============================================================ */
        // p99 of |stroked|: readback
        const strokedArr = ctx.readTexR32F(texStroked);
        const strokedP99 = percentileAbs(strokedArr, 99);
        const noiseP99 = percentileAbs(noiseArr, 99);

        const texStrokedN = takeR();
        ctx.runPass({
            entry: PROG.normalize,
            inputs: { u_src: texStroked },
            output: texStrokedN,
            uniforms: { u_invP99: ['1f', strokedP99 > 1e-8 ? 1 / strokedP99 : 0] },
        });
        const texIsoN = takeR();
        ctx.runPass({
            entry: PROG.normalize,
            inputs: { u_src: texNoise },
            output: texIsoN,
            uniforms: { u_invP99: ['1f', noiseP99 > 1e-8 ? 1 / noiseP99 : 0] },
        });
        giveR(texStroked);
        giveR(texNoise);

        const texStrokeField = takeR();
        ctx.runPass({
            entry: PROG.blend,
            inputs: { u_strokedN: texStrokedN, u_isoN: texIsoN, u_thetaCoh: texThetaCoh },
            output: texStrokeField,
            uniforms: {
                u_directionStrength: ['1f', preset.directionStrength],
                u_isoWeight: ['1f', preset.isoWeight],
            },
        });
        giveR(texStrokedN);
        giveR(texIsoN);
        timings.strokes = toc(t);

        /* ============================================================ *
         *  6. paint density mask                                         *
         * ============================================================ */
        t = tic();
        onProgress('paint-density');
        // lum_mean = box(lum); lumSq_mean = box(lum*lum); var = sqMean - mean^2
        const texLumMean = takeR();
        boxBlurR(texLum, texLumMean, 25);
        const texLumSq = takeR();
        ctx.runPass({
            entry: PROG.square,
            inputs: { u_src: texLum },
            output: texLumSq,
        });
        const texLumSqMean = takeR();
        boxBlurR(texLumSq, texLumSqMean, 25);
        giveR(texLumSq);

        const texDensity = takeR();
        ctx.runPass({
            entry: PROG.var2dens,
            inputs: { u_mean: texLumMean, u_sqMean: texLumSqMean },
            output: texDensity,
        });
        giveR(texLumMean);
        giveR(texLumSqMean);

        const texDensitySmooth = takeR();
        gaussianBlurR(texDensity, texDensitySmooth, 5.0);
        giveR(texDensity);

        // p95 readback
        const densityArr = ctx.readTexR32F(texDensitySmooth);
        const densityP95 = percentileAbs(densityArr, 95);

        const texDensityMask = takeR();
        ctx.runPass({
            entry: PROG.finalDens,
            inputs: { u_density: texDensitySmooth, u_lum: texLum },
            output: texDensityMask,
            uniforms: {
                u_invP95: ['1f', densityP95 > 1e-8 ? 1 / densityP95 : 0],
                u_gamma: ['1f', preset.thicknessGamma],
                u_floor: ['1f', preset.thicknessFloor],
            },
        });
        giveR(texDensitySmooth);
        timings.paintDensity = toc(t);

        /* ============================================================ *
         *  7. compose: stroke * density → recenter + rescale + DC off   *
         * ============================================================ */
        t = tic();
        onProgress('compose');
        const texBumpRaw = takeR();
        ctx.runPass({
            entry: PROG.mul,
            inputs: { u_a: texStrokeField, u_b: texDensityMask },
            output: texBumpRaw,
        });
        giveR(texStrokeField);

        const bumpRawArr = ctx.readTexR32F(texBumpRaw);
        const bumpMean = arrMean(bumpRawArr);
        // 中心化后的 p99
        // 不实际中心化整个数组以省时间：percentileAbs 直接给 p99(|x - mean|) 不方便；
        // 折中：percentileAbs 计算后估算。Python 是先减均值再 p99(|x|)。
        // 这里我们临时中心化一份算 p99（一次扫描足够）。
        let p99 = 0;
        {
            const tmp = new Float32Array(bumpRawArr.length);
            for (let i = 0; i < bumpRawArr.length; i++) tmp[i] = bumpRawArr[i] - bumpMean;
            p99 = percentileAbs(tmp, 99);
        }
        const target = Math.max(preset.outputAmplitude, 1e-6);
        const invP99 = p99 > 1e-8 ? 1 / p99 : 0;

        const texBump = takeR();
        ctx.runPass({
            entry: PROG.composeF,
            inputs: { u_raw: texBumpRaw, u_lum: texLum, u_thickness: texDensityMask },
            output: texBump,
            uniforms: {
                u_mean: ['1f', bumpMean],
                u_invP99: ['1f', invP99],
                u_target: ['1f', target],
                u_lumBias: ['1f', preset.luminanceHeightBias],
            },
        });
        giveR(texBumpRaw);
        giveR(texDensityMask);
        giveR(texLum);
        timings.compose = toc(t);

        /* ============================================================ *
         *  8. Unsharp pre-comp                                           *
         * ============================================================ */
        t = tic();
        onProgress('unsharp');
        const texBumpBlur = takeR();
        gaussianBlurR(texBump, texBumpBlur, preset.unsharpSigma);
        const texBumpFinal = takeR();
        ctx.runPass({
            entry: PROG.unsharp,
            inputs: { u_src: texBump, u_blurred: texBumpBlur },
            output: texBumpFinal,
            uniforms: { u_alpha: ['1f', preset.unsharpAlpha] },
        });
        giveR(texBump);
        giveR(texBumpBlur);
        timings.unsharp = toc(t);

        // 最终读回
        const bumpFloat = ctx.readTexR32F(texBumpFinal);
        giveR(texBumpFinal);

        return { bumpFloat, timings };
    } finally {
        ctx.dispose();
    }
}
