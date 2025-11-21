// Offscreen image difference detection with region identification

(() => {
  // === Configuration Parameters ===
  const PIXEL_SAMPLE_RATE = 2;          // Sample every 2nd pixel for performance
  const COLOR_THRESHOLD_MIN = 2.5;      // Minimum perceptible color difference
  const COLOR_THRESHOLD_DETECT = 4.5;   // Threshold for marking as changed
  const MIN_AREA_SIZE = 20 * 20;        // Minimum pixel area to report

  // Threat level categorization based on color difference
  function determineThreatLevel(colorDifference) {
    return colorDifference >= 28 ? "critical" : 
           colorDifference >= 12 ? "warning" : "minor";
  }

  function assessGlobalThreat(percentage) {
    return percentage >= 35 ? "critical" : 
           percentage >= 15 ? "warning" : "minor";
  }

  // === Color Space Conversion Functions ===
  function linearizeChannel(channel) {
    channel /= 255;
    return channel <= 0.04045 ? 
           channel / 12.92 : 
           Math.pow((channel + 0.055) / 1.055, 2.4);
  }

  function convertToXYZ(red, green, blue) {
    const rLinear = linearizeChannel(red);
    const gLinear = linearizeChannel(green);
    const bLinear = linearizeChannel(blue);
    
    return [
      rLinear * 0.4124564 + gLinear * 0.3575761 + bLinear * 0.1804375,
      rLinear * 0.2126729 + gLinear * 0.7151522 + bLinear * 0.0721750,
      rLinear * 0.0193339 + gLinear * 0.1191920 + bLinear * 0.9503041
    ];
  }

  function convertToLAB(xVal, yVal, zVal) {
    // D65 illuminant reference values
    const refX = 0.95047, refY = 1.00000, refZ = 1.08883;
    
    const normalize = t => (t > 0.008856) ? 
                           Math.cbrt(t) : 
                           (7.787 * t + 16 / 116);
    
    const fx = normalize(xVal / refX);
    const fy = normalize(yVal / refY);
    const fz = normalize(zVal / refZ);
    
    return [
      116 * fy - 16,
      500 * (fx - fy),
      200 * (fy - fz)
    ];
  }

  function rgbToLabSpace(r, g, b) {
    const [x, y, z] = convertToXYZ(r, g, b);
    return convertToLAB(x, y, z);
  }

  function calculateColorDistance(L1, a1, b1, L2, a2, b2) {
    const deltaL = L1 - L2;
    const deltaA = a1 - a2;
    const deltaB = b1 - b2;
    return Math.sqrt(deltaL * deltaL + deltaA * deltaA + deltaB * deltaB);
  }

  // === Image Loading and Processing ===
  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function createCanvasContext(width, height) {
    if (typeof OffscreenCanvas !== "undefined") {
      return new OffscreenCanvas(width, height);
    }
    const canvas = self.document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  async function extractImageData(beforeUrl, afterUrl) {
    const [imgBefore, imgAfter] = await Promise.all([
      loadImageFromUrl(beforeUrl),
      loadImageFromUrl(afterUrl)
    ]);
    
    const width = Math.min(imgBefore.width, imgAfter.width);
    const height = Math.min(imgBefore.height, imgAfter.height);

    const canvasBefore = createCanvasContext(width, height);
    const ctxBefore = canvasBefore.getContext("2d", { willReadFrequently: true });
    
    const canvasAfter = createCanvasContext(width, height);
    const ctxAfter = canvasAfter.getContext("2d", { willReadFrequently: true });
    
    ctxBefore.drawImage(imgBefore, 0, 0, width, height);
    ctxAfter.drawImage(imgAfter, 0, 0, width, height);
    
    return {
      width,
      height,
      dataBefore: ctxBefore.getImageData(0, 0, width, height),
      dataAfter: ctxAfter.getImageData(0, 0, width, height)
    };
  }

  // === Resemble.js Integration for Global Mismatch ===
  function computeGlobalMismatch(beforeUrl, afterUrl) {
    return new Promise(resolve => {
      if (typeof resemble === "undefined") {
        return resolve(0);
      }
      
      try {
        resemble(beforeUrl)
          .compareTo(afterUrl)
          .ignoreNothing()
          .onComplete(data => {
            const percentage = parseFloat(
              data?.rawMisMatchPercentage ?? 
              data?.misMatchPercentage ?? "0"
            ) || 0;
            resolve(percentage);
          });
      } catch {
        resolve(0);
      }
    });
  }

  // === Change Detection Grid Analysis ===
  function createChangeGrid(dataBefore, dataAfter, width, height) {
    const pixelsBefore = dataBefore.data;
    const pixelsAfter = dataAfter.data;
    
    const gridRows = Math.ceil(height / PIXEL_SAMPLE_RATE);
    const gridCols = Math.ceil(width / PIXEL_SAMPLE_RATE);
    
    const changeMap = new Uint8Array(gridRows * gridCols);
    const colorDifferences = new Float32Array(gridRows * gridCols);
    
    let totalChanged = 0;
    let totalSampled = 0;
    let maxColorDiff = 0;

    for (let y = 0, row = 0; y < height; y += PIXEL_SAMPLE_RATE, row++) {
      for (let x = 0, col = 0; x < width; x += PIXEL_SAMPLE_RATE, col++) {
        const pixelIndex = (y * width + x) * 4;
        
        const r1 = pixelsBefore[pixelIndex];
        const g1 = pixelsBefore[pixelIndex + 1];
        const b1 = pixelsBefore[pixelIndex + 2];
        
        const r2 = pixelsAfter[pixelIndex];
        const g2 = pixelsAfter[pixelIndex + 1];
        const b2 = pixelsAfter[pixelIndex + 2];

        const [L1, A1, B1] = rgbToLabSpace(r1, g1, b1);
        const [L2, A2, B2] = rgbToLabSpace(r2, g2, b2);
        
        const colorDist = calculateColorDistance(L1, A1, B1, L2, A2, B2);
        
        const gridIndex = row * gridCols + col;
        colorDifferences[gridIndex] = colorDist;
        
        if (colorDist >= COLOR_THRESHOLD_DETECT) {
          changeMap[gridIndex] = 1;
          totalChanged++;
          if (colorDist > maxColorDiff) {
            maxColorDiff = colorDist;
          }
        }
        totalSampled++;
      }
    }
    
    const estimatedMismatch = (totalChanged / totalSampled) * 100;
    
    return {
      changeMap,
      colorDifferences,
      gridRows,
      gridCols,
      estimatedMismatch,
      maxColorDiff
    };
  }

  // === Connected Component Analysis for Region Detection ===
  function identifyChangeRegions(changeMap, colorDifferences, gridRows, gridCols) {
    const visited = new Uint8Array(changeMap.length);
    const detectedRegions = [];

    const getNeighbors = (row, col) => [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1]
    ];

    for (let row = 0; row < gridRows; row++) {
      for (let col = 0; col < gridCols; col++) {
        const index = row * gridCols + col;
        
        if (!changeMap[index] || visited[index]) continue;

        // Flood fill to find connected component
        let minRow = row, maxRow = row;
        let minCol = col, maxCol = col;
        let pixelCount = 0;
        let maxColorDiff = 0;

        const stack = [[row, col]];
        visited[index] = 1;

        while (stack.length > 0) {
          const [currentRow, currentCol] = stack.pop();
          const currentIndex = currentRow * gridCols + currentCol;
          
          pixelCount++;
          
          if (colorDifferences[currentIndex] > maxColorDiff) {
            maxColorDiff = colorDifferences[currentIndex];
          }
          
          if (currentRow < minRow) minRow = currentRow;
          if (currentRow > maxRow) maxRow = currentRow;
          if (currentCol < minCol) minCol = currentCol;
          if (currentCol > maxCol) maxCol = currentCol;

          for (const [neighborRow, neighborCol] of getNeighbors(currentRow, currentCol)) {
            if (neighborRow < 0 || neighborCol < 0 || 
                neighborRow >= gridRows || neighborCol >= gridCols) continue;
            
            const neighborIndex = neighborRow * gridCols + neighborCol;
            
            if (!visited[neighborIndex] && changeMap[neighborIndex]) {
              visited[neighborIndex] = 1;
              stack.push([neighborRow, neighborCol]);
            }
          }
        }

        // Convert grid coordinates back to pixel coordinates
        const xPos = minCol * PIXEL_SAMPLE_RATE;
        const yPos = minRow * PIXEL_SAMPLE_RATE;
        const regionWidth = (maxCol - minCol + 1) * PIXEL_SAMPLE_RATE;
        const regionHeight = (maxRow - minRow + 1) * PIXEL_SAMPLE_RATE;

        if (regionWidth * regionHeight >= MIN_AREA_SIZE) {
          detectedRegions.push({
            x: xPos,
            y: yPos,
            w: regionWidth,
            h: regionHeight,
            level: determineThreatLevel(maxColorDiff),
            maxDiff: maxColorDiff
          });
        }
      }
    }

    return detectedRegions;
  }

  // === Message Handler ===
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message?.type !== "analysis:request") return;
    
    const { tabId, original, current } = message;

    try {
      // Calculate global mismatch using Resemble.js
      const globalMismatchValue = await computeGlobalMismatch(original, current);

      // Extract image data for detailed analysis
      const { width, height, dataBefore, dataAfter } = 
        await extractImageData(original, current);

      // Build change detection grid
      const { changeMap, colorDifferences, gridRows, gridCols, estimatedMismatch } = 
        createChangeGrid(dataBefore, dataAfter, width, height);

      // Use Resemble value if available, otherwise use our estimate
      const finalMismatch = globalMismatchValue > 0 ? globalMismatchValue : estimatedMismatch;

      // Identify changed regions
      const changeRegions = identifyChangeRegions(
        changeMap, 
        colorDifferences, 
        gridRows, 
        gridCols
      );

      // Send analysis results back
      chrome.runtime.sendMessage({
        type: "analysis:complete",
        tabId,
        mismatch: finalMismatch,
        changes: changeRegions,
        width,
        height
      });

    } catch (error) {
      chrome.runtime.sendMessage({
        type: "analysis:complete",
        tabId,
        mismatch: 0,
        changes: [],
        width: 0,
        height: 0,
        error: String(error?.message || error)
      });
    }
  });
})();