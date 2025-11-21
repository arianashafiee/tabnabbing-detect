// background.js — capture + offscreen orchestration + badge updates

const SNAP_MS = 3000;           // keep your existing cadence
const RETURN_DELAY_MS = 200;    // make return-to-tab feel instant
const blocked = ["chrome://", "chrome-extension://", "edge://", "about:", "devtools://"];

const state = new Map(); // tabId -> { last: dataUrl|null, hasFocus: boolean, timer?: number }

// ---------- utils ----------
function isBlocklisted(url) {
  return !url || blocked.some(p => url.startsWith(p));
}
async function safeGetTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}
async function capture(tabId) {
  const tab = await safeGetTab(tabId);
  if (!tab || !tab.active || isBlocklisted(tab.url)) return null;
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    if (
      msg.includes("cannot access") ||
      msg.includes("cannot be edited") ||
      msg.includes("not in effect") ||
      msg.includes("no tab with id") ||
      msg.includes("dragging")
    ) return null;
    console.warn("[capture] unexpected:", e.message);
    return null;
  }
}
function stopTimer(tabId) {
  const s = state.get(tabId);
  if (s?.timer) { clearInterval(s.timer); s.timer = undefined; }
}
function startTimer(tabId) {
  stopTimer(tabId);
  const s = state.get(tabId) ?? { last: null, hasFocus: true };
  s.timer = setInterval(async () => {
    if (!s.hasFocus) return;
    const img = await capture(tabId);
    if (img) s.last = img;
  }, SNAP_MS);
  state.set(tabId, s);
}

// ---------- offscreen orchestration ----------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  return contexts.some(c => c.documentUrl.endsWith("offscreen.html"));
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: "Perform canvas-based image comparisons without blocking pages."
  });
}
function severityFromMismatch(m) {
  return m >= 30 ? "high" : m >= 10 ? "medium" : "low";
}
async function computeInOffscreen(tabId, before, after) {
  await ensureOffscreen();
  return new Promise((resolve) => {
    const listener = (msg, sender) => {
      if (msg?.type === "tabrewind:result" && msg.tabId === tabId) {
        chrome.runtime.onMessage.removeListener(listener);
        resolve(msg);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    chrome.runtime.sendMessage({
      type: "tabrewind:compute",
      tabId,
      before,
      after
    });
  });
}

// ---------- compare on return ----------
async function compareOnReturn(tabId) {
  const s = state.get(tabId);
  if (!s?.last) return;
  setTimeout(async () => {
    const now = await capture(tabId);
    if (!now) return;
    try {
      const result = await computeInOffscreen(tabId, s.last, now);
      const { mismatch, regions, W, H } = result || {};
      const severity = severityFromMismatch(mismatch || 0);

      // 1) Update toolbar badge immediately
      const colors = {
        high: '#DC3545',   // red
        medium: '#FF8C00', // orange
        low: '#FFC107',    // yellow
        none: '#808080'
      };
      chrome.action.setBadgeBackgroundColor({ color: colors[severity] || colors.none, tabId });
      chrome.action.setBadgeText({ text: String((regions?.length || 0) || ''), tabId });

      // 2) Tell the page to draw overlays (fast)
      await chrome.tabs.sendMessage(tabId, {
        type: "tabrewind:render",
        mismatch,
        regions,
        W, H
      });

      // 3) rotate snapshot
      s.last = now;
      state.set(tabId, s);

    } catch (e) {
      console.warn("[compareOnReturn]", e?.message || e);
    }
  }, RETURN_DELAY_MS);
}

// ---------- tab/window hooks ----------
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const prev = state.get(tabId);
  const wasUnfocused = prev ? prev.hasFocus === false : false;

  for (const [id, s] of state.entries()) if (id !== tabId) s.hasFocus = false;

  const cur = prev ?? { last: null, hasFocus: true };
  cur.hasFocus = true;
  state.set(tabId, cur);

  const all = await chrome.tabs.query({ windowId });
  for (const t of all) if (t.id !== tabId) stopTimer(t.id);
  startTimer(tabId);

  if (wasUnfocused) await compareOnReturn(tabId);
});

chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) {
    for (const s of state.values()) s.hasFocus = false;
    return;
  }
  const [active] = await chrome.tabs.query({ active: true, windowId: winId });
  if (!active?.id) return;
  const prev = state.get(active.id) ?? { last: null, hasFocus: false };
  const wasUnfocused = prev.hasFocus === false;

  const tabs = await chrome.tabs.query({ windowId: winId });
  for (const t of tabs) if (t.id !== active.id) {
    const ts = state.get(t.id);
    if (ts) ts.hasFocus = false;
  }

  prev.hasFocus = true;
  state.set(active.id, prev);
  startTimer(active.id);

  if (wasUnfocused) await compareOnReturn(active.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === "complete" && tab.active && !isBlocklisted(tab.url)) {
    const s = state.get(tabId) ?? { last: null, hasFocus: true };
    s.hasFocus = true;
    state.set(tabId, s);
    startTimer(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopTimer(tabId);
  state.delete(tabId);
});

chrome.runtime.onInstalled.addListener(async () => {
  const actives = await chrome.tabs.query({ active: true });
  for (const t of actives) {
    state.set(t.id, { last: await capture(t.id), hasFocus: true });
    startTimer(t.id);
  }
});

// ---------- optional: force check from popup ----------
chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg?.type === "tabrewind:force-now" && typeof msg.tabId === "number") {
    const tabId = msg.tabId;
    let s = state.get(tabId);
    if (!s) { s = { last: null, hasFocus: true }; state.set(tabId, s); }
    try {
      const before = s.last ?? await capture(tabId);
      const after  = await capture(tabId);
      if (!before || !after) { sendResponse({ ok: false, error: "no-images" }); return true; }
      const result = await computeInOffscreen(tabId, before, after);
      const { mismatch, regions, W, H } = result || {};
      const severity = severityFromMismatch(mismatch || 0);

      const colors = { high:'#DC3545', medium:'#FF8C00', low:'#FFC107', none:'#808080' };
      chrome.action.setBadgeBackgroundColor({ color: colors[severity] || colors.none, tabId });
      chrome.action.setBadgeText({ text: String((regions?.length || 0) || ''), tabId });

      await chrome.tabs.sendMessage(tabId, { type: "tabrewind:render", mismatch, regions, W, H });
      s.last = after; state.set(tabId, s);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }
});
