//  Renders change detection overlays directly on webpage

(() => {
  let changeCanvas = null;
  let statusIndicator = null;

  function createChangeCanvas() {
    if (changeCanvas) return changeCanvas;
    
    changeCanvas = document.createElement("div");
    changeCanvas.id = "tabnab-change-layer";
    changeCanvas.style.cssText = 
      "position:fixed;inset:0;pointer-events:none;z-index:2147483646;";
    document.documentElement.appendChild(changeCanvas);
    return changeCanvas;
  }

  function createStatusIndicator() {
    if (statusIndicator) return statusIndicator;
    
    statusIndicator = document.createElement("div");
    statusIndicator.id = "tabnab-status";
    statusIndicator.style.cssText = `
      position: fixed; 
      top: 15px; 
      right: 15px; 
      z-index: 2147483646;
      background: linear-gradient(135deg, rgba(245,245,250,0.95), rgba(255,255,255,0.98)); 
      color: #2C3E50; 
      border: 2px solid rgba(52,73,94,0.15);
      padding: 8px 14px; 
      border-radius: 8px; 
      font: 700 13px -apple-system, system-ui, 'Segoe UI', Roboto, 'Helvetica Neue', Arial;
      pointer-events: none; 
      box-shadow: 0 4px 12px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.12);
      backdrop-filter: blur(10px);
    `;
    document.documentElement.appendChild(statusIndicator);
    return statusIndicator;
  }

  function getThreatColor(severity) {
    const colorMap = {
      "critical": "rgba(233,30,99,0.55)",   // Pink-red
      "warning": "rgba(255,107,53,0.48)",   // Orange-coral
      "minor": "rgba(255,167,38,0.42)"      // Light orange
    };
    return colorMap[severity] || "rgba(255,167,38,0.42)";
  }

  function renderChangedAreas(changeList, sourceWidth, sourceHeight) {
    const canvas = createChangeCanvas();
    canvas.innerHTML = "";
    
    if (!changeList || !changeList.length || !sourceWidth || !sourceHeight) return;

    const horizontalScale = window.innerWidth / sourceWidth;
    const verticalScale = window.innerHeight / sourceHeight;

    changeList.forEach(area => {
      const highlightBox = document.createElement("div");
      highlightBox.style.cssText = `
        position: absolute; 
        left: ${area.x * horizontalScale}px; 
        top: ${area.y * verticalScale}px;
        width: ${area.w * horizontalScale}px; 
        height: ${area.h * verticalScale}px;
        background: ${getThreatColor(area.level)}; 
        border: 2px solid rgba(44,62,80,0.25); 
        pointer-events: none;
        animation: pulseWarning 2s ease-in-out infinite;
      `;
      canvas.appendChild(highlightBox);
    });

    // Add pulsing animation
    if (!document.getElementById('tabnab-animations')) {
      const style = document.createElement('style');
      style.id = 'tabnab-animations';
      style.textContent = `
        @keyframes pulseWarning {
          0%, 100% { opacity: 0.7; transform: scale(1); }
          50% { opacity: 0.9; transform: scale(1.02); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  function displayMatchPercentage(mismatchValue) {
    const indicator = createStatusIndicator();
    const matchPercentage = Math.max(0, 100 - (mismatchValue || 0));
    const changePercentage = (mismatchValue || 0);
    
    indicator.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 11px; opacity: 0.8;">MATCH</span>
        <span style="font-size: 14px; font-weight: 800;">${matchPercentage.toFixed(1)}%</span>
        <span style="font-size: 11px; opacity: 0.7;">• ${changePercentage.toFixed(1)}% changed</span>
      </div>
    `;
  }

  // Handle window resizing
  let resizeHandler = null;
  
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "visualize:changes") {
      displayMatchPercentage(message.mismatch);
      renderChangedAreas(message.changes || [], message.width, message.height);

      // Reposition overlays on window resize
      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
      }
      
      resizeHandler = () => {
        let animFrame = null;
        if (animFrame) cancelAnimationFrame(animFrame);
        animFrame = requestAnimationFrame(() => {
          renderChangedAreas(message.changes || [], message.width, message.height);
        });
      };
      
      window.addEventListener("resize", resizeHandler);
    }
    
    if (message?.type === "visualize:remove") {
      if (changeCanvas) {
        changeCanvas.remove();
        changeCanvas = null;
      }
      if (statusIndicator) {
        statusIndicator.remove();
        statusIndicator = null;
      }
      if (resizeHandler) {
        window.removeEventListener("resize", resizeHandler);
        resizeHandler = null;
      }
      
      // Remove animations
      const animStyle = document.getElementById('tabnab-animations');
      if (animStyle) animStyle.remove();
    }
  });
})();