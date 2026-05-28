// 极小的 16-bit / 8-bit 灰度 PNG 编码器。
//
// 不依赖任何第三方库。zlib(deflate) 部分用浏览器原生 CompressionStream API。
//
// PNG 结构（参见 RFC 2083 / W3C PNG spec）:
//   8 字节签名 + IHDR + IDAT(s) + IEND
//
// 这里输出的是单 IDAT、color type 0 (grayscale)、bit depth 8 或 16、filter type 0 的最简形式，
// 每个 chunk 自带 4 字节长度 + 4 字节类型 + 数据 + 4 字节 CRC32。
//
// 浏览器要求：CompressionStream 'deflate' 在 Chrome 80+ / Safari 16.4+ / Firefox 113+ 可用。

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) {
        c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeU32BE(buf, off, value) {
    buf[off] = (value >>> 24) & 0xFF;
    buf[off + 1] = (value >>> 16) & 0xFF;
    buf[off + 2] = (value >>> 8) & 0xFF;
    buf[off + 3] = value & 0xFF;
}

/**
 * 构造一个 PNG chunk（length + type + data + CRC32）。
 *
 * @param {string} type 4-char ASCII，例如 "IHDR"
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function buildChunk(type, data) {
    if (type.length !== 4) throw new Error('chunk type must be 4 chars');
    const out = new Uint8Array(4 + 4 + data.length + 4);
    writeU32BE(out, 0, data.length);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    const crc = crc32(out, 4, 8 + data.length);
    writeU32BE(out, 8 + data.length, crc);
    return out;
}

function buildIHDR(width, height, bitDepth) {
    const data = new Uint8Array(13);
    writeU32BE(data, 0, width);
    writeU32BE(data, 4, height);
    data[8] = bitDepth;     // 8 or 16
    data[9] = 0;            // color type 0 = grayscale
    data[10] = 0;           // compression method 0
    data[11] = 0;           // filter method 0
    data[12] = 0;           // interlace 0 (no interlace)
    return buildChunk('IHDR', data);
}

/**
 * 把整数像素数组转成 PNG 扫描线字节流。每行前缀 1 个 filter byte (0 = None)。
 * 16-bit 灰度按大端写入。
 *
 * @param {Uint16Array | Uint8Array} arr
 * @param {number} width
 * @param {number} height
 * @param {8 | 16} bitDepth
 * @returns {Uint8Array}
 */
function buildScanlines(arr, width, height, bitDepth) {
    if (arr.length !== width * height) throw new Error('pixel count mismatch');
    const bytesPerPx = bitDepth === 16 ? 2 : 1;
    const stride = 1 + width * bytesPerPx;
    const out = new Uint8Array(stride * height);
    if (bitDepth === 16) {
        for (let y = 0; y < height; y++) {
            const off = y * stride;
            out[off] = 0; // filter None
            const rowStart = y * width;
            for (let x = 0; x < width; x++) {
                const v = arr[rowStart + x];
                out[off + 1 + x * 2] = (v >>> 8) & 0xFF;
                out[off + 2 + x * 2] = v & 0xFF;
            }
        }
    } else {
        for (let y = 0; y < height; y++) {
            const off = y * stride;
            out[off] = 0;
            const rowStart = y * width;
            for (let x = 0; x < width; x++) {
                out[off + 1 + x] = arr[rowStart + x];
            }
        }
    }
    return out;
}

/**
 * 用浏览器原生 CompressionStream 做 deflate（zlib 格式，RFC 1950）。
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function deflate(bytes) {
    if (typeof CompressionStream === 'undefined') {
        throw new Error('CompressionStream API 不可用，请使用现代浏览器（Chrome 80+ / Firefox 113+ / Safari 16.4+）');
    }
    const stream = new Response(bytes).body.pipeThrough(new CompressionStream('deflate'));
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
}

function concat(...arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) {
        out.set(a, off);
        off += a.length;
    }
    return out;
}

/**
 * 编码一张灰度 PNG。
 *
 * @param {Uint16Array | Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {8 | 16} bitDepth
 * @returns {Promise<Uint8Array>}
 */
export async function encodeGrayPng(pixels, width, height, bitDepth) {
    if (bitDepth !== 8 && bitDepth !== 16) {
        throw new Error(`bitDepth must be 8 or 16, got ${bitDepth}`);
    }
    if (bitDepth === 16 && !(pixels instanceof Uint16Array)) {
        throw new Error('16-bit PNG requires Uint16Array input');
    }
    if (bitDepth === 8 && !(pixels instanceof Uint8Array)) {
        throw new Error('8-bit PNG requires Uint8Array input');
    }
    const ihdr = buildIHDR(width, height, bitDepth);
    const scanlines = buildScanlines(pixels, width, height, bitDepth);
    const compressed = await deflate(scanlines);
    const idat = buildChunk('IDAT', compressed);
    const iend = buildChunk('IEND', new Uint8Array(0));
    return concat(PNG_SIGNATURE, ihdr, idat, iend);
}

/**
 * 同上，返回 Blob，便于直接给 <img>.src 或 download 链接。
 */
export async function encodeGrayPngBlob(pixels, width, height, bitDepth) {
    const bytes = await encodeGrayPng(pixels, width, height, bitDepth);
    return new Blob([bytes], { type: 'image/png' });
}
