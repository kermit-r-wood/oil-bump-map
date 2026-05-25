# Oil-Texture Bump Map (UV-Print Ready)

A FastAPI service that turns any photograph or painting into a depth/bump
map ready to UV-print on the **Eufy Make E1**. The pipeline is tuned to
*fight* the printer's slicing-time smoothing so the printed surface still
carries an oil-painting-like texture.

A single mode is exposed: **`scan_replica`** — it reproduces the look of a
real 3D scan of an oil painting (mid-gray baseline + paint-density-driven
ridges + luminance-driven height bias).

The pipeline is **RGB-only**: no monocular depth estimator, no GPU, no
heavy ML deps. Total runtime dependency footprint is ~50 MB.

---

## Example

| Input image | Generated bump map |
|---|---|
| ![Input](docs/example/frieren_input.jpg) | ![Bump map](docs/example/frieren_bump.png) |

A digital portrait, processed at its native 2734×1536 with default
parameters and viewed as 8-bit grayscale (the actual output is 16-bit).
Notice how the smooth face stays at mid-gray (no false impasto), the
hair brushwork is raised with stroke direction, and the dark eye
sockets register as recessed.

---

## Pipeline

1. **Structure tensor** on the input RGB extracts per-pixel stroke
   orientation (with a high-pass pre-filter so silhouette edges don't
   dominate the field).
2. **Anisotropic LIC** generates a stroke field that follows local image
   structure.
3. **Paint-density mask** (variance-driven, luminance-weighted) detects
   *where* paint would be piled up: clusters of fine brushwork register
   as high density, isolated silhouette edges get diluted by window
   area, smooth regions stay near zero.
4. **Composer**: `bump = stroke × paint_density`, recentered and
   rescaled to a target amplitude.
5. **Luminance-driven DC offset**: bright textured regions become
   persistently raised (real impasto catches light), dark textured
   regions become recessed, smooth regions stay at mid-gray. This adds
   the bulk paint-thickness component a zero-mean ridge field cannot
   produce.
6. **Unsharp pre-compensation** counteracts the E1's smoothing pass.
7. **16-bit grayscale PNG** export (8-bit fallback available).

A `/preview_smoothed` endpoint approximates the E1's smoothing in
software, so you can preview "what the E1 will probably print" without
actually printing.

---

## Quickstart

```bash
# Windows (PowerShell or cmd)
run.bat
```

Or manually:

```bash
python -m venv venv
venv\Scripts\activate          # Linux/macOS: source venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000> in a browser, upload an image, download the
generated bump map.

### Run tests

```bash
venv\Scripts\python.exe -m pytest tests/ -v
```

The test suite is fully offline and finishes in a few seconds (no model
downloads, no GPU).

---

## UV printer polarity convention

The Eufy Make E1 (and most UV displacement printers) treat the depth map
as a height map: **white = raised, black = recessed**.

In `scan_replica` this means:
- Bright textured regions (highlights, impasto) → bright pixels → raised
- Dark textured regions (heavy shadow paint, dark impasto) → dark pixels
  → recessed
- Smooth regions of any luminance → mid-gray → flat

The luminance-driven DC offset (see `luminance_height_bias` in
`pipeline/presets.py`) is what turns "where there is paint" into "how
high the paint is".

---

## How it works (preset parameters)

All parameters live in `pipeline/presets.py` as a single
`StylePreset` instance:

| Field | Default | Effect |
|---|---|---|
| `stroke_length` | 32 | LIC stroke length in pixels (longer = more sweeping brushwork) |
| `stroke_thickness` | 4 | LIC stroke thickness perpendicular to flow |
| `direction_strength` | 1.0 | 0 = isotropic noise; 1 = fully anisotropic LIC |
| `orientation_highpass_sigma` | 8.0 | Pre-blur σ for the structure tensor; > 0 ignores large-scale silhouette edges |
| `iso_weight` | 0.0 | Isotropic-noise blend in low-coherence regions; 0 keeps smooth areas truly flat |
| `thickness_gamma` | 2.0 | Power applied to the paint-density mask (>1 sharpens the contrast between textured and smooth regions) |
| `thickness_floor` | 0.0 | Lift the mask floor; 0.4 gives a uniform "canvas of paint" base + impasto on top |
| `output_amplitude` | 0.22 | 99th-percentile of |bump| target amplitude (final dynamic range) |
| `luminance_height_bias` | 0.5 | DC offset strength: 0 = pure ridge field, 0.5 = noticeable impasto bumps, 1.0 = strong physical thickness |
| `unsharp_sigma` | 1.0 | E1 anti-smoothing pre-comp σ (matches Smoothing 1) |
| `unsharp_alpha` | 0.5 | E1 anti-smoothing pre-comp strength |

---

## Calibration workflow

Goal: tune `pipeline/presets.py` so the print on *your* machine looks
the way you want.

1. **Pick a test image** with a mix of smooth and textured regions
   (e.g. a Van Gogh photo).
2. **Generate** a bump map and save it.
3. **Print** it on the E1 at the lowest smoothing setting you'll use in
   production (typically Smoothing 1).
4. **Inspect** under raking light:
   - **Strokes too soft / lost?** Bump `unsharp_alpha` (+0.1) or
     `output_amplitude` (+0.05).
   - **Strokes look "ringy" / over-sharpened?** Drop `unsharp_alpha`
     by 0.1.
   - **Whole canvas too flat / uniform?** Bump `luminance_height_bias`
     (+0.2) — this widens the persistent-height range.
   - **Subject features too prominent (looks like a portrait, not a
     painted surface)?** Drop `output_amplitude` and/or
     `luminance_height_bias`.
   - **Background is dead flat but you want some "canvas of paint"
     base?** Set `thickness_floor=0.3` to `0.5`.
   - **Strokes too short / fluffy on a 4K-wide image?** Bump
     `stroke_length` to 40–60 and `stroke_thickness` to 5–6.
5. **Re-export** with the new params and reprint.

The browser's "Simulated Print" panel uses `/preview_smoothed` to apply
the estimated σ in software; tune σ to roughly match your printer's
actual smoothing, then iterate the preset parameters until the
simulated preview matches your desired look.

### E1 smoothing reference

| E1 Smoothing slider | Equivalent σ (px) — *approximate* |
|---------------------|-----------------------------------|
| 1                   | ≈ 1.0                             |
| 5                   | ≈ 2.2                             |
| 10                  | ≈ 3.5                             |

These are rough. Calibrate against your machine: print a known grating
pattern, measure the modulation transfer, fit a Gaussian PSF.

---

## Project layout

```
depth_map/
├── app.py                      # FastAPI server (RGB-only, no Marigold)
├── index.html                  # Single-page front-end
├── pipeline/
│   ├── orientation.py          # Structure tensor → (theta, coherence)
│   ├── strokes.py              # Anisotropic LIC stroke field
│   ├── compose.py              # paint_density_mask + compose_bump
│   ├── postprocess.py          # Unsharp pre-comp + PNG quantizer
│   ├── presets.py              # Single locked StylePreset
│   └── runner.py               # OilTextureBumpPipeline (end-to-end)
├── tests/
│   ├── test_orientation.py
│   ├── test_strokes.py
│   ├── test_compose.py
│   ├── test_postprocess.py
│   ├── test_runner.py
│   ├── test_api.py             # FastAPI integration (no model mocking)
│   └── test_preview.py
├── requirements.txt
└── README.md                   # this file
```

---

## API reference

### `POST /predict`

Generate a scan_replica bump-map PNG.

| Field       | Type | Default    | Notes                      |
|-------------|------|------------|----------------------------|
| `file`      | file | (required) | RGB image (any common format). |
| `bit_depth` | int  | 16         | 8 or 16.                   |

Response: `image/png` bytes (8-bit `L` or 16-bit `I;16`).

Inputs larger than 4096 px on the long side are downscaled before
processing (avoids OOM and pathological runtimes).

### `POST /preview_smoothed`

Apply the E1's estimated smoothing to a bump-map PNG, returning the
blurred result.

| Field   | Type  | Default | Notes                              |
|---------|-------|---------|------------------------------------|
| `file`  | file  | —       | A grayscale PNG (8-bit or 16-bit). |
| `sigma` | float | 1.0     | Gaussian σ in pixels. 0 = passthrough. |

Response: `image/png` (same bit depth as input).

---

## Out of scope (intentional)

- **Canvas weave / paper texture** — removed by user request.
- **Subject 3D bas-relief from monocular depth (Marigold)** — removed:
  the `scan_replica` mode is RGB-only by design and ignored Marigold's
  output even when it was wired in. Bringing it back would require
  reintroducing torch/diffusers/transformers (~5 GB of deps + GPU).
- **Front-end advanced parameter sliders** — only bit-depth and the
  E1-smoothing σ slider are exposed; tune everything else in
  `pipeline/presets.py`.

---

## Dependencies

Runtime (~50 MB total):

- `fastapi` + `uvicorn` + `python-multipart` — server
- `opencv-python-headless` — Sobel, Gaussian, box filter
- `numpy`, `scipy` — array math, LIC vectorization (`map_coordinates`)
- `Pillow` — PNG encode/decode (16-bit `I;16`)

Dev:

- `pytest` + `httpx` — tests
