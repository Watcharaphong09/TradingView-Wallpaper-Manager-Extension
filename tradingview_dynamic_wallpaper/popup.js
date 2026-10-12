// popup.js — compact popup controller

const btnOpenManager = document.getElementById("btnOpenManager");
const btnRemove      = document.getElementById("btnRemove");
const currentThumb   = document.getElementById("currentThumb");
const currentThumbEmpty = document.getElementById("currentThumbEmpty");
const currentName    = document.getElementById("currentName");
const currentMeta    = document.getElementById("currentMeta");
const recentList     = document.getElementById("recentList");

// --- Helpers ---

function formatRelative(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)   return "just now";
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function renderThumb(container, data, emptyEl) {
  const existingImg = container.querySelector("img");
  if (data) {
    if (emptyEl) emptyEl.hidden = true;
    const img = existingImg || document.createElement("img");
    img.src = data;
    img.alt = "";
    if (!existingImg) container.appendChild(img);
  } else {
    if (existingImg) existingImg.remove();
    if (emptyEl) emptyEl.hidden = false;
  }
}

// --- Render state ---

function renderPopup(stored) {
  const wallpapers = Array.isArray(stored.wallpapers) ? stored.wallpapers : [];
  const activeId   = stored.activeWallpaperId || null;
  const history    = Array.isArray(stored.history) ? stored.history : [];
  const active     = activeId ? wallpapers.find(w => w.id === activeId) : null;

  // Current wallpaper section.
  if (active) {
    renderThumb(currentThumb, active.data, currentThumbEmpty);
    currentName.textContent = active.name || "Untitled";
    currentMeta.textContent = active.lastUsedAt
      ? `Applied ${formatRelative(active.lastUsedAt)}`
      : "Active";
    btnRemove.disabled = false;
  } else {
    renderThumb(currentThumb, null, currentThumbEmpty);
    currentName.textContent = "—";
    currentMeta.textContent = "No wallpaper active";
    btnRemove.disabled = true;
  }

  // Recent list — last 5 history entries (deduplicated by wallpaperId).
  const seen = new Set();
  const recent = history
    .slice()
    .sort((a, b) => b.appliedAt - a.appliedAt)
    .filter(h => {
      if (seen.has(h.wallpaperId)) return false;
      seen.add(h.wallpaperId);
      return true;
    })
    .slice(0, 5);

  recentList.innerHTML = "";

  if (recent.length === 0) {
    recentList.innerHTML = '<div class="empty-recent">No recent wallpapers.</div>';
  } else {
    recent.forEach(h => {
      const wp = wallpapers.find(w => w.id === h.wallpaperId);
      if (!wp) return;

      const item = document.createElement("div");
      item.className = "recent-item";
      item.title = `Apply: ${wp.name}`;

      const thumbDiv = document.createElement("div");
      thumbDiv.className = "recent-thumb";
      if (wp.data) {
        const img = document.createElement("img");
        img.src = wp.data;
        img.alt = "";
        thumbDiv.appendChild(img);
      }

      const info = document.createElement("div");
      info.className = "recent-info";
      info.innerHTML = `
        <div class="recent-name">${escHtml(wp.name || "Untitled")}</div>
        <div class="recent-time">${formatRelative(h.appliedAt)}</div>
      `;

      item.appendChild(thumbDiv);
      item.appendChild(info);

      item.addEventListener("click", () => applyWallpaper(wp.id, stored));
      recentList.appendChild(item);
    });
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Apply wallpaper ---

async function applyWallpaper(wallpaperId, stored) {
  const wallpapers = Array.isArray(stored.wallpapers) ? stored.wallpapers : [];
  const history    = Array.isArray(stored.history)    ? stored.history    : [];

  const wp = wallpapers.find(w => w.id === wallpaperId);
  if (!wp) return;

  const now = Date.now();
  wp.lastUsedAt = now;

  const newEntry = { wallpaperId, appliedAt: now, settings: { ...(wp.settings || {}) } };
  const newHistory = [newEntry, ...history].slice(0, 50);

  await chrome.storage.local.set({
    wallpapers,
    activeWallpaperId: wallpaperId,
    history: newHistory,
  });

  // Re-render with updated state.
  chrome.storage.local.get(["wallpapers", "activeWallpaperId", "history"], renderPopup);
}

// --- Remove wallpaper ---

btnRemove.addEventListener("click", async () => {
  await chrome.storage.local.set({ activeWallpaperId: null });
  chrome.storage.local.get(["wallpapers", "activeWallpaperId", "history"], renderPopup);
});

// --- Open manager in new tab ---

btnOpenManager.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("manager.html") });
});

// --- Initial render ---

chrome.storage.local.get(["wallpapers", "activeWallpaperId", "history"], renderPopup);
