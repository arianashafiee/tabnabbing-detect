// offscreen.js — fast, canvas-based diff that returns regions + mismatch%

(() => {
    const CELL_COARSE = 32;
    const CELL_FINE   = 12;
    const LOW_GATE    = 0.20; // % from sampler to skip near-zero
    const MID_GATE    = 3.00; // if >=, verify with Resemble
  
    function severityFromMismatch(m) {
      return m >= 30 ? "high" : m >= 10 ? "medium" : "low";
    }
  
    function loadImg(url) {
      return new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = url;
      });
    }
  
    async function prepCanvases(beforeURL, afterURL) {
      const [before, after] = await Promise.all([loadImg(beforeURL), loadImg(afterURL)]);
      const W = Math.min(before.width, after.width);
      const H = Math.min(before.height, after.height);
  
      const c1 = new OffscreenCanvas(W, H), g1 = c1.getContext("2d", { willReadFrequently: true });
      const c2 = new OffscreenCanvas(W, H), g2 = c2.getContext("2d", { willReadFrequently: true });
      g1.drawImage(before, 0, 0, W, H);
      g2.drawImage(after,  0, 0, W, H);
      return { W, H, g1, g2 };
    }
  
    function sampledDiffPct(aData, bData, stride = 6) {
      const a = aData.data, b = bData.data;
      let diffs = 0, total = 0;
      for (let i = 0; i < a.length; i += 4 * stride) {
        const dr = a[i] - b[i], dg = a[i+1] - b[i+1], db = a[i+2] - b[i+2];
        if ((Math.abs(dr)*0.3 + Math.abs(dg)*0.59 + Math.abs(db)*0.11) > 8) diffs++;
        total++;
      }
      return (diffs / total) * 100;
    }
  
    function getCell(g, sx, sy, sw, sh) {
      return g.getImageData(sx, sy, sw, sh);
    }
  
    function resemblePct(aData, bData) {
      return new Promise(resolve => {
        if (typeof resemble === "undefined") return resolve(0);
        try {
          resemble(aData).compareTo(bData).ignoreAntialiasing().ignoreLess().onComplete(d => {
            resolve(parseFloat(d?.rawMisMatchPercentage ?? d?.misMatchPercentage ?? "0") || 0);
          });
        } catch { resolve(0); }
      });
    }
  
    function resembleGlobalPct(beforeURL, afterURL) {
      return new Promise(resolve => {
        if (typeof resemble === "undefined") return resolve(0);
        try {
          resemble(beforeURL).compareTo(afterURL).ignoreAntialiasing().ignoreLess().onComplete(d => {
            resolve(parseFloat(d?.rawMisMatchPercentage ?? d?.misMatchPercentage ?? "0") || 0);
          });
        } catch { resolve(0); }
      });
    }
  
    async function diffCoarse(beforeURL, afterURL) {
      const { W, H, g1, g2 } = await prepCanvases(beforeURL, afterURL);
  
      const cols = Math.ceil(W / CELL_COARSE);
      const rows = Math.ceil(H / CELL_COARSE);
  
      const regions = [];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const sx = c * CELL_COARSE, sy = r * CELL_COARSE;
          const sw = Math.min(CELL_COARSE, W - sx), sh = Math.min(CELL_COARSE, H - sy);
          const A = getCell(g1, sx, sy, sw, sh);
          const B = getCell(g2, sx, sy, sw, sh);
  
          const approx = sampledDiffPct(A, B, 6);
          if (approx < LOW_GATE) continue;
  
          let pct = approx;
          if (approx >= MID_GATE) pct = await resemblePct(A, B);
  
          if (pct >= 0.25) {
            const level = pct >= 40 ? "high" : pct >= 15 ? "medium" : "low";
            regions.push({ x:sx, y:sy, w:sw, h:sh, level, maxPct:pct });
          }
        }
        // yield per row to keep worker responsive
        await new Promise(r => setTimeout(r, 0));
      }
  
      return { regions, W, H };
    }
  
    async function diffRefine(beforeURL, afterURL, coarse) {
      if (!coarse?.regions?.length) return coarse;
      const { W, H, g1, g2 } = await prepCanvases(beforeURL, afterURL);
  
      const refined = [];
      for (const box of coarse.regions) {
        const colsF = Math.ceil(box.w / CELL_FINE);
        const rowsF = Math.ceil(box.h / CELL_FINE);
        for (let rr = 0; rr < rowsF; rr++) {
          for (let cc = 0; cc < colsF; cc++) {
            const sx = box.x + cc * CELL_FINE, sy = box.y + rr * CELL_FINE;
            const sw = Math.min(CELL_FINE, box.x + box.w - sx), sh = Math.min(CELL_FINE, box.y + box.h - sy);
            const A = getCell(g1, sx, sy, sw, sh);
            const B = getCell(g2, sx, sy, sw, sh);
  
            const approx = sampledDiffPct(A, B, 4);
            if (approx < LOW_GATE) continue;
  
            let pct = approx >= MID_GATE ? await resemblePct(A, B) : approx;
            if (pct >= 0.5) {
              const level = pct >= 40 ? "high" : pct >= 15 ? "medium" : "low";
              refined.push({ x:sx, y:sy, w:sw, h:sh, level, maxPct:pct });
            }
          }
        }
        await new Promise(r => setTimeout(r, 0));
      }
      return { regions: refined.length ? refined : coarse.regions, W, H };
    }
  
    chrome.runtime.onMessage.addListener(async (msg) => {
      if (msg?.type !== "tabrewind:compute") return;
      const { tabId, before, after } = msg;
  
      try {
        // Global % used for similarity + badge color
        const mismatch = await resembleGlobalPct(before, after);
  
        // Coarse (fast) first, then refine in the background and push an update
        const coarse = await diffCoarse(before, after);
  
        chrome.runtime.sendMessage({
          type: "tabrewind:result",
          tabId,
          mismatch,
          regions: coarse.regions,
          W: coarse.W, H: coarse.H
        });
  
        // Optional refinement: send improved regions when ready
        queueMicrotask(async () => {
          const refined = await diffRefine(before, after, coarse);
          if (!refined || !refined.regions) return;
          chrome.runtime.sendMessage({
            type: "tabrewind:result",
            tabId,
            mismatch,
            regions: refined.regions,
            W: refined.W, H: refined.H
          });
        });
  
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
  