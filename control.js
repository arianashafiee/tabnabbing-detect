// Popup control — compact, only "Clear Page Highlights"
(async () => {
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg) => { $('feedback').textContent = msg || ''; };

  const getActive = async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  };

  const SYSTEM_PREFIXES = [
    'chrome://','chrome-extension://','edge://','about:','devtools://',
    'brave://','vivaldi://','opera://','moz-extension://'
  ];
  const isSystem = (url) => !url || SYSTEM_PREFIXES.some(p => url.startsWith(p));

  // Clear overlays/badge
  $('clearBtn').addEventListener('click', async () => {
    const tab = await getActive();
    if (!tab?.id) return setStatus('No active tab.');
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'visualize:remove' });
      setStatus('Highlights cleared.');
    } catch {
      setStatus(isSystem(tab.url) ? 'Highlights cleared (system tab).' : 'Highlights cleared.');
    }
  });

  // Init
  const tab = await getActive();
  if (!tab?.id) {
    $('clearBtn').disabled = true;
    setStatus('No active tab.');
  } else if (isSystem(tab.url)) {
    setStatus('Runs only on regular web pages.');
  } else {
    setStatus('Ready.');
  }
})();
