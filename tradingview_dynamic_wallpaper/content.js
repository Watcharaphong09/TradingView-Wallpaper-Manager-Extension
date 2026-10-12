// content.js — Runs in ISOLATED world at document_idle
// Bridges chrome.storage to canvas-hook.js via memory events and a textContent carrier.

(() => {
  const CARRIER_ID = "tv-wallpaper-shared-carrier";

  // Clean up any legacy overlay elements
  function cleanupOldElements() {
    document.getElementById("tv-wallpaper-overlay")?.remove();
    document.getElementById("tv-live-wallpaper-bg")?.remove();
    document.getElementById("tv-wallpaper-bg-layer")?.remove();
    document.getElementById("tv-gif-pure-layer")?.remove();
  }

  // Ensure canvas-hook.js is injected into MAIN world as fallback
  function ensureHookInjected() {
    if (document.getElementById("tv-wallpaper-script-hook")) return;
    try {
      const script = document.createElement("script");
      script.id = "tv-wallpaper-script-hook";
      script.src = chrome.runtime.getURL("canvas-hook.js");
      (document.head || document.documentElement).appendChild(script);
    } catch {}
  }

  function broadcastWallpaper(wallpaper) {
    cleanupOldElements();

    let carrier = document.getElementById(CARRIER_ID);
    if (!carrier) {
      carrier = document.createElement("div");
      carrier.id = CARRIER_ID;
      carrier.style.display = "none";
      carrier.setAttribute("aria-hidden", "true");
      (document.body || document.documentElement).appendChild(carrier);
    }

    carrier.textContent = wallpaper ? JSON.stringify(wallpaper) : "";

    window.dispatchEvent(
      new CustomEvent("tv-wallpaper-update", {
        detail: wallpaper ? JSON.parse(JSON.stringify(wallpaper)) : null,
      })
    );
  }

  function loadAndDispatch() {
    chrome.storage.local.get(
      ["wallpapers", "activeWallpaperId", "wallpaperData", "wallpaperOpacity"],
      (stored) => {
        const wallpapers = Array.isArray(stored.wallpapers) ? stored.wallpapers : [];
        const activeId   = stored.activeWallpaperId || null;
        const active     = activeId ? wallpapers.find((w) => w.id === activeId) : null;

        if (active && active.data) {
          broadcastWallpaper(active);
        } else if (stored.wallpaperData) {
          broadcastWallpaper({
            data: stored.wallpaperData,
            settings: {
              opacity: typeof stored.wallpaperOpacity === "number" ? stored.wallpaperOpacity : 0.35,
              visible: true,
              size: "cover",
              positionX: "50%",
              positionY: "50%",
              blur: 0,
            },
          });
        } else {
          broadcastWallpaper(null);
        }
      }
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes.wallpapers ||
      changes.activeWallpaperId ||
      changes.wallpaperData ||
      changes.wallpaperOpacity
    ) {
      loadAndDispatch();
    }
  });

  window.addEventListener("tv-wallpaper-hook-ready", loadAndDispatch);

  ensureHookInjected();
  loadAndDispatch();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadAndDispatch);
  }
})();