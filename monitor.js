// Service worker: takes periodic snapshots, compares via an offscreen analyzer, then updates badge + page overlays.

const CAPTURE_INTERVAL = 3500;   // how often we refresh the baseline for the active tab
const COMPARISON_DELAY = 150;    // small settle time after the tab regains focus

// Broader “don’t capture here” set (internal/privileged or unreliable contexts)
const BLOCKED_SCHEMES = [
  'chrome://',
  'chrome-untrusted://',
  'chrome-extension://',
  'chrome-search://',
  'chrome-native://',
  'edge://',
  'devtools://',
  'about:',
  'view-source:',
  'brave://',
  'vivaldi://',
  'opera://',
  'moz-extension://',
  'resource://',
  'file:',
  'data:',
  'blob:'
];

// Per-tab runtime state
// tabId -> { snapshot: string|null, isActive: boolean, loop?: number }
const tabState = new Map();

// ---------- small helpers ----------

const isNonCapturableUrl = (url) =>
  !url || BLOCKED_SCHEMES.some(prefix => url.startsWith(prefix));

const getTabSafe = async (tabId) => {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
};

// Centralized screenshotter (returns data URL or null on benign issues)
const snapVisible = async (tabId) => {
  const tab = await getTabSafe(tabId);
  if (!tab || !tab.active || isNonCapturableUrl(tab.url)) return null;

  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (err) {
    // Reframe: treat these as routine/transient conditions not worth logging as “real” errors
    const msg = String(err?.message || '').toLowerCase();
    const benignHints = [
      'permission',                 // activeTab or host not yet in effect
      'cannot access',              // during navigation / no access to page
      'cannot capture',             // capture not available in this state
      'not currently in effect',    // activation lag
      'no tab with id',             // tab closed mid-capture
      'dragging',                   // window/tab being dragged
      'readback',                   // GPU readback / compositor hiccup
      'frame detached',             // navigation race
      'page crashed',               // renderer crash
      'gpu channel',                // gpu reset
      'manifest must request'       // missing host perms scenario
    ];
    if (!benignHints.some(h => msg.includes(h))) {
      console.warn('[monitor] capture issue:', err?.message || err);
    }
    return null;
  }
};

const stopLoop = (tabId) => {
  const st = tabState.get(tabId);
  if (st?.loop) {
    clearInterval(st.loop);
    st.loop = undefined;
  }
};

const startLoop = (tabId) => {
  stopLoop(tabId);
  const st = tabState.get(tabId) ?? { snapshot: null, isActive: true };
  st.loop = setInterval(async () => {
    if (!st.isActive) return;
    const shot = await snapVisible(tabId);
    if (shot) st.snapshot = shot;
  }, CAPTURE_INTERVAL);
  tabState.set(tabId, st);
};

// ---------- offscreen analyzer orchestration ----------

const offscreenAlive = async () => {
  const ctx = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  return ctx.some(c => c.documentUrl.endsWith('analyzer.html'));
};

const ensureOffscreen = async () => {
  if (await offscreenAlive()) return;
  await chrome.offscreen.createDocument({
    url: 'analyzer.html',
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Run canvas-based image differ in an offscreen document.'
  });
};

const gradeThreat = (pct) =>
  pct >= 35 ? 'critical' :
  pct >= 15 ? 'warning'  :
              'minor';

const analyzePair = async (tabId, beforeUrl, afterUrl) => {
  await ensureOffscreen();

  return new Promise((resolve) => {
    const handler = (msg) => {
      if (msg?.type === 'analysis:complete' && msg.tabId === tabId) {
        chrome.runtime.onMessage.removeListener(handler);
        resolve(msg);
      }
    };
    chrome.runtime.onMessage.addListener(handler);

    chrome.runtime.sendMessage({
      type: 'analysis:request',
      tabId,
      original: beforeUrl,
      current: afterUrl
    });
  });
};

// Compare when a tab becomes active again
const compareOnReturn = async (tabId) => {
  const st = tabState.get(tabId);
  if (!st?.snapshot) return;

  setTimeout(async () => {
    const current = await snapVisible(tabId);
    if (!current) return;

    try {
      const { mismatch = 0, changes = [], width = 0, height = 0 } =
        await analyzePair(tabId, st.snapshot, current) || {};

      const tier = gradeThreat(mismatch);

      // Badge palette (keep synced with control panel legend)
      const BADGE = {
        critical: '#E91E63',
        warning:  '#FF6B35',
        minor:    '#FFA726',
        safe:     '#9E9E9E'
      };

      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: BADGE[tier] || BADGE.safe
      });
      await chrome.action.setBadgeText({
        tabId,
        text: String(changes.length || 0)
      });

      // Paint overlays
      await chrome.tabs.sendMessage(tabId, {
        type: 'visualize:changes',
        mismatch,
        changes,
        width,
        height
      });

      // Advance baseline
      st.snapshot = current;
      tabState.set(tabId, st);
    } catch (e) {
      console.warn('[monitor] analysis failed:', e?.message || e);
    }
  }, COMPARISON_DELAY);
};

// ---------- tab/window lifecycle wiring ----------

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const existing = tabState.get(tabId);
  const wasInactive = existing ? existing.isActive === false : false;

  // Mark others inactive
  for (const [id, st] of tabState.entries()) {
    if (id !== tabId) st.isActive = false;
  }

  // Activate this tab
  const st = existing ?? { snapshot: null, isActive: true };
  st.isActive = true;
  tabState.set(tabId, st);

  // Stop loops for other tabs in the same window
  const siblings = await chrome.tabs.query({ windowId });
  for (const t of siblings) {
    if (t.id !== tabId) stopLoop(t.id);
  }

  startLoop(tabId);

  if (wasInactive) {
    await compareOnReturn(tabId);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    for (const st of tabState.values()) st.isActive = false;
    return;
  }

  const [active] = await chrome.tabs.query({ active: true, windowId });
  if (!active?.id) return;

  const st = tabState.get(active.id) ?? { snapshot: null, isActive: false };
  const wasInactive = st.isActive === false;

  // Mark other tabs in this window inactive
  const tabs = await chrome.tabs.query({ windowId });
  for (const t of tabs) {
    if (t.id !== active.id) {
      const peer = tabState.get(t.id);
      if (peer) peer.isActive = false;
    }
  }

  st.isActive = true;
  tabState.set(active.id, st);
  startLoop(active.id);

  if (wasInactive) {
    await compareOnReturn(active.id);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'complete' && tab.active && !isNonCapturableUrl(tab.url)) {
    const st = tabState.get(tabId) ?? { snapshot: null, isActive: true };
    st.isActive = true;
    tabState.set(tabId, st);
    startLoop(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopLoop(tabId);
  tabState.delete(tabId);
});

// Seed baselines at install
chrome.runtime.onInstalled.addListener(async () => {
  const actives = await chrome.tabs.query({ active: true });
  for (const t of actives) {
    const shot = await snapVisible(t.id);
    tabState.set(t.id, { snapshot: shot, isActive: true });
    startLoop(t.id);
  }
});

// ---------- popup <-> background: manual check ----------

chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg?.type === 'manual:check' && typeof msg.tabId === 'number') {
    const tabId = msg.tabId;
    let st = tabState.get(tabId);
    if (!st) {
      st = { snapshot: null, isActive: true };
      tabState.set(tabId, st);
    }

    try {
      const beforeImg = st.snapshot ?? await snapVisible(tabId);
      const afterImg  = await snapVisible(tabId);

      if (!beforeImg || !afterImg) {
        sendResponse({ success: false, error: 'capture-failed' });
        return true;
      }

      const { mismatch = 0, changes = [], width = 0, height = 0 } =
        await analyzePair(tabId, beforeImg, afterImg) || {};

      const tier = gradeThreat(mismatch);

      const BADGE = {
        critical: '#E91E63',
        warning:  '#FF6B35',
        minor:    '#FFA726',
        safe:     '#9E9E9E'
      };

      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: BADGE[tier] || BADGE.safe
      });
      await chrome.action.setBadgeText({
        tabId,
        text: String(changes.length || 0)
      });

      await chrome.tabs.sendMessage(tabId, {
        type: 'visualize:changes',
        mismatch,
        changes,
        width,
        height
      });

      // Advance baseline to “after”
      st.snapshot = afterImg;
      tabState.set(tabId, st);

      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: String(e?.message || e) });
    }
    return true; // keep message channel open for async
  }
});
