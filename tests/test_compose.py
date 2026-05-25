"""Tests for paint_density_mask and compose_bump (scan_replica)."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline.compose import compose_bump, paint_density_mask


def test_paint_density_mask_zero_for_smooth_input():
    """A smooth (low-variance) image should produce ~zero paint density."""
    h, w = 64, 64
    lum = np.full((h, w), 0.5, dtype=np.float32)
    out = paint_density_mask(lum, gamma=1.0)
    assert out.shape == lum.shape
    assert out.dtype == np.float32
    assert out.max() < 1e-3, "smooth input should give ~0 density"


def test_paint_density_mask_high_for_textured_input():
    """A high-frequency (high-variance) image should produce high density."""
    rng = np.random.default_rng(0)
    lum = rng.uniform(0.0, 1.0, (128, 128)).astype(np.float32)
    out = paint_density_mask(lum, gamma=1.0)
    # The 95th percentile of variance becomes 1 by construction; expect a
    # decent fraction of pixels above 0.5.
    assert (out > 0.5).mean() > 0.3


def test_paint_density_mask_floor():
    """floor=0.4 should lift the minimum to 0.4 (after gamma)."""
    h, w = 64, 64
    lum = np.full((h, w), 0.5, dtype=np.float32)  # smooth -> raw density 0
    out = paint_density_mask(lum, gamma=1.0, floor=0.4)
    np.testing.assert_allclose(out, np.full_like(out, 0.4), atol=1e-3)


def test_paint_density_mask_luminance_weighting():
    """Bright textured regions should register higher than dark textured ones."""
    rng = np.random.default_rng(0)
    h, w = 128, 128
    noise = rng.uniform(-0.05, 0.05, (h, w)).astype(np.float32)
    bright = np.clip(0.85 + noise, 0, 1).astype(np.float32)
    dark = np.clip(0.15 + noise, 0, 1).astype(np.float32)
    out_bright = paint_density_mask(bright, gamma=1.0)
    out_dark = paint_density_mask(dark, gamma=1.0)
    # Bright textured > dark textured (lum_factor 1.35 vs 0.65 -> 2.08x).
    assert out_bright.mean() > out_dark.mean() * 1.5


def test_compose_recentered_output_within_range():
    rng = np.random.default_rng(123)
    stroke = rng.standard_normal((64, 64)).astype(np.float32)
    thickness = rng.uniform(0, 1, (64, 64)).astype(np.float32)
    out = compose_bump(stroke, thickness, output_amplitude=0.22)
    assert out.min() >= -0.22 - 1e-5
    assert out.max() <= 0.22 + 1e-5
    assert abs(float(out.mean())) < 0.05


def test_compose_no_recenter_is_pure_product():
    stroke = np.full((4, 4), 0.5, dtype=np.float32)
    thickness = np.full((4, 4), 1.0, dtype=np.float32)
    out = compose_bump(stroke, thickness, output_amplitude=1.0, recenter=False)
    np.testing.assert_allclose(out, np.full_like(out, 0.5), atol=1e-6)


def test_compose_shape_mismatch_raises():
    stroke = np.zeros((4, 5), dtype=np.float32)
    thickness = np.zeros((4, 4), dtype=np.float32)
    with pytest.raises(ValueError):
        compose_bump(stroke, thickness)
