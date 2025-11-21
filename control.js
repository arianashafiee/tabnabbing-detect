(async () => {
  // ---------- feedback helpers ----------
  const setFeedback = (msg, kind = 'info') => {
    const el = document.getElementById('feedback');
    if (!el) return;
    el.textContent = msg || '';
    el.className = kind;

    if (kind !== 'info') {
      setTimeout(() => {
        el.textContent = '';
        el.className = '';
      }, 3500);
    }
  };

  // ---------- tab helpers ----------
  const fetchActiveTab = async () => {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t || null;
  };

  // Expanded set of internal/privileged schemes & non-web contexts we avoid
  const BLOCKED_SCHEMES = [
    'chrome://',
    'chrome-untrusted://',
    'chrome-extension://',
    'edge://',
    'devtools://',
    'about:',
    'brave://',
    'vivaldi://',
    'opera://',
    'moz-extension://',
    'resource://',
    'view-source:',
    'file://',
    'data:',
    'blob:' 
  ];

  const isInternalOrRestricted = (url) =>
    !url || BLOCKED_SCHEMES.some(p => url.startsWith(p));

  // ---------- startup ----------
  const boot = async () => {
    const tab = await fetchActiveTab();

    if (!tab?.id) {
      setFeedback('Unable to detect active tab', 'error');
      const btn = document.getElementById('clearBtn');
      if (btn) btn.disabled = true;
      return;
    }

    if (isInternalOrRestricted(tab.url)) {
      setFeedback('Runs only on regular web pages.', 'info');
    } else {
      setFeedback('Ready.', 'info');
    }
  };

  // ---------- clear overlays action ----------
  document.getElementById('clearBtn').addEventListener('click', async () => {
    const tab = await fetchActiveTab();
    if (!tab?.id) {
      setFeedback('No active tab detected', 'error');
      return;
    }

    // wipe badge
    chrome.action.setBadgeText({ tabId: tab.id, text: '' });

    // remove page visuals
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'visualize:remove' });
      setFeedback('All highlights cleared', 'success');
    } catch {
      // expected on restricted pages
      setFeedback(
        isInternalOrRestricted(tab.url) ? 'Cleared (system page)' : 'Highlights cleared',
        'success'
      );
    }
  });

  await boot();
})();
