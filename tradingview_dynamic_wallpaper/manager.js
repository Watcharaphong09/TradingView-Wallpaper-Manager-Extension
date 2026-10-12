// manager.js — TradingView Wallpaper Manager
// All logic for the extension-hosted manager page.

"use strict";

// ─────────────────────────────────────────────
// Storage keys & defaults
// ─────────────────────────────────────────────

const KEYS = {
  WALLPAPERS:  "wallpapers",
  ACTIVE_ID:   "activeWallpaperId",
  HISTORY:     "history",
};

const DEFAULT_SETTINGS = {
  opacity:   0.18,
  size:      "cover",
  positionX: "50%",
  positionY: "50%",
  blur:      0,
  visible:   true,
  blendMode: "normal",
};

const MAX_HISTORY = 50;
const MAX_IMAGE_SIDE = 2200;
const IMAGE_QUALITY  = 0.88;

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────

let state = {
  wallpapers:        [],   // WallpaperRecord[]
  activeWallpaperId: null, // string | null
  history:           [],   // HistoryEntry[]
};

// Transient UI state
let editingWallpaperId = null;  // id of wallpaper in settings modal
let pendingUploadData  = null;  // data URL pending save
let pendingUploadName  = "";
let pendingConfirmCb   = null;
let favFilterActive    = false;

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
      );
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatRelative(ts) {
  if (!ts) return "never";
  const diff  = Date.now() - ts;
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  < 1)  return "just now";
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
}

function sanitiseUrl(raw) {
  try {
    const u = new URL(raw.trim());
    if (!["http:", "https:"].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

// ─────────────────────────────────────────────
// Chrome Storage
// ─────────────────────────────────────────────

function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get([KEYS.WALLPAPERS, KEYS.ACTIVE_ID, KEYS.HISTORY], stored => {
      state.wallpapers        = Array.isArray(stored[KEYS.WALLPAPERS]) ? stored[KEYS.WALLPAPERS] : [];
      state.activeWallpaperId = stored[KEYS.ACTIVE_ID] || null;
      state.history           = Array.isArray(stored[KEYS.HISTORY])    ? stored[KEYS.HISTORY]    : [];
      resolve();
    });
  });
}

function saveState(partial) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(partial, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ─────────────────────────────────────────────
// Toast notifications
// ─────────────────────────────────────────────

const toastContainer = document.getElementById("toastContainer");

function showToast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ─────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────

document.querySelectorAll(".nav-item[data-page]").forEach(btn => {
  btn.addEventListener("click", () => switchPage(btn.dataset.page));
});

function switchPage(pageId) {
  document.querySelectorAll(".nav-item[data-page]").forEach(b => {
    b.classList.toggle("active", b.dataset.page === pageId);
  });
  document.querySelectorAll(".page").forEach(p => {
    p.classList.toggle("active", p.id === `page-${pageId}`);
  });
}

// ─────────────────────────────────────────────
// TradingView tab detection
// ─────────────────────────────────────────────

const tvStatus = document.getElementById("tvStatus");

async function detectTradingViewTab() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://*.tradingview.com/*" });
    const chartTabs = tabs.filter(t => t.url && t.url.includes("/chart"));
    if (chartTabs.length > 0) {
      tvStatus.textContent = "TradingView detected ✓";
      tvStatus.className = "chip success";
    } else if (tabs.length > 0) {
      tvStatus.textContent = "TradingView open (no chart tab)";
      tvStatus.className = "chip info";
    } else {
      tvStatus.textContent = "No TradingView tab open";
      tvStatus.className = "chip";
      tvStatus.style.cssText = "background:rgba(80,80,80,0.15);color:#888;border:1px solid #333;";
    }
  } catch {
    tvStatus.textContent = "Tab detection unavailable";
    tvStatus.className = "chip";
  }
}

// ─────────────────────────────────────────────
// Image resize/compress
// ─────────────────────────────────────────────

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.onload  = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not decode image."));
      img.onload  = () => {
        const scale  = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width  = Math.max(1, Math.round(img.naturalWidth  * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas unavailable."));
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const outType = (file.type === "image/png" && file.size < 2_000_000) ? "image/png" : "image/jpeg";
        resolve(canvas.toDataURL(outType, IMAGE_QUALITY));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.onload  = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────────
// Upload modal
// ─────────────────────────────────────────────

const uploadModal     = document.getElementById("uploadModal");
const uploadPreview   = document.getElementById("uploadPreview");
const uploadPreviewImg = document.getElementById("uploadPreviewImg");
const uploadError     = document.getElementById("uploadError");
const uploadErrorText = document.getElementById("uploadErrorText");
const uploadNameField = document.getElementById("uploadNameField");
const wallpaperNameInput = document.getElementById("wallpaperName");
const btnSaveUpload   = document.getElementById("btnSaveUpload");
const fileInput       = document.getElementById("fileInput");
const dropZone        = document.getElementById("dropZone");
const urlInput        = document.getElementById("urlInput");
const btnLoadUrl      = document.getElementById("btnLoadUrl");

function openUploadModal() {
  pendingUploadData = null;
  pendingUploadName = "";
  uploadPreview.classList.add("hidden");
  uploadPreviewImg.src = "";
  uploadError.classList.add("hidden");
  uploadNameField.classList.add("hidden");
  wallpaperNameInput.value = "";
  urlInput.value = "";
  fileInput.value = "";
  btnSaveUpload.disabled = true;
  // Reset to file tab
  switchUploadTab("file");
  uploadModal.classList.remove("hidden");
}

function switchUploadTab(tabId) {
  document.querySelectorAll(".upload-tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === tabId);
  });
  document.querySelectorAll(".upload-panel").forEach(p => {
    p.classList.toggle("active", p.id === `uploadPanel${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
  });
}

document.querySelectorAll(".upload-tab").forEach(tab => {
  tab.addEventListener("click", () => switchUploadTab(tab.dataset.tab));
});

// File drop zone
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
  e.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFileSelected(file);
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) handleFileSelected(file);
  fileInput.value = "";
});

async function handleFileSelected(file) {
  const allowedTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  if (!allowedTypes.includes(file.type)) {
    showUploadError("Unsupported file type. Please use PNG, JPG, WebP, or GIF.");
    return;
  }

  if (file.size > 20 * 1024 * 1024) {
    showUploadError("File is too large (maximum 20 MB).");
    return;
  }

  showUploadError(null);
  btnSaveUpload.disabled = true;

  try {
    let dataUrl;
    if (file.type === "image/gif") {
      // Preserve animated GIF frames directly without canvas flattening
      dataUrl = await readFileAsDataUrl(file);
    } else {
      dataUrl = await resizeImage(file);
    }
    setUploadPreview(dataUrl, file.name.replace(/\.[^.]+$/, ""));
  } catch (err) {
    showUploadError(err.message || "Could not load image.");
  }
}

// URL loading
btnLoadUrl.addEventListener("click", loadUrlPreview);
urlInput.addEventListener("keydown", e => { if (e.key === "Enter") loadUrlPreview(); });

async function loadUrlPreview() {
  const raw = urlInput.value.trim();
  const url  = sanitiseUrl(raw);
  if (!url) {
    showUploadError("Please enter a valid http:// or https:// URL.");
    return;
  }
  showUploadError(null);
  btnSaveUpload.disabled = true;
  uploadPreview.classList.add("hidden");

  // Test that the image loads — we let the browser handle CORS naturally.
  const img = new Image();
  img.onload  = () => {
    setUploadPreview(url, url.split("/").pop().split("?")[0] || "URL Wallpaper");
  };
  img.onerror = () => {
    showUploadError("Could not load image from URL. Check the URL or CORS policy of the server.");
  };
  img.src = url;
}

function setUploadPreview(dataOrUrl, suggestedName) {
  pendingUploadData = dataOrUrl;
  pendingUploadName = suggestedName || "Wallpaper";
  uploadPreviewImg.src = dataOrUrl;
  uploadPreview.classList.remove("hidden");
  uploadNameField.classList.remove("hidden");
  wallpaperNameInput.value = pendingUploadName;
  btnSaveUpload.disabled = false;
}

function showUploadError(msg) {
  if (msg) {
    uploadErrorText.textContent = msg;
    uploadError.classList.remove("hidden");
  } else {
    uploadError.classList.add("hidden");
  }
}

btnSaveUpload.addEventListener("click", async () => {
  if (!pendingUploadData) return;

  const name = wallpaperNameInput.value.trim() || pendingUploadName || "Wallpaper";

  // Check for duplicate data URL
  const existing = state.wallpapers.find(w => w.data === pendingUploadData);
  if (existing) {
    showToast(`Already in library as "${existing.name}".`, "warn");
    closeModal("uploadModal");
    return;
  }

  const now = Date.now();
  const wp = {
    id:         uuid(),
    name,
    data:       pendingUploadData,
    sourceType: pendingUploadData.startsWith("http") ? "url" : "local",
    sourceUrl:  pendingUploadData.startsWith("http") ? pendingUploadData : null,
    createdAt:  now,
    updatedAt:  now,
    lastUsedAt: null,
    isFavorite: false,
    settings:   { ...DEFAULT_SETTINGS },
  };

  state.wallpapers = [wp, ...state.wallpapers];

  try {
    await saveState({ [KEYS.WALLPAPERS]: state.wallpapers });
    showToast(`"${name}" added to library.`);
    closeModal("uploadModal");
    renderAll();
  } catch (err) {
    showUploadError("Could not save. Storage may be full — try a smaller image.");
  }
});

// ─────────────────────────────────────────────
// Settings modal
// ─────────────────────────────────────────────

const settingsModal  = document.getElementById("settingsModal");
const settingsTitle  = document.getElementById("settingsModalTitle");
const previewImg     = document.getElementById("previewImg");
const ctrlOpacity    = document.getElementById("ctrlOpacity");
const ctrlOpacityVal = document.getElementById("ctrlOpacityVal");
const ctrlPosX       = document.getElementById("ctrlPosX");
const ctrlPosXVal    = document.getElementById("ctrlPosXVal");
const ctrlPosY       = document.getElementById("ctrlPosY");
const ctrlPosYVal    = document.getElementById("ctrlPosYVal");
const ctrlBlur       = document.getElementById("ctrlBlur");
const ctrlBlurVal    = document.getElementById("ctrlBlurVal");
const ctrlVisible    = document.getElementById("ctrlVisible");
const ctrlBlendMode  = document.getElementById("ctrlBlendMode");
const btnApplySettings  = document.getElementById("btnApplySettings");
const btnResetSettings  = document.getElementById("btnResetSettings");

// Build preview fake candles once
(function buildPreviewBars() {
  const bars = document.getElementById("previewBars");
  const heights = [45, 70, 55, 80, 60, 90, 50, 75, 65, 85, 40, 70, 55, 95, 60];
  heights.forEach(h => {
    const bar = document.createElement("div");
    bar.className = "preview-bar";
    bar.style.height = `${h}%`;
    bars.appendChild(bar);
  });
})();

function openSettingsModal(wallpaperId) {
  const wp = state.wallpapers.find(w => w.id === wallpaperId);
  if (!wp) return;

  editingWallpaperId = wallpaperId;
  settingsTitle.textContent = `Settings — ${wp.name}`;

  const s = { ...DEFAULT_SETTINGS, ...(wp.settings || {}) };

  // Populate controls from settings
  ctrlOpacity.value  = Math.round(s.opacity * 100);
  ctrlOpacityVal.textContent = `${ctrlOpacity.value}%`;

  const posXNum = parseInt(s.positionX) || 50;
  const posYNum = parseInt(s.positionY) || 50;
  ctrlPosX.value = posXNum;
  ctrlPosXVal.textContent = `${posXNum}%`;
  ctrlPosY.value = posYNum;
  ctrlPosYVal.textContent = `${posYNum}%`;
  ctrlBlur.value = s.blur || 0;
  ctrlBlurVal.textContent = `${ctrlBlur.value}px`;
  ctrlVisible.checked = s.visible !== false;
  ctrlBlendMode.value = s.blendMode || "normal";

  // Seg buttons
  document.querySelectorAll(".seg-btn[data-size]").forEach(b => {
    b.classList.toggle("active", b.dataset.size === s.size);
  });

  updateSettingsPreview(wp.data, s);
  settingsModal.classList.remove("hidden");
}

function currentSettingsFromControls() {
  const activeSize = document.querySelector(".seg-btn.active[data-size]")?.dataset.size || "cover";
  return {
    opacity:   Number(ctrlOpacity.value) / 100,
    size:      activeSize,
    positionX: `${ctrlPosX.value}%`,
    positionY: `${ctrlPosY.value}%`,
    blur:      Number(ctrlBlur.value),
    visible:   ctrlVisible.checked,
    blendMode: ctrlBlendMode.value || "normal",
  };
}

function updateSettingsPreview(dataOrUrl, settings) {
  const s = settings || currentSettingsFromControls();
  const safe = String(dataOrUrl || "").replace(/["\\\n\r]/g, "");

  Object.assign(previewImg.style, {
    backgroundImage:    safe ? `url("${safe}")` : "none",
    backgroundSize:     s.size === "stretch" ? "100% 100%" : (s.size || "cover"),
    backgroundPosition: `${s.positionX || "50%"} ${s.positionY || "50%"}`,
    backgroundRepeat:   "no-repeat",
    opacity:            s.visible !== false ? String(s.opacity ?? 0.18) : "0",
    mixBlendMode:       s.blendMode || "normal",
    filter:             s.blur > 0 ? `blur(${s.blur}px)` : "",
  });
}

// Live preview updates
ctrlOpacity.addEventListener("input", () => {
  ctrlOpacityVal.textContent = `${ctrlOpacity.value}%`;
  refreshPreviewFromControls();
});
ctrlPosX.addEventListener("input", () => {
  ctrlPosXVal.textContent = `${ctrlPosX.value}%`;
  refreshPreviewFromControls();
});
ctrlPosY.addEventListener("input", () => {
  ctrlPosYVal.textContent = `${ctrlPosY.value}%`;
  refreshPreviewFromControls();
});
ctrlBlur.addEventListener("input", () => {
  ctrlBlurVal.textContent = `${ctrlBlur.value}px`;
  refreshPreviewFromControls();
});
ctrlVisible.addEventListener("change", refreshPreviewFromControls);
ctrlBlendMode.addEventListener("change", refreshPreviewFromControls);

document.querySelectorAll(".seg-btn[data-size]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn[data-size]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    refreshPreviewFromControls();
  });
});

function refreshPreviewFromControls() {
  const wp = state.wallpapers.find(w => w.id === editingWallpaperId);
  if (wp) updateSettingsPreview(wp.data, currentSettingsFromControls());
}

btnResetSettings.addEventListener("click", () => {
  const s = DEFAULT_SETTINGS;
  ctrlOpacity.value = Math.round(s.opacity * 100);
  ctrlOpacityVal.textContent = `${ctrlOpacity.value}%`;
  ctrlPosX.value = 50; ctrlPosXVal.textContent = "50%";
  ctrlPosY.value = 50; ctrlPosYVal.textContent = "50%";
  ctrlBlur.value = 0;  ctrlBlurVal.textContent = "0px";
  ctrlVisible.checked = true;
  ctrlBlendMode.value = "normal";
  document.querySelectorAll(".seg-btn[data-size]").forEach(b => {
    b.classList.toggle("active", b.dataset.size === "cover");
  });
  refreshPreviewFromControls();
});

btnApplySettings.addEventListener("click", async () => {
  const wp = state.wallpapers.find(w => w.id === editingWallpaperId);
  if (!wp) return;

  const newSettings = currentSettingsFromControls();
  wp.settings  = newSettings;
  wp.updatedAt = Date.now();

  // If this wallpaper is currently active, also update activeWallpaperId to trigger content refresh.
  const isActive = state.activeWallpaperId === wp.id;

  const partial = { [KEYS.WALLPAPERS]: state.wallpapers };
  if (isActive) partial[KEYS.ACTIVE_ID] = wp.id; // triggers storage.onChanged in content.js

  try {
    await saveState(partial);
    showToast("Settings saved and applied.");
    closeModal("settingsModal");
    renderAll();
  } catch {
    showToast("Could not save settings.", "error");
  }
});

// ─────────────────────────────────────────────
// Apply wallpaper
// ─────────────────────────────────────────────

async function applyWallpaper(wallpaperId) {
  const wp = state.wallpapers.find(w => w.id === wallpaperId);
  if (!wp) return;

  const now = Date.now();
  wp.lastUsedAt = now;
  wp.updatedAt  = now;
  state.activeWallpaperId = wallpaperId;

  const entry = {
    wallpaperId,
    appliedAt: now,
    settings: { ...(wp.settings || {}) },
  };
  state.history = [entry, ...state.history].slice(0, MAX_HISTORY);

  try {
    await saveState({
      [KEYS.WALLPAPERS]: state.wallpapers,
      [KEYS.ACTIVE_ID]:  wallpaperId,
      [KEYS.HISTORY]:    state.history,
    });
    showToast(`"${wp.name}" applied.`);
    renderAll();
  } catch {
    showToast("Could not apply wallpaper.", "error");
  }
}

// ─────────────────────────────────────────────
// Remove active wallpaper
// ─────────────────────────────────────────────

async function removeActiveWallpaper() {
  state.activeWallpaperId = null;
  try {
    await saveState({ [KEYS.ACTIVE_ID]: null });
    showToast("Wallpaper removed from TradingView.");
    renderAll();
  } catch {
    showToast("Could not remove wallpaper.", "error");
  }
}

// ─────────────────────────────────────────────
// Delete wallpaper from library
// ─────────────────────────────────────────────

function confirmDelete(wallpaperId) {
  const wp = state.wallpapers.find(w => w.id === wallpaperId);
  if (!wp) return;

  document.getElementById("confirmModalText").textContent =
    `Delete "${wp.name}" from the library? This cannot be undone.`;
  document.getElementById("btnConfirmOk").textContent = "Delete";

  pendingConfirmCb = async () => {
    state.wallpapers = state.wallpapers.filter(w => w.id !== wallpaperId);
    if (state.activeWallpaperId === wallpaperId) state.activeWallpaperId = null;

    const partial = { [KEYS.WALLPAPERS]: state.wallpapers };
    if (state.activeWallpaperId === null) partial[KEYS.ACTIVE_ID] = null;

    try {
      await saveState(partial);
      showToast(`"${wp.name}" deleted.`);
      renderAll();
    } catch {
      showToast("Could not delete wallpaper.", "error");
    }
  };

  document.getElementById("confirmModal").classList.remove("hidden");
}

document.getElementById("btnConfirmOk").addEventListener("click", () => {
  if (pendingConfirmCb) {
    pendingConfirmCb();
    pendingConfirmCb = null;
  }
  closeModal("confirmModal");
});

// ─────────────────────────────────────────────
// Toggle favorite
// ─────────────────────────────────────────────

async function toggleFavorite(wallpaperId) {
  const wp = state.wallpapers.find(w => w.id === wallpaperId);
  if (!wp) return;
  wp.isFavorite = !wp.isFavorite;
  wp.updatedAt  = Date.now();
  try {
    await saveState({ [KEYS.WALLPAPERS]: state.wallpapers });
    renderAll();
  } catch {
    showToast("Could not update favorite.", "error");
  }
}

// ─────────────────────────────────────────────
// Rename wallpaper (inline)
// ─────────────────────────────────────────────

function startRename(wallpaperId, nameEl) {
  const wp = state.wallpapers.find(w => w.id === wallpaperId);
  if (!wp) return;

  const input = document.createElement("input");
  input.type      = "text";
  input.className = "rename-input";
  input.value     = wp.name;
  input.maxLength = 80;

  const original = nameEl.textContent;
  nameEl.textContent = "";
  nameEl.appendChild(input);
  input.focus();
  input.select();

  async function commit() {
    const trimmed = input.value.trim();
    nameEl.textContent = trimmed || original;
    if (trimmed && trimmed !== wp.name) {
      wp.name = trimmed;
      wp.updatedAt = Date.now();
      try {
        await saveState({ [KEYS.WALLPAPERS]: state.wallpapers });
        showToast("Renamed.");
        renderAll();
      } catch {
        showToast("Could not rename.", "error");
      }
    }
  }

  input.addEventListener("blur",  commit);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    if (e.key === "Escape") { nameEl.textContent = original; }
  });
}

// ─────────────────────────────────────────────
// Render helpers
// ─────────────────────────────────────────────

function buildWpCard(wp, isActive) {
  const card = document.createElement("div");
  card.className = `wp-card${isActive ? " active" : ""}`;
  card.dataset.id = wp.id;

  const thumb = document.createElement("div");
  thumb.className = "wp-thumb";

  if (wp.data) {
    const img = document.createElement("img");
    img.src     = wp.data;
    img.alt     = "";
    img.loading = "lazy";
    thumb.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "wp-thumb-placeholder";
    ph.textContent = "🖼";
    thumb.appendChild(ph);
  }

  if (isActive) {
    const badge = document.createElement("div");
    badge.className = "wp-active-badge";
    badge.textContent = "ACTIVE";
    thumb.appendChild(badge);
  }

  const favBtn = document.createElement("button");
  favBtn.className = `wp-fav-btn${wp.isFavorite ? " is-fav" : ""}`;
  favBtn.title    = wp.isFavorite ? "Remove from favorites" : "Add to favorites";
  favBtn.setAttribute("aria-label", favBtn.title);
  favBtn.textContent = "★";
  favBtn.addEventListener("click", e => { e.stopPropagation(); toggleFavorite(wp.id); });
  thumb.appendChild(favBtn);

  const info = document.createElement("div");
  info.className = "wp-info";

  const nameEl = document.createElement("div");
  nameEl.className = "wp-name";
  nameEl.textContent = wp.name || "Untitled";

  const meta = document.createElement("div");
  meta.className = "wp-meta";
  meta.innerHTML = `
    <span>Added ${formatDate(wp.createdAt)}</span>
    ${wp.lastUsedAt ? `<span>Used ${formatRelative(wp.lastUsedAt)}</span>` : ""}
  `;

  info.appendChild(nameEl);
  info.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "wp-actions";

  // Apply button
  const applyBtn = document.createElement("button");
  applyBtn.className = "btn-primary btn-sm";
  applyBtn.textContent = isActive ? "✓ Active" : "Apply";
  applyBtn.disabled = isActive;
  applyBtn.addEventListener("click", () => applyWallpaper(wp.id));

  // Settings button
  const settingsBtn = document.createElement("button");
  settingsBtn.className = "btn-secondary btn-sm btn-icon";
  settingsBtn.title = "Edit Settings";
  settingsBtn.setAttribute("aria-label", "Edit settings");
  settingsBtn.textContent = "⚙";
  settingsBtn.addEventListener("click", () => openSettingsModal(wp.id));

  // Rename button
  const renameBtn = document.createElement("button");
  renameBtn.className = "btn-secondary btn-sm btn-icon";
  renameBtn.title = "Rename";
  renameBtn.setAttribute("aria-label", "Rename");
  renameBtn.textContent = "✎";
  renameBtn.addEventListener("click", () => startRename(wp.id, nameEl));

  // Delete button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "btn-danger btn-sm btn-icon";
  deleteBtn.title = "Delete";
  deleteBtn.setAttribute("aria-label", "Delete wallpaper");
  deleteBtn.textContent = "🗑";
  deleteBtn.addEventListener("click", () => confirmDelete(wp.id));

  actions.appendChild(applyBtn);
  actions.appendChild(settingsBtn);
  actions.appendChild(renameBtn);
  actions.appendChild(deleteBtn);

  card.appendChild(thumb);
  card.appendChild(info);
  card.appendChild(actions);
  return card;
}

function getSortedWallpapers(wallpapers, sortKey, query, favOnly) {
  let list = wallpapers.slice();

  if (favOnly) list = list.filter(w => w.isFavorite);

  if (query) {
    const q = query.toLowerCase();
    list = list.filter(w => (w.name || "").toLowerCase().includes(q));
  }

  if (sortKey === "lastUsed") {
    list.sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
  } else if (sortKey === "createdAt") {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } else if (sortKey === "name") {
    list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  return list;
}

// ─────────────────────────────────────────────
// Render all pages
// ─────────────────────────────────────────────

function renderAll() {
  renderSidebar();
  renderLibrary();
  renderFavorites();
  renderHistory();
  updateBadges();
}

function renderSidebar() {
  const active = state.wallpapers.find(w => w.id === state.activeWallpaperId);
  const awmThumb = document.getElementById("awmThumb");
  const awmName  = document.getElementById("awmName");

  awmThumb.innerHTML = "";
  if (active && active.data) {
    const img = document.createElement("img");
    img.src = active.data;
    img.alt = "";
    awmThumb.appendChild(img);
    awmName.textContent = active.name || "Untitled";
    awmName.className = "awm-name";
  } else {
    awmName.textContent = "None";
    awmName.className = "awm-none";
  }
}

function renderLibrary() {
  const grid      = document.getElementById("libraryGrid");
  const emptyDiv  = document.getElementById("libraryEmpty");
  const query     = document.getElementById("searchInput").value.trim();
  const sortKey   = document.getElementById("sortSelect").value;

  const list = getSortedWallpapers(state.wallpapers, sortKey, query, favFilterActive);

  grid.innerHTML = "";

  if (list.length === 0) {
    grid.classList.add("hidden");
    emptyDiv.classList.remove("hidden");
  } else {
    grid.classList.remove("hidden");
    emptyDiv.classList.add("hidden");
    list.forEach(wp => {
      grid.appendChild(buildWpCard(wp, wp.id === state.activeWallpaperId));
    });
  }
}

function renderFavorites() {
  const grid     = document.getElementById("favGrid");
  const emptyDiv = document.getElementById("favEmpty");
  const favs     = state.wallpapers.filter(w => w.isFavorite);

  grid.innerHTML = "";

  if (favs.length === 0) {
    grid.classList.add("hidden");
    emptyDiv.classList.remove("hidden");
  } else {
    grid.classList.remove("hidden");
    emptyDiv.classList.add("hidden");
    favs.forEach(wp => {
      grid.appendChild(buildWpCard(wp, wp.id === state.activeWallpaperId));
    });
  }
}

function renderHistory() {
  const list     = document.getElementById("historyList");
  const emptyDiv = document.getElementById("historyEmpty");

  list.innerHTML = "";

  if (state.history.length === 0) {
    list.classList.add("hidden");
    emptyDiv.classList.remove("hidden");
    return;
  }

  list.classList.remove("hidden");
  emptyDiv.classList.add("hidden");

  state.history.forEach((entry, idx) => {
    const wp = state.wallpapers.find(w => w.id === entry.wallpaperId);

    const item = document.createElement("div");
    item.className = "history-item";

    const thumb = document.createElement("div");
    thumb.className = "history-thumb";
    if (wp && wp.data) {
      const img = document.createElement("img");
      img.src = wp.data; img.alt = "";
      thumb.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "history-info";
    info.innerHTML = `
      <div class="history-name">${escHtml(wp ? wp.name : "(deleted wallpaper)")}</div>
      <div class="history-meta">Applied ${formatDate(entry.appliedAt)} at ${new Date(entry.appliedAt).toLocaleTimeString()}</div>
    `;

    const acts = document.createElement("div");
    acts.className = "history-actions";

    if (wp) {
      const reapplyBtn = document.createElement("button");
      reapplyBtn.className = "btn-secondary btn-sm";
      reapplyBtn.textContent = "Reapply";
      reapplyBtn.addEventListener("click", () => applyWallpaper(wp.id));
      acts.appendChild(reapplyBtn);
    }

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-ghost btn-sm btn-icon";
    removeBtn.title = "Remove from history";
    removeBtn.setAttribute("aria-label", "Remove from history");
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", async () => {
      state.history.splice(idx, 1);
      try {
        await saveState({ [KEYS.HISTORY]: state.history });
        renderHistory();
      } catch {
        showToast("Could not update history.", "error");
      }
    });
    acts.appendChild(removeBtn);

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(acts);
    list.appendChild(item);
  });
}

function updateBadges() {
  const favCount = state.wallpapers.filter(w => w.isFavorite).length;
  const libCount = state.wallpapers.length;

  const libBadge = document.getElementById("libraryBadge");
  const favBadge = document.getElementById("favBadge");

  libBadge.textContent = String(libCount);
  libBadge.classList.toggle("hidden", libCount === 0);

  favBadge.textContent = String(favCount);
  favBadge.classList.toggle("hidden", favCount === 0);
}

// ─────────────────────────────────────────────
// Toolbar event wiring
// ─────────────────────────────────────────────

document.getElementById("searchInput").addEventListener("input", renderLibrary);
document.getElementById("sortSelect").addEventListener("change", renderLibrary);

document.getElementById("btnFilterFav").addEventListener("click", function() {
  favFilterActive = !favFilterActive;
  this.dataset.active = String(favFilterActive);
  this.style.background = favFilterActive ? "rgba(59,111,224,0.2)" : "";
  this.style.borderColor = favFilterActive ? "var(--accent)" : "";
  this.style.color = favFilterActive ? "#7aabff" : "";
  renderLibrary();
});

// Clear history
document.getElementById("btnClearHistory").addEventListener("click", () => {
  document.getElementById("confirmModalText").textContent =
    "Clear all recent history? This does not delete any wallpapers.";
  document.getElementById("btnConfirmOk").textContent = "Clear";

  pendingConfirmCb = async () => {
    state.history = [];
    try {
      await saveState({ [KEYS.HISTORY]: [] });
      showToast("History cleared.");
      renderHistory();
    } catch {
      showToast("Could not clear history.", "error");
    }
  };
  document.getElementById("confirmModal").classList.remove("hidden");
});

// ─────────────────────────────────────────────
// Modal management
// ─────────────────────────────────────────────

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.add("hidden");
}

// Buttons that close modals via data-close attribute
document.querySelectorAll("[data-close]").forEach(btn => {
  btn.addEventListener("click", () => closeModal(btn.dataset.close));
});

// Click outside modal to close
document.querySelectorAll(".modal-backdrop").forEach(backdrop => {
  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) {
      backdrop.classList.add("hidden");
    }
  });
});

// Upload modal triggers
document.getElementById("btnUploadTop").addEventListener("click", openUploadModal);
document.getElementById("btnUploadEmpty")?.addEventListener("click", openUploadModal);

// ─────────────────────────────────────────────
// Migrate legacy storage (v1 → v2)
// ─────────────────────────────────────────────

async function migrateLegacy() {
  return new Promise(resolve => {
    chrome.storage.local.get(["wallpaperData", "wallpaperOpacity", "wallpaperLabel"], async stored => {
      if (!stored.wallpaperData) return resolve();

      const alreadyMigrated = state.wallpapers.some(w => w.sourceType === "legacy");
      if (alreadyMigrated) return resolve();

      const now = Date.now();
      const wp = {
        id:         uuid(),
        name:       stored.wallpaperLabel || "Imported Wallpaper",
        data:       stored.wallpaperData,
        sourceType: "legacy",
        sourceUrl:  stored.wallpaperData.startsWith("http") ? stored.wallpaperData : null,
        createdAt:  now,
        updatedAt:  now,
        lastUsedAt: now,
        isFavorite: false,
        settings: {
          ...DEFAULT_SETTINGS,
          opacity: typeof stored.wallpaperOpacity === "number"
            ? stored.wallpaperOpacity
            : 0.18,
        },
      };

      state.wallpapers = [wp, ...state.wallpapers];
      state.activeWallpaperId = wp.id;

      await saveState({
        [KEYS.WALLPAPERS]: state.wallpapers,
        [KEYS.ACTIVE_ID]:  wp.id,
      });

      // Clean up old keys
      chrome.storage.local.remove(["wallpaperData", "wallpaperOpacity", "wallpaperLabel"]);
      showToast("Previous wallpaper imported from old version.", "info");
      resolve();
    });
  });
}

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────

async function init() {
  await loadState();
  await migrateLegacy();
  renderAll();
  detectTradingViewTab();
}

init();
