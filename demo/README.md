# Demo pages for Tabnabbing/visual-diff testing

## Start a local server (recommended)
```bash
# from the folder that contains the `demo` directory
python3 -m http.server 8000
# then open: http://localhost:8000/demo/index.html
```

## Pages
- **index.html** – links to all tests
- **low-subtle.html** – barely perceptible color/spacing changes on blur (low diff)
- **medium-adjacent.html** – big hero swap (high) + nearby modest changes (medium)
- **high-full-rebrand.html** – complete page replacement to a login (high)
- **area-percent.html** – deterministic overlays by percentage (10/25/50/75)
  - Query params: `?p=25&mode=blur` for auto overlay of 25% on blur
- **dynamic-noise.html** – tiny animated shimmer (tests tolerance)

**How to test**
1. Open a page.
2. Wait ~2–3s so the extension takes the first screenshot.
3. Switch to another tab so the page loses focus (changes will apply).
4. Return to this tab — the extension compares and overlays differences.
