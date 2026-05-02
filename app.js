// app.js — Eclipse Game Store
import { openDB, putFile, deleteApp, setMeta, getMeta, getAllMetaKeys } from './db.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const GAMES_URL  = 'https://raw.githubusercontent.com/Stratus-Games/Stratus-OS-Apps/refs/heads/main/Games/games.json';
const INSTALLED_GAMES_KEY = 'eclipse:installed-games-cache'; // localStorage key for installed game metadata
const GAMES_FETCH_TIMEOUT_MS = 4500;
const APP_URL    = new URL('./', location.href);
const IS_IFRAMED = (() => {
  try { return window.self !== window.top; }
  catch { return true; }
})();

// ─── State ───────────────────────────────────────────────────────────────────
let allGames       = [];
let installedIds   = new Set();
let isOffline      = !navigator.onLine;
let activeInstalls = {};          // appId -> { cancelled }
let currentView    = 'store';
let currentGameId  = null;
let storeLoadCount = 0;
let storeLoadStep  = 24;
let storeObserver  = null;
let lastStoreQuery = '';

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  await openDB();
  await registerSW();
  await loadInstalledIds();
  watchOnline();

  // Load game list — from network or localStorage cache
  allGames = await fetchGames();

  // Initial routing from URL
  routeFromURL();

  // Bind persistent UI
  bindNav();
  bindSearch();
  bindDownloadEmbed();
  bindGameOverlay();
  document.getElementById('nav-store').addEventListener('click',   () => navigate('store'));
  document.getElementById('nav-library').addEventListener('click', () => navigate('library'));

  // Browser back/forward
  window.addEventListener('popstate', () => routeFromURL());
}

// ─── URL-based routing ───────────────────────────────────────────────────────
function routeFromURL() {
  const params = new URLSearchParams(location.search);
  const view   = params.get('view') || 'store';
  const id     = params.get('id');

  if (id) {
    const game = allGames.find(g => String(g.id) === id);
    if (game) { showView('detail', game, false); return; }
  }
  if (view === 'library') { showView('library', null, false); return; }
  showView('store', null, false);
}

// Navigate — updates URL and view
function navigate(view, game) {
  const params = new URLSearchParams();
  if (view === 'detail' && game) {
    params.set('id', game.id);
  } else if (view === 'library') {
    params.set('view', 'library');
  } else {
    params.set('view', 'store');
  }
  const newURL = location.pathname + '?' + params.toString();
  history.pushState({ view, id: game?.id }, '', newURL);
  showView(view, game, false);
}

// ─── View switcher ───────────────────────────────────────────────────────────
function showView(view, game, pushState = true) {
  if (pushState) { navigate(view, game); return; }

  currentView   = view;
  currentGameId = game?.id ?? null;

  // Update nav active state
  document.getElementById('nav-store').classList.toggle('active',   view === 'store');
  document.getElementById('nav-library').classList.toggle('active', view === 'library');

  // Show/hide search
  const sw = document.getElementById('search-wrap');
  if (view === 'store') sw.removeAttribute('hidden');
  else                  sw.setAttribute('hidden', '');

  const dlBtn = document.getElementById('download-embed-btn');
  if (dlBtn) {
    if (view === 'store' && !IS_IFRAMED) dlBtn.removeAttribute('hidden');
    else                  dlBtn.setAttribute('hidden', '');
  }

  // Prevent hidden store view from continuing lazy-load renders.
  if (view !== 'store' && storeObserver) {
    storeObserver.disconnect();
    storeObserver = null;
  }

  // Animate + render
  const ids    = ['view-store', 'view-library', 'view-detail'];
  const target = view === 'detail' ? 'view-detail'
               : view === 'library' ? 'view-library' : 'view-store';

  ids.forEach(id => {
    const el = document.getElementById(id);
    el.setAttribute('hidden', '');
    el.classList.remove('view-entering');
    el.style.display = 'none';
  });

  const el = document.getElementById(target);
  el.removeAttribute('hidden');
  if (target === 'view-store') el.style.display = 'block';
  else if (target === 'view-detail') el.style.display = 'flex';
  else el.style.display = 'block';
  // Trigger animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('view-entering'));
  });

  // Render
  switch (view) {
    case 'store':   renderStore(); break;
    case 'library': renderLibrary(); break;
    case 'detail':  renderDetail(game); break;
  }
}

// ─── Online/Offline ──────────────────────────────────────────────────────────
function watchOnline() {
  const banner = document.getElementById('offline-banner');
  function update() {
    isOffline = !navigator.onLine;
    if (isOffline) banner.removeAttribute('hidden');
    else           banner.setAttribute('hidden', '');
  }
  window.addEventListener('online',  update);
  window.addEventListener('offline', update);
  update();
}

// ─── Game list fetch (with localStorage cache) ────────────────────────────────
async function fetchGames() {
  const installedCatalog = loadInstalledGamesCatalog();

  if (isOffline) {
    if (installedCatalog.length) return installedCatalog;
    showToast('Offline and no installed games are available', 'error');
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), GAMES_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(GAMES_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
    const games = await res.json();
    if (!Array.isArray(games)) throw new Error('Invalid game list payload');
    return games;
  } catch (e) {
    if (installedCatalog.length) {
      showToast('Using installed games list (network unavailable)', 'info');
      return installedCatalog;
    }
    showToast('Failed to load game list', 'error');
    return [];
  }
}

function loadInstalledGamesCatalog() {
  try {
    const raw = localStorage.getItem(INSTALLED_GAMES_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveInstalledGamesCatalog(games) {
  try {
    if (!Array.isArray(games)) return;
    localStorage.setItem(INSTALLED_GAMES_KEY, JSON.stringify(games));
  } catch {}
}

function rememberInstalledGame(game) {
  if (!game || game.id == null) return;
  const catalog = loadInstalledGamesCatalog() || [];
  const id = String(game.id);
  const next = [...catalog.filter(g => String(g?.id) !== id), game];
  saveInstalledGamesCatalog(next);
}

function forgetInstalledGame(gameId) {
  const catalog = loadInstalledGamesCatalog() || [];
  const id = String(gameId);
  const next = catalog.filter(g => String(g?.id) !== id);
  saveInstalledGamesCatalog(next);
}

// ─── Service Worker registration ─────────────────────────────────────────────
async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  if (!window.isSecureContext) return;
  try {
    const reg = await navigator.serviceWorker.register(new URL('./sw.js', location.href).href);
    reg.update();
    let reloadedForNewSW = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadedForNewSW) return;
      reloadedForNewSW = true;
      location.reload();
    });
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn('SW registration failed', e);
  }
}

// ─── Installed tracking ──────────────────────────────────────────────────────
async function loadInstalledIds() {
  const keys = await getAllMetaKeys();
  installedIds = new Set(keys.map(String));
}

// ─── Nav / Search binding ─────────────────────────────────────────────────────
function bindNav() {}  // handled in boot directly

function bindDownloadEmbed() {
  const btn = document.getElementById('download-embed-btn');
  if (!btn) return;
  if (IS_IFRAMED) {
    btn.setAttribute('hidden', '');
    return;
  }
  btn.addEventListener('click', downloadEmbedFile);
}

function downloadEmbedFile() {
  const appURL = new URL('./', location.href).href;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eclipse Embed</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: 0; display: block; }
  </style>
</head>
<body>
  <iframe src="${appURL}" allow="fullscreen; autoplay"></iframe>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'eclipse-embed.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Downloaded eclipse-embed.html', 'success');
}

function bindSearch() {
  const input = document.getElementById('search-input');
  const clear = document.getElementById('search-clear');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q) clear.removeAttribute('hidden'); else clear.setAttribute('hidden', '');
    if (currentView === 'store') renderStore(q);
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.setAttribute('hidden', '');
    input.focus();
    renderStore('');
  });
}

// ══════════════════════════════════════════════════════════════
// STORE VIEW
// ══════════════════════════════════════════════════════════════
function renderStore(query = '') {
  const el = document.getElementById('view-store');
  const normalizedQuery = String(query || '').trim();

  // When offline, only show installed
  const pool = isOffline
    ? allGames.filter(g => installedIds.has(String(g.id)))
    : allGames;

  const filtered = normalizedQuery
    ? pool.filter(g =>
        g.name.toLowerCase().includes(normalizedQuery.toLowerCase()) ||
        g.description?.toLowerCase().includes(normalizedQuery.toLowerCase()) ||
        (g.type || []).some(t => t.toLowerCase().includes(normalizedQuery.toLowerCase()))
      )
    : pool;

  if (lastStoreQuery !== normalizedQuery) {
    storeLoadCount = 0;
    lastStoreQuery = normalizedQuery;
  }
  storeLoadCount = Math.min(Math.max(storeLoadCount, storeLoadStep), filtered.length);

  if (!filtered.length) {
    if (storeObserver) { storeObserver.disconnect(); storeObserver = null; }
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">${isOffline ? '📡' : '🎮'}</div>
        <p>${isOffline ? 'No installed games' : 'No games found'}</p>
        <p class="sub">${isOffline ? 'Connect to the internet to browse the store' : 'Try a different search term'}</p>
      </div>`;
    return;
  }

  const shown = filtered.slice(0, storeLoadCount);
  const hasMore = shown.length < filtered.length;

  el.innerHTML = `
    ${IS_IFRAMED ? '' : `
    <div class="store-tools">
      <button id="store-download-embed-btn" class="topbar-mini-btn">Download HTML</button>
    </div>
    `}
    <div class="store-grid">
      ${shown.map((g, i) => `
        <a class="store-card" href="?id=${g.id}" data-id="${g.id}" style="animation-delay:${Math.min(i * 18, 200)}ms">
          <div class="store-card-img-wrap">
            <img class="store-card-img" src="${g['large-icon']}" alt="${esc(g.name)}" loading="lazy" draggable="false">
            <div class="store-card-img-overlay">
              ${(g.type || []).slice(0, 3).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
              ${installedIds.has(String(g.id)) ? '<span class="tag tag-installed">✓ Installed</span>' : ''}
            </div>
          </div>
          <div class="store-card-body">
            <h3>${esc(g.name)}</h3>
            <p class="card-maker">${esc(g.maker || 'Unknown')}</p>
            <p class="card-desc">${esc(g.description || '')}</p>
            <div class="card-footer">
              <span class="card-size">${esc(g.size || '')}</span>
            </div>
          </div>
        </a>
      `).join('')}
    </div>
    ${hasMore ? '<div id="store-load-sentinel" aria-hidden="true"></div>' : ''}
  `;

  if (!IS_IFRAMED) {
    const storeDlBtn = document.getElementById('store-download-embed-btn');
    if (storeDlBtn) storeDlBtn.addEventListener('click', downloadEmbedFile);
  }

  el.querySelectorAll('.store-card').forEach(card => {
    card.addEventListener('click', e => {
      e.preventDefault();
      const game = allGames.find(g => String(g.id) === card.dataset.id);
      if (game) navigate('detail', game);
    });
  });

  if (storeObserver) {
    storeObserver.disconnect();
    storeObserver = null;
  }
  if (hasMore) {
    const sentinel = document.getElementById('store-load-sentinel');
    if (sentinel) {
      storeObserver = new IntersectionObserver(entries => {
        if (!entries.some(e => e.isIntersecting)) return;
        if (storeLoadCount >= filtered.length) return;
        storeLoadCount = Math.min(storeLoadCount + storeLoadStep, filtered.length);
        renderStore(lastStoreQuery);
      }, { root: el, rootMargin: '300px 0px 300px 0px', threshold: 0.01 });
      storeObserver.observe(sentinel);
    }
  }
}

// ══════════════════════════════════════════════════════════════
// LIBRARY VIEW
// ══════════════════════════════════════════════════════════════
function renderLibrary() {
  const el = document.getElementById('view-library');
  const installed = allGames.filter(g => installedIds.has(String(g.id)));

  if (!installed.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <p>Your library is empty</p>
        <p class="sub">Install games from the store to play them offline</p>
        <button class="btn-primary" id="go-store-btn" style="margin-top:14px">Browse Store</button>
      </div>`;
    document.getElementById('go-store-btn').addEventListener('click', () => navigate('store'));
    return;
  }

  el.innerHTML = `
    <p class="library-section-title">${installed.length} installed ${installed.length === 1 ? 'game' : 'games'}</p>
    <div class="library-grid">
      ${installed.map((g, i) => `
        <a class="library-card" href="?id=${g.id}" data-id="${g.id}" style="animation-delay:${Math.min(i * 18, 250)}ms">
          <div class="lib-img-wrap">
            <img class="lib-img" src="${g['tall-icon']}" alt="${esc(g.name)}" loading="lazy" draggable="false">
            <div class="lib-play-overlay">
              <span class="play-icon">▶</span>
            </div>
          </div>
          <div class="lib-info">
            <span class="lib-name">${esc(g.name)}</span>
            <span class="lib-maker">${esc(g.maker || '')}</span>
          </div>
        </a>
      `).join('')}
    </div>`;

  el.querySelectorAll('.library-card').forEach(card => {
    card.addEventListener('click', e => {
      e.preventDefault();
      const game = allGames.find(g => String(g.id) === card.dataset.id);
      if (game) navigate('detail', game);
    });
  });
}

// ══════════════════════════════════════════════════════════════
// DETAIL VIEW
// ══════════════════════════════════════════════════════════════
function renderDetail(game) {
  if (!game) { navigate('store'); return; }

  const el         = document.getElementById('view-detail');
  const isInstalled  = installedIds.has(String(game.id));
  const isInstalling = !!activeInstalls[game.id];

  el.innerHTML = `
    <!-- Hero -->
    <div class="detail-hero">
      <img class="detail-hero-img" src="${game['large-icon']}" alt="${esc(game.name)}" draggable="false">
      <div class="detail-hero-grad">
        <button class="back-btn" id="back-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          Back
        </button>
        <div class="detail-hero-info">
          <div class="detail-types">
            ${(game.type || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
          </div>
          <h1 class="detail-title">${esc(game.name)}</h1>
          <p class="detail-maker">by ${esc(game.maker || 'Unknown')}</p>
        </div>
      </div>
    </div>

    <!-- Body -->
    <div class="detail-body">
      <div class="detail-left">
        <div class="detail-thumb-wrap">
          <img class="detail-thumb" src="${game['tall-icon']}" alt="${esc(game.name)}" draggable="false">
        </div>
      </div>
      <div class="detail-right">
        <p class="detail-desc">${esc(game.description || '')}</p>

        <div class="detail-meta">
          <div class="meta-item">
            <span class="meta-label">Size</span>
            <span class="meta-val">${esc(game.size || '—')}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Genre</span>
            <span class="meta-val" title="${esc((game.type || []).join(', '))}">${esc((game.type || ['—']).join(', '))}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Developer</span>
            <span class="meta-val">${esc(game.maker || '—')}</span>
          </div>
          <div class="meta-item">
            <span class="meta-label">Status</span>
            <span class="meta-val" id="meta-status">${isInstalled ? '✓ Installed' : isInstalling ? '⬇ Installing…' : 'Not installed'}</span>
          </div>
        </div>

        <div class="detail-actions" id="detail-actions">
          ${buildActionButtons(game, isInstalled, isInstalling)}
        </div>

        <div class="progress-wrap" id="progress-wrap" ${isInstalling ? '' : 'hidden'}>
          <div class="progress-bar-bg">
            <div class="progress-bar-fill" id="progress-fill" style="width:0%"></div>
          </div>
          <div class="progress-info">
            <span id="progress-label">Preparing…</span>
            <span id="progress-pct">0%</span>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('back-btn').addEventListener('click', () => history.back());
  bindDetailActions(game);
  if (isInstalling) updateProgressUI(game.id, activeInstalls[game.id]?.pct || 0, activeInstalls[game.id]?.label || 'Installing…');
}

function buildActionButtons(game, isInstalled, isInstalling) {
  if (isInstalling) {
    return `<button class="btn-ghost btn-danger" id="btn-cancel">Cancel</button>`;
  }
  if (isInstalled) {
    return `
      <button class="btn-play" id="btn-play">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Play Now
      </button>
      <button class="btn-ghost btn-danger" id="btn-uninstall">Uninstall</button>
    `;
  }
  const offline = isOffline ? ' disabled title="Cannot install while offline"' : '';
  return `
    <button class="btn-install" id="btn-install"${offline}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      Install
      <span class="btn-size">${esc(game.size || '')}</span>
    </button>`;
}

function bindDetailActions(game) {
  const wrap = document.getElementById('detail-actions');
  if (!wrap) return;
  wrap.addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.id === 'btn-install')   startInstall(game);
    if (btn.id === 'btn-play')      openGameOverlay(game);
    if (btn.id === 'btn-uninstall') confirmUninstall(game);
    if (btn.id === 'btn-cancel')    cancelInstall(game.id);
  });
}

function canServeInstalledApps() {
  return location.protocol !== 'file:' && !!navigator.serviceWorker?.controller;
}

function parseManifestUrls(raw) {
  return [...raw.matchAll(/"(https?:\/\/[^"]+)"/g)].map(m => m[1]);
}

async function resolvePlayableURL(game) {
  if (canServeInstalledApps()) {
    return new URL(`apps/${encodeURIComponent(game.id)}/index.html`, APP_URL).href;
  }

  const directCandidates = [game?.play, game?.url, game?.launch, game?.index]
    .filter(v => typeof v === 'string' && /^https?:\/\//i.test(v.trim()))
    .map(v => v.trim());
  if (directCandidates.length) return directCandidates[0];

  if (!game?.install) return null;
  try {
    const res = await fetch(game.install);
    if (!res.ok) return null;
    const raw = await res.text();
    const urls = parseManifestUrls(raw);
    const html = urls.find(u => /\.html?([?#].*)?$/i.test(u));
    if (html) return html;
    return urls[0] || null;
  } catch {
    return null;
  }
}

async function openGameOverlay(game) {
  const gameUrl = await resolvePlayableURL(game);
  if (!gameUrl) {
    showToast('Cannot resolve a playable URL for this game in file iframe mode.', 'error');
    return;
  }
  const overlay = document.getElementById('game-overlay');
  const frame = document.getElementById('game-overlay-frame');
  const title = document.getElementById('game-overlay-title');
  if (!overlay || !frame || !title) {
    showToast('Game overlay is unavailable.', 'error');
    return;
  }

  title.textContent = `Now Playing: ${game.name || 'Game'}`;
  frame.src = gameUrl;
  overlay.removeAttribute('hidden');
  document.body.style.overflow = 'hidden';
}

function closeGameOverlay() {
  const overlay = document.getElementById('game-overlay');
  const frame = document.getElementById('game-overlay-frame');
  if (!overlay || !frame) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  frame.src = 'about:blank';
  overlay.setAttribute('hidden', '');
  document.body.style.overflow = '';
}

function toggleGameOverlayFullscreen() {
  const overlay = document.getElementById('game-overlay');
  if (!overlay) return;
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  } else {
    overlay.requestFullscreen?.().catch(() => {});
  }
}

function bindGameOverlay() {
  const closeBtn = document.getElementById('game-close-btn');
  const fullscreenBtn = document.getElementById('game-fullscreen-btn');
  const overlay = document.getElementById('game-overlay');
  if (!closeBtn || !fullscreenBtn || !overlay) return;

  closeBtn.addEventListener('click', closeGameOverlay);
  fullscreenBtn.addEventListener('click', toggleGameOverlayFullscreen);

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeGameOverlay();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !overlay.hasAttribute('hidden')) closeGameOverlay();
  });

  document.addEventListener('fullscreenchange', () => {
    fullscreenBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
  });
}

function refreshDetailActions(game, isInstalled, isInstalling) {
  const wrap = document.getElementById('detail-actions');
  if (!wrap) return;
  wrap.innerHTML = buildActionButtons(game, isInstalled, isInstalling);
  bindDetailActions(game);
  const statusEl = document.getElementById('meta-status');
  if (statusEl) statusEl.textContent =
    isInstalled ? '✓ Installed' : isInstalling ? '⬇ Installing…' : 'Not installed';
}

// ══════════════════════════════════════════════════════════════
// INSTALL
// ══════════════════════════════════════════════════════════════
async function startInstall(game) {
  if (activeInstalls[game.id]) return;
  if (isOffline) { showToast('Cannot install while offline', 'error'); return; }

  const state = { cancelled: false, pct: 0, label: 'Fetching manifest…' };
  activeInstalls[game.id] = state;

  refreshDetailActions(game, false, true);
  showProgressWrap();
  setProgress(0, 'Fetching manifest…');

  try {
    // 1. Fetch & parse DF.json
    const dfRes  = await fetch(game.install);
    if (!dfRes.ok) throw new Error(`Manifest fetch failed: ${dfRes.status}`);
    const dfText = await dfRes.text();
    const pairs  = parseDF(dfText);
    if (!pairs.length) throw new Error('Manifest is empty or unreadable');

    setProgress(2, `0 / ${pairs.length} files…`);

    // 2. Download each file into IDB
    for (let i = 0; i < pairs.length; i++) {
      if (state.cancelled) {
        await deleteApp(String(game.id)).catch(() => {});
        delete activeInstalls[game.id];
        refreshDetailActions(game, false, false);
        hideProgressWrap();
        showToast('Install cancelled', 'info');
        return;
      }

      const { path, url } = pairs[i];
      const filename = decodeURIComponent(url.split('/').pop().split('?')[0]);
      const relPath  = normPath(path) + filename;

      const pct = 2 + Math.round((i / pairs.length) * 95);
      state.pct   = pct;
      state.label = `${i + 1} / ${pairs.length}: ${filename}`;
      setProgress(pct, state.label);

      const r = await fetch(url);
      if (!r.ok) throw new Error(`Failed: ${filename} (${r.status})`);
      const buf = await r.arrayBuffer();
      await putFile(String(game.id), relPath, buf);
    }

    // 3. Mark installed
    await setMeta(String(game.id), {
      id: String(game.id), name: game.name, size: game.size, installedAt: Date.now()
    });
    installedIds.add(String(game.id));
    rememberInstalledGame(game);
    delete activeInstalls[game.id];

    setProgress(100, 'Complete!');
    await delay(700);
    hideProgressWrap();
    refreshDetailActions(game, true, false);
    showToast(`${game.name} installed successfully`, 'success');

    // refresh store/library badges without re-navigation
    // (they'll pick up installedIds on next render)

  } catch (err) {
    if (!state.cancelled) {
      delete activeInstalls[game.id];
      await deleteApp(String(game.id)).catch(() => {});
      hideProgressWrap();
      refreshDetailActions(game, false, false);
      showToast(`Install failed: ${err.message}`, 'error');
    }
  }
}

function cancelInstall(appId) {
  if (activeInstalls[appId]) activeInstalls[appId].cancelled = true;
}

async function confirmUninstall(game) {
  if (!confirm(`Uninstall "${game.name}"? This will free up storage.`)) return;
  await deleteApp(String(game.id));
  installedIds.delete(String(game.id));
  forgetInstalledGame(game.id);
  refreshDetailActions(game, false, false);
  showToast(`${game.name} uninstalled`, 'info');
}

// ─── DF.json parser ──────────────────────────────────────────────────────────
// Non-standard format: assets is an array mixing "path":"./..." bare entries
// with URL strings. We scan linearly by character position.
function parseDF(raw) {
  const combined = [
    ...[...raw.matchAll(/"path"\s*:\s*"([^"]+)"/g)].map(m => ({ type: 'path', val: m[1], idx: m.index })),
    ...[...raw.matchAll(/"(https?:\/\/[^"]+)"/g)].map(m =>   ({ type: 'url',  val: m[1], idx: m.index })),
  ].sort((a, b) => a.idx - b.idx);

  const pairs = [];
  let currentPath = './';
  for (const tok of combined) {
    if (tok.type === 'path') currentPath = tok.val;
    else                     pairs.push({ path: currentPath, url: tok.val });
  }
  return pairs;
}

// Normalise "./R/" → "R/"  and "./" → ""
function normPath(p) {
  const normalized = String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
  if (!normalized) return '';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

// ─── Progress UI helpers ──────────────────────────────────────────────────────
function showProgressWrap() {
  const pw = document.getElementById('progress-wrap');
  if (pw) pw.removeAttribute('hidden');
}

function hideProgressWrap() {
  const pw = document.getElementById('progress-wrap');
  if (pw) pw.setAttribute('hidden', '');
}

function setProgress(pct, label) {
  const fill  = document.getElementById('progress-fill');
  const lbl   = document.getElementById('progress-label');
  const pctEl = document.getElementById('progress-pct');
  if (fill)  fill.style.width  = pct + '%';
  if (lbl)   lbl.textContent   = label;
  if (pctEl) pctEl.textContent = Math.round(pct) + '%';
}

// Keep alias for compat with external call
function updateProgressUI(appId, pct, label) { setProgress(pct, label); }

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t  = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  document.getElementById('toast-container').appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('toast-show')));
  setTimeout(() => {
    t.classList.remove('toast-show');
    setTimeout(() => t.remove(), 350);
  }, 3200);
}

// ─── Utility ─────────────────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────────────────
boot().catch(err => {
  console.error('Eclipse boot failed:', err);
  const msg = err && err.message ? err.message : String(err);
  showToast(`Startup failed: ${msg}`, 'error');
});
