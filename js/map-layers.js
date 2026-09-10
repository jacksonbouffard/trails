/**
 * Tile layer factories: live raster basemaps/overlays and the offline
 * GridLayer that reads from IndexedDB.
 */

import { tileKey, tileUrl } from './tiles.js';

const L = window.L;

/** { south, west, north, east } → L.LatLngBounds */
export function boundsToLeaflet(b) {
  return L.latLngBounds([b.south, b.west], [b.north, b.east]);
}

/** A plain Leaflet tile layer for a basemap/overlay definition. */
export function createRasterLayer(def, { key, pane, className, zIndex } = {}) {
  const opts = {
    minZoom: def.minZoom ?? 1,
    maxZoom: def.maxZoom ?? 19,
    attribution: def.attribution,
    crossOrigin: true,
    opacity: def.opacity ?? 1,
    keepBuffer: 4,
    updateWhenIdle: true,
  };
  if (def.maxNativeZoom) opts.maxNativeZoom = def.maxNativeZoom;
  if (def.subdomains) opts.subdomains = def.subdomains;
  if (pane) opts.pane = pane;
  if (className) opts.className = className;
  if (zIndex != null) opts.zIndex = zIndex;
  const url = def.url.replace('{key}', key || '');
  return L.tileLayer(url, opts);
}

/**
 * Serves tiles for one layer id straight out of IndexedDB. When the device
 * is online and a tile is missing locally, it falls back to the network
 * (without storing) so a walk that wanders past the saved edge degrades
 * gracefully instead of going blank.
 */
export const OfflineTileLayer = L.GridLayer.extend({
  options: {
    layerId: null,
    def: null,           // basemap/overlay definition (for network fallback + attribution)
    key: '',
    networkFallback: true,
    store: null,
  },

  initialize(options) {
    L.Util.setOptions(this, options);
    if (options.def?.attribution) this.options.attribution = options.def.attribution;
  },

  createTile(coords, done) {
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.setAttribute('role', 'presentation');
    const key = tileKey(this.options.layerId, coords.z, coords.x, coords.y);
    let settled = false;
    const finish = (err) => { if (!settled) { settled = true; done(err || null, img); } };

    img.onload = () => finish();
    img.onerror = () => { img.classList.add('tile-missing'); finish(); };

    this.options.store.getTile(key).then((blob) => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        img.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
        img.src = url;
        return;
      }
      const def = this.options.def;
      if (this.options.networkFallback && def?.url && navigator.onLine) {
        img.classList.add('tile-fallback');
        img.src = tileUrl(def.url, coords, { subdomains: def.subdomains, key: this.options.key });
        return;
      }
      img.classList.add('tile-missing');
      finish();
    }).catch(() => { img.classList.add('tile-missing'); finish(); });

    return img;
  },
});

export function createOfflineLayer(store, layerId, def, { key, pane, className, zIndex, minZoom, maxZoom, opacity, networkFallback = true } = {}) {
  const opts = {
    store, layerId, def, key, networkFallback,
    pane: pane || 'tilePane',
    minZoom: minZoom ?? 1,
    maxZoom: maxZoom ?? 19,
    opacity: opacity ?? def?.opacity ?? 1,
    keepBuffer: 4,
    updateWhenIdle: true,
  };
  if (className) opts.className = className;
  if (zIndex != null) opts.zIndex = zIndex;
  if (def?.maxNativeZoom) opts.maxNativeZoom = def.maxNativeZoom;
  return new OfflineTileLayer(opts);
}
