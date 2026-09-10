/**
 * Public-land boundaries (PAD-US). Filled by manager type — federal,
 * state, local, NGO — with quiet outlines in the spirit of OpenTrailMap's
 * protected-area styling, dashed for easements and greyed for lands that
 * are closed to the public.
 */

import { LIVE_ZOOM, PALETTE } from './config.js';
import { fetchBoundaries, boundaryDisplayName } from './services.js';
import { padBounds, boundsContain } from './geo.js';

const L = window.L;

export function boundaryStyle(props = {}, zoom = 12) {
  const fill = PALETTE.boundaryFill[props.MngTp_Desc] || PALETTE.boundaryFill.default;
  const closed = props.Pub_Access === 'XA';
  const easement = props.Category === 'Easement' || props.FeatClass === 'Easement';
  return {
    color: closed ? '#8d8a80' : PALETTE.boundaryOutline,
    weight: zoom >= 13 ? 1.6 : 1.1,
    opacity: closed ? 0.6 : 0.85,
    dashArray: easement ? '5 4' : closed ? '2 4' : null,
    fillColor: closed ? '#cfcbc0' : fill,
    fillOpacity: closed ? 0.18 : zoom >= 14 ? 0.12 : 0.2,
    lineJoin: 'round',
  };
}

export class BoundaryLayer {
  constructor(map, { onSelect, includeClosed = () => false } = {}) {
    this.map = map;
    this.onSelect = onSelect;
    this.includeClosed = includeClosed;
    this.features = new Map();
    this.fetchedBounds = [];
    this.mode = 'live';
    this.visible = true;
    this._abort = null;
    this._timer = 0;
    this.renderer = L.canvas({ pane: 'boundaries', padding: 0.3 });
    this.layer = L.geoJSON(null, {
      pane: 'boundaries', renderer: this.renderer,
      style: (f) => boundaryStyle(f.properties, this.map.getZoom()),
      onEachFeature: (f, layer) => {
        layer.on('click', (e) => {
          // Trails sit above boundaries and stop propagation, so a click that
          // reaches here really is on open ground inside a unit.
          this.onSelect?.(f, e.latlng);
        });
      },
    }).addTo(map);
    this.selectedOutline = L.geoJSON(null, {
      pane: 'trailHighlight', interactive: false,
      style: { color: PALETTE.trailHighlight, weight: 3, opacity: 0.9, fill: false, dashArray: null },
    }).addTo(map);
    map.on('moveend', () => this._scheduleLive());
    map.on('zoomend', () => this._restyle());
  }

  setData(fc, { replace = false } = {}) {
    if (replace) this.clear();
    const fresh = [];
    for (const f of fc.features || []) {
      const id = f.id ?? f.properties?.OBJECTID;
      if (id == null || this.features.has(id)) continue;
      f.id = id;
      this.features.set(id, f);
      fresh.push(f);
    }
    if (fresh.length) this.layer.addData({ type: 'FeatureCollection', features: fresh });
    return fresh.length;
  }

  clear() {
    this.layer.clearLayers();
    this.features.clear();
    this.fetchedBounds = [];
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'live') { this._abort?.abort(); clearTimeout(this._timer); }
    else { this.fetchedBounds = []; this._scheduleLive(); }
  }

  setVisible(v) {
    this.visible = v;
    if (v && !this.map.hasLayer(this.layer)) this.layer.addTo(this.map);
    if (!v && this.map.hasLayer(this.layer)) this.map.removeLayer(this.layer);
    if (v) this._scheduleLive();
  }

  /** Access-filter changed → refetch from scratch. */
  invalidate() {
    this.clear();
    this._scheduleLive();
  }

  _scheduleLive() {
    if (this.mode !== 'live' || !this.visible) return;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refreshLive(), 400);
  }

  async refreshLive() {
    if (this.mode !== 'live' || !this.visible) return;
    const zoom = this.map.getZoom();
    if (zoom < LIVE_ZOOM.boundaries) { this.clear(); return; }
    const b = this.map.getBounds();
    const view = { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
    // Generalisation depends on zoom, so a zoom-in past a threshold refetches
    // sharper geometry even inside already-covered bounds.
    const tier = zoom >= 15 ? 2 : zoom >= 12 ? 1 : 0;
    if (this.fetchedBounds.some((fb) => fb.tier >= tier && boundsContain(fb, view))) return;
    if (tier !== this._tier) { this.clear(); this._tier = tier; }
    const target = padBounds(view, 0.2);
    this._abort?.abort();
    const ac = new AbortController();
    this._abort = ac;
    try {
      const fc = await fetchBoundaries(target, { zoom, includeClosed: this.includeClosed(), signal: ac.signal });
      if (ac.signal.aborted) return;
      this.setData(fc);
      this.fetchedBounds.push({ ...target, tier });
      if (this.fetchedBounds.length > 30) this.fetchedBounds.shift();
    } catch (err) {
      if (err.name !== 'AbortError') this.map.fire('boundaries:error', { error: err });
    }
  }

  _restyle() {
    const z = this.map.getZoom();
    this.layer.eachLayer((l) => l.setStyle(boundaryStyle(l.feature.properties, z)));
  }

  select(feature) {
    this.selectedOutline.clearLayers();
    if (feature) this.selectedOutline.addData(feature);
  }

  clearSelection() { this.selectedOutline.clearLayers(); }

  static displayName(feature) { return boundaryDisplayName(feature?.properties); }
}
