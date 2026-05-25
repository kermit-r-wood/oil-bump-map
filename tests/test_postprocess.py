"""Tests for unsharp pre-compensation + PNG quantization."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from pipeline.postprocess import (
    precompensate_for_printer,
    quantize_to_array,
    quantize_to_png_bytes,
)


def _make_bump(seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    h, w = 64, 64
    yy, xx = np.meshgrid(np.arange(h), np.arange(w), indexing="ij")
    sig = 0.3 * np.sin(2 * np.pi * xx / 8.0) + 0.1 * rng.standard_normal((h, w))
    return np.clip(sig, -0.5, 0.5).astype(np.float32)


def test_precompensate_alpha_zero_is_identity():
    bump = _make_bump()
    out = precompensate_for_printer(bump, sigma=1.0, alpha=0.0)
    np.testing.assert_array_equal(out, bump)


def test_precompensate_sigma_zero_is_identity():
    bump = _make_bump()
    out = precompensate_for_printer(bump, sigma=0.0, alpha=0.5)
    np.testing.assert_array_equal(out, bump)


def test_precompensate_amplifies_high_freq():
    """High-frequency content should be amplified after unsharp mask."""
    bump = _make_bump()
    out = precompensate_for_printer(bump, sigma=1.0, alpha=0.6)
    # Variance increases when sharpening a noisy/high-freq signal.
    assert float(out.var()) > float(bump.var())


def test_precompensate_rejects_3d():
    with pytest.raises(ValueError):
        precompensate_for_printer(np.zeros((4, 4, 3), dtype=np.float32))


def test_quantize_16bit_round_trip():
    bump = _make_bump()
    arr = quantize_to_array(bump, bit_depth=16)
    assert arr.dtype == np.uint16
    # The mid-gray (0.0 input) should map near 32768.
    zero_idx = np.unravel_index(np.argmin(np.abs(bump)), bump.shape)
    assert abs(int(arr[zero_idx]) - 32768) < 200

    png_bytes = quantize_to_png_bytes(bump, bit_depth=16)
    assert isinstance(png_bytes, bytes)
    assert png_bytes[:8] == b"\x89PNG\r\n\x1a\n"

    decoded = Image.open(io.BytesIO(png_bytes))
    decoded_arr = np.asarray(decoded)
    assert decoded_arr.dtype == np.uint16
    assert decoded_arr.shape == bump.shape
    # Range coverage: with input in [-0.5, 0.5], the encoded image should span
    # nearly the whole 16-bit range.
    assert decoded_arr.max() - decoded_arr.min() > 50000


def test_quantize_8bit_round_trip():
    bump = _make_bump()
    arr = quantize_to_array(bump, bit_depth=8)
    assert arr.dtype == np.uint8
    png_bytes = quantize_to_png_bytes(bump, bit_depth=8)
    decoded = Image.open(io.BytesIO(png_bytes))
    decoded_arr = np.asarray(decoded)
    assert decoded_arr.dtype == np.uint8
    np.testing.assert_array_equal(decoded_arr, arr)


def test_quantize_clips_out_of_range():
    bump = np.array([[-1.0, -0.5, 0.0, 0.5, 1.0]], dtype=np.float32)
    arr8 = quantize_to_array(bump, bit_depth=8)
    np.testing.assert_array_equal(arr8, np.array([[0, 0, 128, 255, 255]], dtype=np.uint8))
    arr16 = quantize_to_array(bump, bit_depth=16)
    assert arr16[0, 0] == 0
    assert arr16[0, -1] == 65535


def test_quantize_invalid_bit_depth_raises():
    bump = _make_bump()
    with pytest.raises(ValueError):
        quantize_to_array(bump, bit_depth=12)
    with pytest.raises(ValueError):
        quantize_to_png_bytes(bump, bit_depth=12)
