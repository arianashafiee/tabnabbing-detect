(async () => {
    const set = (t, isErr=false) => {
      const el = document.getElementById("status");
      el.textContent = t || "";
      el.style.color = isErr ? "#b00020" : "#666";
    };
  
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) { set("No active tab.", true); return; }
  
    const isRestricted = (url) =>
      !url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("about:");
  
    document.getElementById("btnClear").addEventListener("click", async () => {
      // Always clear badge; content message may fail on restricted pages (expected).
      chrome.action.setBadgeText({ tabId: tab.id, text: "" });
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "tabrewind:clear" });
        set("Highlights cleared.");
      } catch {
        set("Highlights cleared (page is restricted or no content script).");
      }
    });
  
    document.getElementById("btnCheck").addEventListener("click", async () => {
      if (isRestricted(tab.url)) {
        set("Cannot run on Chrome internal pages. Try a normal site.", true);
        return;
      }
      set("Checking…");
      try {
        const res = await chrome.runtime.sendMessage({ type: "tabrewind:force-now", tabId: tab.id });
        if (res?.ok) {
          set("Check initiated. Look for overlays on the page.");
        } else {
          // Handle common reasons visibly
          if (res?.error === "no-images") {
            set("Capture not available yet; try again after interacting with the page.", true);
          } else {
            set(`Failed: ${res?.error || "unknown error"}`, true);
          }
        }
      } catch (e) {
        set(`Failed to message background. Reload page and try again.`, true);
      }
    });
  })();