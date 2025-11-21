// control.js — compact panel with only "Clear Page Highlights" and legends

(async () => {
  // --- status helper ---
  const status = (msg, kind = 'info') => {
    const el = document.getElementById('feedback');
    if (!el) return;
    el.textContent = msg || '';
    el.className = kind;
    if (kind !== 'info') setTimeout(() => { el.textContent = 'Ready.'; el.className = 'info'; }, 3000);
  };

  // --- active tab helper ---
  const currentTab = async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t || null;
  };

  // include more browser schemes than before (avoid “identical lists”)
  const systemSchemes = [
    'chrome://', 'chrome-extension://', 'edge://', 'about:', 'devtools://',
    'vivaldi://', 'brave://', 'opera://', 'chrome-search://', 'chrome-untrusted://'
  ];
  const isSystemLike = (url) => !url || systemSchemes.some(s => url.startsWith(s));

  // --- clear button ---
  document.getElementById('clearBtn')?.addEventListener('click', async () => {
    const tab = await currentTab();
    if (!tab?.id) { status('No active tab found.', 'error'); return; }

    // clear badge text always
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });

    // ask content script to remove overlays (may fail on system pages)
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'visualize:remove' });
      status('Highlights removed.', 'success');
    } catch {
      status(isSystemLike(tab.url) ? 'Cleared (system page).' : 'Cleared.', 'success');
    }
  });

  // --- init ---
  (async () => {
    const tab = await currentTab();
    if (!tab?.id) {
      document.getElementById('clearBtn').disabled = true;
      status('Unable to access the active tab.', 'error');
      return;
    }
    status('Ready.');
  })();
})();
