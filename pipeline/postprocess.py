"""Post-processing for the bump pipeline:

1. Pre-compensation (unsharp mask) to counteract the Eufy E1 printer's slicing
   smoothing.  Y = X + α (X − Gauss_σ(X)).
2. Quantization to 8-bit or 16-bit PNG bytes for the printer's slicer.

Input convention: bump map is float, centered around 0, roughly in [-0.5, 0.5].
Output convention: PNG bytes (uint8 mode 'L' or uint16 mode 'I;16').
"""

from __future__ import annotations

import io

import numpy as np
import cv2
from PIL import Image


def precompensate_for_printer(
    bump: np.ndarray,
    sigma: float = 1.0,
    alpha: float = 0.5,
) -> np.ndarray:
    """Apply unsharp masking sized to the printer's expected smoothing kernel.

    The Eufy Make E1 (with smoothing="1") slightly low-passes the depth map
    during slicing. By pre-amplifying the high-frequency component, we cancel
    a portion of that loss so the printed surface still carries fine detail.

    Parameters
    ----------
    bump : np.ndarray
        2D float bump map (any range; recommended [-0.5, 0.5]).
    sigma : float
        Gaussian sigma in pixels matching the printer's PSF.  σ→0 disables.
    alpha : float
        Pre-emphasis gain. 0 = no compensation; typical 0.3-0.7.

    Returns
    -------
    np.ndarray of float32
        Sharpened bump in approximately the same range as the input.
    """
    if bump.ndim != 2:
        raise ValueError(f"bump must be 2D, got shape {bump.shape}")
    bump = bump.astype(np.float32)

    if alpha == 0.0 or sigma <= 0.0:
        return bump.copy()

    # cv2 picks a kernel size from sigma when ksize=(0,0).
    blurred = cv2.GaussianBlur(bump, (0, 0), float(sigma))
    out = bump + float(alpha) * (bump - blurred)
    return out.astype(np.float32)


def quantize_to_png_bytes(bump: np.ndarray, bit_depth: int = 16) -> bytes:
    """Convert a centered float bump map to PNG bytes (8-bit 'L' or 16-bit 'I;16').

    The float input is shifted from [-0.5, 0.5] to [0, 1] (clamped first to
    [-0.5, 0.5]) and then scaled to the integer range.

    Parameters
    ----------
    bump : np.ndarray
        2D float array, expected centered in [-0.5, 0.5].
    bit_depth : int
        Either 8 or 16.

    Returns
    -------
    bytes
        PNG-encoded image bytes.
    """
    if bump.ndim != 2:
        raise ValueError(f"bump must be 2D, got shape {bump.shape}")
    if bit_depth not in (8, 16):
        raise ValueError(f"bit_depth must be 8 or 16, got {bit_depth}")

    clipped = np.clip(bump.astype(np.float32), -0.5, 0.5)
    shifted = clipped + 0.5  # -> [0, 1]
    if bit_depth == 16:
        arr = np.clip(shifted * 65535.0 + 0.5, 0, 65535).astype(np.uint16)
        # Use frombytes for explicit I;16 construction (avoids the deprecated
        # `mode=` parameter on Image.fromarray for type conversion).
        img = Image.new("I;16", (arr.shape[1], arr.shape[0]))
        img.frombytes(arr.tobytes())
    else:
        arr = np.clip(shifted * 255.0 + 0.5, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr, mode="L")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def quantize_to_array(bump: np.ndarray, bit_depth: int = 16) -> np.ndarray:
    """Same scaling logic as :func:`quantize_to_png_bytes` but returns the
    raw integer ndarray (uint8 or uint16). Useful for tests and the simulated
    print preview endpoint.
    """
    if bit_depth not in (8, 16):
        raise ValueError(f"bit_depth must be 8 or 16, got {bit_depth}")
    clipped = np.clip(bump.astype(np.float32), -0.5, 0.5)
    shifted = clipped + 0.5
    if bit_depth == 16:
        return np.clip(shifted * 65535.0 + 0.5, 0, 65535).astype(np.uint16)
    return np.clip(shifted * 255.0 + 0.5, 0, 255).astype(np.uint8)
