"""Paint-density thickness mask + simple bump composer.

paint_density_mask: detects where paint is piled up by measuring local
variance of luminance, with a luminance weighting so bright impasto
regions register strongest.

compose_bump: multiplies the stroke field by the thickness mask, recenters,
and rescales the 99th percentile to `output_amplitude`.
"""

from __future__ import annotations

import numpy as np
import cv2


def paint_density_mask(
    luminance_norm: np.ndarray,
    gamma: float = 1.5,
    floor: float = 0.0,
) -> np.ndarray:
    """Per-pixel paint-density multiplier in [0, 1].

    Detects WHERE paint is piled up by measuring LOCAL VARIANCE of luminance
    in a moderate window. Key properties:
      * A single sharp edge contributes contrast^2 * (edge_len/window) to
        the variance -> diluted by window size -> low density.
      * A cluster of fine brushwork contributes ~constant variance
        independent of window size -> high density.
    This keeps silhouette/contour edges from registering as "thick paint",
    while preserving genuine textured regions (hair, brush patches).

    Then luminance-weighted: bright textured regions (real impasto catches
    light) get boosted (×1.5 at white), dark textured regions (often jpeg
    noise in shadows) get suppressed (×0.5 at black).

    Optional `floor` lifts the mask to give the canvas a baseline texture
    even where raw density is zero.

    Parameters
    ----------
    luminance_norm : np.ndarray (H, W)
        Luminance normalized to [0, 1].
    gamma : float
        Power applied to the final density. >1 emphasizes peaks.
    floor : float in [0, 1)
        Minimum mask value: ``mask = floor + (1 - floor) * raw``.
    """
    lum = np.clip(luminance_norm.astype(np.float32), 0.0, 1.0)
    var_radius = 25
    ks = 2 * var_radius + 1
    mean = cv2.boxFilter(lum, ddepth=-1, ksize=(ks, ks), normalize=True)
    sq_mean = cv2.boxFilter(lum * lum, ddepth=-1, ksize=(ks, ks), normalize=True)
    variance = np.clip(sq_mean - mean * mean, 0.0, None)
    density = np.sqrt(variance)  # std-dev: linear in contrast amplitude
    # Mild spatial smoothing so the mask is locally stable.
    density = cv2.GaussianBlur(density, (17, 17), 5.0)
    # Robust normalization to [0, 1] using a high percentile.
    p95 = float(np.percentile(density, 95))
    if p95 > 1e-8:
        density = density / p95
    density = np.clip(density, 0.0, 1.0)
    # Luminance weighting: impasto catches light; shadow noise is suppressed.
    lum_factor = 0.5 + lum  # range [0.5, 1.5]
    density = np.clip(density * lum_factor, 0.0, 1.0)
    density = np.power(density, max(gamma, 1e-3)).astype(np.float32)
    if floor > 0.0:
        density = (floor + (1.0 - floor) * density).astype(np.float32)
    return density


def compose_bump(
    stroke_field: np.ndarray,
    thickness: np.ndarray,
    output_amplitude: float = 0.5,
    recenter: bool = True,
) -> np.ndarray:
    """Combine the stroke field with the thickness mask.

    bump = stroke_field * thickness

    If ``recenter`` is True (default), then subtract the mean and rescale so
    the 99th percentile of |bump| equals ``output_amplitude``, with final
    clip to ``[-output_amplitude, +output_amplitude]``.

    Parameters
    ----------
    stroke_field : np.ndarray (H, W)
        Anisotropic stroke field, roughly in [-1, 1].
    thickness : np.ndarray (H, W)
        Per-pixel multiplier in [0, 1].
    output_amplitude : float
        Target |bump| 99th percentile after recentering.
    recenter : bool
        If True, subtract mean and rescale; else return raw product.
    """
    if stroke_field.shape != thickness.shape:
        raise ValueError(
            "shape mismatch: stroke "
            f"{stroke_field.shape} vs thickness {thickness.shape}"
        )

    bump = (
        stroke_field.astype(np.float32) * thickness.astype(np.float32)
    ).astype(np.float32)

    if not recenter:
        return bump

    bump = bump - float(np.mean(bump))
    p99 = float(np.percentile(np.abs(bump), 99))
    target = max(float(output_amplitude), 1e-6)
    if p99 > 1e-8:
        bump = bump * (target / p99)
    bump = np.clip(bump, -target, target)
    return bump.astype(np.float32)
