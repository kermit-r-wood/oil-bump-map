"""Tests for RGB structure tensor orientation."""

from __future__ import annotations

import numpy as np

from pipeline.orientation import structure_tensor_orientation


def _crop_center(arr: np.ndarray, frac: float = 0.5) -> np.ndarray:
    h, w = arr.shape
    ch, cw = int(h * frac), int(w * frac)
    y0, x0 = (h - ch) // 2, (w - cw) // 2
    return arr[y0:y0 + ch, x0:x0 + cw]


def _angle_circular_mean(theta: np.ndarray) -> float:
    """Circular mean of angles modulo π (orientation, not direction)."""
    z = np.exp(2j * theta)
    return float(0.5 * np.angle(np.mean(z)) % np.pi)


def _angle_distance(a: float, b: float) -> float:
    """Distance between two orientations in [0, π/2]."""
    d = abs(a - b) % np.pi
    return min(d, np.pi - d)


def test_horizontal_stripes_give_horizontal_tangent():
    """Image with only horizontal stripes (luminance varies along y) has
    edges that are horizontal -> tangent ≈ 0 (or π, same orientation)."""
    h, w = 128, 128
    yy, _ = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    lum = (np.sin(2 * np.pi * yy / 16.0) * 0.5 + 0.5).astype(np.float32)
    rgb = np.stack([lum, lum, lum], axis=-1)

    theta, coherence = structure_tensor_orientation(rgb, sigma=2.0)

    center_theta = _crop_center(theta, 0.5)
    center_coh = _crop_center(coherence, 0.5)

    # Mean orientation should be ≈ 0 (horizontal tangent).
    mean_theta = _angle_circular_mean(center_theta.ravel())
    assert _angle_distance(mean_theta, 0.0) < 0.1, f"mean_theta={mean_theta}"

    # Coherence should be high in the center (clear edges).
    assert float(np.mean(center_coh)) > 0.8


def test_vertical_stripes_give_vertical_tangent():
    h, w = 128, 128
    _, xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    lum = (np.sin(2 * np.pi * xx / 16.0) * 0.5 + 0.5).astype(np.float32)
    rgb = np.stack([lum, lum, lum], axis=-1)

    theta, coherence = structure_tensor_orientation(rgb, sigma=2.0)

    mean_theta = _angle_circular_mean(_crop_center(theta, 0.5).ravel())
    # Vertical tangent ≈ π/2.
    assert _angle_distance(mean_theta, np.pi / 2) < 0.1
    assert float(np.mean(_crop_center(coherence, 0.5))) > 0.8


def test_isotropic_noise_gives_low_coherence():
    rng = np.random.default_rng(0)
    lum = rng.standard_normal((128, 128)).astype(np.float32)
    rgb = np.stack([lum, lum, lum], axis=-1)

    _, coherence = structure_tensor_orientation(rgb, sigma=2.0)
    assert float(np.mean(coherence)) < 0.3


def test_uint8_input_accepted():
    h, w = 64, 64
    rng = np.random.default_rng(0)
    rgb = (rng.uniform(0, 255, (h, w, 3))).astype(np.uint8)
    theta, coherence = structure_tensor_orientation(rgb, sigma=2.0)
    assert theta.shape == (h, w)
    assert coherence.shape == (h, w)
    assert theta.dtype == np.float32
    assert coherence.dtype == np.float32
    assert np.all(theta >= 0) and np.all(theta < np.pi + 1e-5)
    assert np.all(coherence >= 0) and np.all(coherence <= 1.0 + 1e-5)


def test_grayscale_input_accepted():
    h, w = 64, 64
    lum = np.zeros((h, w), dtype=np.float32)
    lum[:, ::4] = 1.0  # vertical stripes
    theta, _ = structure_tensor_orientation(lum, sigma=2.0)
    mean_theta = _angle_circular_mean(_crop_center(theta, 0.5).ravel())
    assert _angle_distance(mean_theta, np.pi / 2) < 0.1
