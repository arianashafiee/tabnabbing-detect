//  Popup control panel interaction logic

(async function() {
  // === UI State Management ===
  const updateStatus = (message, statusType = 'info') => {
    const feedbackElement = document.getElementById('feedback');
    
    if (!feedbackElement) return;
    
    feedbackElement.textContent = message || '';
    feedbackElement.className = statusType;
    
    // Auto-clear success/error messages after delay
    if (statusType !== 'info') {
      setTimeout(() => {
        feedbackElement.textContent = '';
        feedbackElement.className = '';
      }, 3500);
    }
  };

  // === Tab Validation ===
  const getCurrentTab = async () => {
    const tabs = await chrome.tabs.query({ 
      active: true, 
      currentWindow: true 
    });
    return tabs[0] || null;
  };

  const isProtectedUrl = (url) => {
    const protectedSchemes = [
      'chrome://',
      'chrome-extension://',
      'edge://',
      'about:',
      'devtools://'
    ];
    
    return !url || protectedSchemes.some(scheme => url.startsWith(scheme));
  };

  // === Initialize Extension State ===
  const initialize = async () => {
    const currentTab = await getCurrentTab();
    
    if (!currentTab?.id) {
      updateStatus('Unable to detect active tab', 'error');
      document.getElementById('clearBtn').disabled = true;
      document.getElementById('analyzeBtn').disabled = true;
      return;
    }

    if (isProtectedUrl(currentTab.url)) {
      updateStatus('Extension cannot run on system pages', 'info');
      document.getElementById('analyzeBtn').disabled = true;
    } else {
      updateStatus('Ready to analyze for tabnabbing', 'info');
    }
  };

  // === Clear Highlights Handler ===
  document.getElementById('clearBtn').addEventListener('click', async () => {
    const currentTab = await getCurrentTab();
    
    if (!currentTab?.id) {
      updateStatus('No active tab detected', 'error');
      return;
    }

    // Clear extension badge
    chrome.action.setBadgeText({ 
      tabId: currentTab.id, 
      text: '' 
    });

    // Attempt to clear page overlays
    try {
      await chrome.tabs.sendMessage(currentTab.id, { 
        type: 'visualize:remove' 
      });
      updateStatus('All highlights cleared', 'success');
    } catch (err) {
      // Expected to fail on protected pages
      if (isProtectedUrl(currentTab.url)) {
        updateStatus('Cleared (system page)', 'success');
      } else {
        updateStatus('Highlights cleared', 'success');
      }
    }
  });

  // === Analyze Now Handler ===
  document.getElementById('analyzeBtn').addEventListener('click', async () => {
    const currentTab = await getCurrentTab();
    
    if (!currentTab?.id) {
      updateStatus('No active tab detected', 'error');
      return;
    }

    if (isProtectedUrl(currentTab.url)) {
      updateStatus('Cannot analyze Chrome system pages. Navigate to a regular website.', 'error');
      return;
    }

    updateStatus('Analyzing for changes...', 'info');

    try {
      const response = await chrome.runtime.sendMessage({ 
        type: 'manual:check', 
        tabId: currentTab.id 
      });

      if (response?.success) {
        updateStatus('Analysis complete - check page for highlighted changes', 'success');
      } else {
        // Handle specific error cases
        const errorMessage = response?.error || 'unknown error';
        
        if (errorMessage === 'capture-failed') {
          updateStatus('Unable to capture page. Try interacting with the page first.', 'error');
        } else {
          updateStatus(`Analysis failed: ${errorMessage}`, 'error');
        }
      }
    } catch (err) {
      console.error('Analysis error:', err);
      updateStatus('Failed to communicate with extension. Please reload the page.', 'error');
    }
  });

  // === Startup ===
  await initialize();
})();