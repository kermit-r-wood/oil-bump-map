"""FastAPI server for the scan_replica oil-paint bump pipeline.

No depth model required: the pipeline is RGB-only.

Endpoints:
  /                   - serves the single-page front-end (index.html)
  /predict            - generates a scan_replica bump map from an image
  /preview_smoothed   - approximates E1 slicing smoothing for preview
"""

from fastapi import FastAPI, File, UploadFile, Form, HTTPException
from fastapi.responses import Response, HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image

import io
import numpy as np
import cv2

from pipeline.runner import OilTextureBumpPipeline


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Single shared, deterministic instance.
oil_pipeline = OilTextureBumpPipeline(seed=1234)


@app.get("/")
async def serve_index():
    with open("index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.post("/predict")
async def predict(
    file: UploadFile = File(...),
    bit_depth: int = Form(16),
):
    """Generate a scan_replica bump map from an input image.

    Returns a PNG: 16-bit grayscale (mode I;16) by default, 8-bit (mode L)
    if bit_depth=8. White = raised, black = recessed (Eufy E1 convention).
    """
    if bit_depth not in (8, 16):
        raise HTTPException(
            status_code=400,
            detail=f"bit_depth must be 8 or 16; got {bit_depth}",
        )

    contents = await file.read()
    image = Image.open(io.BytesIO(contents)).convert("RGB")

    # Cap input resolution to avoid OOM / pathological runtime on large
    # uploads. The structure tensor + LIC scale roughly linearly with
    # pixel count; 4K wide is the comfortable upper bound.
    max_safe_res = 4096
    if max(image.width, image.height) > max_safe_res:
        image.thumbnail((max_safe_res, max_safe_res), Image.LANCZOS)

    rgb_arr = np.array(image, dtype=np.uint8)
    png_bytes = oil_pipeline.run_to_png(rgb_arr, bit_depth=int(bit_depth))
    return Response(content=png_bytes, media_type="image/png")


@app.post("/preview_smoothed")
async def preview_smoothed(
    file: UploadFile = File(...),
    sigma: float = Form(1.0),
):
    """Approximate the Eufy Make E1 slicing smoothing by Gaussian blur on
    an already-generated bump-map PNG.

    sigma reference (rough; calibrate against your machine):
        smoothing 1   -> sigma  ~ 1.0
        smoothing 5   -> sigma  ~ 2.2
        smoothing 10  -> sigma  ~ 3.5
    """
    contents = await file.read()
    img = Image.open(io.BytesIO(contents))
    arr = np.asarray(img)

    if sigma <= 0.0:
        # Identity: echo unchanged bytes.
        return Response(content=contents, media_type="image/png")

    if arr.ndim != 2:
        raise HTTPException(
            status_code=400,
            detail="preview_smoothed expects a 2D grayscale PNG (8-bit L or 16-bit I;16)",
        )

    # cv2.GaussianBlur preserves dtype.
    blurred = cv2.GaussianBlur(arr, (0, 0), float(sigma))

    if arr.dtype == np.uint16:
        out_pil = Image.new("I;16", (blurred.shape[1], blurred.shape[0]))
        out_pil.frombytes(blurred.astype(np.uint16).tobytes())
    elif arr.dtype == np.uint8:
        out_pil = Image.fromarray(blurred.astype(np.uint8), mode="L")
    else:
        raise HTTPException(
            status_code=400,
            detail=f"unsupported PNG dtype {arr.dtype}; expected uint8 or uint16",
        )

    buf = io.BytesIO()
    out_pil.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")
