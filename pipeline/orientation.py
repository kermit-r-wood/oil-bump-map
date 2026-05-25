"""RGB structure tensor → per-pixel orientation field.

Given an RGB image, compute:
    theta(H, W)     - dominant edge tangent direction in radians, ∈ [0, π)
    coherence(H, W) - anisotropy strength ∈ [0, 1]
                      (1 = strongly oriented edge, 0 = isotropic / flat)

Algorithm:
    1. Convert to luminance (Rec.601: 0.299*R + 0.587*G + 0.114*B).
    2. Sobel gradients Ix, Iy.
    3. Smooth Ix^2, Iy^2, Ix*Iy with a Gaussian (sigma).
    4. Solve the 2x2 eigenvalue problem analytically; theta = orientation of
       smaller-eigenvalue eigenvector = edge tangent (perpendicular to gradient).
    5. coherence = (lambda1 - lambda2) / (lambda1 + lambda2 + eps).
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
import cv2


def _to_luminance(rgb: np.ndarray) -> np.ndarray:
    if rgb.ndim == 2:
        return rgb.astype(np.float32)
    if rgb.ndim != 3 or rgb.shape[2] not in (3, 4):
        raise ValueError(f"rgb must be (H,W) or (H,W,3/4); got {rgb.shape}")
    if rgb.dtype == np.uint8:
        rgb_f = rgb.astype(np.float32) / 255.0
    else:
        rgb_f = rgb.astype(np.float32)
    r, g, b = rgb_f[..., 0], rgb_f[..., 1], rgb_f[..., 2]
    return 0.299 * r + 0.587 * g + 0.114 * b


def structure_tensor_orientation(
    rgb: np.ndarray,
    sigma: float = 2.0,
    pre_highpass_sigma: float = 0.0,
) -> Tuple[np.ndarray, np.ndarray]:
    """Compute (theta, coherence) from an RGB or grayscale image.

    Parameters
    ----------
    rgb : np.ndarray
        (H, W, 3) uint8/float RGB image, or (H, W) grayscale.
    sigma : float
        Gaussian smoothing sigma applied to the tensor components.
        Larger sigma = larger neighborhood = more stable but blurrier orientation.

    Returns
    -------
    theta : np.ndarray of float32 (H, W)
        Tangent orientation in radians, wrapped to [0, π).
    coherence : np.ndarray of float32 (H, W)
        Anisotropy in [0, 1].
    """
    lum = _to_luminance(rgb)

    # Optional high-pass: kills large-scale edges (e.g. subject silhouette) so the
    # structure tensor only picks up brush-stroke-scale orientation. Used by the
    # scan_replica preset for oil-painting reproduction.
    if pre_highpass_sigma > 0.0:
        ks = max(3, int(2 * round(3 * pre_highpass_sigma) + 1))
        if ks % 2 == 0:
            ks += 1
        blurred = cv2.GaussianBlur(lum, (ks, ks), float(pre_highpass_sigma))
        lum = lum - blurred

    Ix = cv2.Sobel(lum, cv2.CV_32F, 1, 0, ksize=3)
    Iy = cv2.Sobel(lum, cv2.CV_32F, 0, 1, ksize=3)

    # Gaussian smoothing of tensor components. ksize=0 lets cv2 pick from sigma.
    ksize = max(3, int(2 * round(3 * sigma) + 1))
    if ksize % 2 == 0:
        ksize += 1
    Jxx = cv2.GaussianBlur(Ix * Ix, (ksize, ksize), sigma)
    Jyy = cv2.GaussianBlur(Iy * Iy, (ksize, ksize), sigma)
    Jxy = cv2.GaussianBlur(Ix * Iy, (ksize, ksize), sigma)

    # Eigenvalues of [[Jxx, Jxy], [Jxy, Jyy]]:
    # lambda_{1,2} = (Jxx+Jyy)/2 ± sqrt(((Jxx-Jyy)/2)^2 + Jxy^2)
    trace = Jxx + Jyy
    diff = Jxx - Jyy
    delta = np.sqrt(diff * diff + 4.0 * Jxy * Jxy)
    lam1 = 0.5 * (trace + delta)  # larger eigenvalue (gradient direction)
    lam2 = 0.5 * (trace - delta)  # smaller eigenvalue (tangent direction)

    eps = 1e-8
    coherence = ((lam1 - lam2) / (lam1 + lam2 + eps)).astype(np.float32)
    coherence = np.clip(coherence, 0.0, 1.0)

    # The eigenvector corresponding to the LARGER eigenvalue points along the
    # gradient (perpendicular to the edge). The edge tangent (= stroke direction)
    # is rotated 90°. atan2(2*Jxy, Jxx-Jyy)/2 gives the gradient angle; add π/2
    # to get the tangent.
    theta = 0.5 * np.arctan2(2.0 * Jxy, diff) + np.pi / 2.0
    # Wrap to [0, π).
    theta = np.mod(theta, np.pi).astype(np.float32)

    return theta, coherence
