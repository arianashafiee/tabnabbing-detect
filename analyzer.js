// Offscreen analyzer: detects visual diffs and returns clustered regions
(() => {
  'use strict';

  // ---------------------------
  // Tunables (do not alter semantics)
  // ---------------------------
  const STEP = 2;                  // sample stride (every 2nd pixel)
  const MIN_VISIBLE_DELTA = 2.5;   // perceptibility threshold (declared for parity)
  const HIT_DELTA = 4.5;           // mark a pixel as changed at/above this delta
  const MIN_REGION_AREA = 20 * 20; // ignore tiny specks

  // Region severity from maximum per-region color distance in Lab space
  const levelFromDelta = (d) =>
      d >= 28 ? 'critical'
    : d >= 12 ? 'warning'
    : 'minor';

  // Global severity from % changed (kept for parity with original; unused here)
  const levelFromPercent = (p) =>
      p >= 35 ? 'critical'
    : p >= 15 ? 'warning'
    : 'minor';

  // ---------------------------
  // Color conversion helpers (sRGB -> XYZ -> Lab)
  // ---------------------------
  const srgbToLinear = (c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };

  const rgbToXyz = (r, g, b) => {
    const rl = srgbToLinear(r);
    const gl = srgbToLinear(g);
    const bl = srgbToLinear(b);
    return [
      rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375,
      rl * 0.2126729 + gl * 0.7151522 + bl * 0.0721750,
      rl * 0.0193339 + gl * 0.1191920 + bl * 0.9503041
    ];
  };

  const xyzToLab = (X, Y, Z) => {
    // D65 reference white
    const refX = 0.95047;
    const refY = 1.00000;
    const refZ = 1.08883;

    const f = (t) => (t > 0.008856) ? Math.cbrt(t) : (7.787 * t + 16 / 116);

    const fx = f(X / refX);
    const fy = f(Y / refY);
    const fz = f(Z / refZ);

    return [
      116 * fy - 16,       // L*
      500 * (fx - fy),     // a*
      200 * (fy - fz)      // b*
    ];
  };

  const rgbToLab = (r, g, b) => {
    const [X, Y, Z] = rgbToXyz(r, g, b);
    return xyzToLab(X, Y, Z);
  };

  const labDistance = (L1, a1, b1, L2, a2, b2) => {
    const dL = L1 - L2;
    const dA = a1 - a2;
    const dB = b1 - b2;
    return Math.sqrt(dL * dL + dA * dA + dB * dB);
  };

  // ---------------------------
  // Image IO
  // ---------------------------
  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = src;
    });

  const makeCanvas = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(w, h);
    }
    const c = self.document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
    // (Offscreen document context guarantees DOM access)
  };

  const getPairImageData = async (beforeUrl, afterUrl) => {
    const [imA, imB] = await Promise.all([loadImage(beforeUrl), loadImage(afterUrl)]);
    const w = Math.min(imA.width, imB.width);
    const h = Math.min(imA.height, imB.height);

    const cA = makeCanvas(w, h);
    const cB = makeCanvas(w, h);
    const ctxA = cA.getContext('2d', { willReadFrequently: true });
    const ctxB = cB.getContext('2d', { willReadFrequently: true });

    ctxA.drawImage(imA, 0, 0, w, h);
    ctxB.drawImage(imB, 0, 0, w, h);

    return {
      width:  w,
      height: h,
      dataA:  ctxA.getImageData(0, 0, w, h),
      dataB:  ctxB.getImageData(0, 0, w, h)
    };
  };

  // ---------------------------
  // Global mismatch via Resemble.js (best-effort; 0 if unavailable)
  // ---------------------------
  const globalMismatch = (urlA, urlB) =>
    new Promise((resolve) => {
      if (typeof resemble === 'undefined') return resolve(0);
      try {
        resemble(urlA)
          .compareTo(urlB)
          .ignoreNothing()
          .onComplete((data) => {
            const pct = parseFloat(
              data?.rawMisMatchPercentage ?? data?.misMatchPercentage ?? '0'
            ) || 0;
            resolve(pct);
          });
      } catch {
        resolve(0);
      }
    });

  // ---------------------------
  // Sampling pass: compute per-sample Lab distance and mark changed samples
  // ---------------------------
  const sampleChanges = (imgA, imgB, w, h) => {
    const pA = imgA.data;
    const pB = imgB.data;

    const rows = Math.ceil(h / STEP);
    const cols = Math.ceil(w / STEP);

    const marks = new Uint8Array(rows * cols);
    const deltas = new Float32Array(rows * cols);

    let changed = 0;
    let total   = 0;

    for (let y = 0, ry = 0; y < h; y += STEP, ry++) {
      for (let x = 0, cx = 0; x < w; x += STEP, cx++) {
        const off = (y * w + x) * 4;

        const r1 = pA[off],     g1 = pA[off + 1], b1 = pA[off + 2];
        const r2 = pB[off],     g2 = pB[off + 1], b2 = pB[off + 2];

        const [L1, a1, b_1] = rgbToLab(r1, g1, b1);
        const [L2, a2, b_2] = rgbToLab(r2, g2, b2);

        const d = labDistance(L1, a1, b_1, L2, a2, b_2);

        const idx = ry * cols + cx;
        deltas[idx] = d;

        if (d >= HIT_DELTA) {
          marks[idx] = 1;
          changed++;
        }
        total++;
      }
    }

    const approxPercent = (changed / total) * 100;

    return { marks, deltas, rows, cols, approxPercent };
  };

  // ---------------------------
  // Connected components over the mark grid to produce bounding boxes
  // ---------------------------
  const regionsFromMarks = (marks, deltas, rows, cols) => {
    const seen = new Uint8Array(marks.length);
    const out = [];

    const neighbors4 = (r, c) => (
      r > 0         ? [[r - 1, c]] : []
    ).concat(
      r + 1 < rows  ? [[r + 1, c]] : []
    ).concat(
      c > 0         ? [[r, c - 1]] : []
    ).concat(
      c + 1 < cols  ? [[r, c + 1]] : []
    );

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!marks[i] || seen[i]) continue;

        let minR = r, maxR = r, minC = c, maxC = c;
        let maxDelta = 0;
        let stack = [[r, c]];
        seen[i] = 1;

        while (stack.length) {
          const [cr, cc] = stack.pop();
          const ci = cr * cols + cc;

          if (deltas[ci] > maxDelta) maxDelta = deltas[ci];
          if (cr < minR) minR = cr; if (cr > maxR) maxR = cr;
          if (cc < minC) minC = cc; if (cc > maxC) maxC = cc;

          for (const [nr, nc] of neighbors4(cr, cc)) {
            const ni = nr * cols + nc;
            if (!seen[ni] && marks[ni]) {
              seen[ni] = 1;
              stack.push([nr, nc]);
            }
          }
        }

        const x = minC * STEP;
        const y = minR * STEP;
        const w = (maxC - minC + 1) * STEP;
        const h = (maxR - minR + 1) * STEP;

        if (w * h >= MIN_REGION_AREA) {
          out.push({
            x, y, w, h,
            level: levelFromDelta(maxDelta),
            maxDiff: maxDelta
          });
        }
      }
    }

    return out;
  };

  // ---------------------------
  // Message bridge
  // ---------------------------
  chrome.runtime.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'analysis:request') return;

    const { tabId, original, current } = msg;

    try {
      // 1) Coarse global % via resemble (if available)
      const coarsePct = await globalMismatch(original, current);

      // 2) Pixel sampling pass
      const { width, height, dataA, dataB } = await getPairImageData(original, current);
      const { marks, deltas, rows, cols, approxPercent } =
        sampleChanges(dataA, dataB, width, height);

      // Prefer Resemble’s percentage if it returned a value; otherwise use our estimate
      const mismatch = coarsePct > 0 ? coarsePct : approxPercent;

      // 3) Connected components -> regions
      const changes = regionsFromMarks(marks, deltas, rows, cols);

      // 4) Respond
      chrome.runtime.sendMessage({
        type: 'analysis:complete',
        tabId,
        mismatch,
        changes,
        width,
        height
      });
    } catch (err) {
      chrome.runtime.sendMessage({
        type: 'analysis:complete',
        tabId,
        mismatch: 0,
        changes: [],
        width: 0,
        height: 0,
        error: String(err?.message || err)
      });
    }
  });
})();
