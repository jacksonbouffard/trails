/**
 * App bootstrap and the pieces that own global map state: settings, the
 * backend, basemaps/overlays, and online ↔ offline mode. Panel behaviour
 * (search, downloads, trail details, routing, notes) lives in panels.js.
 */

import { APP_VERSION, BASEMAPS, OVERLAYS, HOME_VIEW, DEFAULT_SETTINGS, POI_KINDS, DOWNLOAD, basemapDef, overlayDef } from './config.js';
import { Store } from './store.js';
import { createBackend } from './backend.js';
import { AreaDownloader } from './downloader.js';
import { createRasterLayer, createOfflineLayer, boundsToLeaflet } from './map-layers.js';
import { TrailLayer } from './map-trails.js';
import { BoundaryLayer } from './map-boundaries.js';
import { PoiLayer } from './map-pois.js';
import { createOpenTrailMapLayer } from './map-tools.js';
import { AnnotationLayer } from './annotations.js';
import { GpsTracker } from './gps.js';
import { $, esc, toast, Sheet } from './ui.js';
import { formatBytes } from './geo.js';
import { initPanels } from './panels.js';

const L = window.L;

async function boot() {
  const store = new Store();
  let settings;
  try {
    settings = await store.loadSettings(DEFAULT_SETTINGS);
  } catch (err) {
    toast(`Storage is unavailable: ${err.message}. Offline saving will not work.`, { kind: 'error', duration: 8000 });
    settings = structuredClone(DEFAULT_SETTINGS);
  }

  const ctx = {
    L, store, settings,
    backend: createBackend(store, settings),
    units: () => settings.units,
    async saveSetting(key, value) {
      settings[key] = value;
      try { await store.setSetting(key, value); } catch { /* best effort */ }
    },
    mode: 'online',
    activeArea: null,
    activeAreaData: null,
    autoOffline: false,
    areas: [],
  };
  window.trailapp = ctx; // handy for debugging from the console

  // --- Map -------------------------------------------------------------------
  const map = L.map('map', {
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: false,
    maxBoundsViscosity: 0.85,
    tap: false,
  }).setView(HOME_VIEW.center, HOME_VIEW.zoom);
  ctx.map = map;
  L.control.zoom({ position: 'topleft' }).addTo(map);
  const addScale = () => {
    if (ctx.scaleControl) map.removeControl(ctx.scaleControl);
    ctx.scaleControl = L.control.scale({ position: 'bottomleft', imperial: settings.units === 'imperial', metric: settings.units === 'metric', maxWidth: 120 }).addTo(map);
  };
  addScale();
  ctx.addScale = addScale;

  // Stacking order, bottom → top. Trails sit above boundary fills and below
  // GPS/notes; the highlight pane is sandwiched between casing and line.
  const PANES = { boundaries: 350, trailCasing: 440, trailHighlight: 445, trails: 450, route: 460, drawPane: 470, pois: 610, annotations: 620, gps: 650 };
  for (const [name, z] of Object.entries(PANES)) { map.createPane(name); map.getPane(name).style.zIndex = z; }

  // --- Layers ----------------------------------------------------------------
  ctx.trails = new TrailLayer(map, { onSelect: (f, latlng) => ctx.onTrailSelect?.(f, latlng) });
  ctx.boundaries = new BoundaryLayer(map, {
    onSelect: (f, latlng) => ctx.onBoundarySelect?.(f, latlng),
    includeClosed: () => settings.showClosedAccess,
  });
  ctx.pois = new PoiLayer(map, { enabled: settings.pois, units: ctx.units, onSelect: (f, latlng) => ctx.onPoiSelect?.(f, latlng) });
  ctx.annotations = new AnnotationLayer(map, { backend: ctx.backend, onSelect: (n) => ctx.onNoteSelect?.(n) });
  ctx.gps = new GpsTracker(map, { batterySaver: () => settings.batterySaver });
  ctx.gps.setBreadcrumb(settings.breadcrumb);
  ctx.trails.setVisible(settings.showTrails);
  ctx.boundaries.setVisible(settings.showBoundaries);

  ctx.downloader = new AreaDownloader({ store, resolveLayer: (id) => resolveLayerForDownload(ctx, id) });

  // --- Sheet -----------------------------------------------------------------
  ctx.sheet = new Sheet($('#sheet'));

  // --- Basemaps & overlays ---------------------------------------------------
  initBasemaps(ctx);
  initLayersPopover(ctx);

  // --- Mode + status ---------------------------------------------------------
  initModeManager(ctx);

  // --- Panels (selection, downloads, search, details, routing, notes, GPS UI) --
  initPanels(ctx);

  // --- Settings panel --------------------------------------------------------
  initSettingsPanel(ctx);

  await ctx.annotations.load().catch(() => {});
  await ctx.refreshAreas();

  // Quick resume: open the last used saved area rather than the CONUS view.
  const last = ctx.areas.filter((a) => a.lastOpenedAt).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  if (settings.resumeLastArea && last) {
    map.fitBounds(boundsToLeaflet(last.bounds), { animate: false });
    if (!navigator.onLine) ctx.setMode('offline', last.id, { auto: true });
  } else if (!navigator.onLine && ctx.areas.length) {
    ctx.setMode('offline', ctx.areas[0].id, { auto: true });
  }
  ctx.updateStatus();

  registerServiceWorker();
}

// ---------------------------------------------------------------------------
// Basemaps and overlays
// ---------------------------------------------------------------------------

/** Layer definition (with API key filled in) used by the downloader. */
function resolveLayerForDownload(ctx, id) {
  const def = basemapDef(id) || overlayDef(id);
  if (!def || def.kind === 'vector') return null;
  return { ...def, key: def.requiresKey ? ctx.settings[def.requiresKey] : '' };
}

function basemapAvailable(ctx, def) {
  if (def.requiresKey && !ctx.settings[def.requiresKey]) return false;
  return true;
}

function initBasemaps(ctx) {
  const { map, settings } = ctx;
  ctx.basemapId = null;
  ctx.basemapLayer = null;
  ctx.hillshadeLayer = null;

  ctx.setBasemap = async (id, { persist = true } = {}) => {
    let def = basemapDef(id);
    if (!def || !basemapAvailable(ctx, def)) { def = basemapDef('opentopo'); id = def.id; }
    if (ctx.mode === 'offline') {
      // Remember the choice for when we're back online; the offline layer stays.
      ctx.basemapId = id;
      if (persist) ctx.saveSetting('basemap', id);
      ctx.renderBasemapList?.();
      return;
    }
    if (ctx.basemapLayer) { map.removeLayer(ctx.basemapLayer); ctx.basemapLayer = null; }
    let layer;
    if (def.kind === 'vector') {
      $('#layersBtn').classList.add('busy');
      try {
        layer = await createOpenTrailMapLayer(def);
      } catch (err) {
        toast(`OpenTrailMap could not load (${err.message}). Showing OpenTopoMap instead.`, { kind: 'error' });
        def = basemapDef('opentopo');
        id = def.id;
        layer = createRasterLayer(def, { zIndex: 1 });
      } finally {
        $('#layersBtn').classList.remove('busy');
      }
    } else {
      layer = createRasterLayer(def, { key: def.requiresKey ? settings[def.requiresKey] : '', zIndex: 1 });
    }
    ctx.basemapId = id;
    ctx.basemapLayer = layer.addTo(map);
    if (ctx.hillshadeLayer) ctx.hillshadeLayer.bringToFront?.();
    map.setMaxZoom(def.maxZoom || 19);
    if (persist) ctx.saveSetting('basemap', id);
    ctx.renderBasemapList?.();
  };

  ctx.setHillshade = (on, { persist = true } = {}) => {
    if (ctx.hillshadeLayer) { map.removeLayer(ctx.hillshadeLayer); ctx.hillshadeLayer = null; }
    if (on) {
      const def = OVERLAYS[0];
      if (ctx.mode === 'offline' && ctx.activeArea) {
        if (ctx.activeArea.layerIds.includes(def.id)) {
          ctx.hillshadeLayer = createOfflineLayer(ctx.store, def.id, def, { pane: 'tilePane', className: 'hillshade-overlay', zIndex: 2, minZoom: ctx.activeArea.zoomMin, maxZoom: ctx.activeArea.zoomMax });
        } else if (persist) {
          toast('Hillshade was not saved with this area.', { kind: 'info' });
        }
      } else {
        ctx.hillshadeLayer = createRasterLayer(def, { pane: 'tilePane', className: 'hillshade-overlay', zIndex: 2 });
      }
      ctx.hillshadeLayer?.addTo(map);
    }
    if (persist) ctx.saveSetting('hillshade', on);
  };

  ctx.setBasemap(settings.basemap, { persist: false });
  if (settings.hillshade) ctx.setHillshade(true, { persist: false });
}

function initLayersPopover(ctx) {
  const panel = $('#layersPanel');
  const list = $('#basemapList');
  const note = $('#basemapNote');

  ctx.renderBasemapList = () => {
    list.innerHTML = '';
    for (const def of BASEMAPS) {
      const available = basemapAvailable(ctx, def);
      const tag = def.kind === 'vector' ? 'vector · browse only' : !available ? 'needs key' : def.downloadable ? 'offline-ready' : 'browse only';
      const label = document.createElement('label');
      label.className = `${ctx.basemapId === def.id ? 'checked' : ''} ${available ? '' : 'disabled'}`;
      label.innerHTML = `<input type="radio" name="basemap" value="${def.id}" ${ctx.basemapId === def.id ? 'checked' : ''} ${available ? '' : 'disabled'}><span>${esc(def.name)}</span><span class="tag">${tag}</span>`;
      label.querySelector('input').addEventListener('change', () => { ctx.setBasemap(def.id); note.textContent = def.note || ''; });
      list.appendChild(label);
    }
    const cur = basemapDef(ctx.basemapId);
    note.textContent = cur?.note || '';
  };
  ctx.renderBasemapList();

  const poiWrap = $('#poiToggles');
  for (const [kind, def] of Object.entries(POI_KINDS)) {
    const label = document.createElement('label');
    label.className = 'toggle';
    label.innerHTML = `<input type="checkbox" data-poi="${kind}" ${ctx.settings.pois[kind] ? 'checked' : ''}><span>${esc(def.label)}</span>`;
    label.querySelector('input').addEventListener('change', (e) => {
      ctx.settings.pois[kind] = e.target.checked;
      ctx.saveSetting('pois', { ...ctx.settings.pois });
      ctx.pois.setEnabled(kind, e.target.checked);
    });
    poiWrap.appendChild(label);
  }

  $('#ovHillshade').checked = !!ctx.settings.hillshade;
  $('#ovHillshade').addEventListener('change', (e) => ctx.setHillshade(e.target.checked));
  $('#ovBoundaries').checked = ctx.settings.showBoundaries;
  $('#ovBoundaries').addEventListener('change', (e) => { ctx.saveSetting('showBoundaries', e.target.checked); ctx.boundaries.setVisible(e.target.checked); });
  $('#ovTrails').checked = ctx.settings.showTrails;
  $('#ovTrails').addEventListener('change', (e) => { ctx.saveSetting('showTrails', e.target.checked); ctx.trails.setVisible(e.target.checked); });

  const open = () => { panel.classList.remove('hidden'); $('#layersBtn').classList.add('on'); };
  const close = () => { panel.classList.add('hidden'); $('#layersBtn').classList.remove('on'); };
  $('#layersBtn').addEventListener('click', () => (panel.classList.contains('hidden') ? open() : close()));
  $('#layersClose').addEventListener('click', close);
  ctx.map.on('click', close);
  ctx.openLayers = open;
}

// ---------------------------------------------------------------------------
// Online / offline mode
// ---------------------------------------------------------------------------

function initModeManager(ctx) {
  const { map, store } = ctx;
  ctx.offlineBasemapLayer = null;

  ctx.refreshAreas = async () => {
    try { ctx.areas = await ctx.backend.listAreas(); } catch { ctx.areas = []; }
    ctx.onAreasChanged?.();
    return ctx.areas;
  };

  ctx.updateStatus = () => {
    const chip = $('#statusChip');
    const text = $('#statusText');
    const online = navigator.onLine;
    chip.classList.remove('online', 'offline', 'warn');
    if (ctx.mode === 'offline' && ctx.activeArea) {
      chip.classList.add('offline');
      text.textContent = `${online ? 'Offline mode' : 'No connection'} · ${ctx.activeArea.name}`;
    } else if (!online) {
      chip.classList.add('warn');
      text.textContent = ctx.areas.length ? 'No connection · pick a saved area' : 'No connection · nothing saved';
    } else {
      chip.classList.add('online');
      text.textContent = 'Online · live map';
    }
    $('#offlineToggle').checked = ctx.mode === 'offline';
  };

  /**
   * Switch modes. Offline mode swaps every live layer for the saved
   * snapshot and locks the map to the saved footprint and zoom range.
   */
  ctx.setMode = async (mode, areaId, { auto = false } = {}) => {
    if (mode === 'offline') {
      const area = ctx.areas.find((a) => a.id === areaId) || ctx.areas.find((a) => a.status !== 'planned' && a.origin !== 'server');
      if (!area) { toast('No saved area to show offline yet.', { kind: 'error' }); return; }
      if (area.origin === 'server' && !area.downloadedTiles) { toast('That area is only on the server — download it first.', { kind: 'error' }); return; }
      const data = await store.getAreaData(area.id).catch(() => null);
      ctx.activeArea = area;
      ctx.activeAreaData = data;
      ctx.mode = 'offline';
      ctx.autoOffline = auto;
      area.lastOpenedAt = Date.now();
      await store.saveArea(area).catch(() => {});

      // Base + overlay from IndexedDB.
      if (ctx.basemapLayer) { map.removeLayer(ctx.basemapLayer); ctx.basemapLayer = null; }
      if (ctx.offlineBasemapLayer) map.removeLayer(ctx.offlineBasemapLayer);
      const baseId = area.layerIds.find((id) => basemapDef(id)) || area.layerIds[0];
      const def = basemapDef(baseId) || {};
      ctx.offlineBasemapLayer = createOfflineLayer(store, baseId, def, {
        key: def.requiresKey ? ctx.settings[def.requiresKey] : '', zIndex: 1,
        minZoom: Math.max(1, area.zoomMin - 2), maxZoom: area.zoomMax,
      }).addTo(map);
      ctx.setHillshade(!!ctx.settings.hillshade, { persist: false });

      // Vector snapshot.
      ctx.trails.setMode('snapshot');
      ctx.trails.setData(data?.trails || { features: [] }, { replace: true });
      ctx.boundaries.setMode('snapshot');
      ctx.boundaries.setData(data?.boundaries || { features: [] }, { replace: true });
      ctx.pois.setMode('snapshot');
      ctx.pois.setData(data?.pois || { features: [] }, { replace: true });

      // Zoom + pan lock, with viscosity so the edge resists rather than slams.
      const b = boundsToLeaflet(area.bounds);
      map.setMinZoom(Math.max(1, area.zoomMin - 2));
      map.setMaxZoom(area.zoomMax);
      map.setMaxBounds(b.pad(0.05));
      if (!b.contains(map.getCenter()) || map.getZoom() < area.zoomMin) map.fitBounds(b);
      document.body.classList.add('offline-mode');
    } else {
      ctx.mode = 'online';
      ctx.activeArea = null;
      ctx.activeAreaData = null;
      ctx.autoOffline = false;
      if (ctx.offlineBasemapLayer) { map.removeLayer(ctx.offlineBasemapLayer); ctx.offlineBasemapLayer = null; }
      map.setMaxBounds(null);
      map.setMinZoom(1);
      await ctx.setBasemap(ctx.settings.basemap, { persist: false });
      ctx.setHillshade(!!ctx.settings.hillshade, { persist: false });
      ctx.trails.clear();
      ctx.trails.setMode('live');
      ctx.boundaries.clear();
      ctx.boundaries.setMode('live');
      ctx.pois.clear();
      ctx.pois.setMode('live');
      document.body.classList.remove('offline-mode');
    }
    ctx.updateStatus();
    ctx.onModeChanged?.();
  };

  window.addEventListener('offline', () => {
    ctx.updateStatus();
    if (ctx.mode !== 'offline' && ctx.areas.length) {
      const last = ctx.areas.filter((a) => a.downloadedTiles > 0).sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))[0];
      if (last) {
        ctx.setMode('offline', last.id, { auto: true });
        toast(`Connection lost — showing saved area “${last.name}”.`, { duration: 5000 });
      }
    }
  });
  window.addEventListener('online', () => {
    ctx.updateStatus();
    if (ctx.mode === 'offline') {
      toast('Back online.', { action: { label: 'Use live map', onClick: () => ctx.setMode('online') }, duration: 8000 });
    }
    ctx.onBackOnline?.();
  });
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

function initSettingsPanel(ctx) {
  const s = ctx.settings;
  $('#setUnits').value = s.units;
  $('#setUnits').addEventListener('change', (e) => { ctx.saveSetting('units', e.target.value); ctx.addScale(); ctx.onUnitsChanged?.(); toast(`Units: ${e.target.value === 'metric' ? 'kilometres & metres' : 'miles & feet'}`); });
  $('#setResume').checked = !!s.resumeLastArea;
  $('#setResume').addEventListener('change', (e) => ctx.saveSetting('resumeLastArea', e.target.checked));
  $('#setClosed').checked = !!s.showClosedAccess;
  $('#setClosed').addEventListener('change', (e) => { ctx.saveSetting('showClosedAccess', e.target.checked); ctx.boundaries.invalidate(); });
  $('#setTfKey').value = s.thunderforestKey || '';
  $('#setTfKey').addEventListener('change', (e) => { ctx.saveSetting('thunderforestKey', e.target.value.trim()); ctx.renderBasemapList(); });
  $('#setBattery').checked = !!s.batterySaver;
  $('#setBattery').addEventListener('change', (e) => ctx.saveSetting('batterySaver', e.target.checked));
  $('#setBreadcrumb').checked = !!s.breadcrumb;
  $('#setBreadcrumb').addEventListener('change', (e) => { ctx.saveSetting('breadcrumb', e.target.checked); ctx.gps.setBreadcrumb(e.target.checked); });
  const locationStatus = $('#locationPermissionStatus');
  $('#requestLocationPermission').addEventListener('click', () => {
    locationStatus.textContent = 'Requesting location permission…';
    ctx.gps.requestPermission();
  });
  ctx.gps.addEventListener('position', () => { locationStatus.textContent = 'Location permission granted.'; });
  ctx.gps.addEventListener('error', (e) => { locationStatus.textContent = `Location request failed: ${e.detail.message}`; });
  $('#setCap').value = s.hardCapTiles || DOWNLOAD.hardCapTiles;
  $('#setCap').addEventListener('change', (e) => ctx.saveSetting('hardCapTiles', Math.max(500, parseInt(e.target.value, 10) || DOWNLOAD.hardCapTiles)));

  // Backend
  const modeSel = $('#backendMode');
  const fields = $('#backendFields');
  modeSel.value = s.backend?.mode || 'local';
  fields.classList.toggle('hidden', modeSel.value !== 'django');
  $('#backendUrl').value = s.backend?.baseUrl || '';
  $('#backendToken').value = s.backend?.token || '';
  modeSel.addEventListener('change', async () => {
    fields.classList.toggle('hidden', modeSel.value !== 'django');
    if (modeSel.value === 'local') {
      await ctx.saveSetting('backend', { mode: 'local', baseUrl: s.backend?.baseUrl || '', token: s.backend?.token || '' });
      ctx.swapBackend();
      $('#backendStatus').textContent = 'Using this device only.';
    }
  });
  ctx.swapBackend = () => {
    ctx.backend = createBackend(ctx.store, ctx.settings);
    ctx.annotations.setBackend(ctx.backend);
  };
  $('#backendSave').addEventListener('click', async () => {
    const baseUrl = $('#backendUrl').value.trim();
    const token = $('#backendToken').value.trim();
    if (!baseUrl) { toast('Enter the server URL first.', { kind: 'error' }); return; }
    await ctx.saveSetting('backend', { mode: 'django', baseUrl, token });
    ctx.swapBackend();
    $('#backendStatus').textContent = 'Connecting…';
    try {
      const r = await ctx.backend.sync({ lastSync: null });
      await ctx.saveSetting('lastSync', r.at);
      $('#backendStatus').textContent = `Connected. Pushed ${r.pushed}, pulled ${r.pulled}.`;
      await ctx.refreshAreas();
      await ctx.annotations.load();
      ctx.onNotesChanged?.();
      toast('Backend connected and synced.', { kind: 'success' });
    } catch (err) {
      $('#backendStatus').textContent = `Could not reach the server: ${err.message}`;
      toast('Server not reachable — records stay local until it is.', { kind: 'error' });
    }
  });
  $('#backendSync').addEventListener('click', async () => {
    if (ctx.backend.kind !== 'django') { toast('Connect a server first.'); return; }
    $('#backendStatus').textContent = 'Syncing…';
    try {
      const r = await ctx.backend.sync({ lastSync: ctx.settings.lastSync });
      await ctx.saveSetting('lastSync', r.at);
      $('#backendStatus').textContent = `Synced ${new Date(r.at).toLocaleTimeString()}. Pushed ${r.pushed}, pulled ${r.pulled}.`;
      await ctx.refreshAreas();
      await ctx.annotations.load();
      ctx.onNotesChanged?.();
    } catch (err) {
      $('#backendStatus').textContent = `Sync failed: ${err.message}`;
    }
  });
  if (ctx.backend.kind === 'django') $('#backendStatus').textContent = s.lastSync ? `Last synced ${new Date(s.lastSync).toLocaleString()}.` : 'Connected (not synced yet).';

  // Storage
  ctx.refreshStorage = async () => {
    const est = await ctx.store.estimateUsage();
    const tiles = await ctx.store.tileUsage().catch(() => ({ bytes: 0, count: 0 }));
    const used = est?.usage ?? tiles.bytes;
    const quota = est?.quota ?? 0;
    const pct = quota ? Math.min(100, (used / quota) * 100) : 0;
    $('#storageBar').style.width = `${pct}%`;
    $('#storageBar').classList.toggle('warn', pct > 80);
    $('#storageText').textContent = quota
      ? `${formatBytes(used)} used of ${formatBytes(quota)} available · ${tiles.count.toLocaleString()} tiles (${formatBytes(tiles.bytes)})`
      : `${tiles.count.toLocaleString()} tiles stored (${formatBytes(tiles.bytes)})`;
    $('#storageDetail').textContent = `${tiles.count.toLocaleString()} tiles, ${formatBytes(tiles.bytes)}${quota ? ` · browser quota ${formatBytes(quota)}` : ''}. On iOS, storage is separate for Safari and the home-screen app — save areas from the one you'll use on the trail.`;
  };

  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('Delete every saved area, tile, note and setting on this device?')) return;
    await ctx.store.wipeEverything();
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    location.reload();
  });

  $('#aboutText').textContent += ` Version ${APP_VERSION}.`;
}

// ---------------------------------------------------------------------------
// Service worker (app shell only — tiles live in IndexedDB)
// ---------------------------------------------------------------------------

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) {
          toast('An update is ready.', { action: { label: 'Reload', onClick: () => location.reload() }, duration: 0 });
        }
      });
    });
  }).catch((err) => console.warn('Service worker registration failed:', err));
}

boot().catch((err) => {
  console.error(err);
  toast(`The app failed to start: ${err.message}`, { kind: 'error', duration: 0 });
});
