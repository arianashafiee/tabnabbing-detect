// offscreen.js — full-region (no grid) diff, color-sensitive, fast.
// Sends: { type:"tabrewind:result", tabId, mismatch, regions, W, H }

(() => {
    // ---- Tunables (for speed/sensitivity) ----
    const STEP = 2;              // sample every Nth pixel (2 is fast + precise)
    const DELTA_E_LOW = 2.0;     // ~barely-visible color change
    const DELTA_E_KEEP = 4.0;    // treat as changed if >= this ΔE
    const MIN_REGION_PX = 18 * 18; // discard tiny specks after grouping
  
    // Region severity coloring (used by content.js)
    function levelFromDelta(maxDE) {
      return maxDE >= 25 ? "high" : maxDE >= 10 ? "medium" : "low";
    }
  
    function severityFromGlobal(m) {
      return m >= 30 ? "high" : m >= 10 ? "medium" : "low";
    }
  
    // ---------- Color space helpers (RGB -> Lab -> ΔE76) ----------
    function srgbToLinear(c) {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    function rgbToXyz(r, g, b) {
      const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
      const X = R * 0.4124564 + G * 0.3575761 + B * 0.1804375;
      const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
      const Z = R * 0.0193339 + G * 0.1191920 + B * 0.9503041;
      return [X, Y, Z];
    }
    function xyzToLab(x, y, z) {
      // D65 reference white
      const Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
      const f = t => (t > 0.008856) ? Math.cbrt(t) : (7.787 * t + 16 / 116);
      const fx = f(x / Xn), fy = f(y / Yn), fz = f(z / Zn);
      const L = 116 * fy - 16;
      const a = 500 * (fx - fy);
      const b = 200 * (fy - fz);
      return [L, a, b];
    }
    function rgbToLab(r, g, b) {
      const [x, y, z] = rgbToXyz(r, g, b);
      return xyzToLab(x, y, z);
    }
    function deltaE76(L1, a1, b1, L2, a2, b2) {
      const dL = L1 - L2, da = a1 - a2, db = b1 - b2;
      return Math.sqrt(dL * dL + da * da + db * db);
    }
  
    // ---------- Image I/O ----------
    function loadImg(url) {
      return new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
    }
  
    function makeCanvas(w, h) {
      if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
      const c = self.document.createElement("canvas");
      c.width = w; c.height = h;
      return c;
    }
  
    async function getImageDataPair(beforeURL, afterURL) {
      const [A, B] = await Promise.all([loadImg(beforeURL), loadImg(afterURL)]);
      const W = Math.min(A.width, B.width);
      const H = Math.min(A.height, B.height);
  
      const c1 = makeCanvas(W, H), g1 = c1.getContext("2d", { willReadFrequently: true });
      const c2 = makeCanvas(W, H), g2 = c2.getContext("2d", { willReadFrequently: true });
      g1.drawImage(A, 0, 0, W, H);
      g2.drawImage(B, 0, 0, W, H);
      const d1 = g1.getImageData(0, 0, W, H);
      const d2 = g2.getImageData(0, 0, W, H);
      return { W, H, d1, d2 };
    }
  
    // ---------- Global mismatch via Resemble (for badge consistency) ----------
    function globalMismatchResemble(beforeURL, afterURL) {
      return new Promise(resolve => {
        if (typeof resemble === "undefined") return resolve(0);
        try {
          resemble(beforeURL).compareTo(afterURL).ignoreNothing().onComplete(d => {
            const p = parseFloat(d?.rawMisMatchPercentage ?? d?.misMatchPercentage ?? "0") || 0;
            resolve(p);
          });
        } catch { resolve(0); }
      });
    }
  
    // ---------- Full-frame mask + connected components (no grid drawn) ----------
    function buildMaskAndStats(d1, d2, W, H) {
      const a = d1.data, b = d2.data;
  
      const rows = Math.ceil(H / STEP), cols = Math.ceil(W / STEP);
      const mask = new Uint8Array(rows * cols); // 0/1
      const deltas = new Float32Array(rows * cols); // store ΔE for severity
      let changed = 0, total = 0, maxDEGlobal = 0;
  
      // Cache: convert each sampled pixel to Lab and compare
      for (let y = 0, rr = 0; y < H; y += STEP, rr++) {
        for (let x = 0, cc = 0; x < W; x += STEP, cc++) {
          const idx = (y * W + x) * 4;
          const r1 = a[idx], g1 = a[idx + 1], b1 = a[idx + 2];
          const r2 = b[idx], g2 = b[idx + 1], b2 = b[idx + 2];
  
          const [L1, A1, B1] = rgbToLab(r1, g1, b1);
          const [L2, A2, B2] = rgbToLab(r2, g2, b2);
          const dE = deltaE76(L1, A1, B1, L2, A2, B2);
  
          deltas[rr * cols + cc] = dE;
          if (dE >= DELTA_E_KEEP) {
            mask[rr * cols + cc] = 1;
            changed++;
            if (dE > maxDEGlobal) maxDEGlobal = dE;
          }
          total++;
        }
      }
      const mismatchApprox = (changed / total) * 100;
      return { mask, deltas, rows, cols, mismatchApprox, maxDEGlobal };
    }
  
    function componentsToBoxes(mask, deltas, rows, cols) {
      const seen = new Uint8Array(mask.length);
      const boxes = [];
  
      const nbrs = (r, c) => [
        [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]
      ];
  
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const idx = r * cols + c;
          if (!mask[idx] || seen[idx]) continue;
  
          let minR = r, maxR = r, minC = c, maxC = c;
          let pixels = 0, maxDE = 0;
  
          const q = [[r, c]];
          seen[idx] = 1;
  
          while (q.length) {
            const [rr, cc] = q.pop();
            const id = rr * cols + cc;
            pixels++;
            if (deltas[id] > maxDE) maxDE = deltas[id];
            if (rr < minR) minR = rr; if (rr > maxR) maxR = rr;
            if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;
  
            for (const [nr, nc] of nbrs(rr, cc)) {
              if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
              const nid = nr * cols + nc;
              if (!seen[nid] && mask[nid]) {
                seen[nid] = 1;
                q.push([nr, nc]);
              }
            }
          }
  
          // Convert from STEP-grid units back to pixel space
          const x = minC * STEP, y = minR * STEP;
          const w = (maxC - minC + 1) * STEP;
          const h = (maxR - minR + 1) * STEP;
  
          if (w * h >= MIN_REGION_PX) {
            boxes.push({ x, y, w, h, level: levelFromDelta(maxDE), maxPct: maxDE });
          }
        }
      }
      return boxes;
    }
  
    chrome.runtime.onMessage.addListener(async (msg) => {
      if (msg?.type !== "tabrewind:compute") return;
      const { tabId, before, after } = msg;
  
      try {
        // 1) Global mismatch (Resemble, ignoreNothing to capture color changes)
        const globalMismatch = await globalMismatchResemble(before, after);
  
        // 2) Mask + components for full-region boxes (no grid overlay)
        const { W, H, d1, d2 } = await getImageDataPair(before, after);
        const { mask, deltas, rows, cols, mismatchApprox } = buildMaskAndStats(d1, d2, W, H);
  
        // Prefer Resemble’s % if available; fall back to mask estimate
        const mismatch = globalMismatch > 0 ? globalMismatch : mismatchApprox;
  
        const regions = componentsToBoxes(mask, deltas, rows, cols);
  
        // 3) Emit result
        chrome.runtime.sendMessage({
          type: "tabrewind:result",
          tabId,
          mismatch,
          regions,
          W, H
        });
  
        // (No second pass; first paint is fast and final)
  
      } catch (e) {
        chrome.runtime.sendMessage({
          type: "tabrewind:result",
          tabId,
          mismatch: 0,
          regions: [],
          W: 0, H: 0,
          error: String(e?.message || e)
        });
      }
    });
  })();
  