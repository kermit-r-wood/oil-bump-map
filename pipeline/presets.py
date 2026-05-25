"""Hard-coded scan_replica preset for the oil-texture bump pipeline.

scan_replica mimics a real 3D scan of an oil painting: paint-density-driven
mid-gray baseline with subtle impasto ridges where the input image has
visible brush-stroke structure, plus a luminance-driven DC offset so bright
regions read as physically raised paint and dark regions as recessed.

Tune the numbers below; they take effect on the next pipeline run.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class StylePreset:
    """Locked parameter set for the scan_replica style."""

    name: str

    # Anisotropic LIC stroke field
    stroke_length: float
    stroke_thickness: float
    direction_strength: float

    # Pre-blur sigma applied to luminance before the structure tensor.
    # > 0 turns the orientation field into a HIGH-PASS structure tensor, so
    # large-scale silhouette edges (subject vs background) stop dominating
    # the LIC direction; 0 follows the global edges.
    orientation_highpass_sigma: float

    # Weight on the isotropic-noise fallback used by the LIC where coherence
    # is low. 0.0 = smooth/low-coherence regions return to flat (no noise).
    iso_weight: float

    # Power applied to the paint-density (variance-driven) thickness mask.
    # >1 emphasizes strongly-textured regions over weakly-textured ones.
    thickness_gamma: float

    # Lift the paint-density mask so even regions with raw_density == 0
    # still receive `floor` of the texture. 0 = pure variance-driven; 0.4
    # gives a uniform "canvas of paint" base + extra impasto in detail
    # regions.
    thickness_floor: float

    # Final bump-map amplitude before quantization. The composer rescales
    # the 99th-percentile of |bump| to this value.
    output_amplitude: float

    # Luminance-driven DC offset. > 0 makes bright textured regions
    # persistently raised, dark textured regions recessed; smooth regions
    # stay at mid-gray. Without this, the bump map only has zero-mean
    # ridges (AC) and looks like brushy fluff instead of real 3D-scan
    # height.
    luminance_height_bias: float

    # E1 anti-smoothing pre-compensation
    unsharp_sigma: float
    unsharp_alpha: float


PRESET = StylePreset(
    name="scan_replica",
    stroke_length=32.0,
    stroke_thickness=4.0,
    direction_strength=1.0,
    orientation_highpass_sigma=8.0,
    iso_weight=0.0,
    thickness_gamma=2.0,
    thickness_floor=0.0,
    output_amplitude=0.22,
    luminance_height_bias=0.5,
    unsharp_sigma=1.0,
    unsharp_alpha=0.5,
)
