"""Tests for the anisotropic stroke field (LIC)."""

from __future__ import annotations

import numpy as np

from pipeline.strokes import directional_stroke_field


def _autocorr_1d(signal: np.ndarray, max_lag: int) -> np.ndarray:
    """Normalized autocorrelation of a 1D signal at lags 0..max_lag."""
    s = signal - signal.mean()
    var = float(np.dot(s, s))
    if var < 1e-12:
        return np.zeros(max_lag + 1)
    return np.array(
        [float(np.dot(s[: len(s) - k], s[k:])) / var for k in range(max_lag + 1)],
        dtype=np.float32,
    )


def test_horizontal_orientation_yields_horizontal_correlation():
    """θ=0 (horizontal tangent) + coherence=1 -> output highly correlated along x.

    For a uniform moving average of width N applied to white noise, the
    autocorrelation is triangular with HWHM ≈ N/2.
    """
    H, W = 256, 256
    theta = np.zeros((H, W), dtype=np.float32)         # horizontal tangent
    coherence = np.ones((H, W), dtype=np.float32)
    length = 24.0
    out = directional_stroke_field(
        theta, coherence, length=length, thickness=0.0, seed=0
    )
    assert out.shape == (H, W)
    assert out.dtype == np.float32

    # Take a central row, compute autocorrelation along x.
    row = out[H // 2]
    ac = _autocorr_1d(row, max_lag=int(length))
    # Find first lag where ac drops below 0.5 -> that is HWHM.
    below = np.where(ac < 0.5)[0]
    assert len(below) > 0, "autocorrelation never drops below 0.5"
    hwhm = int(below[0])
    expected = length / 2
    # Allow ±50% tolerance: implementation uses uniform averaging which gives
    # a triangular autocorrelation with HWHM = N/2 in the asymptotic limit.
    assert expected * 0.5 <= hwhm <= expected * 1.5, (
        f"HWHM along x = {hwhm}, expected ≈ {expected}"
    )


def test_vertical_orientation_yields_vertical_correlation():
    H, W = 256, 256
    theta = np.full((H, W), np.pi / 2, dtype=np.float32)  # vertical tangent
    coherence = np.ones((H, W), dtype=np.float32)
    length = 24.0
    out = directional_stroke_field(
        theta, coherence, length=length, thickness=0.0, seed=0
    )
    col = out[:, W // 2]
    ac = _autocorr_1d(col, max_lag=int(length))
    below = np.where(ac < 0.5)[0]
    assert len(below) > 0
    hwhm = int(below[0])
    expected = length / 2
    assert expected * 0.5 <= hwhm <= expected * 1.5


def test_zero_coherence_falls_back_to_isotropic():
    """coherence=0 collapses the blend to pure isotropic noise (no streamlining)."""
    H, W = 128, 128
    theta = np.zeros((H, W), dtype=np.float32)
    coherence = np.zeros((H, W), dtype=np.float32)
    out = directional_stroke_field(theta, coherence, length=24.0, thickness=4.0, seed=0)

    # Reference: pure isotropic - obtained by setting length and thickness to 0.
    ref = directional_stroke_field(
        theta, np.zeros_like(coherence), length=0.0, thickness=0.0, seed=0
    )
    # Both clamped/normalized so direct correlation should be > 0.95.
    a = (out - out.mean()).ravel()
    b = (ref - ref.mean()).ravel()
    corr = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))
    assert corr > 0.95, f"correlation with isotropic only = {corr}"


def test_output_is_centered_and_bounded():
    H, W = 128, 128
    rng = np.random.default_rng(42)
    theta = rng.uniform(0.0, np.pi, (H, W)).astype(np.float32)
    coherence = rng.uniform(0.0, 1.0, (H, W)).astype(np.float32)
    out = directional_stroke_field(theta, coherence, length=12.0, thickness=3.0, seed=42)
    assert -1.0 - 1e-5 <= out.min() <= out.max() <= 1.0 + 1e-5
    assert abs(float(out.mean())) < 0.1


def test_deterministic_with_seed():
    H, W = 64, 64
    theta = np.full((H, W), np.pi / 4, dtype=np.float32)
    coherence = np.ones((H, W), dtype=np.float32) * 0.7
    a = directional_stroke_field(theta, coherence, length=12, thickness=3, seed=123)
    b = directional_stroke_field(theta, coherence, length=12, thickness=3, seed=123)
    np.testing.assert_array_equal(a, b)


def test_shape_mismatch_raises():
    import pytest

    with pytest.raises(ValueError):
        directional_stroke_field(
            np.zeros((10, 10)), np.zeros((10, 12)), length=4, thickness=1
        )
