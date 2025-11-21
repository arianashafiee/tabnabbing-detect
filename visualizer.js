// visualizer.js — overlay renderer for on-page change highlights 

(() => {
  // ---------- constants & ids ----------
  const ROOT_ID = 'tnb-overlay-root';
  const HUD_ID = 'tnb-hud';
  const CSS_ID = 'tnb-style';

  // keep levels consistent with background badge colors
  const levelTint = (lvl) => {
    switch (lvl) {
      case 'critical': return 'rgba(233, 30, 99, 0.55)';  // #E91E63
      case 'warning':  return 'rgba(255, 107, 53, 0.48)'; // #FF6B35
      case 'minor':    return 'rgba(255, 167, 38, 0.42)'; // #FFA726
      default:         return 'rgba(255, 167, 38, 0.42)';
    }
  };

  // ---------- dom helpers ----------
  const q = (id) => document.getElementById(id);

  const ensureStyle = () => {
    if (q(CSS_ID)) return;
    const css = document.createElement('style');
    css.id = CSS_ID;
    css.textContent = `
      @keyframes tnbPulse {
        0%   { opacity: .68; transform: scale(1); }
        50%  { opacity: .92; transform: scale(1.015); }
        100% { opacity: .70; transform: scale(1); }
      }
      #${ROOT_ID}{
        position: fixed;
        left: 0; top: 0;
        width: 100vw; height: 100vh;
        pointer-events: none;
        z-index: 2147483646;
      }
      #${HUD_ID}{
        position: fixed;
        right: 14px; top: 14px;
        z-index: 2147483647;
        pointer-events: none;
        padding: 8px 12px;
        border-radius: 9px;
        background: linear-gradient(135deg, rgba(247,248,255,.95), rgba(255,255,255,.98));
        border: 2px solid rgba(45,55,72,.15);
        box-shadow: 0 4px 12px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.12);
        color: #263238;
        font: 700 13px -apple-system, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial;
      }
      .tnb-box{
        position: absolute;
        border: 2px solid rgba(44,62,80,0.28);
        animation: tnbPulse 2000ms ease-in-out infinite;
        pointer-events: none;
      }
    `;
    document.head.appendChild(css);
  };

  const ensureRoot = () => {
    let r = q(ROOT_ID);
    if (r) return r;
    r = document.createElement('div');
    r.id = ROOT_ID;
    r.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(r);
    return r;
  };

  const ensureHud = () => {
    let hud = q(HUD_ID);
    if (hud) return hud;
    hud = document.createElement('div');
    hud.id = HUD_ID;
    document.documentElement.appendChild(hud);
    return hud;
  };

  // ---------- render logic ----------
  const state = {
    payload: null,      // last { changes, width, height, mismatch }
    resizeRAF: null,    // rAF handle
  };

  const updateHud = (mismatch) => {
    const hud = ensureHud();
    const changed = Math.max(0, Number(mismatch) || 0);
    const match = Math.max(0, 100 - changed);
    // build HUD content via DOM to differ from template-literal approach
    hud.textContent = ''; // clear
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '8px';

    const label = document.createElement('span');
    label.style.fontSize = '11px';
    label.style.opacity = '0.8';
    label.textContent = 'MATCH';

    const strong = document.createElement('span');
    strong.style.fontSize = '14px';
    strong.style.fontWeight = '800';
    strong.textContent = `${match.toFixed(1)}%`;

    const subtle = document.createElement('span');
    subtle.style.fontSize = '11px';
    subtle.style.opacity = '0.72';
    subtle.textContent = `• ${changed.toFixed(1)}% changed`;

    wrap.appendChild(label);
    wrap.appendChild(strong);
    wrap.appendChild(subtle);
    hud.appendChild(wrap);
  };

  const paintRegions = (regions, srcW, srcH) => {
    const root = ensureRoot();
    root.innerHTML = '';

    if (!Array.isArray(regions) || !regions.length || !srcW || !srcH) return;

    // use viewport-based scaling
    const sx = window.innerWidth / srcW;
    const sy = window.innerHeight / srcH;

    const frag = document.createDocumentFragment();
    for (const r of regions) {
      const box = document.createElement('div');
      box.className = 'tnb-box';
      // use style props (not one long cssText) to differ from original
      box.style.left = `${(r.x || 0) * sx}px`;
      box.style.top = `${(r.y || 0) * sy}px`;
      box.style.width = `${(r.w || 0) * sx}px`;
      box.style.height = `${(r.h || 0) * sy}px`;
      box.style.background = levelTint(r.level);
      frag.appendChild(box);
    }
    root.appendChild(frag);
  };

  const rerenderOnResize = () => {
    if (!state.payload) return;
    if (state.resizeRAF) cancelAnimationFrame(state.resizeRAF);
    state.resizeRAF = requestAnimationFrame(() => {
      const { changes, width, height } = state.payload;
      paintRegions(changes, width, height);
    });
  };

  const clearAll = () => {
    const root = q(ROOT_ID);
    const hud = q(HUD_ID);
    const css = q(CSS_ID);

    if (root) root.remove();
    if (hud) hud.remove();
    if (css) css.remove();

    if (state.resizeRAF) {
      cancelAnimationFrame(state.resizeRAF);
      state.resizeRAF = null;
    }
    state.payload = null;
    window.removeEventListener('resize', rerenderOnResize);
  };

  // ---------- message bus ----------
  chrome.runtime.onMessage.addListener((msg) => {
    const { type } = msg || {};
    if (type === 'visualize:changes') {
      ensureStyle();
      state.payload = {
        changes: msg.changes || [],
        width: msg.width,
        height: msg.height,
        mismatch: msg.mismatch || 0
      };
      updateHud(state.payload.mismatch);
      paintRegions(state.payload.changes, state.payload.width, state.payload.height);

      // keep overlays aligned with viewport changes
      window.removeEventListener('resize', rerenderOnResize);
      window.addEventListener('resize', rerenderOnResize);
      return;
    }

    if (type === 'visualize:remove') {
      clearAll();
      return;
    }
  });
})();
