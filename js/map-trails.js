/**
 * Trail layer. Two canvas renderers draw every trail twice — a light casing
 * underneath and the coloured line on top — so lines read against busy
 * topo basemaps. Colour and dash encode OSM `sac_scale` and `informal`;
 * unnamed ways are dimmed as a "thinly mapped, trust with care" hint.
 */

import { LIVE_ZOOM, PALETTE, SAC_SCALE } from './config.js';
import { fetchTrails } from './overpass.js';
import { padBounds, boundsContain, nearestOnLine, geometryBounds, distanceToBounds } from './geo.js';
import { TrailGraph } from './graph.js';

const L = window.L;

export function isSparse(props) {
  return !props.name && !props.ref && !(props.routes && props.routes.length);
}

function weightForZoom(z) {
  if (z >= 15) return 4;
  if (z >= 13) return 3;
  return 2;
}

export function trailStyle(props, zoom = 15) {
  const sac = SAC_SCALE[props.sac_scale];
  let color = sac ? sac.color : PALETTE.trailDefault;
  let weight = weightForZoom(zoom);
  let dash = sac?.dash || null;
  if (props.highway === 'track') { if (!sac) color = PALETTE.trailTrack; weight = Math.max(2, weight - 0.5); }
  if (props.highway === 'steps') dash = '2 5';
  if (props.informal === 'yes') dash = '4 6';
  const sparse = isSparse(props);
  return { color, weight, dashArray: dash, opacity: sparse ? 0.55 : 0.95, lineCap: 'round', lineJoin: 'round' };
}

export function casingStyle(props, zoom = 15) {
  const base = trailStyle(props, zoom);
  return { color: PALETTE.trailCasing, weight: base.weight + 3, opacity: isSparse(props) ? 0.55 : 0.9, lineCap: 'round', lineJoin: 'round' };
}

export class TrailLayer {
  /**
   * @param {L.Map} map
   * @param {{ onSelect?: (feature, latlng) => void }} opts
   */
  constructor(map, { onSelect } = {}) {
    this.map = map;
    this.onSelect = onSelect;
    this.features = new Map();       // id → feature
    this.lineLayers = new Map();     // id → L.Polyline
    this.casingLayers = new Map();
    this.fetchedBounds = [];
    this.mode = 'live';              // 'live' | 'snapshot' | 'off'
    this.visible = true;
    this.zoomTier = weightForZoom(map.getZoom());
    this._graph = null;
    this._abort = null;
    this._timer = 0;
    this._selectedId = null;

    this.casingRenderer = L.canvas({ pane: 'trailCasing', padding: 0.3 });
    this.lineRenderer = L.canvas({ pane: 'trails', padding: 0.3 });

    this.casing = L.geoJSON(null, {
      pane: 'trailCasing', renderer: this.casingRenderer, interactive: false,
      style: (f) => casingStyle(f.properties, this.map.getZoom()),
      onEachFeature: (f, layer) => this.casingLayers.set(f.properties.id, layer),
    }).addTo(map);
    this.lines = L.geoJSON(null, {
      pane: 'trails', renderer: this.lineRenderer,
      style: (f) => trailStyle(f.properties, this.map.getZoom()),
      onEachFeature: (f, layer) => {
        this.lineLayers.set(f.properties.id, layer);
        layer.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          this.select(f.properties.id);
          this.onSelect?.(f, e.latlng);
        });
        if (!L.Browser.touch && (f.properties.name || f.properties.ref)) {
          layer.bindTooltip(f.properties.name || f.properties.ref, { sticky: true, className: 'trail-tip' });
        }
      },
    }).addTo(map);
    this.highlight = L.polyline([], {
      pane: 'trailHighlight', color: PALETTE.trailHighlight, weight: 14, opacity: 0.55, lineCap: 'round', lineJoin: 'round', interactive: false,
    }).addTo(map);

    map.on('moveend', () => this._scheduleLive());
    map.on('zoomend', () => this._onZoom());
  }

  // --- data ------------------------------------------------------------------

  /** Replace or merge features. */
  setData(fc, { replace = false } = {}) {
    if (replace) this.clear();
    const fresh = [];
    for (const f of fc.features || []) {
      const id = f.properties?.id ?? f.id;
      if (id == null || this.features.has(id)) continue;
      if (!f.properties) f.properties = { id };
      f.properties.id = id;
      f.properties._bounds = geometryBounds(f.geometry);
      this.features.set(id, f);
      fresh.push(f);
    }
    if (fresh.length) {
      this.casing.addData({ type: 'FeatureCollection', features: fresh });
      this.lines.addData({ type: 'FeatureCollection', features: fresh });
      this._graph = null;
    }
    return fresh.length;
  }

  clear() {
    this.casing.clearLayers();
    this.lines.clearLayers();
    this.features.clear();
    this.lineLayers.clear();
    this.casingLayers.clear();
    this.fetchedBounds = [];
    this._graph = null;
    this.clearSelection();
  }

  get count() { return this.features.size; }

  /** 'live' fetches by viewport; 'snapshot' renders what setData gave it. */
  setMode(mode) {
    this.mode = mode;
    if (mode !== 'live') { this._abort?.abort(); clearTimeout(this._timer); }
    else this._scheduleLive();
  }

  setVisible(v) {
    this.visible = v;
    for (const layer of [this.casing, this.lines, this.highlight]) {
      if (v && !this.map.hasLayer(layer)) layer.addTo(this.map);
      if (!v && this.map.hasLayer(layer)) this.map.removeLayer(layer);
    }
    if (v) this._scheduleLive();
  }

  // --- live fetching ---------------------------------------------------------

  _scheduleLive() {
    if (this.mode !== 'live' || !this.visible) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refreshLive(), 350);
  }

  async refreshLive(force = false) {
    if (this.mode !== 'live' || !this.visible) return;
    if (this.map.getZoom() < LIVE_ZOOM.trails) return;
    const b = this.map.getBounds();
    const view = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    if (!force && this.fetchedBounds.some((fb) => boundsContain(fb, view))) return;
    // Keep memory bounded: after a lot of wandering, start over.
    if (this.features.size > 15000) this.clear();
    const target = padBounds(view, 0.25);
    this._abort?.abort();
    const ac = new AbortController();
    this._abort = ac;
    this.map.fire('trails:loading', { loading: true });
    try {
      const { trails } = await fetchTrails({ bbox: target, signal: ac.signal });
      if (ac.signal.aborted) return;
      this.setData(trails);
      this.fetchedBounds.push(target);
      if (this.fetchedBounds.length > 40) this.fetchedBounds.shift();
      this.map.fire('trails:loaded', { count: trails.features.length });
    } catch (err) {
      if (err.name !== 'AbortError') this.map.fire('trails:error', { error: err });
    } finally {
      if (this._abort === ac) this.map.fire('trails:loading', { loading: false });
    }
  }

  _onZoom() {
    const tier = weightForZoom(this.map.getZoom());
    if (tier === this.zoomTier) return;
    this.zoomTier = tier;
    const z = this.map.getZoom();
    this.lines.eachLayer((l) => l.setStyle(trailStyle(l.feature.properties, z)));
    this.casing.eachLayer((l) => l.setStyle(casingStyle(l.feature.properties, z)));
  }

  // --- selection -------------------------------------------------------------

  select(id) {
    const f = this.features.get(id);
    if (!f) return;
    this._selectedId = id;
    this.highlight.setLatLngs(f.geometry.coordinates.map((c) => [c[1], c[0]]));
    this.lineLayers.get(id)?.bringToFront();
  }

  clearSelection() {
    this._selectedId = null;
    this.highlight.setLatLngs([]);
  }

  get selected() { return this._selectedId != null ? this.features.get(this._selectedId) : null; }

  zoomTo(id) {
    const layer = this.lineLayers.get(id);
    if (layer) this.map.fitBounds(layer.getBounds().pad(0.2), { maxZoom: 16 });
  }

  // --- queries ---------------------------------------------------------------

  /** Nearest trail to [lat, lng] within maxM → { feature, distM, point } or null. */
  nearest(lat, lng, maxM = 2000) {
    let best = null;
    for (const f of this.features.values()) {
      const b = f.properties._bounds;
      if (b && distanceToBounds([lat, lng], b) > (best ? best.distM : maxM)) continue;
      const r = nearestOnLine([lat, lng], f.geometry.coordinates);
      if (r && r.dist <= maxM && (!best || r.dist < best.distM)) best = { feature: f, distM: r.dist, point: r.point };
    }
    return best;
  }

  /** Case-insensitive name/ref/route search over loaded trails. */
  search(q, limit = 30) {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const seen = new Map();
    for (const f of this.features.values()) {
      const p = f.properties;
      const hay = [p.name, p.ref, ...(p.routes || []).map((r) => r.name)].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(needle)) continue;
      const key = p.name || p.ref || `#${p.id}`;
      const entry = seen.get(key) || { name: key, ids: [], lengthM: 0, sac: p.sac_scale || null, feature: f };
      entry.ids.push(p.id);
      entry.lengthM += p.lengthM || 0;
      seen.set(key, entry);
    }
    return [...seen.values()].sort((a, b) => b.lengthM - a.lengthM).slice(0, limit);
  }

  /** Routing graph over the loaded trails (built lazily, cached). */
  graph() {
    if (!this._graph) {
      this._graph = new TrailGraph();
      this._graph.addCollection({ features: [...this.features.values()] });
    }
    return this._graph;
  }
}
