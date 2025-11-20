const SNAP_MS = 3000;
const RETURN_DELAY_MS = 900;
const blocked = ["chrome://", "chrome-extension://", "edge://", "about:", "devtools://"];
const state = new Map(); // tabId -> { last: dataUrl|null, hasFocus: boolean, timer?: number }

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
    const msg = (e && e.message || "").toLowerCase();
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
  if (s?.timer) {
    clearInterval(s.timer);
    s.timer = undefined;
  }
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

async function compareOnReturn(tabId) {
  const s = state.get(tabId);
  if (!s?.last) return;
  setTimeout(async () => {
    const now = await capture(tabId);
    if (!now) return;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "tabrewind:diff",
        before: s.last,
        after: now
      });
      s.last = now;
      state.set(tabId, s);
    } catch (e) {
      if (!String(e?.message).includes("Could not establish connection")) {
        console.warn("[diff send]", e?.message);
      }
    }
  }, RETURN_DELAY_MS);
}

// FIX 1: compute wasUnfocused BEFORE flipping focus flags
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const prev = state.get(tabId);
  const wasUnfocused = prev ? prev.hasFocus === false : false;

  // mark others unfocused
  for (const [id, s] of state.entries()) if (id !== tabId) s.hasFocus = false;

  const cur = prev ?? { last: null, hasFocus: true };
  cur.hasFocus = true;
  state.set(tabId, cur);

  // timers: stop others, start this one
  const all = await chrome.tabs.query({ windowId });
  for (const t of all) if (t.id !== tabId) stopTimer(t.id);
  startTimer(tabId);

  if (wasUnfocused) await compareOnReturn(tabId);
});

// FIX 2: handle window focus regain (same active tab, no tab switch)
chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) {
    for (const s of state.values()) s.hasFocus = false;
    return;
  }
  const [active] = await chrome.tabs.query({ active: true, windowId: winId });
  if (!active?.id) return;
  const prev = state.get(active.id) ?? { last: null, hasFocus: false };
  const wasUnfocused = prev.hasFocus === false;

  // mark others unfocused in this window
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

// badge updates
// FILE: background.js (badge hook; keep your existing logic and add this listener if missing)
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'tabrewind:badge' && sender?.tab?.id) {
      const tabId = sender.tab.id;
      const colors = {
        high: '#DC3545',   // red
        medium: '#FF8C00', // orange
        low: '#FFC107',    // yellow
        none: '#808080'
      };
      const color = colors[msg.level] || colors.none;
      chrome.action.setBadgeBackgroundColor({ color, tabId });
      chrome.action.setBadgeText({ text: String(msg.count || ''), tabId });
    }
  });
  
// optional: popup "force check"
chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg?.type === "tabrewind:force-now" && typeof msg.tabId === "number") {
    const tabId = msg.tabId;
    let s = state.get(tabId);
    if (!s) { s = { last: null, hasFocus: true }; state.set(tabId, s); }
    try {
      const before = s.last ?? await capture(tabId);
      const after  = await capture(tabId);
      if (!before || !after) { sendResponse({ ok: false, error: "no-images" }); return; }
      await chrome.tabs.sendMessage(tabId, { type: "tabrewind:diff", before, after });
      s.last = after;
      state.set(tabId, s);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }
});