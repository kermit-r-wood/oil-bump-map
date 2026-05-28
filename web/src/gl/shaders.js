// WebGL2 fragment shaders（GLSL ES 3.00）。
//
// 约定：
//   - 输出纹理是 R32F（单通道）或 RG32F / RGBA32F（多通道）。
//   - sampler 的 wrap mode 已在 helpers.makeTex 设为 MIRRORED_REPEAT，
//     与 CPU 端的 BORDER_REFLECT_101 不完全一致但相差仅边界 1 像素，可接受。
//   - 所有可分离卷积都是两 pass：horizontal（u_dir = (1, 0)）然后 vertical。
//   - kernel 长度上限 65（即 radius ≤ 32）足够 Gaussian σ ≤ 10。
//   - LIC 的步数也上限 65（即 length ≤ 64，超过会被 clip）。

const PI_HALF = '1.5707963267948966';
const PI = '3.141592653589793';

/** RGBA8 → R32F luminance (Rec.601) */
export const FS_RGBA_TO_LUM = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_rgba;
out float frag;
void main() {
    vec4 c = texture(u_rgba, v_uv);
    frag = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}
`;

/** highpass = src - blurred (R32F) */
export const FS_SUBTRACT = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
out float frag;
void main() {
    frag = texture(u_a, v_uv).r - texture(u_b, v_uv).r;
}
`;

/** 单通道可分离 Gaussian: out = sum_k kernel[k] * src(uv + k * texel * dir) */
export const FS_GAUSSIAN_R = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;       // (1/W, 1/H)
uniform vec2 u_dir;         // (1, 0) horizontal, (0, 1) vertical
uniform int u_radius;
uniform float u_kernel[65];
out float frag;
void main() {
    float acc = 0.0;
    for (int k = -32; k <= 32; k++) {
        if (k < -u_radius) continue;
        if (k > u_radius) break;
        vec2 offset = float(k) * u_texel * u_dir;
        acc += u_kernel[k + u_radius] * texture(u_src, v_uv + offset).r;
    }
    frag = acc;
}
`;

/** 4 通道可分离 Gaussian (用于 (Jxx, Jyy, Jxy, _) 同时 blur) */
export const FS_GAUSSIAN_RGBA = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform int u_radius;
uniform float u_kernel[65];
out vec4 frag;
void main() {
    vec4 acc = vec4(0.0);
    for (int k = -32; k <= 32; k++) {
        if (k < -u_radius) continue;
        if (k > u_radius) break;
        vec2 offset = float(k) * u_texel * u_dir;
        acc += u_kernel[k + u_radius] * texture(u_src, v_uv + offset);
    }
    frag = acc;
}
`;

/** 单通道可分离 box filter (uniform 权重 1/(2r+1))，用于 paint density 的方差 */
export const FS_BOXBLUR_R = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
uniform vec2 u_dir;
uniform int u_radius;
out float frag;
void main() {
    float acc = 0.0;
    int n = 2 * u_radius + 1;
    for (int k = -64; k <= 64; k++) {
        if (k < -u_radius) continue;
        if (k > u_radius) break;
        vec2 offset = float(k) * u_texel * u_dir;
        acc += texture(u_src, v_uv + offset).r;
    }
    frag = acc / float(n);
}
`;

/** Sobel 3x3 + 立刻打包 J = (Ix^2, Iy^2, Ix*Iy, 0) */
export const FS_SOBEL_TO_J = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform vec2 u_texel;
out vec4 frag;
void main() {
    vec2 t = u_texel;
    float tl = texture(u_src, v_uv + vec2(-t.x, -t.y)).r;
    float tm = texture(u_src, v_uv + vec2(   0, -t.y)).r;
    float tr = texture(u_src, v_uv + vec2( t.x, -t.y)).r;
    float ml = texture(u_src, v_uv + vec2(-t.x,    0)).r;
    float mr = texture(u_src, v_uv + vec2( t.x,    0)).r;
    float bl = texture(u_src, v_uv + vec2(-t.x,  t.y)).r;
    float bm = texture(u_src, v_uv + vec2(   0,  t.y)).r;
    float br = texture(u_src, v_uv + vec2( t.x,  t.y)).r;
    float ix = (tr - tl) + 2.0 * (mr - ml) + (br - bl);
    float iy = (bl - tl) + 2.0 * (bm - tm) + (br - tr);
    frag = vec4(ix * ix, iy * iy, ix * iy, 0.0);
}
`;

/** (Jxx_s, Jyy_s, Jxy_s, _) → (theta in [0, π), coherence in [0, 1]) */
export const FS_TENSOR_EIGEN = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_J;
out vec2 frag;
void main() {
    vec3 J = texture(u_J, v_uv).rgb;  // xx, yy, xy
    float xx = J.x, yy = J.y, xy = J.z;
    float trace = xx + yy;
    float diff = xx - yy;
    float delta = sqrt(diff * diff + 4.0 * xy * xy);
    float lam1 = 0.5 * (trace + delta);
    float lam2 = 0.5 * (trace - delta);
    float coh = clamp((lam1 - lam2) / (lam1 + lam2 + 1e-8), 0.0, 1.0);
    float theta = 0.5 * atan(2.0 * xy, diff) + ${PI_HALF};
    theta = mod(theta, ${PI});
    if (theta < 0.0) theta += ${PI};
    frag = vec2(theta, coh);
}
`;

/** LIC streamline: 沿 (cos θ, sin θ) 累计 noise，平均。
 *  约定：像素 0 中心 = 整数坐标 0（与 CPU 端一致）。手工 bilinear。 */
export const FS_LIC_STREAM = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform highp sampler2D u_thetaCoh;   // RG32F (theta, coherence) ; 我们只用 .r
uniform highp sampler2D u_noise;      // R32F
uniform vec2 u_size;            // (W, H)
uniform vec2 u_invSize;
uniform int u_half;
out float frag;

int reflect101(int i, int n) {
    if (n <= 1) return 0;
    int p = 2 * (n - 1);
    int m = i;
    m = m - (m / p) * p;
    if (m < 0) m += p;
    return m < n ? m : p - m;
}

void main() {
    int W = int(u_size.x);
    int H = int(u_size.y);
    ivec2 g = ivec2(gl_FragCoord.xy);    // 像素整数坐标
    float theta = texelFetch(u_thetaCoh, g, 0).r;
    float dx = cos(theta);
    float dy = sin(theta);
    float acc = 0.0;
    int n = 2 * u_half + 1;
    float px = float(g.x);
    float py = float(g.y);
    for (int k = -64; k <= 64; k++) {
        if (k < -u_half) continue;
        if (k > u_half) break;
        float sx = px + float(k) * dx;
        float sy = py + float(k) * dy;
        float x0f = floor(sx);
        float y0f = floor(sy);
        float fx = sx - x0f;
        float fy = sy - y0f;
        int x0 = reflect101(int(x0f), W);
        int x1 = reflect101(int(x0f) + 1, W);
        int y0 = reflect101(int(y0f), H);
        int y1 = reflect101(int(y0f) + 1, H);
        float v00 = texelFetch(u_noise, ivec2(x0, y0), 0).r;
        float v01 = texelFetch(u_noise, ivec2(x1, y0), 0).r;
        float v10 = texelFetch(u_noise, ivec2(x0, y1), 0).r;
        float v11 = texelFetch(u_noise, ivec2(x1, y1), 0).r;
        float top = v00 * (1.0 - fx) + v01 * fx;
        float bot = v10 * (1.0 - fx) + v11 * fx;
        acc += top * (1.0 - fy) + bot * fy;
    }
    frag = acc / float(n);
}
`;

/** LIC perpendicular thickness blur */
export const FS_LIC_THICK = /* glsl */`#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform highp sampler2D u_stroked;
uniform highp sampler2D u_thetaCoh;
uniform vec2 u_size;
uniform vec2 u_invSize;
uniform int u_thalf;
uniform float u_weights[65];
out float frag;

int reflect101(int i, int n) {
    if (n <= 1) return 0;
    int p = 2 * (n - 1);
    int m = i;
    m = m - (m / p) * p;
    if (m < 0) m += p;
    return m < n ? m : p - m;
}

void main() {
    int W = int(u_size.x);
    int H = int(u_size.y);
    ivec2 g = ivec2(gl_FragCoord.xy);
    float theta = texelFetch(u_thetaCoh, g, 0).r;
    float dx = cos(theta);
    float dy = sin(theta);
    float acc = 0.0;
    float px = float(g.x);
    float py = float(g.y);
    for (int k = -32; k <= 32; k++) {
        if (k < -u_thalf) continue;
        if (k > u_thalf) break;
        // perp 方向 = (cos θ, -sin θ)
        float sx = px + float(k) * dx;
        float sy = py + float(k) * (-dy);
        float x0f = floor(sx);
        float y0f = floor(sy);
        float fx = sx - x0f;
        float fy = sy - y0f;
        int x0 = reflect101(int(x0f), W);
        int x1 = reflect101(int(x0f) + 1, W);
        int y0 = reflect101(int(y0f), H);
        int y1 = reflect101(int(y0f) + 1, H);
        float v00 = texelFetch(u_stroked, ivec2(x0, y0), 0).r;
        float v01 = texelFetch(u_stroked, ivec2(x1, y0), 0).r;
        float v10 = texelFetch(u_stroked, ivec2(x0, y1), 0).r;
        float v11 = texelFetch(u_stroked, ivec2(x1, y1), 0).r;
        float top = v00 * (1.0 - fx) + v01 * fx;
        float bot = v10 * (1.0 - fx) + v11 * fx;
        acc += u_weights[k + u_thalf] * (top * (1.0 - fy) + bot * fy);
    }
    frag = acc;
}
`;

/** 归一化（除以已经在 CPU 上算好的 p99）+ clamp 到 [-1, 1] */
export const FS_NORMALIZE_UNIT = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform float u_invP99;     // 1 / p99，p99 < eps 时主代码传 0
out float frag;
void main() {
    float v = texture(u_src, v_uv).r * u_invP99;
    frag = clamp(v, -1.0, 1.0);
}
`;

/** stroke field 混合：blend = clamp(coherence * directionStrength, 0, 1)
 *  out = blend * strokedN + (1 - blend) * isoN * isoWeight
 */
export const FS_BLEND_STROKE = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_strokedN;
uniform sampler2D u_isoN;
uniform sampler2D u_thetaCoh;   // .g = coherence
uniform float u_directionStrength;
uniform float u_isoWeight;
out float frag;
void main() {
    float strokedN = texture(u_strokedN, v_uv).r;
    float isoN = texture(u_isoN, v_uv).r;
    float coh = texture(u_thetaCoh, v_uv).g;
    float b = clamp(coh * u_directionStrength, 0.0, 1.0);
    frag = b * strokedN + (1.0 - b) * isoN * u_isoWeight;
}
`;

/** lum^2 */
export const FS_SQUARE = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
out float frag;
void main() {
    float v = texture(u_src, v_uv).r;
    frag = v * v;
}
`;

/** density = sqrt(max(0, sqMean - mean^2)) */
export const FS_VARIANCE_TO_DENSITY = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_mean;
uniform sampler2D u_sqMean;
out float frag;
void main() {
    float m = texture(u_mean, v_uv).r;
    float s = texture(u_sqMean, v_uv).r;
    float v = s - m * m;
    if (v < 0.0) v = 0.0;
    frag = sqrt(v);
}
`;

/** density mask 后处理：v = density / p95，再 lum 加权，gamma，floor */
export const FS_FINALIZE_DENSITY = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_density;
uniform sampler2D u_lum;
uniform float u_invP95;
uniform float u_gamma;
uniform float u_floor;
out float frag;
void main() {
    float d = texture(u_density, v_uv).r * u_invP95;
    d = clamp(d, 0.0, 1.0);
    float lum = clamp(texture(u_lum, v_uv).r, 0.0, 1.0);
    d = d * (0.5 + lum);
    d = clamp(d, 0.0, 1.0);
    d = pow(d, max(u_gamma, 1e-3));
    if (u_floor > 0.0) d = u_floor + (1.0 - u_floor) * d;
    frag = d;
}
`;

/** 简单 multiply: out = a * b */
export const FS_MULTIPLY = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_a;
uniform sampler2D u_b;
out float frag;
void main() {
    frag = texture(u_a, v_uv).r * texture(u_b, v_uv).r;
}
`;

/** compose 后处理: bump = (raw - mean) * (target / p99); clip; +lum DC offset */
export const FS_COMPOSE_FINALIZE = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_raw;
uniform sampler2D u_lum;
uniform sampler2D u_thickness;
uniform float u_mean;
uniform float u_invP99;
uniform float u_target;
uniform float u_lumBias;
out float frag;
void main() {
    float v = (texture(u_raw, v_uv).r - u_mean) * u_invP99 * u_target;
    v = clamp(v, -u_target, u_target);
    if (u_lumBias > 0.0) {
        float lum = texture(u_lum, v_uv).r;
        float thk = texture(u_thickness, v_uv).r;
        v += (lum - 0.5) * 2.0 * thk * u_lumBias;
    }
    frag = v;
}
`;

/** unsharp: out = src + alpha * (src - blurred) */
export const FS_UNSHARP = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_src;
uniform sampler2D u_blurred;
uniform float u_alpha;
out float frag;
void main() {
    float s = texture(u_src, v_uv).r;
    float b = texture(u_blurred, v_uv).r;
    frag = s + u_alpha * (s - b);
}
`;
