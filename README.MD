# TabNabbing-Detect — README

A Manifest V3 Chrome/Chromium extension that watches for tab-nabbing style swaps. It keeps a rolling screenshot of each active tab (your “baseline”), and when you return to that tab it captures a fresh image, compares the two, and highlights only the regions that actually changed. A small badge on the toolbar summarizes overall change level, and an on-page overlay calls out where the changes happened.

## Quick start (install)

- Open chrome://extensions (or your Chromium browser’s Extensions page).
- Turn on Developer mode (top-right toggle).
- Click Load unpacked and select the project folder.
- Pin the extension (optional) so you can see the badge updates.
- open new tab and click on website, giving it about 5-9 seconds to ensure a screenshot has been captured.
- Navigate to extension tab or any other tab
- Go back to the original website
- Click the extension icon and press the "clear all highlights button" before continuing activity on that website or before leaving the tab again
- You can enter `python3 tools/open_demo_tabs.py --port 5000` in the terminal which will open up test html in chrome
- Reload these pages, waiting a few seconds for the screenshot, leave the tab, and come back to see changes

That’s it — the extension runs automatically.

## What the extension does 

While a tab is active, a background service worker takes periodic screenshots (the baseline).

When you return to a tab (or a window regains focus), it captures a fresh screenshot and performs:

- A global mismatch calculation (via vendor/resemble.js).
- A fine-grained color-sensitive diff in CIE-Lab space (via analyzer.js) that clusters neighboring changes into bounding boxes.

It then:

- Draws translucent boxes over the changed regions on the page (visualizer.js).
- Sets a badge color and number (count of regions) on the extension icon (monitor.js).

You can clear overlays at any time from the popup.

All image processing happens locally in your browser. No data is sent anywhere.

## Folder layout

```text
tabnabbing-detect/
├─ demo/                    # Local demo pages (open in a regular tab)
│  ├─ index.html
│  ├─ cc-attack.html
│  ├─ dynamic-noise.html
│  └─ medium-adjacent.html
├─ icons/                   # Toolbar/store icons
│  ├─ shield.png
│  ├─ shield16.png
│  ├─ shield48.png
│  └─ shield128.png
├─ tools/
│  └─ open_demo_tabs.py     # Convenience helper to open the demo pages
├─ vendor/
│  └─ resemble.js           # Resemble.js (pixel diff library)
├─ analyzer.html            # Offscreen document that runs the analyzer
├─ analyzer.js              # Color-sensitive region detector (runs offscreen)
├─ control.html             # Popup UI (panel shown when clicking the icon)
├─ control.js               # Popup logic — clear overlays, status messages
├─ make_icons.py            # Small script to generate icon sizes
├─ manifest.json            # MV3 configuration
├─ monitor.js               # Background service worker (capture + orchestration)
└─ visualizer.js            # In-page overlay renderer
```

## Using the extension

### Automatic detection

Just browse normally. When you switch away and back, the extension compares the page’s appearance and shows results automatically.

### Popup (control panel)

Open the popup by clicking the toolbar icon.

Clear All Highlights — removes overlays and resets the badge text for the current tab.

Two short legends explain the colors you’ll see:

**Overlay colors (per-region):**

- Critical ≥ 28 (strong color shift)
- Warning 12–27.9
- Minor < 12

**Badge colors (overall % changed):**

- Critical ≥ 35%
- Warning 15–34.9%
- Minor < 15%

When no change is detected, the badge shows no number.

### On-page overlay

Colored rectangles are drawn where changes were detected.

A small floating chip shows MATCH and % changed for quick context.

Overlays rescale on window resize to stay aligned.

## How it works (under the hood)

### 1) Background worker — monitor.js

Captures the visible tab at a fixed cadence (CAPTURE_INTERVAL: 3500 ms).

Keeps a per-tab baseline (most recent active-tab screenshot).

On tab/window focus:

- Takes a new screenshot.
- Sends both images to an offscreen analyzer (analyzer.html + analyzer.js).
- Updates the badge color (based on overall % changed) and badge text (number of regions).
- Sends the regions + metadata to visualizer.js to draw overlays.

Certain pages can’t be captured by Chrome (e.g., browser settings). These are skipped safely.

### 2) Offscreen analyzer — analyzer.html + analyzer.js

Uses Resemble.js for a global mismatch number.

Does a color-aware pass in CIE-Lab:

- Converts sampled pixels to Lab (rgb → XYZ → Lab).
- Computes ΔE-style Euclidean distance between the two images.
- Marks pixels above a detection threshold and clusters them via flood-fill to produce bounding boxes.
- Only meaningful areas (minimum size) are reported.

Returns: `{ mismatch, changes: [{x,y,w,h,level}], width, height }`.

Key tunables (in analyzer.js):

- PIXEL_SAMPLE_RATE = 2 – sample every Nth pixel (performance vs. sensitivity).
- COLOR_THRESHOLD_DETECT = 4.5 – per-pixel color delta to consider “changed.”
- MIN_AREA_SIZE = 20 * 20 – minimum region size in pixels to report.

### 3) In-page overlay — visualizer.js

Draws highlight boxes using the analyzer’s coordinates, scaled to the current viewport.

Renders a small status pill (MATCH / % changed).

Listens for a `visualize:remove` message to clean up.

## Permissions & privacy

- `tabs`, `activeTab` – required for screenshot capture of the active tab.
- `offscreen` – to run the analyzer in an offscreen document.
- `<all_urls>` host permissions – needed so capture works on normal webpages.

Privacy: Screenshots never leave your machine. All computation is local. No network requests are made by the extension.

## Demos

The demo/ folder contains simple pages illustrating different change patterns:

- medium-adjacent.html — localized partial changes.
- dynamic-noise.html — moving/animated noise (shows robustness).
- cc-attack.html — a credit-card style tab-swap scenario.
- index.html — basic index page linking the others.

Open them in normal tabs (not as file URLs with restricted schemes) for the most realistic behavior.  
The helper `tools/open_demo_tabs.py` can open all demo pages at once (requires Python).

## Customizing behavior

### Background cadence (monitor.js)

```js
const CAPTURE_INTERVAL = 3500;  // ms between baseline refreshes
const COMPARISON_DELAY = 150;   // ms delay after focus before comparing
```

### Sensitive color diffs (analyzer.js)

```js
const PIXEL_SAMPLE_RATE = 2;          // lower = more precise, heavier
const COLOR_THRESHOLD_DETECT = 4.5;   // lower = more sensitive to color shifts
const MIN_AREA_SIZE = 20 * 20;        // smaller = report tinier regions
```

### Overlay/badge thresholds (UI)

Overlay “minor/warning/critical” and badge thresholds are shown in the popup legends and match the analyzer/monitor logic.

## Troubleshooting

**No overlays appear**  
You might be on a restricted page (Chrome internal pages, extension pages, some special schemes). Those cannot be captured by design. Try a normal website.

**Badge shows a number but I don’t see boxes**  
The visualizer might have been cleared by the page or another script. Click the toolbar icon and press Clear All Highlights.

**Too sensitive / not sensitive enough**  
Tweak in analyzer.js:

- Lower COLOR_THRESHOLD_DETECT to catch subtler color changes.
- Lower PIXEL_SAMPLE_RATE (e.g., 1) for maximum precision (heavier).
- Lower MIN_AREA_SIZE to show very small regions.

**Performance dips on large/animated pages**  
Consider raising PIXEL_SAMPLE_RATE to 3–4 and/or increasing CAPTURE_INTERVAL.

## Development notes

### Message flow

- monitor.js → (creates) analyzer.html offscreen document (once)
- monitor.js → analyzer.js : `analysis:request`
- analyzer.js → monitor.js : `analysis:complete` with results
- monitor.js → visualizer.js : `visualize:changes` (or `visualize:remove`)

Offscreen document is used to safely keep Canvas work out of the page context.

Resemble.js is bundled in vendor/resemble.js and used only for the global mismatch percentage.

## Known limitations

- Browser-internal pages (chrome://, edge://, about:, etc.) cannot be captured.
- Highly animated content may inflate the change percentage (that is expected behavior for a visual-difference tool).
- Exact pixel diffs can vary across platforms due to font rendering and GPU compositing.

## License / attribution

Resemble.js © Huddle / James Cryer — included in vendor/resemble.js under its license.

All other code in this project is provided for educational use.
