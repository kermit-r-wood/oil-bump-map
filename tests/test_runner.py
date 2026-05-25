"""End-to-end tests for OilTextureBumpPipeline (scan_replica only)."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline.runner import OilTextureBumpPipeline


def _synthetic_rgb(seed: int = 7, h: int = 256, w: int = 256) -> np.ndarray:
    """Reproducible synthetic RGB image with structure for testing."""
    rng = np.random.default_rng(seed)
    yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    r = (
        128 + 80 * np.sin(2 * np.pi * xx / 32.0)
        + 30 * np.cos(2 * np.pi * yy / 18.0)
    )
    g = (
        128 + 60 * np.cos(2 * np.pi * (xx + yy) / 24.0)
        + 20 * np.sin(2 * np.pi * yy / 12.0)
    )
    b = (
        128 + 70 * np.sin(2 * np.pi * (xx - yy) / 20.0)
        + 25 * np.cos(2 * np.pi * xx / 16.0)
    )
    noise = rng.standard_normal((h, w, 3)) * 8
    return np.clip(np.stack([r, g, b], axis=-1) + noise, 0, 255).astype(np.uint8)


@pytest.fixture(scope="module")
def synthetic_rgb():
    return _synthetic_rgb()


def test_pipeline_run_returns_uint16(synthetic_rgb):
    pipe = OilTextureBumpPipeline(seed=42)
    out = pipe.run(synthetic_rgb, bit_depth=16)
    assert out.shape == synthetic_rgb.shape[:2]
    assert out.dtype == np.uint16
    # Should span a meaningful portion of the 16-bit range.
    assert int(out.max()) - int(out.min()) > 1000


def test_pipeline_run_8bit(synthetic_rgb):
    pipe = OilTextureBumpPipeline(seed=42)
    out = pipe.run(synthetic_rgb, bit_depth=8)
    assert out.dtype == np.uint8
    assert out.shape == synthetic_rgb.shape[:2]


def test_pipeline_deterministic_with_seed(synthetic_rgb):
    a = OilTextureBumpPipeline(seed=99).run(synthetic_rgb)
    b = OilTextureBumpPipeline(seed=99).run(synthetic_rgb)
    np.testing.assert_array_equal(a, b)


def test_pipeline_different_seeds_differ(synthetic_rgb):
    a = OilTextureBumpPipeline(seed=1).run(synthetic_rgb)
    b = OilTextureBumpPipeline(seed=2).run(synthetic_rgb)
    assert not np.array_equal(a, b)


def test_pipeline_run_to_png_returns_png_bytes(synthetic_rgb):
    pipe = OilTextureBumpPipeline(seed=42)
    png = pipe.run_to_png(synthetic_rgb, bit_depth=16)
    assert isinstance(png, bytes)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


def test_pipeline_run_full_returns_bundle(synthetic_rgb):
    pipe = OilTextureBumpPipeline(seed=42)
    res = pipe.run_full(synthetic_rgb)
    assert res.bump_float.dtype == np.float32
    assert res.bump_uint16.dtype == np.uint16
    # Unsharp pre-compensation can overshoot the [-amp, +amp] target;
    # quantizer clips. Allow generous range here.
    assert res.bump_float.min() >= -1.5
    assert res.bump_float.max() <= 1.5


def test_pipeline_smooth_input_produces_mid_gray():
    """Pure flat-gray RGB has no paint density; output should be tightly
    clustered around mid-gray (no DC offset because thickness is 0 and
    bias × 0 = 0)."""
    flat = np.full((128, 128, 3), 128, dtype=np.uint8)
    out = OilTextureBumpPipeline(seed=0).run(flat, bit_depth=16)
    mean = float(out.astype(np.float32).mean())
    std = float(out.astype(np.float32).std())
    assert abs(mean - 32767) < 1500, f"mean={mean} not near 32767"
    assert std < 1500, f"std={std} too large for flat input"


def test_pipeline_polarity_bright_textured_is_raised():
    """White-noise (bright + textured) regions should quantize ABOVE mid-gray;
    dark-noise (dark + textured) regions should quantize BELOW mid-gray.
    This validates the luminance_height_bias DC offset.
    """
    rng = np.random.default_rng(0)
    h, w = 64, 256
    # Left half dark+textured, right half bright+textured.
    noise_dark = np.clip(0.15 + rng.uniform(-0.05, 0.05, (h, w // 2, 3)), 0, 1)
    noise_bright = np.clip(0.85 + rng.uniform(-0.05, 0.05, (h, w // 2, 3)), 0, 1)
    rgb = np.concatenate([noise_dark, noise_bright], axis=1)
    rgb = (rgb * 255).astype(np.uint8)

    out = OilTextureBumpPipeline(seed=0).run(rgb, bit_depth=16)
    dark_mean = float(out[:, : w // 4].mean())
    bright_mean = float(out[:, -w // 4 :].mean())
    assert bright_mean > dark_mean, (
        f"bright textured should be raised: bright={bright_mean}, dark={dark_mean}"
    )
