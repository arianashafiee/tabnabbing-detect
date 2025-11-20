// FILE: content.js
// Purpose: High-sensitivity (subtle) detection with low-severity badge for micro-diffs.

(() => {
    // Smaller cell -> more sensitive to single-pixel changes
    const CELL = 16;       // px
    const HI = 25;         // % per cell (high)
    const MID = 5;         // % per cell (medium)
    const LOW = 0.25;      // % per cell (low, for subtle)
    const BATCH = 24;
  
    let overlayRoot = null;
    let infoBadge = null;
  
    // ---- Safe messaging (prevents MV3 "Extension context invalidated") ----
    async function safeSendMessage(payload) {
      try {
        if (!chrome?.runtime?.id) return;
        const p = chrome.runtime.sendMessage(payload);
        if (p && typeof p.then === 'function') await p;
      } catch (e) {
        const msg = String(e?.message || e || '');
        if (msg.includes('Extension context invalidated')) return;
        console.warn('[tabrewind] sendMessage failed:', msg);
      }
    }
  
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "tabrewind:diff") {
        runCompare(msg.before, msg.after)
          .then((r) => sendResponse(r))
          .catch((err) => {
            console.error('[tabrewind] runCompare error:', err);
            sendResponse({ ok: false, error: String(err?.message || err) });
          });
        return true; // async
      }
      if (msg?.type === "tabrewind:clear") {
        tearDownOverlay(true);
      }
    });
  
    function tearDownOverlay(clearBadgeToo) {
      if (overlayRoot) overlayRoot.remove();
      overlayRoot = null;
      if (clearBadgeToo && infoBadge) { infoBadge.remove(); infoBadge = null; }
      // best-effort
      safeSendMessage({ type: "tabrewind:badge", count: "", level: "none" });
    }
  
    function ensureOverlay() {
      if (overlayRoot) return overlayRoot;
      overlayRoot = document.createElement("div");
      overlayRoot.id = "tabrewind-overlay";
      overlayRoot.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
      document.documentElement.appendChild(overlayRoot);
      return overlayRoot;
    }
  
    function ensureInfoBadge() {
      if (infoBadge) return infoBadge;
      infoBadge = document.createElement("div");
      infoBadge.id = "tabrewind-info";
      infoBadge.style.cssText = `
        position: fixed; top: 10px; right: 10px; z-index: 2147483647;
        background: rgba(255,255,255,0.92); color: #111; border: 1px solid rgba(0,0,0,.12);
        padding: 6px 10px; border-radius: 6px; font: 600 12px system-ui,-apple-system,Segoe UI,Roboto,Arial;
        pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.12);
      `;
      document.documentElement.appendChild(infoBadge);
      return infoBadge;
    }
  
    function colorFor(level) {
      // low: yellow, medium: orange, high: red
      return level === "high"   ? "rgba(220,53,69,0.45)"  :
             level === "medium" ? "rgba(255,140,0,0.40)" :
                                  "rgba(255,193,7,0.35)";
    }
  
    async function loadImg(dataURL) {
      return new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = dataURL;
      });
    }
  
    function cropToDataURL(img, sx, sy, sw, sh) {
      const c = document.createElement("canvas");
      c.width = sw; c.height = sh;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      return c.toDataURL("image/png");
    }
  
    function neighbors(c, r, cols, rows) {
      const out = [];
      if (c > 0) out.push([c - 1, r]);
      if (c + 1 < cols) out.push([c + 1, r]);
      if (r > 0) out.push([c, r - 1]);
      if (r + 1 < rows) out.push([c, r + 1]);
      return out;
    }
  
    // Global mismatch for severity / badge
    async function globalMismatch(beforeURL, afterURL) {
      return new Promise((resolve) => {
        if (typeof resemble === "undefined") return resolve(0);
        try {
          // Why: capture subtle changes -> no ignores
          resemble(beforeURL)
            .compareTo(afterURL)
            .ignoreNothing()
            .onComplete((d) => {
              const pct = parseFloat(d?.rawMisMatchPercentage ?? d?.misMatchPercentage ?? "0") || 0;
              resolve(pct);
            });
        } catch { resolve(0); }
      });
    }
  
    async function diffGrid(beforeURL, afterURL) {
      const before = await loadImg(beforeURL);
      const after  = await loadImg(afterURL);
      const W = Math.min(before.width, after.width);
      const H = Math.min(before.height, after.height);
  
      const cols = Math.ceil(W / CELL);
      const rows = Math.ceil(H / CELL);
  
      const tasks = [];
      const cells = Array.from({ length: rows }, () => Array(cols).fill(0));
  
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const sx = c * CELL, sy = r * CELL;
          const sw = Math.min(CELL, W - sx), sh = Math.min(CELL, H - sy);
          const a = cropToDataURL(before, sx, sy, sw, sh);
          const b = cropToDataURL(after,  sx, sy, sw, sh);
          tasks.push({ r, c, a, b });
        }
      }
  
      // Per-cell compare; no ignores (sensitive)
      for (let i = 0; i < tasks.length; i += BATCH) {
        await Promise.all(tasks.slice(i, i + BATCH).map(t =>
          new Promise(resolve => {
            if (typeof resemble === "undefined") { cells[t.r][t.c] = 0; resolve(); return; }
            try {
              resemble(t.a).compareTo(t.b).ignoreNothing().onComplete(d => {
                const pct = parseFloat(d?.misMatchPercentage || d?.rawMisMatchPercentage || "0") || 0;
                cells[t.r][t.c] = pct;
                resolve();
              });
            } catch {
              cells[t.r][t.c] = 0; resolve();
            }
          })
        ));
      }
  
      // Keep logic:
      // - HI: always keep
      // - MID: keep
      // - LOW: keep only if it has a LOW+ neighbor (avoid isolated noise)
      const keep = new Set(), highs = new Set(), mids = new Set(), lows = new Set();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const p = cells[r][c];
        const key = `${r},${c}`;
        if (p >= HI) { highs.add(key); keep.add(key); continue; }
        if (p >= MID) { mids.add(key); keep.add(key); continue; }
        if (p >= LOW) { lows.add(key); /* decide later */ }
      }
      // Low cells: require at least one low-or-better neighbor
      for (const key of lows) {
        const [r, c] = key.split(',').map(Number);
        const near = neighbors(c, r, cols, rows)
          .some(([cc, rr]) => {
            const k = `${rr},${cc}`;
            return highs.has(k) || mids.has(k) || lows.has(k);
          });
        if (near) keep.add(key);
      }
  
      // Flood-merge kept cells into regions
      const visited = new Set();
      const regions = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const key = `${r},${c}`;
        if (!keep.has(key) || visited.has(key)) continue;
        let minC = c, maxC = c, minR = r, maxR = r, maxPct = cells[r][c];
        const q = [[r, c]];
        visited.add(key);
        while (q.length) {
          const [rr, cc] = q.shift();
          minC = Math.min(minC, cc); maxC = Math.max(maxC, cc);
          minR = Math.min(minR, rr); maxR = Math.max(maxR, rr);
          maxPct = Math.max(maxPct, cells[rr][cc]);
          for (const [nc, nr] of neighbors(cc, rr, cols, rows)) {
            const k = `${nr},${nc}`;
            if (keep.has(k) && !visited.has(k)) { visited.add(k); q.push([nr, nc]); }
          }
        }
        const level = maxPct >= HI ? "high" : (maxPct >= MID ? "medium" : "low");
        regions.push({
          x: minC * CELL, y: minR * CELL,
          w: (maxC - minC + 1) * CELL, h: (maxR - minR + 1) * CELL,
          level, maxPct
        });
      }
  
      return { regions, W, H };
    }
  
    function drawRegions(regions, imgW, imgH) {
      if (!regions.length) { tearDownOverlay(false); return; }
      const root = ensureOverlay();
      root.innerHTML = "";
      const scaleX = window.innerWidth / imgW;
      const scaleY = window.innerHeight / imgH;
  
      // Draw semi-transparent boxes; low-severity stays subtle
      regions.forEach((r) => {
        const el = document.createElement("div");
        el.style.cssText = `
          position:absolute; left:${r.x * scaleX}px; top:${r.y * scaleY}px;
          width:${r.w * scaleX}px; height:${r.h * scaleY}px;
          background:${colorFor(r.level)}; border:1px solid rgba(0,0,0,.10); pointer-events:none;
        `;
        root.appendChild(el);
      });
    }
  
    function showSimilarityBadge(similarityPct, mismatchPct, severity) {
      const badge = ensureInfoBadge();
      badge.textContent = `Similarity ${similarityPct.toFixed(2)}%  (diff ${mismatchPct.toFixed(2)}%) [${severity}]`;
    }
  
    function severityFromMismatch(m) {
      return m >= 30 ? "high" : m >= 10 ? "medium" : "low";
    }
  
    async function runCompare(beforeURL, afterURL) {
      try {
        const mismatch = await globalMismatch(beforeURL, afterURL);     // sensitive global %
        const similarity = Math.max(0, 100 - mismatch);
        const severity = severityFromMismatch(mismatch);
  
        showSimilarityBadge(similarity, mismatch, severity);
  
        const { regions, W, H } = await diffGrid(beforeURL, afterURL);
        drawRegions(regions, W, H);
  
        // Drive toolbar badge by global mismatch -> subtle = low color
        await safeSendMessage({
          type: "tabrewind:badge",
          count: regions.length || 1, // show at least '1' so user notices something changed
          level: severity
        });
  
        // re-layout once on resize
        let raf = null;
        const onResize = () => {
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => drawRegions(regions, W, H));
        };
        window.addEventListener("resize", onResize, { once: true });
  
        return { ok: true, changes: regions.length, mismatch };
      } catch (e) {
        console.error("[tabrewind] compare failed:", e);
        tearDownOverlay(true);
        return { ok: false, error: String(e?.message || e) };
      }
    }
  })();
  
  
  