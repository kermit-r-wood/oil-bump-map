// scan_replica 风格预设。数值与 pipeline/presets.py 中的 PRESET 一一对应。
//
// 调参时直接改这里：刷新页面就生效。

/**
 * @typedef {Object} StylePreset
 * @property {string} name
 * @property {number} strokeLength             - LIC 笔触长度 (px)
 * @property {number} strokeThickness          - LIC 笔触厚度 (px)
 * @property {number} directionStrength        - 0=各向同性, 1=完全 LIC
 * @property {number} orientationHighpassSigma - 结构张量前的 luminance 高通 σ
 * @property {number} isoWeight                - 低 coherence 区域的各向同性 fallback 权重
 * @property {number} thicknessGamma           - paint-density mask 的 power
 * @property {number} thicknessFloor           - paint-density mask 的下限
 * @property {number} outputAmplitude          - 99 百分位 |bump| 目标
 * @property {number} luminanceHeightBias      - 0=纯 ridge field, 0.5=明显 impasto
 * @property {number} unsharpSigma             - E1 反平滑 σ
 * @property {number} unsharpAlpha             - E1 反平滑强度
 */

/** @type {StylePreset} */
export const PRESET = Object.freeze({
    name: 'scan_replica',
    strokeLength: 32.0,
    strokeThickness: 4.0,
    directionStrength: 1.0,
    orientationHighpassSigma: 8.0,
    isoWeight: 0.0,
    thicknessGamma: 2.0,
    thicknessFloor: 0.0,
    outputAmplitude: 0.22,
    luminanceHeightBias: 0.5,
    unsharpSigma: 1.0,
    unsharpAlpha: 0.5,
});
