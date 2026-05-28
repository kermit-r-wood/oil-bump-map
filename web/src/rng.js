// 确定性 PRNG。
//
// Python 端用的是 numpy.random.default_rng(seed)（PCG64），我们这里换成
// Mulberry32 + Box-Muller —— 不会与 numpy 逐位一致，但保证：
//   1. 同一 seed 生成的整张噪声场完全可复现；
//   2. 期望、方差、空间无关性等统计性质与 numpy 等价；
//   3. 实现极小（< 30 行），无依赖。
//
// LIC 阶段对噪声的需求只是 "i.i.d. N(0, 1)"，跨语言逐位一致并不重要。

/**
 * 32-bit 整数种子 → 32-bit uint 流。
 *
 * @param {number} seed
 * @returns {() => number} 返回 [0, 1) 内的 float
 */
export function mulberry32(seed) {
    let a = (seed | 0) >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * 用 Box-Muller 把均匀分布转换成标准正态。每两次 uniform 调用产出两个高斯样本。
 *
 * @param {() => number} uniform
 * @returns {() => number}
 */
export function makeStandardNormal(uniform) {
    let cached = null;
    return function () {
        if (cached !== null) {
            const v = cached;
            cached = null;
            return v;
        }
        // 避免 log(0)
        let u1 = uniform();
        if (u1 < 1e-12) u1 = 1e-12;
        const u2 = uniform();
        const r = Math.sqrt(-2.0 * Math.log(u1));
        const theta = 2.0 * Math.PI * u2;
        cached = r * Math.sin(theta);
        return r * Math.cos(theta);
    };
}

/**
 * 给定 seed，填充一个 Float32Array 长度为 n 的标准正态噪声。
 *
 * @param {number} n
 * @param {number} seed
 * @returns {Float32Array}
 */
export function standardNormalArray(n, seed) {
    const uniform = mulberry32(seed);
    const normal = makeStandardNormal(uniform);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = normal();
    return out;
}
