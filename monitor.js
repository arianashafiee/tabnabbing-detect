// Screenshot capture coordinator, comparison orchestrator, and alert system

const CAPTURE_INTERVAL = 3500;        // Screenshot interval in milliseconds  
const COMPARISON_DELAY = 150;         // Delay before comparison after tab return
const restrictedUrls = ["chrome://", "chrome-extension://", "edge://", "about:", "devtools://"];

const tabMonitor = new Map(); // tabId -> { snapshot: dataUrl|null, isActive: boolean, captureLoop?: number }

// === Utility Functions ===
function isRestrictedUrl(url) {
  return !url || restrictedUrls.some(prefix => url.startsWith(prefix));
}

async function retrieveTab(tabId) {
  try { 
    return await chrome.tabs.get(tabId); 
  } catch { 
    return null; 
  }
}

async function captureScreenshot(tabId) {
  const tab = await retrieveTab(tabId);
  if (!tab || !tab.active || isRestrictedUrl(tab.url)) return null;
  
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (err) {
    const errorMsg = String(err?.message || "").toLowerCase();
    const expectedErrors = ["cannot access", "cannot be edited", "not in effect", "no tab with id", "dragging"];
    
    if (!expectedErrors.some(e => errorMsg.includes(e))) {
      console.warn("[captureScreenshot] Unexpected error:", err.message);
    }
    return null;
  }
}

function haltCapturing(tabId) {
  const monitor = tabMonitor.get(tabId);
  if (monitor?.captureLoop) {
    clearInterval(monitor.captureLoop);
    monitor.captureLoop = undefined;
  }
}

function initiateCapturing(tabId) {
  haltCapturing(tabId);
  const monitor = tabMonitor.get(tabId) ?? { snapshot: null, isActive: true };
  
  monitor.captureLoop = setInterval(async () => {
    if (!monitor.isActive) return;
    const screenshot = await captureScreenshot(tabId);
    if (screenshot) monitor.snapshot = screenshot;
  }, CAPTURE_INTERVAL);
  
  tabMonitor.set(tabId, monitor);
}

// === Offscreen Document Management ===
async function isOffscreenActive() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  return contexts.some(ctx => ctx.documentUrl.endsWith("analyzer.html"));
}

async function activateOffscreen() {
  if (await isOffscreenActive()) return;
  await chrome.offscreen.createDocument({
    url: "analyzer.html",
    reasons: [chrome.offscreen.Reason.DOM_PARSER],
    justification: "Canvas-based image difference analysis for tabnabbing detection."
  });
}

function calculateThreatLevel(mismatchPercent) {
  return mismatchPercent >= 35 ? "critical" : 
         mismatchPercent >= 15 ? "warning" : "minor";
}

async function analyzeImages(tabId, original, current) {
  await activateOffscreen();
  
  return new Promise((resolve) => {
    const messageHandler = (msg, sender) => {
      if (msg?.type === "analysis:complete" && msg.tabId === tabId) {
        chrome.runtime.onMessage.removeListener(messageHandler);
        resolve(msg);
      }
    };
    
    chrome.runtime.onMessage.addListener(messageHandler);
    chrome.runtime.sendMessage({
      type: "analysis:request",
      tabId,
      original,
      current
    });
  });
}

// === Tab Return Analysis ===
async function analyzeTabReturn(tabId) {
  const monitor = tabMonitor.get(tabId);
  if (!monitor?.snapshot) return;
  
  setTimeout(async () => {
    const currentCapture = await captureScreenshot(tabId);
    if (!currentCapture) return;
    
    try {
      const analysis = await analyzeImages(tabId, monitor.snapshot, currentCapture);
      const { mismatch, changes, width, height } = analysis || {};
      const threatLevel = calculateThreatLevel(mismatch || 0);
      
      // Update extension badge with threat indicator
      const badgeColors = {
        critical: '#E91E63',  // Magenta-pink
        warning: '#FF6B35',   // Orange-red  
        minor: '#FFA726',     // Amber
        safe: '#9E9E9E'       // Gray
      };
      
      chrome.action.setBadgeBackgroundColor({ 
        color: badgeColors[threatLevel] || badgeColors.safe, 
        tabId 
      });
      
      chrome.action.setBadgeText({ 
        text: String(changes?.length || 0) || '', 
        tabId 
      });
      
      // Send visualization data to content script
      await chrome.tabs.sendMessage(tabId, {
        type: "visualize:changes",
        mismatch,
        changes,
        width,
        height
      });
      
      // Update stored snapshot
      monitor.snapshot = currentCapture;
      tabMonitor.set(tabId, monitor);
      
    } catch (err) {
      console.warn("[analyzeTabReturn]", err?.message || err);
    }
  }, COMPARISON_DELAY);
}

// === Tab and Window Event Handlers ===
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const existingMonitor = tabMonitor.get(tabId);
  const wasInactive = existingMonitor ? existingMonitor.isActive === false : false;
  
  // Deactivate all other tabs
  for (const [id, monitor] of tabMonitor.entries()) {
    if (id !== tabId) monitor.isActive = false;
  }
  
  // Activate current tab
  const currentMonitor = existingMonitor ?? { snapshot: null, isActive: true };
  currentMonitor.isActive = true;
  tabMonitor.set(tabId, currentMonitor);
  
  // Stop capturing for inactive tabs
  const allTabs = await chrome.tabs.query({ windowId });
  for (const tab of allTabs) {
    if (tab.id !== tabId) haltCapturing(tab.id);
  }
  
  initiateCapturing(tabId);
  
  if (wasInactive) {
    await analyzeTabReturn(tabId);
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    for (const monitor of tabMonitor.values()) {
      monitor.isActive = false;
    }
    return;
  }
  
  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (!activeTab?.id) return;
  
  const existingMonitor = tabMonitor.get(activeTab.id) ?? { snapshot: null, isActive: false };
  const wasInactive = existingMonitor.isActive === false;
  
  // Deactivate other tabs in window
  const windowTabs = await chrome.tabs.query({ windowId });
  for (const tab of windowTabs) {
    if (tab.id !== activeTab.id) {
      const tabMon = tabMonitor.get(tab.id);
      if (tabMon) tabMon.isActive = false;
    }
  }
  
  existingMonitor.isActive = true;
  tabMonitor.set(activeTab.id, existingMonitor);
  initiateCapturing(activeTab.id);
  
  if (wasInactive) {
    await analyzeTabReturn(activeTab.id);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active && !isRestrictedUrl(tab.url)) {
    const monitor = tabMonitor.get(tabId) ?? { snapshot: null, isActive: true };
    monitor.isActive = true;
    tabMonitor.set(tabId, monitor);
    initiateCapturing(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  haltCapturing(tabId);
  tabMonitor.delete(tabId);
});

// === Extension Installation ===
chrome.runtime.onInstalled.addListener(async () => {
  const activeTabs = await chrome.tabs.query({ active: true });
  for (const tab of activeTabs) {
    const initialCapture = await captureScreenshot(tab.id);
    tabMonitor.set(tab.id, { 
      snapshot: initialCapture, 
      isActive: true 
    });
    initiateCapturing(tab.id);
  }
});

// === Manual Check from Popup ===
chrome.runtime.onMessage.addListener(async (msg, _sender, sendResponse) => {
  if (msg?.type === "manual:check" && typeof msg.tabId === "number") {
    const tabId = msg.tabId;
    let monitor = tabMonitor.get(tabId);
    
    if (!monitor) {
      monitor = { snapshot: null, isActive: true };
      tabMonitor.set(tabId, monitor);
    }
    
    try {
      const beforeImg = monitor.snapshot ?? await captureScreenshot(tabId);
      const afterImg = await captureScreenshot(tabId);
      
      if (!beforeImg || !afterImg) {
        sendResponse({ success: false, error: "capture-failed" });
        return true;
      }
      
      const analysis = await analyzeImages(tabId, beforeImg, afterImg);
      const { mismatch, changes, width, height } = analysis || {};
      const threatLevel = calculateThreatLevel(mismatch || 0);
      
      const badgeColors = {
        critical: '#E91E63',
        warning: '#FF6B35',
        minor: '#FFA726',
        safe: '#9E9E9E'
      };
      
      chrome.action.setBadgeBackgroundColor({ 
        color: badgeColors[threatLevel] || badgeColors.safe, 
        tabId 
      });
      chrome.action.setBadgeText({ 
        text: String(changes?.length || 0) || '', 
        tabId 
      });
      
      await chrome.tabs.sendMessage(tabId, {
        type: "visualize:changes",
        mismatch,
        changes,
        width,
        height
      });
      
      monitor.snapshot = afterImg;
      tabMonitor.set(tabId, monitor);
      sendResponse({ success: true });
      
    } catch (err) {
      sendResponse({ success: false, error: String(err?.message || err) });
    }
    return true;
  }
});