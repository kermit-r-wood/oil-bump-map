"""Integration tests for the FastAPI /predict endpoint.

The pipeline is RGB-only (no depth model), so no mocking is needed.
"""

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


def _make_test_png_bytes(h: int = 64, w: int = 64) -> bytes:
    """Produce a small RGB PNG to upload."""
    rng = np.random.default_rng(0)
    arr = rng.uniform(0, 255, (h, w, 3)).astype(np.uint8)
    img = Image.fromarray(arr, mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_predict_returns_16bit_png(app_client):
    png = _make_test_png_bytes()
    resp = app_client.post(
        "/predict",
        files={"file": ("test.png", png, "image/png")},
        data={"bit_depth": "16"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"].startswith("image/png")
    out = Image.open(io.BytesIO(resp.content))
    arr = np.asarray(out)
    assert arr.dtype == np.uint16
    assert arr.shape == (64, 64)


def test_predict_8bit(app_client):
    png = _make_test_png_bytes()
    resp = app_client.post(
        "/predict",
        files={"file": ("test.png", png, "image/png")},
        data={"bit_depth": "8"},
    )
    assert resp.status_code == 200, resp.text
    out = Image.open(io.BytesIO(resp.content))
    arr = np.asarray(out)
    assert arr.dtype == np.uint8


def test_predict_default_bit_depth_is_16(app_client):
    """Calling /predict without bit_depth should default to 16-bit."""
    png = _make_test_png_bytes()
    resp = app_client.post(
        "/predict",
        files={"file": ("test.png", png, "image/png")},
    )
    assert resp.status_code == 200, resp.text
    arr = np.asarray(Image.open(io.BytesIO(resp.content)))
    assert arr.dtype == np.uint16


def test_predict_invalid_bit_depth_returns_400(app_client):
    png = _make_test_png_bytes()
    resp = app_client.post(
        "/predict",
        files={"file": ("test.png", png, "image/png")},
        data={"bit_depth": "12"},
    )
    assert resp.status_code == 400


def test_root_serves_html(app_client):
    resp = app_client.get("/")
    assert resp.status_code == 200
    assert "Oil-Texture Bump Map" in resp.text
