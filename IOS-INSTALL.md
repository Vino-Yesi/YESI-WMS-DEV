# YESI Lite WMS — Install & run on iPhone / iPad

YESI Lite is a **Progressive Web App (PWA)**. On iOS it installs from **Safari** to the Home Screen and runs fullscreen offline (IndexedDB + service worker). No App Store build required.

## Requirements

| Item | Detail |
|------|--------|
| Browser | **Safari** (Chrome/Firefox on iOS cannot install PWAs) |
| Network | First load over **HTTPS** (or `localhost` for development) |
| iOS | iOS 16.4+ recommended for fuller Web App support |
| Device | iPhone or iPad |

## Production install (operators)

1. Deploy the production build to HTTPS, e.g.:
   ```bash
   npm run build
   # serve dist/ via Netlify, Vercel, nginx, Cloudflare Pages, etc.
   ```
2. On the iPhone/iPad open the site **in Safari**.
3. Tap **Share** → **Add to Home Screen** → **Add**.
4. Open **YESI Lite** from the home screen (standalone, no Safari chrome).

The in-app banner also explains these steps the first time you visit on iOS.

## Local development on a physical iPhone

Your phone and PC must be on the same Wi‑Fi.

```bash
# On the PC (bind to LAN)
npm run dev -- --host 0.0.0.0
```

Note the machine LAN IP (e.g. `192.168.1.42:3000`). On the iPhone, open:

```text
http://192.168.1.42:3000
```

**Note:** iOS only allows *Add to Home Screen* with full offline SW reliability on **HTTPS**. For true install testing:

- Use a tunnel (`npx cloudflared tunnel --url http://localhost:3000`), or
- Deploy `dist/` to any HTTPS host, or
- Use a trusted local cert (advanced).

## What works offline after install

- App shell (HTML/JS/CSS) via service worker
- Inventory, sessions, operator XP, postings in **IndexedDB**
- Camera barcode scan (permission required once)
- Daily Manual wave resume after refresh

Large sample PDFs may still need network on first fetch.

## Capabilities & limits on iOS

| Feature | iOS PWA |
|---------|---------|
| Home Screen icon | Yes (apple-touch-icon) |
| Standalone fullscreen | Yes |
| Offline shell | Yes (service worker) |
| IndexedDB | Yes |
| Camera / barcode | Yes (user permission) |
| Push notifications | Limited / version-dependent |
| Background sync | Limited |
| File system access | Limited vs desktop |

For a fully native App Store binary, use the existing **Tauri** desktop path or a future Capacitor wrap (requires Mac + Xcode). The PWA path is the supported mobile install for Lite.

## Troubleshooting

- **No “Add to Home Screen”** — use Safari, not an in-app browser; reload once.
- **Icon looks generic** — hard-refresh, re-add; ensure `apple-touch-icon.png` is reachable.
- **White flash on open** — theme-color / background are set to `#0a0a0a`.
- **Content under notch** — app uses `viewport-fit=cover` + safe-area insets.
- **Data missing after reinstall** — IndexedDB is origin-scoped; clearing site data wipes local warehouse state.

## Build commands

```bash
npm install
npm run build          # → dist/ (PWA + service worker)
npm run preview        # local preview of production build
```

Deploy the entire `dist/` folder to HTTPS. Operators then install from Safari as above.
