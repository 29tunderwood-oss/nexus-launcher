/**
 * ════════════════════════════════════════════════════════════════
 * NEXUS LAUNCHER — app.js (Polished Edition)
 * ════════════════════════════════════════════════════════════════
 *
 * Classes:
 *  AppDatabase   — IndexedDB wrapper
 *  ZipHandler    — ZIP extraction & virtual filesystem blob-URL builder
 *  Launcher      — Fullscreen iframe overlay
 *  LibraryUI     — Grid/list rendering, search, filter, view toggle
 *  UploadHandler — File-input + drag-and-drop pipeline
 */

'use strict';

/* ════════════════════════════════════════════════════════════════
   1. AppDatabase
   ════════════════════════════════════════════════════════════════ */
class AppDatabase {
  static DB_NAME    = 'NexusLauncherDB';
  static DB_VERSION = 1;
  static STORE      = 'apps';

  constructor() { this.db = null; }

  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(AppDatabase.DB_NAME, AppDatabase.DB_VERSION);
      req.onerror = () => reject(new Error('IndexedDB open failed'));
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(AppDatabase.STORE)) {
          const s = db.createObjectStore(AppDatabase.STORE, { keyPath: 'id', autoIncrement: true });
          s.createIndex('name',      'name',      { unique: false });
          s.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  async saveApp(name, type, files) {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction(AppDatabase.STORE, 'readwrite');
      const req = tx.objectStore(AppDatabase.STORE).add({ name, type, files, timestamp: Date.now() });
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(new Error('Save failed'));
    });
  }

  async getAllApps() {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction(AppDatabase.STORE, 'readonly');
      const req = tx.objectStore(AppDatabase.STORE).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(new Error('GetAll failed'));
    });
  }

  async getApp(id) {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction(AppDatabase.STORE, 'readonly');
      const req = tx.objectStore(AppDatabase.STORE).get(id);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror   = () => reject(new Error('Get failed'));
    });
  }

  async deleteApp(id) {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction(AppDatabase.STORE, 'readwrite');
      const req = tx.objectStore(AppDatabase.STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(new Error('Delete failed'));
    });
  }
}

/* ════════════════════════════════════════════════════════════════
   2. ZipHandler
   ════════════════════════════════════════════════════════════════ */
class ZipHandler {
  static async extractFiles(zipFile) {
    const zip     = await JSZip.loadAsync(zipFile);
    const fileMap = {};
    const promises = [];
    zip.forEach((rel, entry) => {
      if (!entry.dir) {
        const norm = rel.replace(/\\/g, '/');
        promises.push(entry.async('uint8array').then(b => { fileMap[norm] = b; }));
      }
    });
    await Promise.all(promises);
    return fileMap;
  }

  static buildVirtualFS(fileMap, entryPoint) {
    const mimeFor = (p) => ({
      js:'application/javascript',mjs:'application/javascript',css:'text/css',
      html:'text/html',htm:'text/html',json:'application/json',
      png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',
      svg:'image/svg+xml',webp:'image/webp',ico:'image/x-icon',
      mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',
      mp4:'video/mp4',webm:'video/webm',
      woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',
      wasm:'application/wasm',
    }[p.split('.').pop().toLowerCase()] || 'application/octet-stream');

    const blobURLs = {};
    const revList  = [];

    for (const [path, bytes] of Object.entries(fileMap)) {
      if (path === entryPoint) continue;
      const url = URL.createObjectURL(new Blob([bytes], { type: mimeFor(path) }));
      blobURLs[path] = url;
      revList.push(url);
    }

    let html = new TextDecoder('utf-8').decode(fileMap[entryPoint]);
    html = html.replace(/(src|href|url)\s*=\s*["']([^"'#?]+)["']/gi, (match, attr, raw) => {
      const base = entryPoint.includes('/') ? entryPoint.slice(0, entryPoint.lastIndexOf('/') + 1) : '';
      const full = ZipHandler._resolve(base, raw);
      const url  = blobURLs[full] || blobURLs[raw];
      return url ? `${attr}="${url}"` : match;
    });

    const polyfill = `<script>(function(){var __vfs=${JSON.stringify(blobURLs)};function r(u){if(!u||/^(blob:|data:|http)/.test(u))return null;var c=u.replace(/^[./]+/,'');return __vfs[c]||__vfs[u]||null;}var _f=window.fetch;window.fetch=function(res,init){var m=r(typeof res==='string'?res:res.url);return _f.call(this,m||res,init);};var _o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){var m=r(url);arguments[1]=m||url;return _o.apply(this,arguments);};})()\x3c/script>`;
    html = html.replace(/(<head[^>]*>)/i, '$1' + polyfill);

    const htmlUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    revList.push(htmlUrl);
    return { blobUrl: htmlUrl, revoke: () => revList.forEach(URL.revokeObjectURL) };
  }

  static findEntryPoint(fileMap) {
    const paths = Object.keys(fileMap);
    for (const c of ['index.html','index.htm']) {
      if (fileMap[c]) return c;
      const n = paths.find(p => p.endsWith('/'+c));
      if (n) return n;
    }
    return paths.find(p => /\.(html|htm)$/i.test(p)) || null;
  }

  static _resolve(base, rel) {
    if (rel.startsWith('/')) return rel.slice(1);
    return (base + rel).split('/').reduce((a, p) => {
      if (p === '..') a.pop(); else if (p !== '.') a.push(p);
      return a;
    }, []).join('/');
  }
}

/* ════════════════════════════════════════════════════════════════
   3. Launcher
   ════════════════════════════════════════════════════════════════ */
class Launcher {
  constructor() {
    this.$overlay = document.getElementById('launch-overlay');
    this.$frame   = document.getElementById('app-frame');
    this.$bar     = document.getElementById('exit-bar');
    this.$name    = document.getElementById('exit-app-name');
    this.$exitBtn = document.getElementById('exit-btn');
    this._revoke  = null;
    this._timer   = null;

    this.$exitBtn.addEventListener('click', () => this.exit());
    this.$overlay.addEventListener('mousemove',  () => this._resetHide());
    this.$overlay.addEventListener('touchstart', () => this._resetHide(), { passive: true });
  }

  launch(name, url, revoke) {
    this.$name.textContent = name.toUpperCase();
    this._revoke = revoke || null;
    this.$frame.src = url;
    this.$overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    this._resetHide();
  }

  exit() {
    this.$overlay.hidden = true;
    this.$frame.src = 'about:blank';
    if (this._revoke) { this._revoke(); this._revoke = null; }
    clearTimeout(this._timer);
    this.$bar.classList.remove('hidden');
    document.body.style.overflow = '';
  }

  _resetHide() {
    this.$bar.classList.remove('hidden');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.$bar.classList.add('hidden'), 2500);
  }
}

/* ════════════════════════════════════════════════════════════════
   4. LibraryUI
   ════════════════════════════════════════════════════════════════ */
class LibraryUI {
  constructor({ onLaunch, onDelete }) {
    this.$grid      = document.getElementById('app-grid');
    this.$empty     = document.getElementById('empty-state');
    this.$header    = document.getElementById('grid-header');
    this.$noResults = document.getElementById('no-results');
    this.$count     = document.getElementById('app-count');
    this.$badge     = document.getElementById('grid-count-badge');
    this.$search    = document.getElementById('search-input');
    this.$clear     = document.getElementById('search-clear');

    this.onLaunch   = onLaunch;
    this.onDelete   = onDelete;
    this.apps       = [];
    this.filter     = 'all'; // 'all' | 'html' | 'zip'
    this.listMode   = false;

    // Search
    this.$search.addEventListener('input', () => {
      this.$clear.hidden = !this.$search.value;
      this._render();
    });
    this.$clear.addEventListener('click', () => {
      this.$search.value = '';
      this.$clear.hidden = true;
      this._render();
    });

    // Filter pills
    document.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filter = btn.dataset.filter;
        this._render();
      });
    });

    // View toggles
    document.getElementById('view-grid').addEventListener('click', () => this._setView(false));
    document.getElementById('view-list').addEventListener('click', () => this._setView(true));
  }

  _setView(list) {
    this.listMode = list;
    this.$grid.classList.toggle('list-view', list);
    document.getElementById('view-grid').classList.toggle('active', !list);
    document.getElementById('view-list').classList.toggle('active',  list);
  }

  setApps(apps) {
    this.apps = apps;
    this.$count.textContent = `${apps.length} APP${apps.length !== 1 ? 'S' : ''}`;
    this._render();
  }

  _render() {
    const q = this.$search.value.trim().toLowerCase();
    let list = this.apps;

    if (this.filter !== 'all') list = list.filter(a => a.type === this.filter);
    if (q) list = list.filter(a => a.name.toLowerCase().includes(q));

    const hasLibrary = this.apps.length > 0;
    const hasResults = list.length > 0;

    this.$empty.hidden     = hasLibrary;
    this.$header.hidden    = !hasLibrary;
    this.$grid.hidden      = !hasResults || !hasLibrary;
    this.$noResults.hidden = hasResults || !hasLibrary;

    if (!hasResults) { this.$grid.innerHTML = ''; return; }

    const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp);
    this.$badge.textContent = sorted.length;

    this.$grid.innerHTML = sorted.map((app, i) => this._cardHTML(app, i)).join('');

    // Wire events
    this.$grid.querySelectorAll('.card-btn-launch').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); this.onLaunch(Number(btn.dataset.id)); });
    });
    this.$grid.querySelectorAll('.card-btn-delete').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); this.onDelete(Number(btn.dataset.id), btn.dataset.name); });
    });
    this.$grid.querySelectorAll('.card-banner').forEach(el => {
      el.addEventListener('click', () => this.onLaunch(Number(el.closest('.app-card').dataset.id)));
    });
  }

  _cardHTML(app, index) {
    const isZip = app.type === 'zip';
    const typeLabel = isZip ? 'ZIP' : 'HTML';
    const date = new Date(app.timestamp).toLocaleDateString(undefined, { year:'2-digit', month:'short', day:'numeric' });
    const size = LibraryUI._fmtSize(Object.values(app.files).reduce((a,b) => a + b.length, 0));
    const delay = `animation-delay:${index * 0.04}s`;
    const icon = isZip
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"/><rect x="15" y="15" width="4" height="4" rx="1" fill="currentColor" stroke="none" opacity="0.4"/><line x1="17" y1="13" x2="17" y2="15"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/><line x1="9" y1="13" x2="15" y2="13" opacity="0.5"/><line x1="9" y1="17" x2="13" y2="17" opacity="0.5"/></svg>`;

    return `
    <div class="app-card type-${app.type}" data-id="${app.id}" style="${delay}">
      <div class="card-banner">
        <div class="card-banner-grid"></div>
        <div class="card-banner-grad"></div>
        <div class="card-banner-icon">${icon}</div>
        <div class="card-type-badge">
          <span class="badge-dot"></span>${typeLabel}
        </div>
      </div>
      <div class="card-body">
        <div class="card-name" title="${LibraryUI._esc(app.name)}">${LibraryUI._esc(app.name)}</div>
        <div class="card-meta">
          <span>${date}</span>
          <span class="card-meta-sep">·</span>
          <span>${size}</span>
        </div>
      </div>
      <div class="card-action-row">
        <button class="card-btn card-btn-launch" data-id="${app.id}" data-name="${LibraryUI._esc(app.name)}">
          <svg viewBox="0 0 16 16" fill="currentColor"><polygon points="4,2 14,8 4,14"/></svg>
          LAUNCH
        </button>
        <button class="card-btn card-btn-delete" data-id="${app.id}" data-name="${LibraryUI._esc(app.name)}">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><polyline points="3,4 4,14 12,14 13,4"/><line x1="1" y1="4" x2="15" y2="4"/><line x1="6" y1="2" x2="10" y2="2"/></svg>
        </button>
      </div>
    </div>`;
  }

  static _fmtSize(b) {
    if (b < 1024) return b + 'B';
    if (b < 1024*1024) return (b/1024).toFixed(1) + 'KB';
    return (b/(1024*1024)).toFixed(1) + 'MB';
  }
  static _esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

/* ════════════════════════════════════════════════════════════════
   5. UploadHandler
   ════════════════════════════════════════════════════════════════ */
class UploadHandler {
  constructor({ db, onSuccess, onError, onProgress }) {
    this.db = db;
    this.onSuccess  = onSuccess;
    this.onError    = onError;
    this.onProgress = onProgress;

    this.$input = document.getElementById('file-input');
    this.$drop  = document.getElementById('drop-overlay');

    document.getElementById('upload-btn').addEventListener('click',       () => this.$input.click());
    document.getElementById('upload-btn-empty').addEventListener('click', () => this.$input.click());
    this.$input.addEventListener('change', e => { this._handle(e.target.files); });

    this._dc = 0;
    document.addEventListener('dragenter', e => { if(e.dataTransfer?.types.includes('Files')){ this._dc++; this.$drop.hidden=false; }});
    document.addEventListener('dragleave', () => { if(--this._dc <= 0){ this._dc=0; this.$drop.hidden=true; }});
    document.addEventListener('dragover',  e => e.preventDefault());
    document.addEventListener('drop',      e => { e.preventDefault(); this._dc=0; this.$drop.hidden=true; if(e.dataTransfer?.files?.length) this._handle(e.dataTransfer.files); });
  }

  async _handle(files) {
    this.$input.value = '';
    for (const f of files) await this._process(f);
  }

  async _process(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'html' || ext === 'htm') await this._processHTML(file);
    else if (ext === 'zip')              await this._processZIP(file);
    else this.onError(`Unsupported: .${ext} — please upload .html or .zip`);
  }

  async _processHTML(file) {
    try {
      this.onProgress(`Reading ${file.name}`, 35);
      const bytes = await this._bytes(file);
      this.onProgress(`Saving ${file.name}`, 75);
      await this.db.saveApp(file.name, 'html', { 'index.html': bytes });
      this.onProgress(null, 100);
      this.onSuccess(`"${file.name}" added to library`);
    } catch(e) { this.onError(`Failed: ${e.message}`); }
  }

  async _processZIP(file) {
    try {
      this.onProgress(`Extracting ${file.name}`, 25);
      const map   = await ZipHandler.extractFiles(file);
      const entry = ZipHandler.findEntryPoint(map);
      if (!entry) { this.onError(`No HTML entry found in ${file.name}`); return; }
      this.onProgress(`Saving ${file.name}`, 72);
      await this.db.saveApp(file.name.replace(/\.zip$/i,''), 'zip', map);
      this.onProgress(null, 100);
      this.onSuccess(`"${file.name.replace(/\.zip$/i,'')}" added to library`);
    } catch(e) { this.onError(`Failed: ${e.message}`); }
  }

  _bytes(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = () => res(new Uint8Array(r.result));
      r.onerror = () => rej(new Error('Read error'));
      r.readAsArrayBuffer(file);
    });
  }
}

/* ════════════════════════════════════════════════════════════════
   UI HELPERS
   ════════════════════════════════════════════════════════════════ */
const $toast     = document.getElementById('toast');
const $toastIcon = document.getElementById('toast-icon');
const $toastMsg  = document.getElementById('toast-msg');
const $status    = document.getElementById('status-msg');
const $statusLed = document.getElementById('status-led');
let   _toastT    = null;
let   _progEl    = null;

const ICONS = { success: '✓', error: '✕', info: '⬡' };

function showToast(msg, type = 'info', dur = 3200) {
  $toastIcon.textContent = ICONS[type] || '⬡';
  $toastMsg.textContent  = msg;
  $toast.className = `toast ${type} show`;
  clearTimeout(_toastT);
  _toastT = setTimeout(() => $toast.className = 'toast', dur);
}

function setStatus(msg, ok = true) {
  $status.textContent = msg;
  $statusLed.style.background   = ok ? 'var(--c-green)' : 'var(--c-red)';
  $statusLed.style.boxShadow    = ok ? '0 0 6px var(--c-green)' : '0 0 6px var(--c-red)';
}

function setProgress(label, pct) {
  if (label === null) {
    if (_progEl) { _progEl.remove(); _progEl = null; }
    setStatus('READY');
    return;
  }
  if (!_progEl) {
    _progEl = document.createElement('div');
    _progEl.className = 'progress-widget';
    _progEl.innerHTML = `<div class="progress-label"></div><div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>`;
    document.body.appendChild(_progEl);
  }
  _progEl.querySelector('.progress-label').textContent = label;
  _progEl.querySelector('.progress-fill').style.width  = pct + '%';
  setStatus(label.toUpperCase());
}

/* ════════════════════════════════════════════════════════════════
   CONFIRM MODAL
   ════════════════════════════════════════════════════════════════ */
class ConfirmModal {
  constructor() {
    this.$back   = document.getElementById('confirm-modal');
    this.$msg    = document.getElementById('confirm-msg');
    this.$ok     = document.getElementById('confirm-ok');
    this.$cancel = document.getElementById('confirm-cancel');
    this._res    = null;

    this.$ok.addEventListener('click',     () => this._close(true));
    this.$cancel.addEventListener('click', () => this._close(false));
    this.$back.addEventListener('click', e => { if(e.target===this.$back) this._close(false); });
  }
  ask(msg) {
    this.$msg.textContent = msg;
    this.$back.hidden = false;
    return new Promise(r => { this._res = r; });
  }
  _close(v) { this.$back.hidden = true; if(this._res){ this._res(v); this._res=null; } }
}

/* ════════════════════════════════════════════════════════════════
   BOOTSTRAP
   ════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  const db      = new AppDatabase();
  const confirm = new ConfirmModal();
  const launcher = new Launcher();

  try {
    await db.open();
    setStatus('READY');
  } catch(e) {
    showToast('IndexedDB unavailable', 'error', 8000);
    setStatus('STORAGE ERROR', false);
    return;
  }

  const library = new LibraryUI({
    onLaunch: async (id) => {
      try {
        setStatus('LOADING…');
        const app = await db.getApp(id);
        if (!app) { showToast('App not found', 'error'); return; }

        if (app.type === 'html') {
          const blob = new Blob([app.files['index.html']], { type: 'text/html' });
          const url  = URL.createObjectURL(blob);
          launcher.launch(app.name, url, () => URL.revokeObjectURL(url));
        } else {
          const entry = ZipHandler.findEntryPoint(app.files);
          if (!entry) { showToast('No entry point found', 'error'); return; }
          const { blobUrl, revoke } = ZipHandler.buildVirtualFS(app.files, entry);
          launcher.launch(app.name, blobUrl, revoke);
        }
        setStatus(`RUNNING: ${app.name.toUpperCase()}`);
      } catch(e) {
        showToast('Launch failed: ' + e.message, 'error');
        setStatus('ERROR', false);
      }
    },
    onDelete: async (id, name) => {
      const ok = await confirm.ask(`Permanently delete "${name}" from your library?`);
      if (!ok) return;
      try {
        await db.deleteApp(id);
        showToast(`"${name}" removed`, 'info');
        await refresh();
      } catch(e) { showToast('Delete failed', 'error'); }
    },
  });

  new UploadHandler({
    db,
    onSuccess: async (msg) => { showToast(msg, 'success'); setProgress(null, 100); await refresh(); },
    onError:   (msg) => { showToast(msg, 'error', 5000); setProgress(null, 0); setStatus('ERROR', false); },
    onProgress: (l, p) => setProgress(l, p),
  });

  async function refresh() {
    try {
      library.setApps(await db.getAllApps());
      setStatus('READY');
    } catch(e) { showToast('Failed to load library', 'error'); }
  }

  await refresh();
});
