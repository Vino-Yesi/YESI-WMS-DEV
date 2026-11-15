# YESI Lite WMS — Windows install (safe fixes)

## 1. Install dependencies

```bat
cd C:\Users\user\Downloads\ninwms\without\WMS-Lite
npm install
```

Deprecation warnings for `glob` / `recharts` are **harmless** (transitive). You can ignore them.

## 2. Safe fix: blocked install-scripts (esbuild + core-js)

npm 11 may block postinstall scripts. **esbuild must run** or Vite will fail.

```bat
npm install-scripts approve esbuild
npm install-scripts approve core-js
npm rebuild esbuild
npm rebuild core-js
```

If `install-scripts` is unavailable on your npm version:

```bat
npm config set ignore-scripts false
npm rebuild esbuild core-js
```

## 3. High severity vulnerability (`xlsx` / SheetJS)

```bat
npm audit
```

Typical report: **Prototype Pollution / ReDoS in `xlsx`** — **no fixed release** on the public `xlsx` package.

**Safe stance for this app:**
- Only open **local** posting / audit files you trust (not arbitrary internet files).
- Do **not** run `npm audit fix --force` (can break the app with major upgrades).
- Optional later: migrate readers to ExcelJS (separate task).

```bat
REM Safe: only apply non-breaking fixes if any exist
npm audit fix
```

If audit still shows 1 high on `xlsx`, that is expected until a library migration.

## 4. Start the app

```bat
npm run dev
```

Open http://localhost:3000 (or the port Vite prints).

Login: `admin` / `admin` (or `operator` / `operator`).

## 5. Optional cleanup if install is corrupted

```bat
taskkill /F /IM node.exe
rmdir /s /q node_modules
del package-lock.json
npm cache clean --force
npm install
npm install-scripts approve esbuild
npm install-scripts approve core-js
npm rebuild esbuild
npm run dev
```

## Do not

- `npm audit fix --force` without a backup
- Mix Chinese mirrors (`npmmirror`) with `registry.npmjs.org` lockfiles
- Leave `ignore-scripts=true` permanently (breaks esbuild)
