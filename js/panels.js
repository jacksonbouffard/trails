/**
 * Everything the bottom sheet does. Each init* function wires one panel
 * (or one cross-cutting behaviour) against the shared ctx built in app.js.
 */

import { BASEMAPS, OVERLAYS, DOWNLOAD, SAC_SCALE, LIVE_ZOOM, basemapDef } from './config.js';
import { PolygonDraw } from './map-tools.js';
import { boundsToLeaflet } from './map-layers.js';
import { NOTE_CATEGORIES } from './annotations.js';
import { BoundaryLayer } from './map-boundaries.js';
import { poiTitle } from './map-pois.js';
import { isSparse } from './map-trails.js';
import { geocode, reverseGeocode, profileForLine, PUB_ACCESS, GAP_STATUS } from './services.js';
import { fetchTrails } from './overpass.js';
import { $, esc, el, toast, debounce, relativeTime, downloadFile, drawProfile } from './ui.js';
import {
  formatDistance, formatElevation, formatArea, formatBytes, formatDuration, naismithMinutes,
  geometryAreaKm2, geometryBounds, boundsToPolygon, nearestOnLine, haversine, compassPoint, uid,
} from './geo.js';

const L = window.L;

export function initPanels(ctx) {
  initPlacing(ctx);
  initSelection(ctx);
  initAreaPanel(ctx);
  initSavedPanel(ctx);
  initSearch(ctx);
  initTrailPanel(ctx);
  initBoundaryPanel(ctx);
  initPoiPanel(ctx);
  initRouting(ctx);
  initNotes(ctx);
  initGpsReadout(ctx);
}

const fmtD = (ctx, m) => formatDistance(m, ctx.units());
const fmtE = (ctx, m) => formatElevation(m, ctx.units());

// ---------------------------------------------------------------------------
// "Tap the map" placement mode, shared by notes and route points
// ---------------------------------------------------------------------------

function initPlacing(ctx) {
  const bar = $('#placeBar');
  ctx.placing = null;
  ctx.startPlacing = (hint, onPick) => {
    ctx.placing = { onPick };
    $('#placeHint').textContent = hint;
    bar.classList.remove('hidden');
    document.body.classList.add('placing');
    ctx.sheet.setSnap('peek');
  };
  ctx.stopPlacing = () => {
    ctx.placing = null;
    bar.classList.add('hidden');
    document.body.classList.remove('placing');
  };
  $('#placeCancel').addEventListener('click', () => { const p = ctx.placing; ctx.stopPlacing(); p?.onCancel?.(); ctx.onPlaceCancelled?.(); });
  ctx.map.on('click', (e) => {
    if (!ctx.placing) return;
    const p = ctx.placing;
    ctx.stopPlacing();
    p.onPick(e.latlng);
  });
  /** Trail/boundary/POI click handlers call this first; true = consumed. */
  ctx.consumePick = (latlng) => {
    if (!ctx.placing) return false;
    const p = ctx.placing;
    ctx.stopPlacing();
    p.onPick(latlng);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Selection (draw / view / boundary) → area to save
// ---------------------------------------------------------------------------

function initSelection(ctx) {
  const { map } = ctx;
  ctx.selection = null;
  const outline = L.geoJSON(null, { pane: 'drawPane', interactive: false, style: { color: '#b0362b', weight: 2, dashArray: '6 5', fillColor: '#b0362b', fillOpacity: 0.06 } }).addTo(map);

  ctx.setSelection = (sel) => {
    ctx.selection = sel;
    outline.clearLayers();
    if (sel) outline.addData({ type: 'Feature', geometry: sel.geometry, properties: {} });
    const card = $('#selectionCard');
    card.classList.toggle('hidden', !sel);
    if (sel) {
      $('#selectionTitle').textContent = sel.name;
      $('#selectionSub').textContent = `${sel.source} · ${formatArea(geometryAreaKm2(sel.geometry), ctx.units())}`;
    }
  };

  const toolbar = $('#drawToolbar');
  const draw = new PolygonDraw(map, {
    onChange: (n) => {
      $('#drawFinish').disabled = n < 3;
      $('#drawHint').textContent = n === 0 ? 'Tap the map to place corners' : n < 3 ? `${n} corner${n === 1 ? '' : 's'} — add at least 3` : `${n} corners — tap the first one or Finish to close`;
    },
    onDone: (geometry) => {
      toolbar.classList.add('hidden');
      ctx.setSelection({ name: 'Drawn area', geometry, source: 'Drawn by hand' });
      ctx.sheet.show('explore', { reset: true, snap: 'half' });
      // Name it after wherever it is, when we can.
      const c = geometryBounds(geometry);
      if (navigator.onLine) {
        reverseGeocode((c.north + c.south) / 2, (c.east + c.west) / 2).then((place) => {
          if (place && ctx.selection?.source === 'Drawn by hand') ctx.setSelection({ ...ctx.selection, name: `Area near ${place}` });
        }).catch(() => {});
      }
    },
    onCancel: () => toolbar.classList.add('hidden'),
  });
  ctx.draw = draw;

  $('#exploreDraw').addEventListener('click', () => {
    if (ctx.mode === 'offline') { toast('Switch to the live map to choose a new area.'); return; }
    ctx.setSelection(null);
    toolbar.classList.remove('hidden');
    ctx.sheet.setSnap('peek');
    draw.start();
  });
  $('#drawUndo').addEventListener('click', () => draw.undo());
  $('#drawCancel').addEventListener('click', () => draw.cancel());
  $('#drawFinish').addEventListener('click', () => draw.finish());

  $('#exploreView').addEventListener('click', async () => {
    if (ctx.mode === 'offline') { toast('Switch to the live map to choose a new area.'); return; }
    if (map.getZoom() < 9) { toast('Zoom in first — this view is bigger than any sensible download.', { kind: 'error' }); return; }
    const b = map.getBounds();
    const geometry = boundsToPolygon({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
    ctx.setSelection({ name: 'Map view', geometry, source: 'Current map view' });
    try {
      const place = await reverseGeocode(b.getCenter().lat, b.getCenter().lng);
      if (place && ctx.selection?.source === 'Current map view') ctx.setSelection({ ...ctx.selection, name: `View near ${place}` });
    } catch { /* fine */ }
  });
  $('#selectionClear').addEventListener('click', () => { ctx.setSelection(null); ctx.boundaries.clearSelection(); });
  $('#selectionOpen').addEventListener('click', () => ctx.openAreaPanel());
}

// ---------------------------------------------------------------------------
// Area panel — choose layers/zoom/margin, estimate, download with progress
// ---------------------------------------------------------------------------

function initAreaPanel(ctx) {
  const { downloader } = ctx;
  const nameEl = $('#areaName'), baseSel = $('#areaBasemap'), hillEl = $('#areaHillshade');
  const zoomSel = $('#areaZoom'), marginSel = $('#areaMargin'), estEl = $('#areaEstimate'), warnEl = $('#areaWarn');
  const dlBtn = $('#areaDownload'), prog = $('#areaProgress');
  let pending = null;
  let estimateAbort = null;

  for (const m of DOWNLOAD.marginChoices) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = m === 0 ? 'None' : m < 1000 ? `${m} m` : `${m / 1000} km`;
    marginSel.appendChild(o);
  }

  function fillBasemaps() {
    baseSel.innerHTML = '';
    for (const def of BASEMAPS) {
      if (!def.downloadable) continue;
      const needsKey = def.requiresKey && !ctx.settings[def.requiresKey];
      const o = document.createElement('option');
      o.value = def.id;
      o.textContent = def.name + (needsKey ? ' (needs API key)' : '');
      o.disabled = !!needsKey;
      baseSel.appendChild(o);
    }
    const cur = basemapDef(ctx.basemapId);
    baseSel.value = cur?.downloadable && !(cur.requiresKey && !ctx.settings[cur.requiresKey]) ? cur.id : 'opentopo';
  }

  function fillZooms() {
    const def = basemapDef(baseSel.value);
    const cap = Math.min(def?.maxNativeZoom ?? def?.maxZoom ?? 17, 17);
    const prev = zoomSel.value;
    zoomSel.innerHTML = '';
    for (const z of DOWNLOAD.maxZoomChoices) {
      if (z > cap) continue;
      const o = document.createElement('option');
      o.value = z;
      o.textContent = `Zoom ${z} — ${z <= 13 ? 'overview' : z === 14 ? 'light' : z === 15 ? 'balanced' : z === 16 ? 'detailed' : 'maximum'}`;
      zoomSel.appendChild(o);
    }
    zoomSel.value = [...zoomSel.options].some((o) => o.value === prev) ? prev : String(Math.min(DOWNLOAD.maxZoomDefault, cap));
  }

  ctx.openAreaPanel = () => {
    if (!ctx.selection) return;
    fillBasemaps();
    fillZooms();
    nameEl.value = ctx.selection.name;
    hillEl.checked = !!ctx.settings.hillshade;
    marginSel.value = '0';
    $('#areaSource').textContent = ctx.selection.source;
    $('#areaSize').textContent = formatArea(geometryAreaKm2(ctx.selection.geometry), ctx.units());
    prog.classList.add('hidden');
    dlBtn.disabled = false;
    replan();
    ctx.sheet.show('area', { snap: 'full' });
  };

  function currentLayerIds() {
    const ids = [baseSel.value];
    if (hillEl.checked) ids.push(OVERLAYS[0].id);
    return ids;
  }

  const replan = () => {
    if (!ctx.selection) return;
    pending = downloader.plan(ctx.selection, {
      zoomMin: DOWNLOAD.minZoomDefault,
      zoomMax: parseInt(zoomSel.value, 10),
      marginMeters: parseInt(marginSel.value, 10),
      layerIds: currentLayerIds(),
      name: nameEl.value.trim() || ctx.selection.name,
    });
    showEstimate(false);
  };

  async function showEstimate(sample) {
    if (!pending) return;
    estimateAbort?.abort();
    const ac = new AbortController();
    estimateAbort = ac;
    if (sample) estEl.textContent = 'Measuring…';
    try {
      const est = await downloader.estimate(pending, { sample, signal: ac.signal });
      if (ac.signal.aborted) return;
      estEl.textContent = `${est.tileCount.toLocaleString()} tiles · about ${formatBytes(est.bytes)}${est.sampled ? ' (measured)' : ' (estimated)'}`;
      const cap = ctx.settings.hardCapTiles || DOWNLOAD.hardCapTiles;
      const srcCap = basemapDef(baseSel.value)?.maxTiles;
      warnEl.classList.add('hidden');
      warnEl.classList.remove('danger');
      dlBtn.disabled = false;
      if (est.tileCount > cap) {
        warnEl.textContent = `That's over your ${cap.toLocaleString()}-tile cap. Lower the zoom, shrink the area, or raise the cap in Settings.`;
        warnEl.classList.remove('hidden');
        warnEl.classList.add('danger');
        dlBtn.disabled = true;
      } else if (srcCap && est.tileCount > srcCap) {
        warnEl.textContent = `${basemapDef(baseSel.value).name} asks users to keep bulk downloads small — this is ${est.tileCount.toLocaleString()} tiles. Consider a lower zoom or the Esri/USGS basemaps for big areas.`;
        warnEl.classList.remove('hidden');
      } else if (est.tileCount > DOWNLOAD.warnTiles) {
        warnEl.textContent = 'Big download — expect it to take a few minutes on a good connection. It can be paused and resumed.';
        warnEl.classList.remove('hidden');
      }
    } catch (err) {
      if (err.name !== 'AbortError') estEl.textContent = `Estimate failed: ${err.message}`;
    }
  }

  [baseSel, hillEl, zoomSel, marginSel].forEach((elm) => elm.addEventListener('change', () => { if (elm === baseSel) fillZooms(); replan(); }));
  nameEl.addEventListener('input', () => { if (pending) pending.name = nameEl.value.trim() || ctx.selection?.name; });
  $('#areaEstimateBtn').addEventListener('click', () => showEstimate(true));

  // --- run ---
  const phaseEl = $('#areaPhase'), bar = $('#areaBar'), counts = $('#areaCounts');
  let running = null;

  function renderProgress(e) {
    const d = e.detail;
    if (d.phase === 'data') {
      phaseEl.textContent = d.label || 'Fetching trail data…';
      bar.style.width = '2%';
      counts.textContent = '';
      return;
    }
    const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
    phaseEl.textContent = `Saving tiles — ${pct}%`;
    bar.style.width = `${pct}%`;
    counts.textContent = `${d.done.toLocaleString()} / ${d.total.toLocaleString()} tiles · ${formatBytes(d.bytes)}${d.failed ? ` · ${d.failed} failed` : ''}`;
  }
  downloader.addEventListener('progress', (e) => { if (running && e.detail.area.id === running.id) renderProgress(e); ctx.onAreaProgress?.(e.detail); });
  downloader.addEventListener('done', async (e) => {
    const a = e.detail.area;
    if (a.status === 'complete') toast(`“${a.name}” is saved for offline use.`, { kind: 'success', action: { label: 'Use it', onClick: () => ctx.setMode('offline', a.id) } });
    else if (a.status === 'partial') toast(`“${a.name}” saved with ${e.detail.failed || 0} missing tiles — Resume later to fill gaps.`, { kind: 'info', duration: 6000 });
    else if (a.status === 'paused') toast('Download paused.');
    else if (a.status === 'interrupted') toast('Connection dropped — the download will resume when you\'re back online.', { duration: 6000 });
    running = null;
    dlBtn.disabled = false;
    prog.classList.add('hidden');
    await ctx.refreshAreas();
    ctx.refreshStorage();
    if (a.status === 'complete' || a.status === 'partial') ctx.sheet.show('saved', { reset: true });
  });
  downloader.addEventListener('error', (e) => {
    toast(`Download failed: ${e.detail.error.message}`, { kind: 'error', duration: 6000 });
    running = null;
    dlBtn.disabled = false;
    prog.classList.add('hidden');
    ctx.refreshAreas();
  });

  ctx.runDownload = async (area) => {
    if (downloader.busy) { toast('A download is already running.'); return; }
    if (!navigator.onLine) { toast('No connection — downloads need one.', { kind: 'error' }); return; }
    running = area;
    dlBtn.disabled = true;
    prog.classList.remove('hidden');
    phaseEl.textContent = 'Starting…';
    bar.style.width = '0%';
    counts.textContent = '';
    try {
      await downloader.run(area);
    } catch (err) {
      if (err.name !== 'AbortError') console.error(err);
    }
  };

  dlBtn.addEventListener('click', async () => {
    if (!pending) return;
    pending.name = nameEl.value.trim() || pending.name;
    if (pending.tileCount === 0) { toast('Nothing to download for that selection.', { kind: 'error' }); return; }
    await ctx.backend.saveArea(pending);
    await ctx.refreshAreas();
    ctx.setSelection(null);
    ctx.boundaries.clearSelection();
    ctx.sheet.show('area', { snap: 'half' });
    await ctx.runDownload(pending);
  });
  $('#areaPause').addEventListener('click', () => downloader.pause('user'));
  $('#areaCancel').addEventListener('click', async () => {
    if (!running) return;
    const area = running;
    downloader.cancel();
    if (confirm('Discard the partial download?')) {
      setTimeout(async () => {
        await downloader.deleteArea(area);
        await ctx.backend.deleteArea(area.id).catch(() => {});
        await ctx.refreshAreas();
        ctx.refreshStorage();
      }, 300);
    }
  });

  // Auto-resume interrupted downloads when the network returns.
  ctx.onBackOnline = async () => {
    await ctx.refreshAreas();
    const interrupted = ctx.areas.find((a) => a.status === 'interrupted');
    if (interrupted && !downloader.busy) {
      toast(`Resuming “${interrupted.name}”…`);
      ctx.runDownload(interrupted);
    }
  };
}

// ---------------------------------------------------------------------------
// Saved areas panel
// ---------------------------------------------------------------------------

function initSavedPanel(ctx) {
  const list = $('#savedList'), empty = $('#savedEmpty'), select = $('#offlineAreaSelect'), toggle = $('#offlineToggle');

  const statusLabel = (a) => {
    if (a.origin === 'server' && !a.downloadedTiles) return ['server', 'On server only'];
    switch (a.status) {
      case 'complete': return ['complete', 'Ready'];
      case 'partial': return ['partial', `Partial${a.failedTiles ? ` · ${a.failedTiles} missing` : ''}`];
      case 'paused': return ['paused', 'Paused'];
      case 'interrupted': return ['interrupted', 'Interrupted'];
      case 'downloading': return ['downloading', 'Downloading'];
      default: return ['planned', 'Not downloaded'];
    }
  };

  ctx.onAreasChanged = () => {
    list.innerHTML = '';
    select.innerHTML = '';
    const usable = ctx.areas.filter((a) => a.downloadedTiles > 0);
    empty.classList.toggle('hidden', ctx.areas.length > 0);
    for (const a of usable) {
      const o = document.createElement('option');
      o.value = a.id;
      o.textContent = a.name;
      select.appendChild(o);
    }
    if (ctx.activeArea) select.value = ctx.activeArea.id;
    select.disabled = !usable.length;
    toggle.disabled = !usable.length;

    for (const a of ctx.areas) {
      const [cls, label] = statusLabel(a);
      const base = basemapDef(a.layerIds?.[0])?.name || a.layerIds?.[0] || '';
      const li = el(`<li>
        <button type="button" class="row">
          <div class="row-main">
            <div class="row-title">${esc(a.name)}</div>
            <div class="row-sub">${esc(base)}${a.layerIds?.includes('esri-hillshade') ? ' + hillshade' : ''} · zoom ${a.zoomMin}–${a.zoomMax} · ${(a.tileCount || 0).toLocaleString()} tiles · ${formatBytes(a.byteCount || 0)}${a.trailCount != null ? ` · ${a.trailCount} trails` : ''}</div>
          </div>
          <span class="status-badge ${cls}">${label}</span>
        </button>
        <div class="row-actions"></div>
      </li>`);
      const actions = li.querySelector('.row-actions');
      const addBtn = (text, fn, cls2 = '') => {
        const b = el(`<button type="button" class="btn ${cls2}">${text}</button>`);
        b.addEventListener('click', fn);
        actions.appendChild(b);
        return b;
      };
      li.querySelector('.row').addEventListener('click', () => {
        ctx.map.fitBounds(boundsToLeaflet(a.bounds));
        ctx.sheet.setSnap('peek');
      });
      if (a.downloadedTiles > 0) addBtn(ctx.activeArea?.id === a.id && ctx.mode === 'offline' ? 'Showing offline' : 'Use offline', () => ctx.setMode('offline', a.id), 'btn-primary');
      if (['partial', 'paused', 'interrupted', 'planned'].includes(a.status) || (a.origin === 'server' && !a.downloadedTiles)) {
        addBtn(a.downloadedTiles ? 'Resume' : 'Download', () => { ctx.sheet.show('area', { snap: 'half' }); ctx.runDownload(a); });
      }
      if (a.downloadedTiles > 0) addBtn('Update trails', async () => {
        a.dataStatus = 'pending';
        await ctx.store.saveArea(a);
        ctx.sheet.show('area', { snap: 'half' });
        ctx.runDownload(a);
      });
      addBtn('Delete', async () => {
        if (!confirm(`Delete “${a.name}” and its tiles?`)) return;
        if (ctx.activeArea?.id === a.id) await ctx.setMode('online');
        const r = await ctx.downloader.deleteArea(a);
        await ctx.backend.deleteArea(a.id).catch(() => {});
        await ctx.refreshAreas();
        ctx.refreshStorage();
        toast(`Deleted. Freed ${formatBytes(r.bytesFreed)}${r.kept ? ` (${r.kept} tiles kept — shared with another area)` : ''}.`);
      }, 'btn-danger');
      list.appendChild(li);
    }
    ctx.updateStatus?.();
  };

  toggle.addEventListener('change', () => {
    if (toggle.checked) ctx.setMode('offline', select.value);
    else ctx.setMode('online');
  });
  select.addEventListener('change', () => { if (ctx.mode === 'offline') ctx.setMode('offline', select.value); });
  ctx.onModeChanged = () => { ctx.onAreasChanged(); if (ctx.activeArea) select.value = ctx.activeArea.id; };
  ctx.sheet.onPanel = (id) => { if (id === 'saved' || id === 'settings') ctx.refreshStorage?.(); };
}

// ---------------------------------------------------------------------------
// Search: places (Nominatim), loaded trails, and "trails near"
// ---------------------------------------------------------------------------

function initSearch(ctx) {
  const form = $('#searchForm'), input = $('#searchInput'), clearBtn = $('#searchClear');
  const results = $('#resultsList'), title = $('#resultsTitle'), emptyEl = $('#resultsEmpty');
  const nearControls = $('#nearControls'), radiusSel = $('#nearRadius');
  let nearCenter = null;
  const nearCircle = L.circle([0, 0], { radius: 0, pane: 'drawPane', color: '#2f6fb0', weight: 1, dashArray: '4 6', fillOpacity: 0.03, interactive: false });

  input.addEventListener('input', () => clearBtn.classList.toggle('hidden', !input.value));
  clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.classList.add('hidden'); input.focus(); });

  function row({ titleText, sub, aside, onClick, actions = [] }) {
    const li = el(`<li><button type="button" class="row"><div class="row-main"><div class="row-title"></div><div class="row-sub"></div></div><span class="row-aside"></span></button></li>`);
    li.querySelector('.row-title').textContent = titleText;
    li.querySelector('.row-sub').textContent = sub || '';
    li.querySelector('.row-aside').textContent = aside || '';
    li.querySelector('.row').addEventListener('click', onClick);
    if (actions.length) {
      const wrap = el('<div class="row-actions"></div>');
      for (const a of actions) {
        const b = el(`<button type="button" class="btn">${esc(a.label)}</button>`);
        b.addEventListener('click', a.onClick);
        wrap.appendChild(b);
      }
      li.appendChild(wrap);
    }
    return li;
  }

  async function runSearch(q) {
    results.innerHTML = '';
    emptyEl.classList.add('hidden');
    nearControls.classList.add('hidden');
    title.textContent = `“${q}”`;
    ctx.sheet.show('results', { snap: 'half' });
    input.blur();

    const local = ctx.trails.search(q, 8);
    for (const t of local) {
      results.appendChild(row({
        titleText: t.name,
        sub: `Loaded trail · ${t.ids.length} segment${t.ids.length === 1 ? '' : 's'}${t.sac ? ` · ${SAC_SCALE[t.sac]?.label || t.sac}` : ''}`,
        aside: fmtD(ctx, t.lengthM),
        onClick: () => { ctx.trails.zoomTo(t.ids[0]); ctx.showTrail(t.feature); },
      }));
    }
    if (ctx.mode === 'offline' || !navigator.onLine) {
      if (!local.length) emptyEl.classList.remove('hidden');
      return;
    }
    const loading = el('<li class="muted small" style="padding:8px 4px">Searching places…</li>');
    results.appendChild(loading);
    try {
      const b = ctx.map.getBounds();
      const viewbox = ctx.map.getZoom() >= 7 ? { west: b.getWest(), east: b.getEast(), north: b.getNorth(), south: b.getSouth() } : null;
      const places = await geocode(q, { viewbox });
      loading.remove();
      if (places.length) {
        ctx.store.addSearch({ id: uid(), q, at: Date.now(), top: places[0] }).then(renderRecent).catch(() => {});
      }
      for (const p of places) {
        results.appendChild(row({
          titleText: p.name,
          sub: [p.type?.replace(/_/g, ' '), p.county, p.state].filter(Boolean).join(' · '),
          onClick: () => flyToPlace(p),
          actions: [{ label: 'Trails near here', onClick: () => runNear(p.lat, p.lng, `Trails near ${p.name}`) }],
        }));
      }
      if (!places.length && !local.length) emptyEl.classList.remove('hidden');
    } catch (err) {
      loading.textContent = `Place search failed: ${err.message}`;
    }
  }

  function flyToPlace(p) {
    if (p.bounds && (p.bounds.north - p.bounds.south) > 0.002) ctx.map.fitBounds(boundsToLeaflet(p.bounds), { maxZoom: 14 });
    else ctx.map.setView([p.lat, p.lng], 14);
    ctx.sheet.setSnap('peek');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (q) runSearch(q);
  });

  // Trails near a point — runs the Overpass radius query, merges into the layer.
  async function runNear(lat, lng, label) {
    nearCenter = { lat, lng, label };
    results.innerHTML = '';
    emptyEl.classList.add('hidden');
    nearControls.classList.remove('hidden');
    title.textContent = label;
    ctx.sheet.show('results', { snap: 'half' });
    const radius = parseInt(radiusSel.value, 10);
    const loading = el('<li class="muted small" style="padding:8px 4px">Looking for trails…</li>');
    results.appendChild(loading);
    let features;
    try {
      if (ctx.mode === 'offline') {
        features = [...ctx.trails.features.values()];
      } else {
        const { trails } = await fetchTrails({ around: { lat, lng, radius } });
        ctx.trails.setData(trails);
        features = trails.features;
      }
    } catch (err) {
      loading.textContent = `Couldn't load trails: ${err.message}`;
      return;
    }
    loading.remove();
    // Group segments by name; distance = nearest point of any segment.
    const groups = new Map();
    for (const f of features) {
      const p = f.properties;
      const near = nearestOnLine([lat, lng], f.geometry.coordinates);
      if (!near || near.dist > radius) continue;
      const key = p.name || p.ref || (p.routes?.[0]?.name ? `${p.routes[0].name} (segment)` : null) || `Unnamed ${p.highway || 'path'} #${p.id}`;
      const g = groups.get(key) || { name: key, distM: Infinity, lengthM: 0, ids: [], sac: null, feature: f, point: null };
      if (near.dist < g.distM) { g.distM = near.dist; g.feature = f; g.point = near.point; }
      g.lengthM += p.lengthM || 0;
      g.ids.push(p.id);
      if (!g.sac && p.sac_scale) g.sac = p.sac_scale;
      groups.set(key, g);
    }
    const sorted = [...groups.values()].sort((a, b) => a.distM - b.distM).slice(0, 60);
    if (!sorted.length) emptyEl.classList.remove('hidden');
    for (const g of sorted) {
      results.appendChild(row({
        titleText: g.name,
        sub: `${fmtD(ctx, g.lengthM)} total${g.ids.length > 1 ? ` in ${g.ids.length} segments` : ''}${g.sac ? ` · ${SAC_SCALE[g.sac]?.label || g.sac}` : ''}`,
        aside: `${fmtD(ctx, g.distM)} away`,
        onClick: () => { ctx.map.setView(g.point, Math.max(ctx.map.getZoom(), 15)); ctx.trails.select(g.feature.properties.id); ctx.showTrail(g.feature); },
      }));
    }
    nearCircle.setLatLng([lat, lng]).setRadius(radius);
    if (!ctx.map.hasLayer(nearCircle)) nearCircle.addTo(ctx.map);
    ctx.map.fitBounds(L.latLng(lat, lng).toBounds(radius * 2), { maxZoom: 14 });
  }
  ctx.runNear = runNear;
  radiusSel.addEventListener('change', () => { if (nearCenter) runNear(nearCenter.lat, nearCenter.lng, nearCenter.label); });

  $('#exploreNear').addEventListener('click', async () => {
    const pos = ctx.gps.position;
    if (pos) { runNear(pos.lat, pos.lng, 'Trails near me'); return; }
    toast('Getting your position…');
    ctx.gps.start();
    ctx.gps.addEventListener('position', (e) => runNear(e.detail.lat, e.detail.lng, 'Trails near me'), { once: true });
  });

  // Filter loaded trails by name (works offline too).
  const filterResults = $('#trailFilterResults');
  $('#trailFilter').addEventListener('input', debounce((e) => {
    const q = e.target.value.trim();
    filterResults.innerHTML = '';
    if (q.length < 2) return;
    const hits = ctx.trails.search(q, 12);
    if (!hits.length) { filterResults.appendChild(el(`<li class="muted small" style="padding:6px 4px">No loaded trail matches — ${ctx.trails.count ? 'try the search box for places' : 'zoom in to load trails first'}.</li>`)); return; }
    for (const t of hits) {
      filterResults.appendChild(row({ titleText: t.name, sub: `${t.ids.length} segment${t.ids.length === 1 ? '' : 's'}`, aside: fmtD(ctx, t.lengthM), onClick: () => { ctx.trails.zoomTo(t.ids[0]); ctx.showTrail(t.feature); } }));
    }
  }, 250));

  // Recent searches
  const recentList = $('#recentSearches'), recentEmpty = $('#recentEmpty');
  async function renderRecent() {
    const items = await ctx.store.listSearches(10).catch(() => []);
    recentList.innerHTML = '';
    recentEmpty.classList.toggle('hidden', items.length > 0);
    for (const s of items) {
      recentList.appendChild(row({
        titleText: s.q, sub: s.top ? [s.top.name, s.top.state].filter(Boolean).join(', ') : '', aside: relativeTime(s.at),
        onClick: () => { if (s.top) flyToPlace(s.top); else { input.value = s.q; runSearch(s.q); } },
      }));
    }
  }
  renderRecent();
}

// ---------------------------------------------------------------------------
// Trail detail panel + elevation profile
// ---------------------------------------------------------------------------

const ACCESS_WORDS = { yes: 'allowed', designated: 'designated', permissive: 'permissive', no: 'not allowed', private: 'private', discouraged: 'discouraged', dismount: 'dismount', limited: 'limited', leashed: 'leashed', unleashed: 'off-leash', unknown: 'unknown' };
const humanTag = (v) => (v ? String(v).replace(/_/g, ' ') : null);

function initTrailPanel(ctx) {
  let current = null;
  let clickLatLng = null;

  ctx.onTrailSelect = (f, latlng) => {
    if (ctx.consumePick(latlng)) return;
    clickLatLng = latlng;
    ctx.showTrail(f);
  };

  ctx.showTrail = (f) => {
    current = f;
    const p = f.properties;
    ctx.trails.select(p.id);
    const title = p.name || (p.ref ? `Trail ${p.ref}` : p.routes?.[0]?.name ? `${p.routes[0].name} (segment)` : `Unnamed ${p.highway === 'track' ? 'track' : p.highway === 'steps' ? 'steps' : 'path'}`);
    $('#trailName').textContent = title;

    const badges = $('#trailBadges');
    badges.innerHTML = '';
    const sac = SAC_SCALE[p.sac_scale];
    const badge = (text, color) => badges.appendChild(el(`<span class="badge">${color ? `<span class="swatch" style="--c:${color}"></span>` : ''}${esc(text)}</span>`));
    badge(sac ? sac.label : 'No difficulty tagged', sac ? sac.color : '#4f2e28');
    badge(fmtD(ctx, p.lengthM));
    if (p.highway === 'track') badge('Vehicle-width track');
    if (p.informal === 'yes') badge('Informal / unofficial');
    if (p.abandoned || p.disused) badge('Abandoned or disused');

    const warn = $('#trailWarn');
    if (isSparse(p)) { warn.textContent = 'No name in OpenStreetMap — this part of the area may be thinly mapped. Treat the line as approximate.'; warn.classList.remove('hidden'); }
    else warn.classList.add('hidden');

    const meta = $('#trailMeta');
    meta.innerHTML = '';
    const rows = [
      ['Surface', humanTag(p.surface)],
      ['Visibility', humanTag(p.trail_visibility)],
      ['Incline', p.incline],
      ['Width', p.width ? `${p.width} m` : null],
      ['Smoothness', humanTag(p.smoothness)],
      ['Track grade', p.tracktype ? p.tracktype.replace('grade', 'grade ') : null],
      ['Foot', ACCESS_WORDS[p.foot] || p.foot],
      ['Bicycles', ACCESS_WORDS[p.bicycle] || p.bicycle],
      ['Horses', ACCESS_WORDS[p.horse] || p.horse],
      ['Dogs', ACCESS_WORDS[p.dog] || p.dog],
      ['Wheelchair', ACCESS_WORDS[p.wheelchair] || p.wheelchair],
      ['MTB scale', p['mtb:scale']],
      ['Access', ACCESS_WORDS[p.access] || p.access],
      ['Operator', p.operator],
      ['Reference', p.ref],
      ['Blaze / symbol', p.symbol || p['osmc:symbol']],
      ['Lit', p.lit],
      ['Description', p.description],
      ['Note', p.note],
    ];
    for (const [k, v] of rows) {
      if (v == null || v === '') continue;
      meta.appendChild(el(`<dt>${esc(k)}</dt>`));
      meta.appendChild(el(`<dd>${esc(v)}</dd>`));
    }
    if (p.wikipedia) {
      meta.appendChild(el('<dt>Wikipedia</dt>'));
      const [lang, article] = p.wikipedia.includes(':') ? p.wikipedia.split(/:(.+)/) : ['en', p.wikipedia];
      meta.appendChild(el(`<dd><a href="https://${esc(lang)}.wikipedia.org/wiki/${encodeURIComponent(article)}" target="_blank" rel="noopener">${esc(article)}</a></dd>`));
    }

    const routes = p.routes || [];
    $('#trailRoutes').classList.toggle('hidden', !routes.length);
    const rl = $('#trailRoutesList');
    rl.innerHTML = '';
    for (const r of routes) {
      rl.appendChild(el(`<li><div class="row" style="cursor:default"><div class="row-main"><div class="row-title">${esc(r.name || r.ref || 'Route')}</div><div class="row-sub">${esc([r.network, r.ref, r.symbol].filter(Boolean).join(' · '))}</div></div></div></li>`));
    }

    $('#trailOsmLink').href = `https://www.openstreetmap.org/way/${p.id}`;
    $('#trailProfileWrap').classList.add('hidden');
    ctx.sheet.show('trail', { snap: 'half' });
  };

  $('#trailZoom').addEventListener('click', () => current && ctx.trails.zoomTo(current.properties.id));
  $('#trailProfileBtn').addEventListener('click', async () => {
    if (!current) return;
    await ctx.showProfile(current.geometry.coordinates, `way-${current.properties.id}`, $('#trailProfileCanvas'), $('#trailProfileStats'), $('#trailProfileWrap'));
  });
  $('#trailRouteFrom').addEventListener('click', () => current && ctx.routeSetPoint('start', clickLatLng || midpoint(current)));
  $('#trailRouteTo').addEventListener('click', () => current && ctx.routeSetPoint('end', clickLatLng || midpoint(current)));

  ctx.showProfile = async (coords, cacheKey, canvas, statsEl, wrap) => {
    wrap.classList.remove('hidden');
    statsEl.innerHTML = '<div class="muted small">Loading elevation…</div>';
    let profile = await ctx.store.getElevation(cacheKey).catch(() => null);
    if (!profile) {
      if (!navigator.onLine || ctx.mode === 'offline') { statsEl.innerHTML = '<div class="muted small">Elevation needs a connection the first time; profiles you\'ve viewed before work offline.</div>'; wrap.querySelector('canvas').getContext('2d').clearRect(0, 0, 9999, 9999); return; }
      try {
        profile = await profileForLine(coords);
        await ctx.store.saveElevation(cacheKey, profile).catch(() => {});
      } catch (err) {
        statsEl.innerHTML = `<div class="muted small">Elevation unavailable: ${esc(err.message)}</div>`;
        return;
      }
    }
    const styles = getComputedStyle(document.body);
    drawProfile(canvas, profile, { units: ctx.units(), accent: styles.getPropertyValue('--green').trim() || '#3f6b3a', muted: styles.getPropertyValue('--muted').trim() });
    const mins = naismithMinutes(profile.distanceM, profile.gain, profile.loss);
    statsEl.innerHTML = [
      ['Gain', fmtE(ctx, profile.gain)], ['Loss', fmtE(ctx, profile.loss)],
      ['Low', fmtE(ctx, profile.min)], ['High', fmtE(ctx, profile.max)],
      ['Est. time', formatDuration(mins)],
    ].map(([l, n]) => `<div class="stat"><div class="stat-n">${esc(n)}</div><div class="stat-l">${esc(l)}</div></div>`).join('');
  };

  ctx.onUnitsChanged = () => { if (ctx.sheet.current === 'trail' && current) ctx.showTrail(current); };
}

function midpoint(f) {
  const c = f.geometry.coordinates;
  const m = c[Math.floor(c.length / 2)];
  return L.latLng(m[1], m[0]);
}

// ---------------------------------------------------------------------------
// Boundary detail panel
// ---------------------------------------------------------------------------

function initBoundaryPanel(ctx) {
  let current = null;
  ctx.onBoundarySelect = (f, latlng) => {
    if (ctx.consumePick(latlng)) return;
    if (ctx.draw.active) return;
    current = f;
    ctx.boundaries.select(f);
    const p = f.properties || {};
    $('#boundaryName').textContent = BoundaryLayer.displayName(f);
    const meta = $('#boundaryMeta');
    meta.innerHTML = '';
    const rows = [
      ['Manager', p.MngNm_Desc], ['Manager type', p.MngTp_Desc], ['Designation', p.DesTp_Desc],
      ['Public access', PUB_ACCESS[p.Pub_Access] || p.Pub_Access], ['Protection (GAP)', GAP_STATUS[p.GAP_Sts] ? `${p.GAP_Sts} — ${GAP_STATUS[p.GAP_Sts]}` : p.GAP_Sts],
      ['Mechanism', p.Category], ['Size', p.GIS_Acres ? `${Math.round(p.GIS_Acres).toLocaleString()} acres` : null], ['State', p.ST_Name],
    ];
    for (const [k, v] of rows) {
      if (v == null || v === '') continue;
      meta.appendChild(el(`<dt>${esc(k)}</dt>`));
      meta.appendChild(el(`<dd>${esc(v)}</dd>`));
    }
    ctx.sheet.show('boundary', { snap: 'half' });
  };
  $('#boundaryUse').addEventListener('click', () => {
    if (!current) return;
    if (ctx.mode === 'offline') { toast('Switch to the live map to choose a new area.'); return; }
    ctx.setSelection({ name: BoundaryLayer.displayName(current), geometry: current.geometry, source: current.properties?.MngNm_Desc || 'Boundary' });
    ctx.openAreaPanel();
  });
  $('#boundaryZoom').addEventListener('click', () => current && ctx.map.fitBounds(boundsToLeaflet(geometryBounds(current.geometry)).pad(0.05)));
}

// ---------------------------------------------------------------------------
// POI detail panel
// ---------------------------------------------------------------------------

function initPoiPanel(ctx) {
  let current = null;
  ctx.onPoiSelect = (f, latlng) => {
    if (ctx.consumePick(latlng)) return;
    current = f;
    $('#poiName').textContent = poiTitle(f.properties);
    const ul = $('#poiMeta');
    ul.innerHTML = '';
    const kindLine = f.properties.kind === 'peak' ? 'Summit' : f.properties.kind.charAt(0).toUpperCase() + f.properties.kind.slice(1);
    const lines = [kindLine, ...ctx.pois.describe(f)];
    if (ctx.gps.position) lines.push(`${fmtD(ctx, haversine([ctx.gps.position.lat, ctx.gps.position.lng], [f.geometry.coordinates[1], f.geometry.coordinates[0]]))} from you`);
    for (const line of lines) ul.appendChild(el(`<li><div class="row" style="cursor:default;min-height:32px">${esc(line)}</div></li>`));
    ctx.sheet.show('poi', { snap: 'half' });
  };
  $('#poiZoom').addEventListener('click', () => current && ctx.map.setView([current.geometry.coordinates[1], current.geometry.coordinates[0]], Math.max(ctx.map.getZoom(), 15)));
  $('#poiRouteTo').addEventListener('click', () => current && ctx.routeSetPoint('end', L.latLng(current.geometry.coordinates[1], current.geometry.coordinates[0]), 600));
  $('#poiNote').addEventListener('click', () => current && ctx.openNoteEditor({ lat: current.geometry.coordinates[1], lng: current.geometry.coordinates[0], title: poiTitle(current.properties), category: current.properties.kind === 'water' ? 'water' : current.properties.kind === 'camp' ? 'camp' : current.properties.kind === 'viewpoint' ? 'view' : 'other' }));
}

// ---------------------------------------------------------------------------
// Routing over loaded trails
// ---------------------------------------------------------------------------

function initRouting(ctx) {
  const { map } = ctx;
  const R = { start: null, end: null, result: null, active: false };
  const line = L.polyline([], { pane: 'route', color: '#0f7b8f', weight: 6, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false });
  const lineCase = L.polyline([], { pane: 'route', color: '#fbf8ee', weight: 10, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false });
  const mk = (cls) => L.marker([0, 0], { pane: 'route', keyboard: false, icon: L.divIcon({ className: `route-pin ${cls}`, html: `<span class="pin-glyph" style="background:${cls === 'start' ? '#2e7d32' : '#b0362b'};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] }) });
  const startMk = mk('start'), endMk = mk('end');
  const btn = $('#routeBtn');
  const hint = $('#routeHint'), stats = $('#routeStats'), segs = $('#routeSegments');

  function snap(latlng, maxM = 300) {
    if (ctx.map.getZoom() < LIVE_ZOOM.trails && ctx.mode !== 'offline') { toast('Zoom in so the trails around that point are loaded.', { kind: 'error' }); return null; }
    const g = ctx.trails.graph();
    const n = g.nearestNode(latlng.lat, latlng.lng, maxM);
    if (!n) { toast(`No loaded trail within ${fmtD(ctx, maxM)} of that point.`, { kind: 'error' }); return null; }
    return n.node;
  }

  function askFor(which) {
    ctx.startPlacing(which === 'start' ? 'Tap the start point on a trail' : 'Tap the end point on a trail', (latlng) => ctx.routeSetPoint(which, latlng));
  }

  ctx.routeSetPoint = (which, latlng, maxM = 300) => {
    const node = snap(latlng, maxM);
    if (!node) { if (ctx.sheet.current !== 'route') ctx.sheet.show('route', { snap: 'half' }); return; }
    R[which] = node;
    R.active = true;
    btn.classList.add('on');
    (which === 'start' ? startMk : endMk).setLatLng([node.lat, node.lng]).addTo(map);
    if (R.start && R.end) compute();
    else {
      ctx.sheet.show('route', { snap: 'half' });
      hint.textContent = which === 'start' ? 'Start set. Now tap the end point on a trail.' : 'End set. Now tap the start point on a trail.';
      askFor(which === 'start' ? 'end' : 'start');
    }
  };

  function compute() {
    const g = ctx.trails.graph();
    const result = g.route(R.start.key, R.end.key);
    R.result = result;
    stats.innerHTML = '';
    segs.innerHTML = '';
    $('#routeProfileWrap').classList.add('hidden');
    if (!result) {
      line.setLatLngs([]); lineCase.setLatLngs([]);
      hint.textContent = 'No connected trail path between those points. The network between them may not be loaded (zoom/pan across it) or may not connect in OSM.';
      ctx.sheet.show('route', { snap: 'half' });
      return;
    }
    lineCase.setLatLngs(result.path).addTo(map);
    line.setLatLngs(result.path).addTo(map);
    hint.textContent = 'Route along loaded trails. Tap Elevation profile for gain and an estimated time.';
    stats.classList.remove('hidden');
    stats.innerHTML = `<div class="stat"><div class="stat-n">${esc(fmtD(ctx, result.distanceM))}</div><div class="stat-l">Distance</div></div>
      <div class="stat"><div class="stat-n">${result.segments.length}</div><div class="stat-l">Segments</div></div>
      <div class="stat"><div class="stat-n">${esc(formatDuration(naismithMinutes(result.distanceM)))}</div><div class="stat-l">Flat-ground time</div></div>`;
    for (const s of result.segments) {
      segs.appendChild(el(`<li><div class="row" style="cursor:default"><div class="row-main"><div class="row-title">${esc(s.name || 'Unnamed path')}</div></div><span class="row-aside">${esc(fmtD(ctx, s.distM))}</span></div></li>`));
    }
    map.fitBounds(line.getBounds().pad(0.15));
    ctx.sheet.show('route', { snap: 'half' });
  }

  function clear() {
    R.start = R.end = R.result = null;
    R.active = false;
    btn.classList.remove('on');
    [line, lineCase, startMk, endMk].forEach((l) => map.removeLayer(l));
    stats.classList.add('hidden');
    segs.innerHTML = '';
    hint.textContent = 'Tap a start point on a trail, then an end point. Routing uses the trails loaded on screen — zoom in so the network around your route is loaded.';
    $('#routeProfileWrap').classList.add('hidden');
    if (ctx.placing) ctx.stopPlacing();
  }

  btn.addEventListener('click', () => {
    if (R.active && R.result) { ctx.sheet.show('route', { snap: 'half' }); return; }
    if (R.active) { clear(); return; }
    R.active = true;
    btn.classList.add('on');
    ctx.sheet.show('route', { snap: 'half' });
    askFor('start');
  });
  ctx.onPlaceCancelled = () => { if (R.active && !R.result) clear(); };
  $('#routeClear').addEventListener('click', clear);
  $('#routeReverse').addEventListener('click', () => { if (R.start && R.end) { [R.start, R.end] = [R.end, R.start]; startMk.setLatLng([R.start.lat, R.start.lng]); endMk.setLatLng([R.end.lat, R.end.lng]); compute(); } });
  $('#routeFromGps').addEventListener('click', () => {
    const p = ctx.gps.position;
    if (!p) { toast('No GPS fix yet — turn on location first.'); return; }
    ctx.routeSetPoint('start', L.latLng(p.lat, p.lng), 500);
  });
  $('#routeProfileBtn').addEventListener('click', async () => {
    if (!R.result) { toast('Plan a route first.'); return; }
    const coords = R.result.path.map(([lat, lng]) => [lng, lat]);
    await ctx.showProfile(coords, `route-${R.start.key}-${R.end.key}`, $('#routeProfileCanvas'), $('#routeProfileStats'), $('#routeProfileWrap'));
  });
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

function initNotes(ctx) {
  const list = $('#notesList'), empty = $('#notesEmpty');
  const catSel = $('#noteCategory');
  for (const [k, c] of Object.entries(NOTE_CATEGORIES)) {
    const o = document.createElement('option');
    o.value = k; o.textContent = c.label;
    catSel.appendChild(o);
  }
  let editing = null;

  ctx.onNotesChanged = () => {
    list.innerHTML = '';
    const notes = ctx.annotations.list();
    empty.classList.toggle('hidden', notes.length > 0);
    for (const n of notes) {
      const cat = NOTE_CATEGORIES[n.category] || NOTE_CATEGORIES.other;
      const li = el(`<li><button type="button" class="row"><span class="pin-glyph" style="background:${cat.color}">${cat.glyph}</span><div class="row-main"><div class="row-title"></div><div class="row-sub"></div></div><span class="row-aside">${esc(relativeTime(n.updatedAt))}</span></button></li>`);
      li.querySelector('.row-title').textContent = n.title || cat.label;
      li.querySelector('.row-sub').textContent = n.note || '';
      li.querySelector('.row').addEventListener('click', () => { ctx.map.setView([n.lat, n.lng], Math.max(ctx.map.getZoom(), 15)); ctx.openNoteEditor(n); });
      list.appendChild(li);
    }
  };

  ctx.openNoteEditor = (note) => {
    editing = note;
    $('#noteEditTitle').textContent = note.id ? 'Edit note' : 'New note';
    $('#noteTitle').value = note.title || '';
    catSel.value = NOTE_CATEGORIES[note.category] ? note.category : 'other';
    $('#noteText').value = note.note || '';
    $('#noteCoords').textContent = `${note.lat.toFixed(5)}, ${note.lng.toFixed(5)}`;
    $('#noteDelete').classList.toggle('hidden', !note.id);
    ctx.sheet.show('noteEdit', { snap: 'full' });
  };

  ctx.onNoteSelect = (n) => { if (ctx.consumePick(L.latLng(n.lat, n.lng))) return; ctx.openNoteEditor(n); };

  const startAdd = () => ctx.startPlacing('Tap where the note goes', (latlng) => ctx.openNoteEditor({ lat: latlng.lat, lng: latlng.lng }));
  $('#noteBtn').addEventListener('click', startAdd);
  $('#notesAdd').addEventListener('click', startAdd);

  $('#noteSave').addEventListener('click', async () => {
    if (!editing) return;
    const patch = { title: $('#noteTitle').value.trim(), category: catSel.value, note: $('#noteText').value.trim() };
    try {
      if (editing.id) await ctx.annotations.update(editing.id, patch);
      else await ctx.annotations.add({ lat: editing.lat, lng: editing.lng, ...patch });
      toast('Note saved.', { kind: 'success' });
      ctx.onNotesChanged();
      ctx.sheet.show('notes', { reset: true, snap: 'half' });
    } catch (err) {
      toast(`Could not save the note: ${err.message}`, { kind: 'error' });
    }
  });
  $('#noteDelete').addEventListener('click', async () => {
    if (!editing?.id || !confirm('Delete this note?')) return;
    await ctx.annotations.remove(editing.id);
    ctx.onNotesChanged();
    ctx.sheet.show('notes', { reset: true, snap: 'half' });
  });
  $('#notesExport').addEventListener('click', () => {
    const fc = ctx.annotations.toGeoJSON();
    if (!fc.features.length) { toast('No notes to export yet.'); return; }
    downloadFile(`trail-notes-${new Date().toISOString().slice(0, 10)}.geojson`, JSON.stringify(fc, null, 2), 'application/geo+json');
  });
  $('#notesImport').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const fc = JSON.parse(await file.text());
      const n = await ctx.annotations.importGeoJSON(fc);
      toast(`Imported ${n} note${n === 1 ? '' : 's'}.`, { kind: 'success' });
      ctx.onNotesChanged();
    } catch (err) {
      toast(`Import failed: ${err.message}`, { kind: 'error' });
    }
    e.target.value = '';
  });
  ctx.onNotesChanged();
}

// ---------------------------------------------------------------------------
// GPS readout: off-trail distance, accuracy, follow, compass
// ---------------------------------------------------------------------------

function initGpsReadout(ctx) {
  const { gps } = ctx;
  const readout = $('#readout'), dist = $('#readoutDistance'), label = $('#readoutLabel'), sub = $('#readoutSub');
  const locateBtn = $('#locateBtn'), followBtn = $('#followBtn'), compassBtn = $('#compassBtn');
  let firstFix = true;

  locateBtn.addEventListener('click', () => {
    if (!gps.running) { gps.start(); firstFix = true; locateBtn.classList.add('busy'); return; }
    if (gps.position) ctx.map.setView([gps.position.lat, gps.position.lng], Math.max(ctx.map.getZoom(), 15));
  });
  $('#gpsStopBtn').addEventListener('click', () => gps.stop());
  followBtn.addEventListener('click', () => {
    gps.setFollow(!gps.follow);
    followBtn.setAttribute('aria-pressed', String(gps.follow));
  });
  ctx.map.on('dragstart', () => { if (gps.follow) { gps.setFollow(false); followBtn.setAttribute('aria-pressed', 'false'); } });
  compassBtn.addEventListener('click', async () => {
    if (gps.compassOn) { gps.disableCompass(); compassBtn.setAttribute('aria-pressed', 'false'); return; }
    const ok = await gps.enableCompass();
    compassBtn.setAttribute('aria-pressed', String(ok));
  });

  gps.addEventListener('state', (e) => {
    readout.classList.toggle('hidden', !e.detail.running);
    locateBtn.classList.toggle('on', e.detail.running);
    if (!e.detail.running) locateBtn.classList.remove('busy');
  });
  gps.addEventListener('error', (e) => { toast(e.detail.message, { kind: 'error' }); locateBtn.classList.remove('busy'); });
  gps.addEventListener('position', (e) => {
    const fix = e.detail;
    locateBtn.classList.remove('busy');
    if (firstFix) { firstFix = false; ctx.map.setView([fix.lat, fix.lng], Math.max(ctx.map.getZoom(), 14)); }
    const near = ctx.trails.nearest(fix.lat, fix.lng, 3000);
    const acc = fix.accuracy || 0;
    if (near) {
      const name = near.feature.properties.name || near.feature.properties.routes?.[0]?.name || (near.feature.properties.highway === 'track' ? 'unnamed track' : 'unnamed path');
      if (near.distM <= Math.max(12, acc)) { dist.textContent = 'On trail'; label.textContent = name; }
      else { dist.textContent = fmtD(ctx, near.distM); label.textContent = `off trail · nearest: ${name}`; }
    } else {
      dist.textContent = '—';
      label.textContent = ctx.trails.count ? 'no trail within 3 km' : 'no trails loaded here';
    }
    const parts = [`±${Math.round(acc)} m`];
    if (fix.altitude != null) parts.push(`GPS alt ${fmtE(ctx, fix.altitude)}`);
    if (gps.headingDeg != null) parts.push(`${Math.round(gps.headingDeg)}° ${compassPoint(gps.headingDeg)}`);
    parts.push(relativeTime(fix.ts));
    sub.textContent = parts.join(' · ');
  });
  gps.addEventListener('mode', (e) => { if (e.detail.mode === 'polling') sub.textContent += ' · battery saver'; });

  $('#exportTrack').addEventListener('click', () => {
    if (!gps.breadcrumbPoints.length) { toast('No breadcrumb yet — turn it on under Location and walk a bit.'); return; }
    downloadFile(`breadcrumb-${new Date().toISOString().slice(0, 16).replace(':', '')}.gpx`, gps.breadcrumbAsGpx(), 'application/gpx+xml');
  });
  $('#clearTrack').addEventListener('click', () => { gps.clearBreadcrumb(); toast('Breadcrumb cleared.'); });
}

