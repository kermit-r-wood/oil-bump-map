// WebGL2 context 创建 + 浮点扩展嗅探。
//
// 单个 OffscreenCanvas + WebGL2 context per pipeline 调用。dispose() 释放。

/**
 * @returns {{ok: boolean, gl?: WebGL2RenderingContext, canvas?: OffscreenCanvas | HTMLCanvasElement, reason?: string}}
 */
export function makeContext(W = 16, H = 16) {
    let canvas;
    if (typeof OffscreenCanvas !== 'undefined') {
        canvas = new OffscreenCanvas(W, H);
    } else if (typeof document !== 'undefined') {
        canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
    } else {
        return { ok: false, reason: 'no canvas constructor (Node?)' };
    }
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) return { ok: false, reason: 'WebGL2 unavailable' };

    // EXT_color_buffer_float 是把 RGBA32F / R32F 渲染到 framebuffer 的关键扩展。
    // WebGL2 baseline 不一定包含；现代桌面浏览器都有。
    const ext = gl.getExtension('EXT_color_buffer_float');
    if (!ext) {
        return { ok: false, reason: 'EXT_color_buffer_float not supported' };
    }
    return { ok: true, gl, canvas };
}

/**
 * 编译 shader，失败抛错带源码。
 */
export function compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
        throw new Error(`${kind} shader compile error:\n${log}\n--- source ---\n${source}`);
    }
    return sh;
}

/**
 * 链接 program。
 */
export function linkProgram(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        gl.deleteProgram(p);
        throw new Error(`program link error:\n${log}`);
    }
    return p;
}

/**
 * 通用全屏 quad VS：
 *   in vec2 a_pos in [-1, 1] × [-1, 1]，输出 v_uv ∈ [0, 1]
 */
export const FULLSCREEN_VS = /* glsl */`#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;
