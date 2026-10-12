# TradingView Wallpaper Manager

A Chrome Extension (Manifest V3) that provides a full wallpaper management experience for TradingView chart pages, rendering custom wallpapers directly onto the chart canvas **behind** the candlesticks and indicators.

## Install

1. Open Chrome and visit `chrome://extensions`.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select the `tradingview_dynamic_wallpaper` folder (the inner folder containing `manifest.json`).
5. Open or refresh a TradingView tab, then click the extension icon.

## Use

### Quick Popup
Click the extension icon in Chrome's toolbar.

- **Current wallpaper** — shows which wallpaper is active.
- **Remove** — removes the wallpaper from TradingView immediately.
- **Recent** — list of recently used wallpapers for quick reapply.
- **Open Wallpaper Manager** — opens the full manager in a new tab.

### Full Wallpaper Manager

#### Library
All saved wallpapers in a responsive grid. Each card includes:
- Apply / Settings / Rename / Delete buttons.
- Favorite star to mark important wallpapers.
- Date added and last used date.
- Active badge when currently applied.

Search, sort (recently used / recently added / alphabetical), and filter by favorites.

#### Favorites
Quick access to starred wallpapers.

#### Recent History
Every time you apply a wallpaper, an entry is added here.  
Reapply any previous configuration in one click.  
Removing a history entry does **not** delete the wallpaper itself.

#### Add Wallpaper
Click **+ Add Wallpaper** to open the upload dialog:
- **From Device** — drag-and-drop or file picker (PNG, JPG, WebP).  
  Large images are automatically resized to ≤ 2200 px on the longest side.
- **From URL** — paste a direct `https://` image URL.

Preview before saving. Enter a custom name.

#### Settings (per wallpaper)
Each wallpaper stores its own settings:
- **Opacity** — 5 % to 95 % (recommend 30 % – 50 % for vivid charts).
- **Scaling** — Cover / Contain / Stretch.
- **Horizontal & Vertical position**.
- **Blur** — 0 to 20 px.
- **Visibility toggle** — hide without deleting.

Reset to defaults button. Live preview in the settings panel.

## Architecture

```
manifest.json         — MV3, permissions: storage + tabs
canvas-hook.js        — Runs in MAIN world at document_start. Hooks Canvas 2D fillRect.
content.js            — Runs in ISOLATED world at document_idle. Bridges chrome.storage to canvas hook.
popup.html/js/css     — Compact 300px popup: status, recent, Open Manager button.
manager.html/js/css   — Full-page SPA (extension-hosted). All management UI.
```

**Storage schema** (`chrome.storage.local`):

| Key | Type | Description |
|-----|------|-------------|
| `wallpapers` | `WallpaperRecord[]` | Full library with metadata and settings. |
| `activeWallpaperId` | `string \| null` | ID of the currently applied wallpaper. |
| `history` | `HistoryEntry[]` | Up to 50 recent apply events. |

Image data (data URLs for local files, direct URLs for remote) is stored inside each `WallpaperRecord`.

## Native Canvas Rendering (Behind Candles)

Unlike conventional extensions that place a clumsy semi-transparent HTML overlay over the entire chart (dimming candles and indicators), this extension uses **Native Canvas Injection**:

1. At the start of every render pass, TradingView clears/fills the chart canvas background.
2. The extension's canvas hook injects the wallpaper image directly onto the canvas bitmap immediately following the background fill.
3. TradingView then proceeds to render the grid lines, candlestick wicks & bodies, indicators, drawings, and crosshairs directly on top of the wallpaper.

**Result:** Candlesticks, volume bars, and indicators are 100% crisp and vibrant, floating directly in front of your custom wallpaper with zero dimming or interaction obstruction.

## Privacy

- All wallpaper data stays in your browser's local extension storage.
- No external server receives any images or usage information.
- Remote image URLs are loaded by the browser natively; the extension never proxies or uploads them.
- Only `https://*.tradingview.com/*` is accessed by the content script.
