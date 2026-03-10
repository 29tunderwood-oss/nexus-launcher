/**
 * ════════════════════════════════════════════════════════════════
 * NEXUS LAUNCHER — app.js
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

/* ════════════════════════════════════════════════════════════════
   1. AppDatabase — IndexedDB wrapper
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
          const s = db.createObjectStore(AppDatabase.STORE, {
            keyPath: 'id', autoIncrement: true,
          });
          s.createIndex('name',      'name',      { unique: false });
          s.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  async saveApp(name, type, files) {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction(AppDatabase.STORE, 'readwrite');
      const req = tx.objectStore(AppDatabase.STORE).add({
        name, type, files, timestamp: Date.now(),
      });
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(new Error('Save failed: ' + req.error));
    });
  }

  async getAllApps() {
    return new Promise((resolve, reject) => {
      const tx  = this.db.transaction(AppDatabase.STORE, 'readonly');
      const req = tx.objectStore(AppDatabase.STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
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
   2. ZipHandler — ZIP extraction & virtual filesystem
   ════════════════════════════════════════════════════════════════ */
class ZipHandler {
  /** Extract all files from a ZIP into a { path: Uint8Array } map */
  static async extractFiles(zipFile) {
    const zip      = await JSZip.loadAsync(zipFile);
    const fileMap  = {};
    const promises = [];
    zip.forEach((rel, entry) => {
      if (!entry.dir) {
        const norm = rel.replace(/\\/g, '/');
        promises.push(
          entry.async('uint8array').then(b => { fileMap[norm] = b; })
        );
      }
    });
    await Promise.all(promises);
    return fileMap;
  }

  /**
   * Build a virtual filesystem from a stored file-map.
   * Creates Blob URLs for all assets and patches index.html
   * to reference them, plus injects a fetch/XHR polyfill.
   */
  static buildVirtualFS(fileMap, entryPoint) {
    const mimeFor = (p) => {
      const ext = p.split('.').pop().toLowerCase();
      return ({
        js: 'application/javascript', mjs: 'application/javascript',
        css: 'text/css',
        html: 'text/html', htm: 'text/html',
        json: 'application/json',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
        ico: 'image/x-icon',
        mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
        mp4: 'video/mp4', webm: 'video/webm',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
        wasm: 'application/wasm',
      })[ext] || 'application/octet-stream';
    };

    const blobURLs = {};
    const revList  = [];

    /* Create a Blob URL for every non-HTML asset */
    for (const [path, bytes] of Object.entries(fileMap)) {
      if (path === entryPoint) continue;
      const url = URL.createObjectURL(
        new Blob([bytes], { type: mimeFor(path) })
      );
      blobURLs[path] = url;
      revList.push(url);
    }

    /* Patch index.html — replace relative src/href/url() references */
    let html = new TextDecoder('utf-8').decode(fileMap[entryPoint]);
    const basedir = entryPoint.includes('/')
      ? entryPoint.slice(0, entryPoint.lastIndexOf('/') + 1)
      : '';

    html = html.replace(
      /(src|href)\s*=\s*["']([^"'#?:][^"']*?)["']/gi,
      (match, attr, raw) => {
        const full = ZipHandler._resolve(basedir, raw);
        const url  = blobURLs[full] || blobURLs[raw];
        return url ? `${attr}="${url}"` : match;
      }
    );
    /* Also replace CSS url() references */
    html = html.replace(
      /url\(\s*['"]?([^'")(]+?)['"]?\s*\)/gi,
      (match, raw) => {
        const full = ZipHandler._resolve(basedir, raw);
        const url  = blobURLs[full] || blobURLs[raw];
        return url ? `url("${url}")` : match;
      }
    );

    /* Inject fetch/XHR polyfill so dynamic asset loads also resolve */
    const polyfill = `<script>
(function(){
  var __vfs = ${JSON.stringify(blobURLs)};
  function vfsResolve(u) {
    if (!u || /^(blob:|data:|https?:|\/\/)/.test(u)) return null;
    var c = u.replace(/^[./]+/, '');
    return __vfs[c] || __vfs[u] || null;
  }
  var _fetch = window.fetch;
  window.fetch = function(res, init) {
    var url = typeof res === 'string' ? res : (res && res.url);
    var m = vfsResolve(url);
    return _fetch.call(this, m ? new Request(m, res instanceof Request ? res : init) : res, init);
  };
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    var m = vfsResolve(url);
    if (m) arguments[1] = m;
    return _xhrOpen.apply(this, arguments);
  };
})();
\x3c/script>`;

    html = html.replace(/(<head[^>]*>)/i, '$1\n' + polyfill);

    const htmlUrl = URL.createObjectURL(
      new Blob([html], { type: 'text/html' })
    );
    revList.push(htmlUrl);

    return {
      blobUrl: htmlUrl,
      revoke:  () => revList.forEach(u => URL.revokeObjectURL(u)),
    };
  }

  /** Find the most likely HTML entry point in a file map */
  static findEntryPoint(fileMap) {
    const paths = Object.keys(fileMap);
    for (const c of ['index.html', 'index.htm']) {
      if (fileMap[c]) return c;
      const nested = paths.find(p => p.endsWith('/' + c));
      if (nested) return nested;
    }
    return paths.find(p => /\.(html|htm)$/i.test(p)) || null;
  }

  /** Resolve a relative path against a base directory */
  static _resolve(base, rel) {
    if (/^(https?:|data:|blob:|\/\/)/.test(rel)) return rel;
    if (rel.startsWith('/')) return rel.slice(1);
    return (base + rel).split('/').reduce((acc, p) => {
      if (p === '..') acc.pop();
      else if (p !== '.') acc.push(p);
      return acc;
    }, []).join('/');
  }
}

/* ════════════════════════════════════════════════════════════════
   3. Launcher — fullscreen iframe overlay
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
    /* Show exit bar on any mouse/touch movement inside the overlay */
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
    /* Navigate iframe to blank to stop any audio/timers in the launched app */
    this.$frame.src = 'about:blank';
    if (this._revoke) {
      this._revoke();
      this._revoke = null;
    }
    clearTimeout(this._timer);
    this.$bar.classList.remove('hidden');
    document.body.style.overflow = '';
  }

  _resetHide() {
    this.$bar.classList.remove('hidden');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this.$bar.classList.add('hidden');
    }, 2500);
  }
}

/* ════════════════════════════════════════════════════════════════
   4. LibraryUI — card grid, search, filter, view toggle
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

    this.onLaunch  = onLaunch;
    this.onDelete  = onDelete;
    this.apps      = [];
    this.filter    = 'all';
    this.listMode  = false;

    /* Search */
    this.$search.addEventListener('input', () => {
      this.$clear.hidden = this.$search.value.length === 0;
      this._render();
    });
    this.$clear.addEventListener('click', () => {
      this.$search.value = '';
      this.$clear.hidden = true;
      this._render();
    });

    /* Filter pills */
    document.querySelectorAll('.filter-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter-pill')
          .forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.filter = btn.dataset.filter;
        this._render();
      });
    });

    /* View toggles */
    document.getElementById('view-grid')
      .addEventListener('click', () => this._setView(false));
    document.getElementById('view-list')
      .addEventListener('click', () => this._setView(true));
  }

  _setView(list) {
    this.listMode = list;
    this.$grid.classList.toggle('list-view', list);
    document.getElementById('view-grid').classList.toggle('active', !list);
    document.getElementById('view-list').classList.toggle('active',  list);
  }

  /** Replace the displayed library with a fresh DB snapshot */
  setApps(apps) {
    this.apps = Array.isArray(apps) ? apps : [];
    const count = this.apps.length;
    this.$count.textContent = `${count} APP${count !== 1 ? 'S' : ''}`;
    this._render();
  }

  _render() {
    const q = this.$search.value.trim().toLowerCase();

    /* Apply type filter */
    let list = this.filter === 'all'
      ? this.apps
      : this.apps.filter(a => a.type === this.filter);

    /* Apply search query */
    if (q) list = list.filter(a => a.name.toLowerCase().includes(q));

    const hasLibrary = this.apps.length > 0;
    const hasResults = list.length > 0;

    /* Toggle section visibility */
    this.$empty.hidden     = hasLibrary;
    this.$header.hidden    = !hasLibrary;
    this.$grid.hidden      = !hasLibrary || !hasResults;
    this.$noResults.hidden = !hasLibrary || hasResults;

    /* Update count badge (only when header is visible) */
    if (hasLibrary && this.$badge) {
      this.$badge.textContent = list.length;
    }

    if (!hasResults) {
      this.$grid.innerHTML = '';
      return;
    }

    /* Sort newest first */
    const sorted = [...list].sort((a, b) => b.timestamp - a.timestamp);

    this.$grid.innerHTML = sorted
      .map((app, i) => this._cardHTML(app, i))
      .join('');

    /* Wire card events after DOM insertion */
    this.$grid.querySelectorAll('.card-btn-launch').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onLaunch(Number(btn.dataset.id));
      });
    });
    this.$grid.querySelectorAll('.card-btn-delete').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        this.onDelete(Number(btn.dataset.id), btn.dataset.name);
      });
    });
    /* Clicking the banner also launches */
    this.$grid.querySelectorAll('.card-banner').forEach(el => {
      el.addEventListener('click', () => {
        this.onLaunch(Number(el.closest('.app-card').dataset.id));
      });
    });
  }

  _cardHTML(app, index) {
    const isZip = app.type === 'zip';
    const badge = isZip ? 'ZIP' : 'HTML';

    const date = new Date(app.timestamp).toLocaleDateString(undefined, {
      year: '2-digit', month: 'short', day: 'numeric',
    });
    const totalBytes = Object.values(app.files)
      .reduce((acc, b) => acc + b.length, 0);
    const size = LibraryUI._fmtSize(totalBytes);

    /* Stagger animation delay */
    const delay = `animation-delay:${(index * 0.04).toFixed(2)}s`;

    const icon = isZip
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
           <rect x="3" y="3" width="7" height="7" rx="1"/>
           <rect x="14" y="3" width="7" height="7" rx="1"/>
           <rect x="3" y="14" width="7" height="7" rx="1"/>
           <rect x="14" y="14" width="7" height="7" rx="1" fill="currentColor" opacity="0.3"/>
         </svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/>
           <polyline points="13 2 13 9 20 9"/>
           <line x1="9" y1="13" x2="15" y2="13" opacity="0.5"/>
           <line x1="9" y1="17" x2="13" y2="17" opacity="0.5"/>
         </svg>`;

    return `
<div class="app-card type-${app.type}" data-id="${app.id}"
     style="${delay}" role="listitem">
  <div class="card-banner" title="Launch ${LibraryUI._esc(app.name)}">
    <div class="card-banner-grid" aria-hidden="true"></div>
    <div class="card-banner-grad" aria-hidden="true"></div>
    <div class="card-banner-icon" aria-hidden="true">${icon}</div>
    <div class="card-type-badge" aria-label="${badge} app">
      <span class="badge-dot" aria-hidden="true"></span>${badge}
    </div>
  </div>
  <div class="card-body">
    <div class="card-name" title="${LibraryUI._esc(app.name)}">
      ${LibraryUI._esc(app.name)}
    </div>
    <div class="card-meta">
      <span>${date}</span>
      <span class="card-meta-sep" aria-hidden="true">·</span>
      <span>${size}</span>
    </div>
  </div>
  <div class="card-action-row">
    <button class="card-btn card-btn-launch"
            data-id="${app.id}"
            data-name="${LibraryUI._esc(app.name)}"
            aria-label="Launch ${LibraryUI._esc(app.name)}">
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <polygon points="4,2 14,8 4,14"/>
      </svg>
      LAUNCH
    </button>
    <button class="card-btn card-btn-delete"
            data-id="${app.id}"
            data-name="${LibraryUI._esc(app.name)}"
            aria-label="Delete ${LibraryUI._esc(app.name)}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor"
           stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <polyline points="3,4 4,14 12,14 13,4"/>
        <line x1="1" y1="4" x2="15" y2="4"/>
        <line x1="6" y1="2" x2="10" y2="2"/>
      </svg>
    </button>
  </div>
</div>`;
  }

  static _fmtSize(b) {
    if (b < 1024)          return b + ' B';
    if (b < 1024 * 1024)   return (b / 1024).toFixed(1) + ' KB';
    return (b / (1024 * 1024)).toFixed(1) + ' MB';
  }

  static _esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

/* ════════════════════════════════════════════════════════════════
   5. UploadHandler — file input + drag and drop
   ════════════════════════════════════════════════════════════════ */
class UploadHandler {
  constructor({ db, onSuccess, onError, onProgress }) {
    this.db         = db;
    this.onSuccess  = onSuccess;
    this.onError    = onError;
    this.onProgress = onProgress;

    this.$input = document.getElementById('file-input');
    this.$drop  = document.getElementById('drop-overlay');

    /* Upload button clicks */
    document.getElementById('upload-btn')
      .addEventListener('click', () => this.$input.click());
    document.getElementById('upload-btn-empty')
      .addEventListener('click', () => this.$input.click());

    /* File input change */
    this.$input.addEventListener('change', e => {
      this._handleFiles(e.target.files);
    });

    /* Drag & drop */
    this._dragCounter = 0;
    document.addEventListener('dragenter', e => this._onDragEnter(e));
    document.addEventListener('dragleave', e => this._onDragLeave(e));
    document.addEventListener('dragover',  e => e.preventDefault());
    document.addEventListener('drop',      e => this._onDrop(e));
  }

  _onDragEnter(e) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    this._dragCounter++;
    this.$drop.hidden = false;
  }

  _onDragLeave() {
    this._dragCounter = Math.max(0, this._dragCounter - 1);
    if (this._dragCounter === 0) this.$drop.hidden = true;
  }

  _onDrop(e) {
    e.preventDefault();
    this._dragCounter = 0;
    this.$drop.hidden = true;
    if (e.dataTransfer?.files?.length) {
      this._handleFiles(e.dataTransfer.files);
    }
  }

  async _handleFiles(fileList) {
    /* Reset input so the same file can be re-uploaded */
    this.$input.value = '';
    for (const file of Array.from(fileList)) {
      await this._processFile(file);
    }
  }

  async _processFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'html' || ext === 'htm') {
      await this._processHTML(file);
    } else if (ext === 'zip') {
      await this._processZIP(file);
    } else {
      this.onError(`Unsupported file type ".${ext}" — please upload .html or .zip`);
    }
  }

  async _processHTML(file) {
    try {
      this.onProgress(`Reading ${file.name}`, 35);
      const bytes = await this._readBytes(file);
      this.onProgress(`Saving ${file.name}`, 75);
      await this.db.saveApp(file.name, 'html', { 'index.html': bytes });
      this.onProgress(null, 100);
      this.onSuccess(`"${file.name}" added to library`);
    } catch (err) {
      this.onProgress(null, 0);
      this.onError(`Failed to import "${file.name}": ${err.message}`);
    }
  }

  async _processZIP(file) {
    try {
      this.onProgress(`Extracting ${file.name}`, 20);
      const fileMap = await ZipHandler.extractFiles(file);
      const entry   = ZipHandler.findEntryPoint(fileMap);

      if (!entry) {
        this.onProgress(null, 0);
        this.onError(`No HTML entry point found in "${file.name}"`);
        return;
      }

      const displayName = file.name.replace(/\.zip$/i, '');
      this.onProgress(`Saving ${displayName}`, 72);
      await this.db.saveApp(displayName, 'zip', fileMap);
      this.onProgress(null, 100);
      this.onSuccess(`"${displayName}" added to library`);
    } catch (err) {
      this.onProgress(null, 0);
      this.onError(`Failed to import "${file.name}": ${err.message}`);
    }
  }

  _readBytes(file) {
    return new Promise((resolve, reject) => {
      const reader  = new FileReader();
      reader.onload  = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(new Error('FileReader error'));
      reader.readAsArrayBuffer(file);
    });
  }
}

/* ════════════════════════════════════════════════════════════════
   UI HELPERS
   ════════════════════════════════════════════════════════════════ */
const $toast     = document.getElementById('toast');
const $toastIcon = document.getElementById('toast-icon');
const $toastMsg  = document.getElementById('toast-msg');
const $statusEl  = document.getElementById('status-msg');
const $ledEl     = document.getElementById('status-led');
let   _toastTimer = null;
let   _progressEl = null;

const TOAST_ICONS = { success: '✓', error: '✕', info: '⬡' };

function showToast(msg, type = 'info', duration = 3500) {
  $toastIcon.textContent = TOAST_ICONS[type] || '⬡';
  $toastMsg.textContent  = msg;
  $toast.className = `toast ${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    $toast.className = 'toast';
  }, duration);
}

function setStatus(msg, ok = true) {
  $statusEl.textContent        = msg;
  $ledEl.style.background      = ok ? 'var(--c-green)' : 'var(--c-red)';
  $ledEl.style.boxShadow       = ok ? '0 0 6px var(--c-green)' : '0 0 6px var(--c-red)';
}

function setProgress(label, pct) {
  /* label=null means "hide the progress widget" */
  if (label === null) {
    if (_progressEl) {
      _progressEl.remove();
      _progressEl = null;
    }
    return; /* caller sets status themselves */
  }

  if (!_progressEl) {
    _progressEl = document.createElement('div');
    _progressEl.className = 'progress-widget';
    _progressEl.innerHTML =
      `<div class="progress-label"></div>` +
      `<div class="progress-track">` +
        `<div class="progress-fill" style="width:0%"></div>` +
      `</div>`;
    document.body.appendChild(_progressEl);
  }

  _progressEl.querySelector('.progress-label').textContent = label;
  _progressEl.querySelector('.progress-fill').style.width  = Math.min(100, pct) + '%';
  setStatus(label.toUpperCase());
}

/* ════════════════════════════════════════════════════════════════
   ConfirmModal
   ════════════════════════════════════════════════════════════════ */
class ConfirmModal {
  constructor() {
    this.$backdrop = document.getElementById('confirm-modal');
    this.$msg      = document.getElementById('confirm-msg');
    this.$ok       = document.getElementById('confirm-ok');
    this.$cancel   = document.getElementById('confirm-cancel');
    this._resolve  = null;

    this.$ok.addEventListener('click',     () => this._close(true));
    this.$cancel.addEventListener('click', () => this._close(false));
    /* Click on the dark backdrop to cancel */
    this.$backdrop.addEventListener('click', e => {
      if (e.target === this.$backdrop) this._close(false);
    });
    /* Escape key to cancel */
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !this.$backdrop.hidden) this._close(false);
    });
  }

  ask(message) {
    this.$msg.textContent   = message;
    this.$backdrop.hidden   = false;
    this.$ok.focus();
    return new Promise(resolve => { this._resolve = resolve; });
  }

  _close(result) {
    this.$backdrop.hidden = true;
    if (this._resolve) {
      this._resolve(result);
      this._resolve = null;
    }
  }
}

/* ════════════════════════════════════════════════════════════════
   BOOTSTRAP — wire everything together
   ════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {

  const db       = new AppDatabase();
  const confirm  = new ConfirmModal();
  const launcher = new Launcher();

  /* Open IndexedDB */
  try {
    await db.open();
    setStatus('READY');
  } catch (err) {
    showToast('IndexedDB unavailable — uploads will not persist', 'error', 8000);
    setStatus('STORAGE ERROR', false);
    console.error('[Nexus]', err);
    return; /* Cannot continue without storage */
  }

  /* Library UI */
  const library = new LibraryUI({

    onLaunch: async (id) => {
      try {
        setStatus('LOADING…');
        const app = await db.getApp(id);
        if (!app) {
          showToast('App record not found', 'error');
          setStatus('READY');
          return;
        }

        if (app.type === 'html') {
          const blob = new Blob([app.files['index.html']], { type: 'text/html' });
          const url  = URL.createObjectURL(blob);
          launcher.launch(app.name, url, () => URL.revokeObjectURL(url));

        } else if (app.type === 'zip') {
          const entry = ZipHandler.findEntryPoint(app.files);
          if (!entry) {
            showToast('No HTML entry point found in this app', 'error');
            setStatus('READY');
            return;
          }
          const { blobUrl, revoke } = ZipHandler.buildVirtualFS(app.files, entry);
          launcher.launch(app.name, blobUrl, revoke);
        }

        setStatus(`RUNNING: ${app.name.toUpperCase()}`);

      } catch (err) {
        showToast(`Launch failed: ${err.message}`, 'error');
        setStatus('LAUNCH ERROR', false);
        console.error('[Nexus] Launch error:', err);
      }
    },

    onDelete: async (id, name) => {
      const confirmed = await confirm.ask(
        `Permanently delete "${name}" from your library?`
      );
      if (!confirmed) return;

      try {
        await db.deleteApp(id);
        showToast(`"${name}" removed from library`, 'info');
        await refreshLibrary();
      } catch (err) {
        showToast('Delete failed: ' + err.message, 'error');
        console.error('[Nexus] Delete error:', err);
      }
    },
  });

  /* Upload handler */
  new UploadHandler({
    db,
    onSuccess: async (msg) => {
      showToast(msg, 'success');
      setProgress(null, 100);
      setStatus('READY');
      await refreshLibrary();
    },
    onError: (msg) => {
      showToast(msg, 'error', 5000);
      setProgress(null, 0);
      setStatus('ERROR', false);
    },
    onProgress: (label, pct) => setProgress(label, pct),
  });

  /* Initial library load */
  await refreshLibrary();

  /** Fetch all apps from DB and re-render the grid */
  async function refreshLibrary() {
    try {
      const apps = await db.getAllApps();
      library.setApps(apps);
      setStatus('READY');
    } catch (err) {
      showToast('Failed to load library', 'error');
      setStatus('DB ERROR', false);
      console.error('[Nexus] Library load error:', err);
    }
  }
});
