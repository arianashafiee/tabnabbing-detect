// analyzer.js — Offscreen document. No chrome.tabs.* API here.
// Receives: { type:"analysis:request", ticket, tabId, original, current }
// Replies:  { type:"analysis:complete", ticket, tabId, mismatch, changes[], width, height }

(() => {
  // --- helpers ---
  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load error'));
      img.crossOrigin = 'anonymous';
      img.src = src;
    });

  const createCanvas = (w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  };

  // Level mapping used by overlays (per-region mean color distance)
  const levelFromDelta = (avgDelta) =>
    avgDelta >= 28 ? 'critical' :
    avgDelta >= 12 ? 'warning'  : 'minor';

  // Main: build a binary mask of changed pixels, then CC-label to boxes
  function diffToRegions(img1Data, img2Data, width, height) {
    const a = img1Data.data;
    const b = img2Data.data;

    // Thresholds tuned to resemble-like sensitivity
    const DIFF_THRESHOLD = 22;              // per-pixel average RGB delta to count as "changed"
    const MIN_REGION_AREA = Math.max(24, (width * height) / 10000 | 0); // adaptive floor
    const MAX_REGIONS = 50;                 // safety cap

    const total = width * height;
    const mask = new Uint8Array(total);     // 1 = changed
    let changedCount = 0;

    // Build mask
    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const dr = Math.abs(a[p]   - b[p]);
      const dg = Math.abs(a[p+1] - b[p+1]);
      const db = Math.abs(a[p+2] - b[p+2]);
      const da = Math.abs(a[p+3] - b[p+3]); // rarely needed, but keep for transparency jumps

      const avg = (dr + dg + db) / 3;
      if (avg >= DIFF_THRESHOLD || (da > 25 && avg > 8)) {
        mask[i] = 1;
        changedCount++;
      }
    }

    // Connected components (4-neighbor BFS)
    const visited = new Uint8Array(total);
    const qx = new Int32Array(total);
    const qy = new Int32Array(total);

    const regions = [];
    const pushRegion = (x0, y0, x1, y1, sumDelta, nPix) => {
      const w = x1 - x0 + 1;
      const h = y1 - y0 + 1;
      if (w <= 0 || h <= 0) return;
      if (w * h < MIN_REGION_AREA) return;
      const avgDelta = sumDelta / Math.max(1, nPix);
      regions.push({ x: x0, y: y0, w, h, level: levelFromDelta(avgDelta) });
    };

    const idx = (x, y) => y * width + x;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = idx(x, y);
        if (!mask[i] || visited[i]) continue;

        let rmin = x, rmax = x, tmin = y, tmax = y;
        let front = 0, back = 0;
        let sumDelta = 0, nPix = 0;

        visited[i] = 1;
        qx[back] = x; qy[back] = y; back++;

        while (front !== back) {
          const cx = qx[front];
          const cy = qy[front];
          front++;

          const pi = idx(cx, cy) * 4;
          const dr = Math.abs(a[pi]   - b[pi]);
          const dg = Math.abs(a[pi+1] - b[pi+1]);
          const db = Math.abs(a[pi+2] - b[pi+2]);
          sumDelta += (dr + dg + db) / 3;
          nPix++;

          if (cx < rmin) rmin = cx; if (cx > rmax) rmax = cx;
          if (cy < tmin) tmin = cy; if (cy > tmax) tmax = cy;

          // neighbors
          if (cx > 0) {
            const ni = idx(cx - 1, cy);
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[back] = cx - 1; qy[back] = cy; back++; }
          }
          if (cx + 1 < width) {
            const ni = idx(cx + 1, cy);
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[back] = cx + 1; qy[back] = cy; back++; }
          }
          if (cy > 0) {
            const ni = idx(cx, cy - 1);
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[back] = cx; qy[back] = cy - 1; back++; }
          }
          if (cy + 1 < height) {
            const ni = idx(cx, cy + 1);
            if (mask[ni] && !visited[ni]) { visited[ni] = 1; qx[back] = cx; qy[back] = cy + 1; back++; }
          }

          // guard (avoid pathological explosions)
          if (regions.length > MAX_REGIONS) break;
        }

        pushRegion(rmin, tmin, rmax, tmax, sumDelta, nPix);
        if (regions.length > MAX_REGIONS) break;
      }
      if (regions.length > MAX_REGIONS) break;
    }

    // (optional) merge very close boxes to reduce fragmentation
    const merged = mergeNearbyBoxes(regions, 6);
    const mismatch = (changedCount / total) * 100;

    return { regions: merged, mismatch };
  }

  function mergeNearbyBoxes(boxes, pad = 4) {
    if (boxes.length <= 1) return boxes.slice();
    const out = [];
    const used = new Array(boxes.length).fill(false);

    const overlaps = (a, b) => {
      const ax1 = a.x - pad, ay1 = a.y - pad, ax2 = a.x + a.w + pad, ay2 = a.y + a.h + pad;
      const bx1 = b.x,       by1 = b.y,       bx2 = b.x + b.w,       by2 = b.y + b.h;
      return !(bx1 > ax2 || bx2 < ax1 || by1 > ay2 || by2 < ay1);
    };

    for (let i = 0; i < boxes.length; i++) {
      if (used[i]) continue;
      let cur = { ...boxes[i] };
      used[i] = true;

      let merged = true;
      while (merged) {
        merged = false;
        for (let j = i + 1; j < boxes.length; j++) {
          if (used[j]) continue;
          if (overlaps(cur, boxes[j])) {
            // merge bounds; level = max severity
            const nx = Math.min(cur.x, boxes[j].x);
            const ny = Math.min(cur.y, boxes[j].y);
            const nx2 = Math.max(cur.x + cur.w, boxes[j].x + boxes[j].w);
            const ny2 = Math.max(cur.y + cur.h, boxes[j].y + boxes[j].h);
            cur.x = nx; cur.y = ny; cur.w = nx2 - nx; cur.h = ny2 - ny;
            cur.level = maxLevel(cur.level, boxes[j].level);
            used[j] = true;
            merged = true;
          }
        }
      }
      out.push(cur);
    }
    return out;
  }

  function maxLevel(a, b) {
    const rank = { minor: 0, warning: 1, critical: 2 };
    return (rank[b] > rank[a]) ? b : a;
  }

  // Handle messages
  chrome.runtime.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'analysis:request') return;

    const { ticket, tabId, original, current } = msg;

    try {
      // Load both images and scale to same size (like Resemble's scaleToSameSize)
      const [im1, im2] = await Promise.all([loadImage(original), loadImage(current)]);
      const width  = Math.max(im1.naturalWidth || im1.width || 0, im2.naturalWidth || im2.width || 0);
      const height = Math.max(im1.naturalHeight || im1.height || 0, im2.naturalHeight || im2.height || 0);

      if (!width || !height) throw new Error('invalid-dimensions');

      const c1 = createCanvas(width, height);
      const c2 = createCanvas(width, height);
      c1.getContext('2d').drawImage(im1, 0, 0, width, height);
      c2.getContext('2d').drawImage(im2, 0, 0, width, height);

      const d1 = c1.getContext('2d').getImageData(0, 0, width, height);
      const d2 = c2.getContext('2d').getImageData(0, 0, width, height);

      const { regions, mismatch } = diffToRegions(d1, d2, width, height);

      chrome.runtime.sendMessage({
        type: 'analysis:complete',
        ticket,
        tabId,
        mismatch,
        changes: regions,
        width,
        height
      });
    } catch (e) {
      chrome.runtime.sendMessage({
        type: 'analysis:complete',
        ticket,
        tabId,
        mismatch: 0,
        changes: [],
        width: 0,
        height: 0,
        error: String(e?.message || e)
      });
    }
  });
})();
