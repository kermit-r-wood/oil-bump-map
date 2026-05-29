# Oil-Texture Bump Map (UV-Print Ready)

**English** | [简体中文](README_zh.md)

---

**Live Demo:** [https://kermit-r-wood.github.io/oil-bump-map/](https://kermit-r-wood.github.io/oil-bump-map/)

A single-page web app that turns any photograph or painting into a depth/bump
map ready to UV-print on the **Eufy Make E1**. The pipeline is tuned to
*fight* the printer's slicing-time smoothing so the printed surface still
carries an oil-painting-like texture.

A single mode is exposed: **`scan_replica`** — it reproduces the look of a
real 3D scan of an oil painting (mid-gray baseline + paint-density-driven
ridges + luminance-driven height bias).

The pipeline is **RGB-only** and **runs entirely in the browser**: no
monocular depth estimator, no GPU, no server, no build tooling, no upload.
Drop the `web/` folder on any static host (or open it via a one-line static
server) and you have a working app.

---

## Example

| Input image | Generated bump map |
|---|---|
| ![Input](docs/example/frieren_input.jpg) | ![Bump map](docs/example/frieren_bump.png) |

A digital portrait, processed with default parameters and viewed as 8-bit
grayscale (the actual output is 16-bit). Notice how the smooth face stays
at mid-gray (no false impasto), the hair brushwork is raised with stroke
direction, and the dark eye sockets register as recessed.

---

## Quickstart (front-end, no install)

The whole app is plain ES modules in `web/`. You only need a static server
because browsers refuse to load ES modules off `file://`.

```powershell
# Recommended (Node 18+, zero dependencies — uses scripts/dev_server.mjs)
npm run dev
# then open http://127.0.0.1:8000/
```

```bash
# macOS / Linux
npm run dev
# or any other static server, e.g.: npx serve web
```

`npm install` does nothing useful (there are no runtime dependencies); the
`scripts/dev_server.mjs` is a ~70-line static server using only Node's
built-in `http` module. The port can be overridden with `PORT=8080 npm run dev`.

Upload an image, the bump map is computed in your browser and offered as a
16-bit grayscale PNG download. **Your image never leaves your machine.**

### Browser requirements

- Chrome / Edge **80+**, Firefox **113+**, Safari **16.4+** (any browser
  with the `CompressionStream` API and ES modules).

### Performance reference

End-to-end on a 2048×2048 image, single tab in Chrome:

| Backend                | 2K time | Notes |
|------------------------|---------|-------|
| CPU (pure JS, Worker)  | ~10 s   | Always available |
| WebGL2 (fragment)      | ~0.4 s  | Almost universal browser support |

The pipeline runs in a Web Worker so the page stays responsive regardless of
backend. `auto` mode picks the fastest available backend at page load.

The "max side" selector in the UI caps the input long edge before
processing (default 2048). 4K is fine on the GPU backends; the CPU
backend will be unbearably slow at 4K (≈ 1 minute) — keep it at ≤ 2K.

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

The "Simulated Print" panel applies a Gaussian blur to the generated
bump map in software so you can preview "what the E1 will probably print"
without actually printing.

---

## UV printer polarity convention

The Eufy Make E1 (and most UV displacement printers) treat the depth map
as a height map: **white = raised, black = recessed**.

In `scan_replica` this means:
- Bright textured regions (highlights, impasto) → bright pixels → raised
- Dark textured regions (heavy shadow paint, dark impasto) → dark pixels
  → recessed
- Smooth regions of any luminance → mid-gray → flat

The luminance-driven DC offset (`luminanceHeightBias` in
`web/src/presets.js`) is what turns "where there is paint" into "how
high the paint is".

---

## How it works (preset parameters)

All parameters live in `web/src/presets.js` as a single `PRESET` object:

| Field | Default | Effect |
|---|---|---|
| `strokeLength` | 32 | LIC stroke length in pixels (longer = more sweeping brushwork) |
| `strokeThickness` | 4 | LIC stroke thickness perpendicular to flow |
| `directionStrength` | 1.0 | 0 = isotropic noise; 1 = fully anisotropic LIC |
| `orientationHighpassSigma` | 8.0 | Pre-blur σ for the structure tensor; > 0 ignores large-scale silhouette edges |
| `isoWeight` | 0.0 | Isotropic-noise blend in low-coherence regions; 0 keeps smooth areas truly flat |
| `thicknessGamma` | 2.0 | Power applied to the paint-density mask (>1 sharpens the contrast between textured and smooth regions) |
| `thicknessFloor` | 0.0 | Lift the mask floor; 0.4 gives a uniform "canvas of paint" base + impasto on top |
| `outputAmplitude` | 0.22 | 99th-percentile of \|bump\| target amplitude (final dynamic range) |
| `luminanceHeightBias` | 0.5 | DC offset strength: 0 = pure ridge field, 0.5 = noticeable impasto bumps, 1.0 = strong physical thickness |
| `unsharpSigma` | 1.0 | E1 anti-smoothing pre-comp σ (matches Smoothing 1) |
| `unsharpAlpha` | 0.5 | E1 anti-smoothing pre-comp strength |

Edit the file, refresh the page — done.

---

## Calibration workflow

Goal: tune `web/src/presets.js` so the print on *your* machine looks the
way you want.

1. **Pick a test image** with a mix of smooth and textured regions
   (e.g. a Van Gogh photo).
2. **Generate** a bump map and save it.
3. **Print** it on the E1 at the lowest smoothing setting you'll use in
   production (typically Smoothing 1).
4. **Inspect** under raking light:
   - **Strokes too soft / lost?** Bump `unsharpAlpha` (+0.1) or
     `outputAmplitude` (+0.05).
   - **Strokes look "ringy" / over-sharpened?** Drop `unsharpAlpha`
     by 0.1.
   - **Whole canvas too flat / uniform?** Bump `luminanceHeightBias`
     (+0.2) — this widens the persistent-height range.
   - **Subject features too prominent (looks like a portrait, not a
     painted surface)?** Drop `outputAmplitude` and/or
     `luminanceHeightBias`.
   - **Background is dead flat but you want some "canvas of paint"
     base?** Set `thicknessFloor=0.3` to `0.5`.
   - **Strokes too short / fluffy on a 4K-wide image?** Bump
     `strokeLength` to 40–60 and `strokeThickness` to 5–6.
5. **Re-export** with the new params and reprint.

The "Simulated Print" panel approximates the E1's smoothing in software;
tune σ to roughly match your printer's actual smoothing, then iterate
the preset parameters until the simulated preview matches your desired
look.

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
├── web/                        # ★ the actual app — drop this on a static host
│   ├── index.html
│   ├── package.json            # only used so Node treats *.js as ESM for tests
│   ├── test_node.mjs           # smoke test: `node web/test_node.mjs`
│   └── src/
│       ├── main.js             # UI glue (file upload → worker → PNG)
│       ├── worker.js           # Web Worker entry; runs the pipeline off-main
│       ├── runner.js           # backend dispatcher + auto-selection
│       ├── i18n.js             # English / Chinese strings + helpers
│       ├── backends/
│       │   ├── cpu.js          # pure-JS pipeline (always available)
│       │   └── webgl.js        # WebGL2 fragment-shader pipeline
│       ├── gl/                 # WebGL2 helpers + shaders + orchestrator
│       ├── orientation.js      # CPU: structure tensor → (θ, coherence)
│       ├── strokes.js          # CPU: anisotropic LIC stroke field
│       ├── compose.js          # CPU: paint-density mask + bump composer
│       ├── postprocess.js      # CPU: unsharp + 8/16-bit quantizer
│       ├── presets.js          # locked StylePreset
│       ├── filters.js          # Gaussian / box / Sobel / bilinear / percentile
│       ├── rng.js              # Mulberry32 + Box-Muller standard-normal
│       └── png.js              # tiny 16-bit grayscale PNG encoder
├── scripts/
│   ├── dev_server.mjs          # zero-dep Node http static server (npm run dev)
│   └── test_dev_server.mjs     # smoke test for the dev server
├── .github/workflows/          # GitHub Pages deploy on push to main
├── docs/example/               # input / output sample
├── package.json                # npm scripts (dev / test) — no runtime deps
├── README.md                   # English documentation
└── README_zh.md                # Chinese documentation
```

---

## Backends

The pipeline is implemented twice, behind a common dispatcher:

| Backend  | Where it runs                  | Browser support               |
|----------|--------------------------------|-------------------------------|
| **cpu**  | Pure JS in a Web Worker        | Universal (anywhere ES modules + CompressionStream work) |
| **webgl**| WebGL2 fragment shaders        | Chrome 56+ / Firefox 51+ / Safari 15+ (requires `EXT_color_buffer_float`) |

Selection happens in three places:
- `auto` (default): the runtime probes WebGL → CPU and picks the
  first available; degraded gracefully on older browsers.
- The UI dropdown lets you force a specific backend for benchmarking.
- The dropdown disables backends the runtime reported as unavailable.

Both backends share the same `IBackend` interface
(`{ name, isAvailable(), run(rgba, W, H, opts), dispose() }`) and produce
the same `bumpFloat: Float32Array`. Quantization (Float32 → Uint16/Uint8)
and PNG encoding always happen on the CPU after the backend returns —
they're cheap (≪ 100 ms at 2K) and avoid duplicating PNG plumbing per
backend.

The WebGL backend still calls back to CPU for the **percentile** computations
(99th of \|stroke\|, 95th of paint density, mean & 99th of raw bump).
Each readback at 2K is ~10–30 ms, far cheaper than the GPU compute it
saves on the LIC + structure tensor.

The Web Worker is mandatory for the WebGL backend to keep the UI thread
free during readbacks; the CPU backend benefits from it too (no main-thread
hitches during the 10s 2K run).

---

## Dev / testing

```powershell
# Run both: pipeline smoke test (CPU backend) + dev-server smoke test
npm test

# Or one at a time:
npm run test:pipeline      # node web/test_node.mjs
npm run test:server        # node scripts/test_dev_server.mjs
```

`web/test_node.mjs` covers 9 invariants on the CPU backend (dtype, flat-input
mid-gray, polarity, determinism, PNG encode, backend probe, forced selection,
shader source sanity). It also writes a sample 256×256 16-bit PNG to
`web/test_node_out.png` to visually confirm the encoder.

WebGL backend can only be exercised in a real browser — open the
dev server and force the backend from the dropdown.

---

## Out of scope (intentional)

- **Canvas weave / paper texture** — removed by user request.
- **Subject 3D bas-relief from monocular depth (Marigold)** — removed:
  the `scan_replica` mode is RGB-only by design.
- **Front-end advanced parameter sliders** — only bit-depth, max-side
  and the E1-smoothing σ slider are exposed; tune everything else in
  `web/src/presets.js`.

---

## Dependencies

Runtime: **none.** Just the browser.

Dev tooling: **none.** `npm install` does nothing useful — `package.json`
declares no `dependencies` and no `devDependencies`. The dev server,
test runner, and CI all use only Node's built-in modules.
