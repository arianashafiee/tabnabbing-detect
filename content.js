// content.js — draw overlays fast; no heavy comparison here

(() => {
    let overlayRoot = null;
    let infoBadge = null;
  
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
      return level === "high"   ? "rgba(220,53,69,0.45)"  :
             level === "medium" ? "rgba(255,140,0,0.40)" :
                                  "rgba(255,193,7,0.35)"; // low
    }
  
    function drawRegions(regions, imgW, imgH) {
      const root = ensureOverlay();
      root.innerHTML = "";
      if (!regions || !regions.length || !imgW || !imgH) return;
  
      const scaleX = window.innerWidth / imgW;
      const scaleY = window.innerHeight / imgH;
  
      for (const r of regions) {
        const el = document.createElement("div");
        el.style.cssText = `
          position:absolute; left:${r.x * scaleX}px; top:${r.y * scaleY}px;
          width:${r.w * scaleX}px; height:${r.h * scaleY}px;
          background:${colorFor(r.level)}; border:1px solid rgba(0,0,0,.10); pointer-events:none;
        `;
        root.appendChild(el);
      }
    }
  
    function showSimilarityBadge(mismatch) {
      const badge = ensureInfoBadge();
      const similarity = Math.max(0, 100 - (mismatch || 0));
      badge.textContent = `Similarity ${similarity.toFixed(2)}%  (diff ${(mismatch||0).toFixed(2)}%)`;
    }
  
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "tabrewind:render") {
        showSimilarityBadge(msg.mismatch);
        drawRegions(msg.regions || [], msg.W, msg.H);
  
        // Re-layout once on resize so boxes stay aligned
        let raf = null;
        const onResize = () => {
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => drawRegions(msg.regions || [], msg.W, msg.H));
        };
        window.addEventListener("resize", onResize, { once: true });
      }
      if (msg?.type === "tabrewind:clear") {
        if (overlayRoot) overlayRoot.remove(), overlayRoot = null;
        if (infoBadge) infoBadge.remove(), infoBadge = null;
      }
    });
  })();
  