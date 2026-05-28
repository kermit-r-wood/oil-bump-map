// 基础像素级滤波器：Gaussian、box、Sobel、双线性采样、percentile。
//
// 约定：
// - 所有 2D 数据都用 Float32Array，行主序：pixel(y, x) = arr[y * W + x]。
// - 边界都用 BORDER_REFLECT_101（无边缘重复，对应 OpenCV 默认）。
// - Gaussian / box 都是可分离卷积，O(W*H*ksize)；box 用 running sum 优化为 O(W*H)。

/**
 * BORDER_REFLECT_101 索引：...3 2 1 | 0 1 2 3 4 | 3 2 1...
 *
 * @param {number} i
 * @param {number} n
 * @returns {number}
 */
function reflect101(i, n) {
    if (n <= 1) return 0;
    const period = 2 * (n - 1);
    let m = i % period;
    if (m < 0) m += period;
    return m < n ? m : period - m;
}

/* -------------------------------------------------------------------- *
 *  Gaussian blur (separable)                                            *
 * -------------------------------------------------------------------- */

function gaussianKernel1D(sigma) {
    const radius = Math.max(1, Math.ceil(3 * sigma));
    const size = 2 * radius + 1;
    const k = new Float32Array(size);
    const inv2s2 = 1.0 / (2.0 * sigma * sigma);
    let sum = 0.0;
    for (let i = -radius; i <= radius; i++) {
        const v = Math.exp(-i * i * inv2s2);
        k[i + radius] = v;
        sum += v;
    }
    for (let i = 0; i < size; i++) k[i] /= sum;
    return { kernel: k, radius };
}

/**
 * 2D Gaussian blur.
 *
 * @param {Float32Array} src
 * @param {number} W
 * @param {number} H
 * @param {number} sigma
 * @returns {Float32Array}
 */
export function gaussianBlur(src, W, H, sigma) {
    if (sigma <= 0) return src.slice();
    const { kernel, radius } = gaussianKernel1D(sigma);
    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);

    // Horizontal pass: src -> tmp
    for (let y = 0; y < H; y++) {
        const rowOff = y * W;
        for (let x = 0; x < W; x++) {
            let acc = 0.0;
            for (let k = -radius; k <= radius; k++) {
                const xi = reflect101(x + k, W);
                acc += src[rowOff + xi] * kernel[k + radius];
            }
            tmp[rowOff + x] = acc;
        }
    }
    // Vertical pass: tmp -> out
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            let acc = 0.0;
            for (let k = -radius; k <= radius; k++) {
                const yi = reflect101(y + k, H);
                acc += tmp[yi * W + x] * kernel[k + radius];
            }
            out[y * W + x] = acc;
        }
    }
    return out;
}

/* -------------------------------------------------------------------- *
 *  Box filter (separable; running sum)                                  *
 * -------------------------------------------------------------------- */

/**
 * Per-row running sum box filter, normalize by window size.
 * 边界也用 reflect101，但实现是 "mirror padding + running sum" 的等价形式：
 * 我们直接把每一行扩展成对称数组的一段，再算前缀和。
 */
function boxFilter1D(srcRow, dstRow, n, radius) {
    if (radius <= 0) {
        for (let i = 0; i < n; i++) dstRow[i] = srcRow[i];
        return;
    }
    const win = 2 * radius + 1;
    const inv = 1.0 / win;
    // 直接每个目标像素累加（可读，速度对 W*H * (2r+1) 这一项依赖；够用）。
    // 为了 4K 速度，我们用累计和：先构造 prefix[0..n+2r] 含 reflect padding。
    const padded = new Float64Array(n + 2 * radius + 1); // n + 2r 个像素 + 一个 0 前缀
    // padded[1+i] = srcRow[reflect101(i - radius, n)]，i in 0..n+2r-1
    for (let i = 0; i < n + 2 * radius; i++) {
        padded[i + 1] = padded[i] + srcRow[reflect101(i - radius, n)];
    }
    // out[x] = (prefix[x + 2r + 1] - prefix[x]) / win
    for (let x = 0; x < n; x++) {
        dstRow[x] = (padded[x + win] - padded[x]) * inv;
    }
}

/**
 * 2D box filter，归一化。窗口 = 2*radius+1。
 *
 * @param {Float32Array} src
 * @param {number} W
 * @param {number} H
 * @param {number} radius
 * @returns {Float32Array}
 */
export function boxFilter(src, W, H, radius) {
    if (radius <= 0) return src.slice();
    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);

    // Horizontal
    const rowSrc = new Float32Array(W);
    const rowDst = new Float32Array(W);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) rowSrc[x] = src[y * W + x];
        boxFilter1D(rowSrc, rowDst, W, radius);
        for (let x = 0; x < W; x++) tmp[y * W + x] = rowDst[x];
    }
    // Vertical (沿列做)
    const colSrc = new Float32Array(H);
    const colDst = new Float32Array(H);
    for (let x = 0; x < W; x++) {
        for (let y = 0; y < H; y++) colSrc[y] = tmp[y * W + x];
        boxFilter1D(colSrc, colDst, H, radius);
        for (let y = 0; y < H; y++) out[y * W + x] = colDst[y];
    }
    return out;
}

/* -------------------------------------------------------------------- *
 *  Sobel 3x3                                                            *
 * -------------------------------------------------------------------- */

/**
 * Sobel x：可分离 = horizontal [-1, 0, 1] 然后 vertical [1, 2, 1]。
 *
 * @param {Float32Array} src
 * @param {number} W
 * @param {number} H
 * @returns {Float32Array}
 */
export function sobelX(src, W, H) {
    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);
    // horizontal [-1, 0, 1]
    for (let y = 0; y < H; y++) {
        const off = y * W;
        for (let x = 0; x < W; x++) {
            const xm = reflect101(x - 1, W);
            const xp = reflect101(x + 1, W);
            tmp[off + x] = src[off + xp] - src[off + xm];
        }
    }
    // vertical [1, 2, 1]
    for (let y = 0; y < H; y++) {
        const ym = reflect101(y - 1, H);
        const yp = reflect101(y + 1, H);
        for (let x = 0; x < W; x++) {
            out[y * W + x] = tmp[ym * W + x] + 2 * tmp[y * W + x] + tmp[yp * W + x];
        }
    }
    return out;
}

/**
 * Sobel y：可分离 = horizontal [1, 2, 1] 然后 vertical [-1, 0, 1]。
 */
export function sobelY(src, W, H) {
    const tmp = new Float32Array(W * H);
    const out = new Float32Array(W * H);
    // horizontal [1, 2, 1]
    for (let y = 0; y < H; y++) {
        const off = y * W;
        for (let x = 0; x < W; x++) {
            const xm = reflect101(x - 1, W);
            const xp = reflect101(x + 1, W);
            tmp[off + x] = src[off + xm] + 2 * src[off + x] + src[off + xp];
        }
    }
    // vertical [-1, 0, 1]
    for (let y = 0; y < H; y++) {
        const ym = reflect101(y - 1, H);
        const yp = reflect101(y + 1, H);
        for (let x = 0; x < W; x++) {
            out[y * W + x] = tmp[yp * W + x] - tmp[ym * W + x];
        }
    }
    return out;
}

/* -------------------------------------------------------------------- *
 *  Bilinear sampling at fractional coords (for LIC)                     *
 * -------------------------------------------------------------------- */

/**
 * 对 src 在浮点坐标 (sampleY, sampleX) 上做双线性采样，写入 dst。
 * 边界用 reflect101。等价于 scipy.ndimage.map_coordinates(order=1, mode='reflect'/'mirror'）
 * （注意 scipy 'reflect' 和 OpenCV 默认有差，但对内部像素无影响；这里
 * 统一用 reflect101，与其他滤波器边界一致）。
 *
 * @param {Float32Array} src
 * @param {number} W
 * @param {number} H
 * @param {Float32Array} sampleY
 * @param {Float32Array} sampleX
 * @param {Float32Array} dst
 */
export function bilinearSampleInto(src, W, H, sampleY, sampleX, dst) {
    const N = sampleY.length;
    for (let i = 0; i < N; i++) {
        const sy = sampleY[i];
        const sx = sampleX[i];
        const y0f = Math.floor(sy);
        const x0f = Math.floor(sx);
        const fy = sy - y0f;
        const fx = sx - x0f;
        const y0 = reflect101(y0f, H);
        const y1 = reflect101(y0f + 1, H);
        const x0 = reflect101(x0f, W);
        const x1 = reflect101(x0f + 1, W);
        const v00 = src[y0 * W + x0];
        const v01 = src[y0 * W + x1];
        const v10 = src[y1 * W + x0];
        const v11 = src[y1 * W + x1];
        const top = v00 * (1 - fx) + v01 * fx;
        const bot = v10 * (1 - fx) + v11 * fx;
        dst[i] = top * (1 - fy) + bot * fy;
    }
}

/* -------------------------------------------------------------------- *
 *  Percentile                                                           *
 * -------------------------------------------------------------------- */

/**
 * 直方图近似的 |arr| 的第 p 百分位（p in [0, 100]）。
 * 对 16M 像素也只是一次扫描 + 一次累加，毫秒级；精度 ≈ (max-min)/bins。
 *
 * @param {Float32Array} arr
 * @param {number} p
 * @param {number} bins
 * @returns {number}
 */
export function percentileAbs(arr, p, bins = 4096) {
    const n = arr.length;
    if (n === 0) return 0;

    // 1st pass: max(|arr|)
    let maxAbs = 0;
    for (let i = 0; i < n; i++) {
        const v = arr[i];
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs <= 1e-12) return 0;

    // 2nd pass: histogram
    const hist = new Int32Array(bins);
    const scale = bins / maxAbs;
    for (let i = 0; i < n; i++) {
        const v = arr[i];
        const a = v < 0 ? -v : v;
        let b = (a * scale) | 0;
        if (b >= bins) b = bins - 1;
        hist[b]++;
    }
    // 累计找到第 p 百分位所在 bin
    const target = (p / 100) * n;
    let cum = 0;
    for (let b = 0; b < bins; b++) {
        cum += hist[b];
        if (cum >= target) {
            // bin 中心
            return (b + 0.5) * (maxAbs / bins);
        }
    }
    return maxAbs;
}

/* -------------------------------------------------------------------- *
 *  Misc utilities                                                       *
 * -------------------------------------------------------------------- */

/**
 * 数组均值。
 *
 * @param {Float32Array} arr
 * @returns {number}
 */
export function mean(arr) {
    let s = 0.0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
}

/**
 * 把 arr clip 到 [lo, hi]，原地。
 *
 * @param {Float32Array} arr
 * @param {number} lo
 * @param {number} hi
 */
export function clipInPlace(arr, lo, hi) {
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        arr[i] = v < lo ? lo : (v > hi ? hi : v);
    }
}
