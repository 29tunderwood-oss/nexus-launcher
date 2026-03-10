# NEXUS LAUNCHER — Documentation

A client-side HTML application launcher inspired by Dolphin Emulator. Upload, persist,
and launch HTML apps and ZIP-packaged web projects entirely from the browser — no backend required.

---

## File Structure

```
nexus-launcher/
├── index.html    — Main launcher UI (structure & markup)
├── style.css     — Retro-futuristic theme, layout, animations
├── app.js        — All application logic (DB, upload, ZIP, launching)
└── README.md     — This file
```

---

## Hosting on Render (Static Site)

1. Push the three files (`index.html`, `style.css`, `app.js`) to a GitHub repository.

2. Log in to [https://render.com](https://render.com) and click **New → Static Site**.

3. Connect your GitHub repository.

4. Configure the build:
   - **Build Command**: *(leave empty — no build step needed)*
   - **Publish Directory**: `.` (the root of the repo)

5. Click **Create Static Site**. Render will deploy immediately.

6. Open the live URL — the launcher runs 100% in the browser.

> **No server, no database, no build tools required.** Everything is vanilla HTML/CSS/JS.

---

## How It Works — Architecture Deep Dive

### Storage: IndexedDB

IndexedDB is a transactional, key-value object store built into every modern browser.
Unlike `localStorage` (which is limited to ~5 MB of strings), IndexedDB can store
binary data (Uint8Array) with no practical size cap beyond available disk space.

**Schema:**
```
Database:  NexusLauncherDB  (version 1)
Store:     apps
  id         — auto-increment integer (primary key)
  name       — display name string
  type       — 'html' or 'zip'
  files      — Object<path: string, bytes: Uint8Array>
  timestamp  — Unix ms (used for "newest first" sort)
```

Each uploaded app is stored as **one record**. The `files` map holds all the
file contents as raw bytes, making it binary-safe and preserving full fidelity.

### Upload Pipeline

**Single HTML file:**
1. FileReader reads the file as an ArrayBuffer.
2. Converted to `Uint8Array` and stored under the key `'index.html'`.
3. The record is saved to IndexedDB.

**ZIP archive:**
1. JSZip (loaded from CDN) asynchronously extracts all entries.
2. Each file is converted to `Uint8Array` and added to a `fileMap`.
3. An entry-point search (`index.html → index.htm → first .html`) identifies
   the root HTML file.
4. The entire `fileMap` is stored as one DB record.

### App Launching

**HTML app:**
```
StoredBytes → new Blob([bytes], { type: 'text/html' })
           → URL.createObjectURL(blob)
           → iframe.src = blobURL
```
The Blob URL (`blob:null/...`) is a short-lived in-memory URL. It's revoked
automatically when the user exits the app.

**ZIP app (Virtual Filesystem):**
1. A Blob URL is created for **every** asset (JS, CSS, images, fonts, WASM…).
2. The index.html text is parsed and all `src=`, `href=`, `url()` references
   replaced with the corresponding Blob URLs using a regex replacer.
3. A polyfill `<script>` is injected into `<head>` that patches `window.fetch`
   and `XMLHttpRequest.prototype.open` so **dynamic** asset loads (e.g. game
   engine lazy-loading chunks) also resolve from the blob map.
4. The patched HTML is turned into a final Blob URL and loaded in the iframe.

### Save Data Compatibility

The iframe runs with `sandbox="allow-scripts allow-same-origin allow-forms …"`.
The `allow-same-origin` flag means the app inside the iframe shares the host
origin (`https://your-site.onrender.com`), so:

- `localStorage` **works** (same origin, persists across reloads).
- `IndexedDB` **works** (same origin).
- Cookies **work**.

This means games like **Eaglercraft** that store worlds in `localStorage` or
`IndexedDB` will save and restore their data correctly.

> ⚠️ If you host two apps that both use `localStorage` they share the same
> origin namespace. This is fine for most games but worth noting.

### Memory Management

All Blob URLs created for a launch session are tracked in an array.
When the user clicks **EXIT**, the `revoke()` function runs
`URL.revokeObjectURL(url)` for each, returning the memory to the browser
immediately. This prevents memory leaks even when launching many apps in a session.

---

## Features

| Feature | Status |
|---|---|
| Upload `.html` single-file apps | ✅ |
| Upload `.zip` multi-file projects | ✅ |
| Drag-and-drop upload | ✅ |
| IndexedDB persistence across reloads | ✅ |
| Fullscreen iframe launch (100vw × 100vh) | ✅ |
| No margins / black bars | ✅ |
| Auto-hiding exit button | ✅ |
| Delete app from library | ✅ |
| Search / filter library | ✅ |
| localStorage / IndexedDB in launched apps | ✅ |
| Dynamic asset loading polyfill (ZIP) | ✅ |
| Upload progress indicator | ✅ |
| Responsive mobile layout | ✅ |

---

## Optional Improvements for Scale

### Many apps (50+)
- Add **pagination** or **virtual scrolling** (e.g. with `IntersectionObserver`)
  instead of rendering all cards at once.
- Store only **metadata** in the initial `getAll()` query; fetch file bytes
  only when launching (add a separate `metadata` index store).

### Large apps (100 MB+ ZIPs)
- Use a **Web Worker** for ZIP extraction to keep the UI responsive.
- Stream extraction with JSZip's `generateAsync` with progress callbacks.

### App Organisation
- Add **tags / categories** to the DB schema and render filter pills.
- Allow custom **thumbnail images** (stored as small base64 PNGs).
- Add a **rename** feature (update the `name` field in place).

### Service Worker (advanced)
- A Service Worker can intercept all fetch requests, eliminating the need for
  the injected polyfill. It also enables true offline-first caching.
- Downside: requires HTTPS (already satisfied on Render) and added complexity.

### Multi-tab / Import / Export
- Export your entire library as a `.json` blob (base64 encoded files) for
  backup or transfer between machines.
- Import the same JSON to re-hydrate the IndexedDB on another device.

---

## Browser Support

| Browser | Support |
|---|---|
| Chrome / Edge 80+ | ✅ Full |
| Firefox 75+ | ✅ Full |
| Safari 14+ | ✅ Full |
| Mobile Chrome / Safari | ✅ Supported |

Requirements: `IndexedDB`, `Blob`, `URL.createObjectURL`, `fetch`.
All are baseline-supported in any browser released after 2020.
