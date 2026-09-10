/**
 * Points of interest from OSM: peaks & saddles, water sources, trailheads,
 * camps & shelters, viewpoints. Each kind is toggled separately. Markers are
 * small SVG glyphs with an elevation label on peaks.
 */

import { LIVE_ZOOM, PALETTE } from './config.js';
import { fetchPois } from './overpass.js';
import { padBounds, boundsContain, formatElevation } from './geo.js';

const L = window.L;

const GLYPHS = {
  peak: '<svg viewBox="0 0 20 20"><path d="M2 17 10 3l8 14z" fill="currentColor"/><path d="M7.2 9.5 10 12l2.8-2.5" fill="none" stroke="#fff" stroke-width="1.6"/></svg>',
  saddle: '<svg viewBox="0 0 20 20"><path d="M1 6c4 0 5 7 9 7s5-7 9-7v11H1z" fill="currentColor"/></svg>',
  water: '<svg viewBox="0 0 20 20"><path d="M10 2c3 4.5 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-6.5 6-11z" fill="currentColor"/></svg>',
  trailhead: '<svg viewBox="0 0 20 20"><rect x="2" y="2" width="16" height="16" rx="3" fill="currentColor"/><path d="M6 14l2.5-5 2 3 1.5-2 2 4" fill="none" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  camp: '<svg viewBox="0 0 20 20"><path d="M10 3 2 17h16z" fill="currentColor"/><path d="M10 9v8" stroke="#fff" stroke-width="1.7"/></svg>',
  viewpoint: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="currentColor"/><circle cx="10" cy="10" r="3" fill="#fff"/></svg>',
};

function iconFor(f) {
  const p = f.properties;
  const glyph = p.subtype === 'saddle' ? GLYPHS.saddle : GLYPHS[p.kind] || GLYPHS.viewpoint;
  const color = PALETTE.poi[p.kind] || '#555';
  const label = p.kind === 'peak' && p.name ? `<span class="poi-label">${escapeHtml(p.name)}</span>` : '';
  return L.divIcon({
    className: `poi poi-${p.kind}`,
    html: `<span class="poi-glyph" style="color:${color}">${glyph}</span>${label}`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
    popupAnchor: [0, -10],
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function poiTitle(p) {
  if (p.name) return p.name;
  const sub = p.subtype || p.kind;
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

export class PoiLayer {
  constructor(map, { enabled, units = () => 'imperial', onSelect } = {}) {
    this.map = map;
    this.enabled = { ...enabled };
    this.units = units;
    this.onSelect = onSelect;
    this.features = new Map();
    this.markers = new Map();
    this.fetchedBounds = [];
    this.mode = 'live';
    this._abort = null;
    this._timer = 0;
    this.group = L.layerGroup([], { pane: 'pois' }).addTo(map);
    map.on('moveend', () => this._scheduleLive());
    map.on('zoomend', () => this._applyZoomVisibility());
  }

  get anyEnabled() { return Object.values(this.enabled).some(Boolean); }

  setEnabled(kind, on) {
    this.enabled[kind] = on;
    for (const [id, m] of this.markers) {
      const f = this.features.get(id);
      if (f.properties.kind !== kind) continue;
      if (on) m.addTo(this.group); else this.group.removeLayer(m);
    }
    if (on) this._scheduleLive();
  }

  setData(fc, { replace = false } = {}) {
    if (replace) this.clear();
    let added = 0;
    for (const f of fc.features || []) {
      const id = f.id;
      if (this.features.has(id)) continue;
      this.features.set(id, f);
      const [lng, lat] = f.geometry.coordinates;
      const m = L.marker([lat, lng], { icon: iconFor(f), pane: 'pois', keyboard: false, title: poiTitle(f.properties) });
      m.on('click', () => this.onSelect?.(f, m.getLatLng()));
      this.markers.set(id, m);
      if (this.enabled[f.properties.kind]) m.addTo(this.group);
      added++;
    }
    this._applyZoomVisibility();
    return added;
  }

  clear() {
    this.group.clearLayers();
    this.features.clear();
    this.markers.clear();
    this.fetchedBounds = [];
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'live') { this._abort?.abort(); clearTimeout(this._timer); }
    else this._scheduleLive();
  }

  _applyZoomVisibility() {
    // Peaks are worth seeing from further out than a drinking-water tap.
    const z = this.map.getZoom();
    const el = this.map.getPane('pois');
    if (!el) return;
    el.classList.toggle('poi-zoomed-out', z < 13);
  }

  _scheduleLive() {
    if (this.mode !== 'live' || !this.anyEnabled) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refreshLive(), 500);
  }

  async refreshLive() {
    if (this.mode !== 'live' || !this.anyEnabled) return;
    if (this.map.getZoom() < LIVE_ZOOM.pois) return;
    const b = this.map.getBounds();
    const view = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    if (this.fetchedBounds.some((fb) => boundsContain(fb, view))) return;
    if (this.features.size > 6000) this.clear();
    const target = padBounds(view, 0.25);
    this._abort?.abort();
    const ac = new AbortController();
    this._abort = ac;
    try {
      const fc = await fetchPois({ bbox: target, signal: ac.signal });
      if (ac.signal.aborted) return;
      this.setData(fc);
      this.fetchedBounds.push(target);
      if (this.fetchedBounds.length > 40) this.fetchedBounds.shift();
    } catch (err) {
      if (err.name !== 'AbortError') this.map.fire('pois:error', { error: err });
    }
  }

  /** Human-readable detail lines for a POI. */
  describe(f) {
    const p = f.properties;
    const lines = [];
    if (p.subtype && p.subtype !== p.kind) lines.push(p.subtype.charAt(0).toUpperCase() + p.subtype.slice(1));
    if (p.ele != null) lines.push(`Elevation ${formatElevation(p.ele, this.units())}`);
    if (p.seasonal) lines.push(`Seasonal / intermittent: ${p.seasonal}`);
    if (p.drinkable) lines.push(`Drinking water: ${p.drinkable}`);
    if (p.capacity) lines.push(`Capacity: ${p.capacity}`);
    if (p.fee) lines.push(`Fee: ${p.fee}`);
    if (p.operator) lines.push(`Operator: ${p.operator}`);
    if (p.description) lines.push(p.description);
    return lines;
  }
}
