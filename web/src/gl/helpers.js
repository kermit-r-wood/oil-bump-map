// GL helpers: program builder, texture/FBO 包装, fullscreen quad VAO。
//
// 用法：
//   const ctx = makeWebglContext(W, H);
//   const prog = ctx.makeProgram(fragSrc);
//   const tex = ctx.makeTexR32F();
//   ctx.runPass({program: prog, inputs: {u_src: srcTex}, output: tex, uniforms: {...}});
//   const out = ctx.readTexR32F(tex);   // Float32Array
//   ctx.dispose();

import { makeContext, compileShader, linkProgram, FULLSCREEN_VS } from './context.js';

/**
 * 创建一个完整的 WebGL2 工作环境，所有 stage 都共享 viewport / quad VAO / context。
 *
 * @param {number} W
 * @param {number} H
 */
export function makeWebglContext(W, H) {
    const r = makeContext(W, H);
    if (!r.ok) throw new Error(`WebGL2 unavailable: ${r.reason}`);
    const gl = r.gl;
    const canvas = r.canvas;
    canvas.width = W;
    canvas.height = H;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // 全屏 quad，两个三角形覆盖 NDC。
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1,  1, -1, -1, 1,
        -1,  1,  1, -1,  1, 1,
    ]), gl.STATIC_DRAW);

    const fbo = gl.createFramebuffer();

    // 编译共享 vertex shader
    const sharedVS = compileShader(gl, gl.VERTEX_SHADER, FULLSCREEN_VS);

    const programs = new Map(); // fragSrc → {program, attribLoc, uniformLocs}
    const textures = new Set();

    function makeProgram(fragSrc) {
        if (programs.has(fragSrc)) return programs.get(fragSrc);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
        const program = linkProgram(gl, sharedVS, fs);
        gl.deleteShader(fs);
        const aPos = gl.getAttribLocation(program, 'a_pos');
        const entry = { program, aPos, uniformLocs: new Map() };
        programs.set(fragSrc, entry);
        return entry;
    }

    function getUniformLoc(entry, name) {
        if (entry.uniformLocs.has(name)) return entry.uniformLocs.get(name);
        const loc = gl.getUniformLocation(entry.program, name);
        entry.uniformLocs.set(name, loc);
        return loc;
    }

    function makeTex(internalFormat, format, type, w = W, h = H) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texStorage2D(gl.TEXTURE_2D, 1, internalFormat, w, h);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
        const obj = { tex: t, w, h, internalFormat, format, type };
        textures.add(obj);
        return obj;
    }

    function makeTexR32F(w, h) { return makeTex(gl.R32F, gl.RED, gl.FLOAT, w, h); }
    function makeTexRG32F(w, h) { return makeTex(gl.RG32F, gl.RG, gl.FLOAT, w, h); }
    function makeTexRGBA32F(w, h) { return makeTex(gl.RGBA32F, gl.RGBA, gl.FLOAT, w, h); }
    function makeTexRGBA8(w, h) { return makeTex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, w, h); }

    function uploadFloat32ToTex(tex, data, w = tex.w, h = tex.h) {
        gl.bindTexture(gl.TEXTURE_2D, tex.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, tex.format, tex.type, data);
    }

    function uploadRGBA8ToTex(tex, data, w = tex.w, h = tex.h) {
        gl.bindTexture(gl.TEXTURE_2D, tex.tex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    /**
     * 把单通道 R32F texture 读回 Float32Array(W*H)。
     * WebGL2 的 readPixels 对单通道 R32F 不直接支持，需要 RGBA32F 或先把 framebuffer attach 成 R32F，
     * 然后用 RED + FLOAT 读回。我们走 attach-as-R32F + RED+FLOAT。
     */
    function readTexR32F(tex) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`readTexR32F: FBO incomplete 0x${status.toString(16)}`);
        }
        // 部分驱动只允许通过 IMPLEMENTATION_COLOR_READ_FORMAT 读，但 R32F → RED+FLOAT 通常 OK
        const out = new Float32Array(tex.w * tex.h);
        gl.readPixels(0, 0, tex.w, tex.h, gl.RED, gl.FLOAT, out);
        return out;
    }

    /**
     * 运行一个 pass：把 inputs 绑到 sampler，把 uniforms 设置好，渲染到 output 纹理。
     * uniforms: {name: [type, ...args]}, e.g. { u_size: ['2f', W, H], u_radius: ['1i', 5] }
     */
    function runPass({ entry, inputs = {}, output, uniforms = {} }) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, output.tex, 0);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
            throw new Error(`runPass: FBO incomplete 0x${status.toString(16)}`);
        }
        gl.viewport(0, 0, output.w, output.h);
        gl.useProgram(entry.program);
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.enableVertexAttribArray(entry.aPos);
        gl.vertexAttribPointer(entry.aPos, 2, gl.FLOAT, false, 0, 0);

        // bind input samplers
        let unit = 0;
        for (const [name, tex] of Object.entries(inputs)) {
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, tex.tex);
            const loc = getUniformLoc(entry, name);
            if (loc !== null) gl.uniform1i(loc, unit);
            unit++;
        }
        // set uniforms
        for (const [name, args] of Object.entries(uniforms)) {
            const loc = getUniformLoc(entry, name);
            if (loc === null) continue;
            const [type, ...vals] = args;
            switch (type) {
                case '1i': gl.uniform1i(loc, vals[0]); break;
                case '1f': gl.uniform1f(loc, vals[0]); break;
                case '2f': gl.uniform2f(loc, vals[0], vals[1]); break;
                case '3f': gl.uniform3f(loc, vals[0], vals[1], vals[2]); break;
                case '4f': gl.uniform4f(loc, vals[0], vals[1], vals[2], vals[3]); break;
                case '1fv': gl.uniform1fv(loc, vals[0]); break;
                default: throw new Error(`unknown uniform type: ${type}`);
            }
        }
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    function dispose() {
        for (const t of textures) gl.deleteTexture(t.tex);
        textures.clear();
        for (const { program } of programs.values()) gl.deleteProgram(program);
        programs.clear();
        gl.deleteShader(sharedVS);
        gl.deleteFramebuffer(fbo);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
        // OffscreenCanvas 没有 close()，让它被 GC
    }

    return {
        gl, canvas, W, H,
        makeProgram,
        makeTexR32F, makeTexRG32F, makeTexRGBA32F, makeTexRGBA8,
        uploadFloat32ToTex, uploadRGBA8ToTex,
        readTexR32F,
        runPass,
        dispose,
    };
}
