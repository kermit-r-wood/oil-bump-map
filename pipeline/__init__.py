"""Oil texture bump map pipeline.

Submodules:
    legacy: simple high-pass bump (backward compatible with original /predict)
    pyramid: Laplacian pyramid decomposition + non-linear band gain
    orientation: RGB structure tensor -> orientation field
    strokes: anisotropic LIC stroke field
    compose: depth-modulated thickness mask + two-layer composer
    postprocess: unsharp pre-compensation + 16-bit PNG quantizer
    presets: fixed style preset table (Van Gogh / Impressionist / Rembrandt)
    runner: end-to-end OilTextureBumpPipeline wrapper
"""
