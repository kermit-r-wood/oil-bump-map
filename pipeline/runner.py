"""End-to-end scan_replica bump pipeline (RGB-only, no depth).

    OilTextureBumpPipeline.run(rgb_uint8) -> uint16 ndarray

scan_replica is RGB-only: a paint-density mask (variance-driven, luminance-
weighted) modulates an anisotropic LIC stroke field; a luminance-driven DC
offset adds bulk paint thickness; unsharp pre-compensation counteracts the
E1 printer's slicing-time smoothing.

Output
------
uint16 ndarray of shape (H, W); range [0, 65535] suitable for direct PIL
save as a 16-bit PNG (`pipeline.postprocess.quantize_to_png_bytes` returns
the encoded bytes).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .compose import compose_bump, paint_density_mask
from .orientation import structure_tensor_orientation
from .postprocess import (
    precompensate_for_printer,
    quantize_to_array,
    quantize_to_png_bytes,
)
from .presets import PRESET, StylePreset
from .strokes import directional_stroke_field


def _luminance(rgb_uint8: np.ndarray) -> np.ndarray:
    """Rec.601 luminance in [0, 1] from a uint8 RGB."""
    if rgb_uint8.ndim != 3 or rgb_uint8.shape[2] not in (3, 4):
        raise ValueError(
            f"rgb_uint8 must be (H, W, 3 or 4); got {rgb_uint8.shape}"
        )
    f = rgb_uint8[..., :3].astype(np.float32) / 255.0
    return (
        0.299 * f[..., 0] + 0.587 * f[..., 1] + 0.114 * f[..., 2]
    ).astype(np.float32)


@dataclass
class PipelineResult:
    """Bundle returned by :meth:`OilTextureBumpPipeline.run_full`."""

    bump_float: np.ndarray   # centered float, roughly in [-amp, +amp]
    bump_uint16: np.ndarray  # quantized ndarray ready to save


class OilTextureBumpPipeline:
    """Deterministic in-process transformer from RGB to scan_replica bump map.

    Parameters
    ----------
    seed : int
        RNG seed for the LIC stroke field; identical seed -> identical
        output for the same input.
    """

    def __init__(self, seed: int = 1234):
        self.seed = int(seed)

    # ------------------------------------------------------------------
    # Internal stage
    # ------------------------------------------------------------------

    def _bump_float(
        self, rgb_uint8: np.ndarray, preset: StylePreset
    ) -> np.ndarray:
        lum = _luminance(rgb_uint8)

        # 1. Stroke field: structure-tensor orientation + LIC noise.
        theta, coherence = structure_tensor_orientation(
            rgb_uint8,
            sigma=2.0,
            pre_highpass_sigma=preset.orientation_highpass_sigma,
        )
        stroke = directional_stroke_field(
            theta,
            coherence,
            length=preset.stroke_length,
            thickness=preset.stroke_thickness,
            seed=self.seed,
            direction_strength=preset.direction_strength,
            iso_weight=preset.iso_weight,
        )

        # 2. Paint-density thickness mask (RGB-only, luminance-driven).
        thickness = paint_density_mask(
            lum,
            gamma=preset.thickness_gamma,
            floor=preset.thickness_floor,
        )

        # 3. Stroke × thickness, recentered + rescaled.
        bump = compose_bump(
            stroke_field=stroke,
            thickness=thickness,
            output_amplitude=preset.output_amplitude,
            recenter=True,
        )

        # 4. Luminance-driven DC offset: bright textured regions
        # persistently raised, dark textured regions recessed, smooth
        # regions stay mid-gray.
        if preset.luminance_height_bias > 0.0:
            height_dc = (
                (lum - 0.5) * 2.0 * thickness
                * float(preset.luminance_height_bias)
            ).astype(np.float32)
            bump = (bump + height_dc).astype(np.float32)

        # 5. Anti-smoothing pre-compensation for the E1.
        bump = precompensate_for_printer(
            bump, sigma=preset.unsharp_sigma, alpha=preset.unsharp_alpha
        )
        return bump

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(self, rgb_uint8: np.ndarray, bit_depth: int = 16) -> np.ndarray:
        """Return the integer bump map (uint16 default, uint8 if bit_depth=8)."""
        bump = self._bump_float(rgb_uint8, PRESET)
        return quantize_to_array(bump, bit_depth=bit_depth)

    def run_to_png(self, rgb_uint8: np.ndarray, bit_depth: int = 16) -> bytes:
        """Same as :meth:`run` but returns PNG-encoded bytes."""
        bump = self._bump_float(rgb_uint8, PRESET)
        return quantize_to_png_bytes(bump, bit_depth=bit_depth)

    def run_full(
        self, rgb_uint8: np.ndarray, bit_depth: int = 16
    ) -> PipelineResult:
        """Return both the float bump and the integer bump for advanced users."""
        bump_f = self._bump_float(rgb_uint8, PRESET)
        return PipelineResult(
            bump_float=bump_f,
            bump_uint16=quantize_to_array(bump_f, bit_depth=bit_depth),
        )
