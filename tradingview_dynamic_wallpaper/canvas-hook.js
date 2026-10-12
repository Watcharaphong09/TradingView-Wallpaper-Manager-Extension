// canvas-hook.js — Runs in the MAIN world (page context)
// Hooks CanvasRenderingContext2D to draw wallpapers directly on the chart canvas
// right after background fill, but BEFORE candlesticks, indicators, and grid.
// Uses native WebCodecs ImageDecoder for animated GIFs with smart anti-stutter engine.

(() => {
  if (window._tvCanvasHookInstalled) return;
  window._tvCanvasHookInstalled = true;

  let currentSource = null; // ImageBitmap or HTMLImageElement
  let isGifMode = false;
  let gifFrames = []; // Array of { bmp: ImageBitmap, dur: number }
  let currentFrameIdx = 0;
  let gifTimer = null;

  // Track user interaction (dragging, panning, scrolling)
  // When user is interacting, TradingView renders natively at 60 FPS.
  // Suppressing synthetic events during user interaction eliminates chart stutter completely!
  let isUserInteracting = false;
  window.addEventListener("mousedown", () => { isUserInteracting = true; }, { capture: true, passive: true });
  window.addEventListener("mouseup", () => { setTimeout(() => { isUserInteracting = false; }, 120); }, { capture: true, passive: true });
  window.addEventListener("touchstart", () => { isUserInteracting = true; }, { capture: true, passive: true });
  window.addEventListener("touchend", () => { setTimeout(() => { isUserInteracting = false; }, 120); }, { capture: true, passive: true });

  let currentSettings = {
    opacity: 0.35,
    size: "cover",
    positionX: "50%",
    positionY: "50%",
    blur: 0,
    visible: true,
  };

  function stopGifPlayback() {
    if (gifTimer) {
      clearTimeout(gifTimer);
      gifTimer = null;
    }
    if (gifFrames.length > 0) {
      gifFrames.forEach((f) => {
        try {
          f.bmp?.close();
        } catch {}
      });
      gifFrames = [];
    }
    isGifMode = false;
    currentFrameIdx = 0;
  }

  function triggerRedraw() {
    // Never dispatch synthetic events while the user is actively dragging the chart!
    if (isUserInteracting) return;

    // When idle, trigger gentle update on canvas without heavy window resize
    const canvas = document.querySelector(".chart-container canvas");
    if (canvas) {
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaX: 0, deltaY: 0, bubbles: true }));
      canvas.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    }
  }

  function startGifPlayback() {
    if (gifFrames.length === 0) return;
    isGifMode = true;

    function tick() {
      if (!isGifMode || gifFrames.length === 0) return;

      currentFrameIdx = (currentFrameIdx + 1) % gifFrames.length;
      currentSource = gifFrames[currentFrameIdx].bmp;

      // Only trigger synthetic update when idle and tab is active
      if (!document.hidden && !isUserInteracting) {
        triggerRedraw();
      }

      // Smooth frame delay (clamp between 50ms and 200ms to prevent CPU overload)
      const delay = Math.max(50, gifFrames[currentFrameIdx].dur || 80);
      gifTimer = setTimeout(tick, delay);
    }

    currentSource = gifFrames[0].bmp;
    triggerRedraw();
    gifTimer = setTimeout(tick, Math.max(50, gifFrames[0].dur || 80));
  }

  async function decodeGif(dataUrl) {
    try {
      const res = await fetch(dataUrl);
      const buf = await res.arrayBuffer();

      if (typeof ImageDecoder === "undefined") {
        throw new Error("ImageDecoder not supported");
      }

      const decoder = new ImageDecoder({ data: buf, type: "image/gif" });
      await decoder.tracks.ready;

      const track = decoder.tracks.selectedTrack;
      const count = track ? track.frameCount : 1;

      const loaded = [];
      for (let i = 0; i < count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        const bmp = await createImageBitmap(image);
        const dur = (image.duration || 80000) / 1000;
        image.close();
        loaded.push({ bmp, dur });
      }

      return loaded;
    } catch (err) {
      console.warn("[TV Wallpaper] WebCodecs decode error:", err);
      return null;
    }
  }

  async function applyWallpaperData(wallpaper) {
    stopGifPlayback();

    if (!wallpaper || !wallpaper.data || wallpaper.settings?.visible === false) {
      currentSource = null;
      triggerRedraw();
      return;
    }

    currentSettings = Object.assign(
      {
        opacity: 0.35,
        size: "cover",
        positionX: "50%",
        positionY: "50%",
        blur: 0,
        visible: true,
      },
      wallpaper.settings || {}
    );

    const isGif =
      typeof wallpaper.data === "string" &&
      (wallpaper.data.startsWith("data:image/gif") ||
        wallpaper.data.includes(".gif") ||
        wallpaper.data.includes("R0lGOD"));

    if (isGif) {
      const frames = await decodeGif(wallpaper.data);
      if (frames && frames.length > 1) {
        gifFrames = frames;
        startGifPlayback();
        return;
      }
    }

    // Static image fallback (PNG, JPG, WebP)
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      currentSource = img;
      triggerRedraw();
    };
    img.src = wallpaper.data;
  }

  // Hook CanvasRenderingContext2D.prototype.fillRect
  const origFillRect = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function (x, y, w, h) {
    origFillRect.apply(this, arguments);

    if (!currentSource) return;
    if (currentSettings.visible === false) return;

    // Detect full-canvas fill (TradingView background)
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (x === 0 && y === 0 && w >= cw * 0.85 && h >= ch * 0.85) {
      if (this.canvas.closest && this.canvas.closest(".chart-container")) {
        drawWallpaper(this, cw, ch);
      }
    }
  };

  function drawWallpaper(ctx, cw, ch) {
    if (!currentSource) return;

    ctx.save();

    // 1. Opacity
    const opacity =
      typeof currentSettings.opacity === "number"
        ? Math.min(1, Math.max(0, currentSettings.opacity))
        : 0.35;
    ctx.globalAlpha = opacity;

    // 2. Blur
    const blur =
      typeof currentSettings.blur === "number" ? currentSettings.blur : 0;
    if (blur > 0 && typeof ctx.filter === "string") {
      ctx.filter = `blur(${blur}px)`;
    }

    // 3. Dimension & Position
    const iw = currentSource.width || currentSource.naturalWidth;
    const ih = currentSource.height || currentSource.naturalHeight;
    const size = currentSettings.size || "cover";

    let nw = cw;
    let nh = ch;

    if (size === "cover") {
      const scale = Math.max(cw / iw, ch / ih);
      nw = iw * scale;
      nh = ih * scale;
    } else if (size === "contain") {
      const scale = Math.min(cw / iw, ch / ih);
      nw = iw * scale;
      nh = ih * scale;
    } else if (size === "stretch") {
      nw = cw;
      nh = ch;
    }

    const posXPercent = (parseFloat(currentSettings.positionX) || 50) / 100;
    const posYPercent = (parseFloat(currentSettings.positionY) || 50) / 100;

    const nx = (cw - nw) * posXPercent;
    const ny = (ch - nh) * posYPercent;

    ctx.drawImage(currentSource, nx, ny, nw, nh);
    ctx.restore();
  }

  // Read carrier DOM element for synchronous initial load
  function readCarrier() {
    const el = document.getElementById("tv-wallpaper-shared-carrier");
    if (el && el.textContent) {
      try {
        const wp = JSON.parse(el.textContent);
        applyWallpaperData(wp);
      } catch {}
    }
  }

  // Listen for updates from content.js
  window.addEventListener("tv-wallpaper-update", (e) => {
    applyWallpaperData(e.detail);
  });

  // Check carrier on startup
  readCarrier();
  setTimeout(readCarrier, 400);
  setTimeout(readCarrier, 1200);

  // Notify content.js that hook is ready
  window.dispatchEvent(new CustomEvent("tv-wallpaper-hook-ready"));
})();
