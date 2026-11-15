# Yesi-WMS Lite — Build, PWA & Tauri Packaging (v1.2)

## Features included in this desktop / web build

| Area | Capability |
|------|------------|
| Daily Manual | 5-step instant fulfillment, Smart group, Quantum route, Neural scan |
| Session | Versioned operator-scoped auto-save, multi-tab awareness |
| Operators | XP / levels in TopBar; awards on assemble & audit |
| Inventory | Oracle forecast + AnomalySentinel panel |
| Batch Pick | Classic path + Quantum route |
| Admin | **User Management** (`/users`) — create / edit / delete / audit logs |
| Login | Title **Yesi-WMS Lite** (no demo credential hint) |
| Web / iOS | PWA + Add to Home Screen |
| Desktop | **Tauri v2** native shell (this document) |

## 1. Web production build

```bash
npm install
npm run build          # → dist/
npm run preview
```

PWA service worker is **enabled** for plain web builds (not for Tauri).

## 2. Tauri v2 desktop packaging

### Scaffold

| Path | Purpose |
|------|---------|
| `src-tauri/tauri.conf.json` | Product **Yesi-WMS Lite** `1.2.0`, id `com.yesi.lite-wms` |
| `src-tauri/Cargo.toml` | Crate `yesi-lite-wms` + shell, dialog, fs, clipboard, log |
| `src-tauri/capabilities/default.json` | Window, dialog save/open, fs, clipboard |
| `src-tauri/icons/` | App icons (synced from web assets) |
| `vite.config.ts` | **PWA plugin disabled** when `TAURI_ENV_*` is set |

### Commands

```bash
npm install
npm run tauri:info     # environment check
npm run tauri:dev      # Vite + native window (all enhanced features)
npm run tauri:build    # production installers
```

`beforeBuildCommand` runs `npm run build` so the **same** frontend (users, neural ops, session, login title) is bundled into the native app.

### Prerequisites

**All platforms**
- Node.js 20+
- Rust 1.77+ via [rustup](https://rustup.rs/)

**Windows**
- Visual Studio 2022 Build Tools (“Desktop development with C++”) **or** MinGW
- `rustup default stable-x86_64-pc-windows-msvc`

**macOS**
- Xcode Command Line Tools

**Linux (Debian/Ubuntu)**
```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
  libayatana-appindicator3-dev patchelf pkg-config
```

### Outputs after `npm run tauri:build`

```text
src-tauri/target/release/bundle/
  msi/ | nsis/     # Windows
  dmg/             # macOS
  deb/ | appimage/ # Linux
```

Window title: **Yesi-WMS Lite**. Install prompt is hidden inside Tauri (already a native app).

## 3. Circular chunk note

React + Recharts + Dexie stay in one `vendor-react` chunk. Independent vendors (pdf, scanner, framer/lucide) are split separately. See `vite.config.ts`.

## 4. iOS mobile (web only)

See `IOS-INSTALL.md`. Tauri mobile is not the primary path for Lite; use Safari PWA for iPhone/iPad.
