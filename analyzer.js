/* monitor.js
 * Background service worker:
 * - Periodically snapshots the active tab (baseline)
 * - When a tab regains focus, compares current view vs. last baseline via an offscreen analyzer
 * - Sends drawing instructions to the content script and updates the action badge
 * - Supports manual “baseline now” and “check now” messages from the popup
 */

// ------------------------------
// Tunables
// ------------------------------
const SNAPSHOT_EVERY_MS = 3500;  // cadence while a tab is active
const COMPARE_AFTER_FOCUS_MS = 150; // small settle delay after activation
const MIN_GAP_BETWEEN_CAPTURES_MS = 800; // throttle per-window capture calls

// A more expansive “don’t try to capture these” list.
// (Schemes & chrome-like internal pages where capture is not possible/meaningful.)
const BLOCKED_SCHEMES = [
  'chrome://',
  'chrome-untrusted://',
  'chrome-extension://',
  'edge://',
  'devtools://',
  'about:',
  'brave://',
  'opera://',
  'vivaldi://',
  'moz-extension://',
  'resource://'
];

// Badge palette (keep consistent with your popup legend)
const BADGE_COLOR = {
  safe:    '#9E9E9E', // neutral gray
  minor:   '#FFA726', // amber
  warning: '#FF6B35', // orange-red
  critical:'#E91E63'  // pink-red
};

// ------------------------------
// In-memory state
// ------------------------------

// Per-tab state
// tabId -> { baseline: dataURL|null, active: boolean, timer?: number }
const tabState = new Map();

// Per-window throttling (avoid capture quota errors)
const windowThrottle = new Map(); // windowId -> { last: number }

// Simple unique id counter for offscreen requests
let seq = 1;

// ------------------------------
// Small utilities
// ------------------------------
const delay = (ms) => new Promise(r => setTimeout(r, ms));

const isBlockedUrl = (url) => {
  if (!url || typeof url !== 'string') return true;
  return BLOCKED_SCHEMES.some(prefix => url.startsWith(prefix));
};

const getTab = async (tabId) => {
  try { return await chrome.tabs.get(tabId); }
  catch { return null; }
};

const touchThrottle = async (windowId) => {
  const now = Date.now();
  const info = windowThrottle.get(windowId) || { last: 0 };
  const gap = now - info.last;

  if (gap < MIN_GAP_BETWEEN_CAPTURES_MS) {
    await delay(MIN_GAP_BETWEEN_CAPTURES_MS - gap);
  }

  info.last = Date.now();
  windowThrottle.set(windowId, info);
};

// Gate + capture as visible tab PNG
const captureActiveView = async (tabId) => {
  const t = await getTab(tabId);
  if (!t || !t.active || isBlockedUrl(t.url)) return null;

  try {
    await touchThrottle(t.windowId);
    return await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    // Known, non-fatal capture hiccups we ignore
    const benign = [
      'permission',                 // permission not available yet
      'cannot access',              // page mid-navigation / no access
      'not currently in effect',    // transient
      'no tab with id',             // tab disappeared
      'dragging',                   // window/tab dragging
      'readback',                   // gpu readback error
      'page crashed',               // renderer crash
      'frame detached'              // navigation race
    ];
    if (!benign.some(h => msg.includes(h))) {
      console.warn('[defender-bg] capture issue:', err.message);
    }
    return null;
  }
};

// Calculate coarse threat tier from percent mismatch
const classify = (percent) =>
  percent >= 35 ? 'critical' :
  percent >= 15 ? 'warning'  :
                  'minor';

// ------------------------------
// Periodic snapshot management
// ------------------------------
const stopTimer = (tabId) => {
  const st = tabState.get(tabId);
  if (st?.timer) {
    clearInterval(st.timer);
    st.timer = undefined;
  }
};

const startTimer = (tabId) => {
  stopTimer(tabId);
  const st = tabState.get(tabId) || { baseline: null, active: true };
  st.timer = setInterval(async () => {
    if (!st.active) return;
    const snap = await captureActiveView(tabId);
    if (snap) st.baseline = snap;
  }, SNAPSHOT_EVERY_MS);
  tabState.set(tabId, st);
};

// ------------------------------
// Offscreen analyzer coordination
// ------------------------------
const ensureAnalyzer = async () => {
  // Avoid duplicate offscreen documents
  const ctxs = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  const exists = ctxs.some(c => c.documentUrl.endsWith('analyzer.html'));
  if (exists) return;

  await chrome.offscreen.createDocument({
    url: 'analyzer.html',
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: 'Image diff analysis using canvas in an offscreen document'
  });
};

const analyzePair = async (tabId, beforeDataUrl, afterDataUrl) => {
  await ensureAnalyzer();

  const ticket = `req_${Date.now()}_${seq++}`;

  return new Promise((resolve) => {
    const onMsg = (msg) => {
      if (msg?.type === 'analysis:complete' && msg.tabId === tabId && msg.ticket === ticket) {
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve(msg);
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    chrome.runtime.sendMessage({
      type: 'analysis:request',
      ticket,
      tabId,
      original: beforeDataUrl,
      current: afterDataUrl
    });
  });
};

// ------------------------------
// Compare on tab return
// ------------------------------
const compareAfterActivation = async (tabId) => {
  const st = tabState.get(tabId);
  if (!st?.baseline) return; // nothing to compare against

  setTimeout(async () => {
    const current = await captureActiveView(tabId);
    if (!current) return;

    try {
      const { mismatch = 0, changes = [], width = 0, height = 0 } =
        await analyzePair(tabId, st.baseline, current) || {};

      const tier = classify(mismatch);

      // Update badge (color + number of changed regions)
      await chrome.action.setBadgeBackgroundColor({
        tabId,
        color: BADGE_COLOR[tier] || BADGE_COLOR.safe
      });
      await chrome.action.setBadgeText({
        tabId,
        text: String(changes.length || 0)
      });

      // Ask content script to draw overlays
      await chrome.tabs.sendMessage(tabId, {
        type: 'visualize:changes',
        mismatch,
        changes,
        width,
        height
      });

      // Move the baseline forward so repeated focus events compare against the latest
      st.baseline = current;
      tabState.set(tabId, st);
    } catch (e) {
      console.warn('[defender-bg] analysis failed:', e?.message || e);
    }
  }, COMPARE_AFTER_FOCUS_MS);
};

// ------------------------------
// Tab/window event wiring
// ------------------------------
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // Mark only the activated tab as active
  for (const [id, state] of tabState.entries()) {
    state.active = (id === tabId);
    if (!state.active) stopTimer(id);
  }

  // Start/refresh state for the activated tab
  const st = tabState.get(tabId) || { baseline: null, active: true };
  st.active = true;
  tabState.set(tabId, st);

  // Cancel timers for other tabs in the same window
  const siblings = await chrome.tabs.query({ windowId });
  for (const t of siblings) {
    if (t.id !== tabId) stopTimer(t.id);
  }

  startTimer(tabId);

  // If this tab was previously inactive and had a baseline, compare now
  compareAfterActivation(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // All windows unfocused – suspend capture loops
    for (const st of tabState.values()) st.active = false;
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (!activeTab?.id) return;

  // Mark this tab active, others in the window inactive
  const current = tabState.get(activeTab.id) || { baseline: null, active: false };
  current.active = true;
  tabState.set(activeTab.id, current);

  const peers = await chrome.tabs.query({ windowId });
  for (const t of peers) {
    if (t.id !== activeTab.id) {
      const peer = tabState.get(t.id);
      if (peer) peer.active = false;
      stopTimer(t.id);
    }
  }

  startTimer(activeTab.id);
  compareAfterActivation(activeTab.id);
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'complete' && tab?.active && !isBlockedUrl(tab.url)) {
    const st = tabState.get(tabId) || { baseline: null, active: true };
    st.active = true;
    tabState.set(tabId, st);
    startTimer(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopTimer(tabId);
  tabState.delete(tabId);
});

// ------------------------------
// First install bootstrap
// ------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  const actives = await chrome.tabs.query({ active: true });
  for (const t of actives) {
    const snap = await captureActiveView(t.id);
    tabState.set(t.id, { baseline: snap, active: true });
    startTimer(t.id);
  }
});

// ------------------------------
// Messages from popup / content
// ------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Manual baseline: capture a single snapshot now and store it.
  if (msg?.type === 'manual:baseline' && typeof msg.tabId === 'number') {
    (async () => {
      const snap = await captureActiveView(msg.tabId);
      if (!snap) {
        sendResponse({ ok: false, error: 'baseline-failed' });
        return;
      }
      const st = tabState.get(msg.tabId) || { baseline: null, active: true };
      st.baseline = snap;
      tabState.set(msg.tabId, st);

      // Badge hint that a baseline exists (dot)
      await chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: BADGE_COLOR.safe });
      await chrome.action.setBadgeText({ tabId: msg.tabId, text: '•' });

      sendResponse({ ok: true });
    })();
    return true; // keep channel open
  }

  // Manual check: compare now (kept for compatibility with older popup)
  if (msg?.type === 'manual:check' && typeof msg.tabId === 'number') {
    (async () => {
      const st = tabState.get(msg.tabId) || { baseline: null, active: true };

      // If no stored baseline, try to get one first.
      const beforeImg = st.baseline ?? await captureActiveView(msg.tabId);
      const afterImg  = await captureActiveView(msg.tabId);

      if (!beforeImg || !afterImg) {
        sendResponse({ success: false, error: 'capture-failed' });
        return;
      }

      try {
        const { mismatch = 0, changes = [], width = 0, height = 0 } =
          await analyzePair(msg.tabId, beforeImg, afterImg) || {};

        const tier = classify(mismatch);

        await chrome.action.setBadgeBackgroundColor({
          tabId: msg.tabId,
          color: BADGE_COLOR[tier] || BADGE_COLOR.safe
        });
        await chrome.action.setBadgeText({
          tabId: msg.tabId,
          text: String(changes.length || 0)
        });

        await chrome.tabs.sendMessage(msg.tabId, {
          type: 'visualize:changes',
          mismatch,
          changes,
          width,
          height
        });

        // Advance baseline so follow-up checks use the latest
        const keep = tabState.get(msg.tabId) || { baseline: null, active: true };
        keep.baseline = afterImg;
        tabState.set(msg.tabId, keep);

        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: String(e?.message || e) });
      }
    })();
    return true; // keep channel open
  }
});
