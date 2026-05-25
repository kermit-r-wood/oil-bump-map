"""Anisotropic stroke field via Line Integral Convolution.

Given a per-pixel orientation field (theta, coherence), generate a noise-like
field that is "combed" along the local tangent direction. Where coherence is
low, smoothly blend back to isotropic noise.

Pipeline per pixel (vectorized via scipy.ndimage.map_coordinates):
    1. Sample white noise along the streamline (cos θ, sin θ) at integer
       offsets in [-length/2, +length/2]; average -> directional smoothing.
    2. Sample the result perpendicular to the streamline at integer offsets in
       [-thickness/2, +thickness/2] with Gaussian weights -> thickness blur.
    3. Blend the streamlined output with isotropic noise using coherence.

Output is centered around 0 and roughly bounded in [-1, 1].
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import map_coordinates


def _normalize_to_unit_amplitude(arr: np.ndarray) -> np.ndarray:
    """Scale so that 99th percentile of |x| ≈ 1; clip to [-1, 1]."""
    p99 = float(np.percentile(np.abs(arr), 99))
    if p99 < 1e-8:
        return arr.astype(np.float32)
    out = arr / p99
    return np.clip(out, -1.0, 1.0).astype(np.float32)


def directional_stroke_field(
    theta: np.ndarray,
    coherence: np.ndarray,
    length: float,
    thickness: float,
    seed: int = 0,
    direction_strength: float = 1.0,
    iso_weight: float = 1.0,
) -> np.ndarray:
    """Generate an anisotropic noise field aligned to the orientation.

    Parameters
    ----------
    theta : np.ndarray (H, W)
        Tangent orientation in radians (any range; only direction matters).
    coherence : np.ndarray (H, W)
        Per-pixel anisotropy strength in [0, 1].
    length : float
        Streamline integration length in pixels (full width). 0 -> isotropic.
    thickness : float
        Perpendicular Gaussian blur width in pixels. 0 -> no thickness blur.
    seed : int
        RNG seed for the underlying white noise (deterministic outputs).
    direction_strength : float
        Multiplier on coherence used for the blend (0..1+). 1.0 = use coherence
        directly. Higher = stroke more visible in low-coherence regions.

    Returns
    -------
    np.ndarray of float32 (H, W) in roughly [-1, 1], mean ≈ 0.
    """
    if theta.shape != coherence.shape:
        raise ValueError(
            f"theta {theta.shape} and coherence {coherence.shape} must match"
        )
    if theta.ndim != 2:
        raise ValueError(f"theta must be 2D, got {theta.shape}")

    H, W = theta.shape
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal((H, W)).astype(np.float32)

    # Coordinate grid (y, x).
    yy, xx = np.meshgrid(
        np.arange(H, dtype=np.float32),
        np.arange(W, dtype=np.float32),
        indexing="ij",
    )

    dx = np.cos(theta).astype(np.float32)
    dy = np.sin(theta).astype(np.float32)

    # ---- Step 1: streamline integration (line integral convolution) ----
    if length >= 1.0:
        n_steps = max(3, int(round(length)))
        if n_steps % 2 == 0:
            n_steps += 1
        half = (n_steps - 1) // 2

        acc = np.zeros((H, W), dtype=np.float32)
        for k in range(-half, half + 1):
            sample_y = yy + k * dy
            sample_x = xx + k * dx
            sampled = map_coordinates(
                noise,
                [sample_y, sample_x],
                order=1,
                mode="reflect",
            )
            acc += sampled.astype(np.float32)
        stroked = acc / float(n_steps)
    else:
        stroked = noise.copy()

    # ---- Step 2: perpendicular Gaussian thickness blur ----
    if thickness >= 1.0:
        n_thick = max(3, int(round(thickness)))
        if n_thick % 2 == 0:
            n_thick += 1
        thalf = (n_thick - 1) // 2
        sigma_t = max(thickness / 2.0, 0.5)
        ks = np.arange(-thalf, thalf + 1, dtype=np.float32)
        weights = np.exp(-0.5 * (ks / sigma_t) ** 2)
        weights = weights / weights.sum()

        acc2 = np.zeros_like(stroked)
        # Perpendicular direction: rotate 90° -> (-sin θ, cos θ) i.e. (-dy, dx)
        for k, w in zip(ks, weights):
            sample_y = yy + k * dx       # perp y component is +cos θ = +dx
            sample_x = xx + k * (-dy)    # perp x component is -sin θ = -dy
            sampled = map_coordinates(
                stroked,
                [sample_y, sample_x],
                order=1,
                mode="reflect",
            )
            acc2 += sampled.astype(np.float32) * w
        stroked = acc2

    # ---- Step 3: blend with isotropic noise via coherence ----
    iso = noise  # already shares the same RNG seed

    # Normalize each component independently so they live on a comparable scale.
    stroked_n = _normalize_to_unit_amplitude(stroked)
    iso_n = _normalize_to_unit_amplitude(iso)

    blend = np.clip(coherence.astype(np.float32) * float(direction_strength), 0.0, 1.0)
    iw = float(iso_weight)
    out = blend * stroked_n + (1.0 - blend) * iso_n * iw
    return out.astype(np.float32)
