/**
 * Two map tools that don't fit elsewhere:
 *   - the OpenTrailMap vector basemap, rendered by MapLibre inside the
 *     Leaflet map (loaded on demand — ~1 MB of WebGL renderer nobody needs
 *     until they pick that basemap), and
 *   - a tap-to-draw polygon tool for choosing a download area, written in
 *     ~80 lines so the app doesn't depend on Leaflet.draw and its touch bugs.
 */

const L = window.L;

// ---------------------------------------------------------------------------
// OpenTrailMap (vector, browse-only)
// ---------------------------------------------------------------------------

let maplibreReady = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

async function ensureMaplibre() {
  if (!maplibreReady) {
    maplibreReady = (async () => {
      loadCss('./vendor/maplibre/maplibre-gl.css');
      const mod = await import('./vendor/maplibre/maplibre-gl.mjs');
      window.maplibregl = mod.default && mod.default.Map ? mod.default : mod;
      await loadScript('./vendor/maplibre/leaflet-maplibre-gl.js');
      if (!L.maplibreGL) throw new Error('MapLibre bridge did not register L.maplibreGL');
    })().catch((err) => { maplibreReady = null; throw err; });
  }
  return maplibreReady;
}

/** Create the OpenTrailMap layer (resolves once MapLibre is loaded). */
export async function createOpenTrailMapLayer(def) {
  await ensureMaplibre();
  return L.maplibreGL({
    style: def.style,
    attribution: def.attribution,
    pane: 'tilePane',
    interactive: false,
    padding: 0.15,
  });
}

// ---------------------------------------------------------------------------
// Polygon draw tool
// ---------------------------------------------------------------------------

export class PolygonDraw {
  /**
   * @param {L.Map} map
   * @param {{ onChange?: (count:number)=>void, onDone?: (geometry)=>void, onCancel?: ()=>void }} handlers
   */
  constructor(map, handlers = {}) {
    this.map = map;
    this.h = handlers;
    this.points = [];
    this.active = false;
    this.group = L.layerGroup([], { pane: 'drawPane' });
    this.line = L.polyline([], { pane: 'drawPane', color: '#b0362b', weight: 2, dashArray: '6 6', interactive: false });
    this.fill = L.polygon([], { pane: 'drawPane', color: '#b0362b', weight: 2, fillColor: '#b0362b', fillOpacity: 0.08, interactive: false });
    this._onClick = (e) => this.add(e.latlng);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.points = [];
    this.group.addTo(this.map);
    this.line.addTo(this.map);
    this.fill.addTo(this.map);
    this.map.getContainer().classList.add('drawing');
    this.map.doubleClickZoom.disable();
    this.map.on('click', this._onClick);
    this.h.onChange?.(0);
  }

  add(latlng) {
    this.points.push(latlng);
    const idx = this.points.length - 1;
    const m = L.circleMarker(latlng, {
      pane: 'drawPane', radius: idx === 0 ? 9 : 6, color: '#fff', weight: 2,
      fillColor: idx === 0 ? '#b0362b' : '#e07b5f', fillOpacity: 1,
    });
    if (idx === 0) {
      // Tapping the first vertex again closes the ring.
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); this.finish(); });
    }
    this.group.addLayer(m);
    this._redraw();
    this.h.onChange?.(this.points.length);
  }

  undo() {
    if (!this.points.length) return;
    this.points.pop();
    const layers = this.group.getLayers();
    this.group.removeLayer(layers[layers.length - 1]);
    this._redraw();
    this.h.onChange?.(this.points.length);
  }

  _redraw() {
    this.line.setLatLngs(this.points);
    this.fill.setLatLngs(this.points.length >= 3 ? this.points : []);
  }

  finish() {
    if (this.points.length < 3) return false;
    const ring = this.points.map((p) => [p.lng, p.lat]);
    ring.push(ring[0]);
    const geometry = { type: 'Polygon', coordinates: [ring] };
    this._teardown();
    this.h.onDone?.(geometry);
    return true;
  }

  cancel() {
    if (!this.active) return;
    this._teardown();
    this.h.onCancel?.();
  }

  _teardown() {
    this.active = false;
    this.map.off('click', this._onClick);
    this.map.doubleClickZoom.enable();
    this.map.getContainer().classList.remove('drawing');
    this.group.clearLayers();
    this.map.removeLayer(this.group);
    this.map.removeLayer(this.line);
    this.map.removeLayer(this.fill);
    this.points = [];
  }
}
