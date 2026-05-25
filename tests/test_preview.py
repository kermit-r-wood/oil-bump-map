"""Tests for the /preview_smoothed endpoint."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture(scope="module")
def app_client():
    with TestClient(app_module.app) as client:
        yield client


def _make_8bit_png() -> bytes:
    """High-frequency 8-bit grayscale PNG (so blur produces detectable change)."""
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 256, size=(64, 64), dtype=np.uint8)
    img = Image.fromarray(arr, mode="L")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _make_16bit_png() -> bytes:
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 65536, size=(64, 64), dtype=np.uint16)
    out = Image.new("I;16", (arr.shape[1], arr.shape[0]))
    out.frombytes(arr.tobytes())
    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


def test_preview_sigma_zero_is_identity(app_client):
    png = _make_8bit_png()
    resp = app_client.post(
        "/preview_smoothed",
        files={"file": ("bump.png", png, "image/png")},
        data={"sigma": "0"},
    )
    assert resp.status_code == 200
    # Identity path returns the original bytes verbatim.
    assert resp.content == png


def test_preview_blurs_8bit_input(app_client):
    png = _make_8bit_png()
    resp = app_client.post(
        "/preview_smoothed",
        files={"file": ("bump.png", png, "image/png")},
        data={"sigma": "2.0"},
    )
    assert resp.status_code == 200
    out = Image.open(io.BytesIO(resp.content))
    assert out.mode == "L"
    out_arr = np.asarray(out)
    in_arr = np.asarray(Image.open(io.BytesIO(png)))
    # Variance should drop after a moderate blur.
    assert float(out_arr.var()) < float(in_arr.var())


def test_preview_preserves_16bit(app_client):
    png = _make_16bit_png()
    resp = app_client.post(
        "/preview_smoothed",
        files={"file": ("bump.png", png, "image/png")},
        data={"sigma": "2.0"},
    )
    assert resp.status_code == 200
    out = Image.open(io.BytesIO(resp.content))
    out_arr = np.asarray(out)
    assert out_arr.dtype == np.uint16
    in_arr = np.asarray(Image.open(io.BytesIO(png)))
    assert float(out_arr.var()) < float(in_arr.var())


def test_preview_rejects_rgb_input(app_client):
    """An RGB image is not a valid bump-map preview input."""
    arr = np.zeros((32, 32, 3), dtype=np.uint8)
    img = Image.fromarray(arr, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    resp = app_client.post(
        "/preview_smoothed",
        files={"file": ("bump.png", buf.getvalue(), "image/png")},
        data={"sigma": "1.0"},
    )
    assert resp.status_code == 400
