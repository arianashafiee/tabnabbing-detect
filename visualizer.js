// Paints change overlays and a small status HUD in the page, and cleans them up on demand.

(() => {
  let layerEl = null;     // overlay container
  let hudEl = null;       // top-right status HUD
  let resizeUnsub = null; // active resize listener
  let lastPayload = null; // cache last draw for responsive repaint

  // Ensure a single full-viewport overlay container exists
  const ensureLayer = () => {
    if (layerEl) return layerEl;
    const el = document.createElement('div');
    el.id = 'tn-layer';
    el.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.documentElement.appendChild(el);
    layerEl = el;
    return el;
  };

  // Ensure a single HUD element exists
  const ensureHud = () => {
    if (hudEl) return hudEl;
    const el = document.createElement('div');
    el.id = 'tn-hud';
    el.style.cssText = [
      'position:fixed',
      'top:15px',
      'right:15px',
      'z-index:2147483646',
      'background:linear-gradient(135deg, rgba(245,245,250,.95), rgba(255,255,255,.98))',
      'color:#2C3E50',
      'border:2px solid rgba(52,73,94,.15)',
      'padding:8px 14px',
      'border-radius:8px',
      "font:700 13px -apple-system,system-ui,'Segoe UI',Roboto,'Helvetica Neue',Arial",
      'pointer-events:none',
      'box-shadow:0 4px 12px rgba(0,0,0,.08),0 1px 3px rgba(0,0,0,.12)',
      'backdrop-filter:blur(10px)'
    ].join(';');
    document.documentElement.appendChild(el);
    hudEl = el;
    return el;
  };

  // Map severity -> overlay fill
  const colorFor = (level) => {
    const map = {
      critical: 'rgba(233,30,99,0.55)',  
      warning:  'rgba(255,107,53,0.48)', 
      minor:    'rgba(255,167,38,0.42)'  
    };
    return map[level] || map.minor;
  };

  // Inject animation stylesheet once
  const ensureAnim = () => {
    if (document.getElementById('tn-anim')) return;
    const style = document.createElement('style');
    style.id = 'tn-anim';
    style.textContent = `
      @keyframes tnPulse {
        0%,100% { opacity: .7; transform: scale(1); }
        50%     { opacity: .9; transform: scale(1.02); }
      }
    `;
    document.head.appendChild(style);
  };

  // Draw overlays, scaled to current viewport
  const paintAreas = (areas, srcW, srcH) => {
    const host = ensureLayer();
    host.innerHTML = '';
    if (!areas?.length || !srcW || !srcH) return;

    ensureAnim();

    const scaleX = window.innerWidth / srcW;
    const scaleY = window.innerHeight / srcH;

    const frag = document.createDocumentFragment();
    for (const a of areas) {
      const box = document.createElement('div');
      box.style.cssText = [
        'position:absolute',
        `left:${a.x * scaleX}px`,
        `top:${a.y * scaleY}px`,
        `width:${a.w * scaleX}px`,
        `height:${a.h * scaleY}px`,
        `background:${colorFor(a.level)}`,
        'border:2px solid rgba(44,62,80,.25)',
        'pointer-events:none',
        'animation:tnPulse 2s ease-in-out infinite'
      ].join(';');
      frag.appendChild(box);
    }
    host.appendChild(frag);
  };

  // Update HUD with match / change percentages
  const showHud = (mismatch) => {
    const el = ensureHud();
    const changed = Math.max(0, Number(mismatch) || 0);
    const match = Math.max(0, 100 - changed);
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:11px;opacity:.8;">MATCH</span>
        <span style="font-size:14px;font-weight:800;">${match.toFixed(1)}%</span>
        <span style="font-size:11px;opacity:.7;">• ${changed.toFixed(1)}% changed</span>
      </div>
    `;
  };

  // Repaint on resize using the last payload
  const installResize = () => {
    if (resizeUnsub) window.removeEventListener('resize', resizeUnsub);
    let rafId = 0;
    resizeUnsub = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        if (lastPayload) {
          paintAreas(lastPayload.changes, lastPayload.width, lastPayload.height);
        }
      });
    };
    window.addEventListener('resize', resizeUnsub);
  };

  // Teardown everything we add
  const clearAll = () => {
    if (layerEl) { layerEl.remove(); layerEl = null; }
    if (hudEl)   { hudEl.remove();   hudEl = null; }
    if (resizeUnsub) {
      window.removeEventListener('resize', resizeUnsub);
      resizeUnsub = null;
    }
    const style = document.getElementById('tn-anim');
    if (style) style.remove();
    lastPayload = null;
  };

  // Wire messages from the service worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'visualize:changes') {
      lastPayload = {
        changes: msg.changes || [],
        width: msg.width,
        height: msg.height
      };
      showHud(msg.mismatch);
      paintAreas(lastPayload.changes, lastPayload.width, lastPayload.height);
      installResize();
    } else if (msg?.type === 'visualize:remove') {
      clearAll();
    }
  });
})();
