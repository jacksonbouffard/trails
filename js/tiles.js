/**
 * Slippy-map tile math plus "which tiles cover this polygon" enumeration.
 *
 * The enumeration is polygon-aware, not bbox-based: a long skinny state
 * forest downloads its own shape (plus an optional margin), not the whole
 * rectangle around it. Two passes per zoom level:
 *   1. walk every ring edge and mark the tiles it crosses (+ margin), and
 *   2. scanline-fill the interior using even-odd crossings, which handles
 *      holes and multipolygons without any special casing.
 */

import { geometryRings, geometryBounds, toRad } from './geo.js';

export function lon2tileFloat(lon, z) {
  return ((lon + 180) / 360) * Math.pow(2, z);
}

export function lat2tileFloat(lat, z) {
  const rad = toRad(lat);
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}

export function lon2tile(lon, z) { return Math.floor(lon2tileFloat(lon, z)); }
export function lat2tile(lat, z) { return Math.floor(lat2tileFloat(lat, z)); }

export function tile2lon(x, z) { return (x / Math.pow(2, z)) * 360 - 180; }
export function tile2lat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/** Geographic bounds of tile x/y/z. */
export function tileBounds(x, y, z) {
  return { west: tile2lon(x, z), east: tile2lon(x + 1, z), north: tile2lat(y, z), south: tile2lat(y + 1, z) };
}

export function tileKey(layerId, z, x, y) {
  return `${layerId}/${z}/${x}/${y}`;
}

export function parseTileKey(key) {
  const [layerId, z, x, y] = key.split('/');
  return { layerId, z: +z, x: +x, y: +y };
}

/** Fill a URL template ({s},{z},{x},{y},{key},{-y}). */
export function tileUrl(template, { z, x, y }, { subdomains, key } = {}) {
  let s = '';
  if (subdomains && subdomains.length) s = subdomains[(x + y) % subdomains.length];
  return template
    .replace('{s}', s)
    .replace('{z}', z)
    .replace('{x}', x)
    .replace('{y}', y)
    .replace('{-y}', Math.pow(2, z) - 1 - y)
    .replace('{key}', key || '');
}

function clampRange(v, max) {
  return Math.max(0, Math.min(max, v));
}

/**
 * Tiles covering a Polygon/MultiPolygon across a zoom range.
 * @returns {Array<{z:number,x:number,y:number}>} ordered low zoom → high zoom
 */
export function tilesForGeometry(geometry, zMin, zMax, { marginMeters = 0 } = {}) {
  const out = [];
  for (let z = zMin; z <= zMax; z++) {
    const set = tileSetForZoom(geometry, z, marginMeters);
    const n = Math.pow(2, z);
    // Row-major order so the download sweeps the area predictably.
    const rows = [...set].map((k) => k.split(',').map(Number)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    for (const [x, y] of rows) {
      if (x >= 0 && x < n && y >= 0 && y < n) out.push({ z, x, y });
    }
  }
  return out;
}

/** Count-only variant (avoids building the big array when just estimating). */
export function countTilesForGeometry(geometry, zMin, zMax, opts = {}) {
  const byZoom = {};
  let total = 0;
  for (let z = zMin; z <= zMax; z++) {
    const n = tileSetForZoom(geometry, z, opts.marginMeters || 0).size;
    byZoom[z] = n;
    total += n;
  }
  return { total, byZoom };
}

/** Set of "x,y" strings for one zoom level. */
export function tileSetForZoom(geometry, z, marginMeters = 0) {
  const rings = geometryRings(geometry);
  const set = new Set();
  if (!rings.length) return set;

  const b = geometryBounds(geometry);
  const midLat = (b.north + b.south) / 2;
  const tileWidthDeg = 360 / Math.pow(2, z);
  const tileHeightDeg = tileWidthDeg * Math.cos(toRad(midLat)); // roughly, at this latitude
  const marginTilesX = marginMeters > 0 ? Math.ceil(marginMeters / (111320 * Math.cos(toRad(midLat))) / tileWidthDeg) : 0;
  const marginTilesY = marginMeters > 0 ? Math.ceil(marginMeters / 111320 / tileHeightDeg) : 0;
  const maxIdx = Math.pow(2, z) - 1;

  const mark = (x, y) => {
    for (let dx = -marginTilesX; dx <= marginTilesX; dx++) {
      for (let dy = -marginTilesY; dy <= marginTilesY; dy++) {
        set.add(`${clampRange(x + dx, maxIdx)},${clampRange(y + dy, maxIdx)}`);
      }
    }
  };

  // Pass 1: edges. Step along each edge at half-tile resolution so a long
  // diagonal edge marks only the tiles it actually crosses.
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      const px = lon2tileFloat(p[0], z), py = lat2tileFloat(p[1], z);
      const qx = lon2tileFloat(q[0], z), qy = lat2tileFloat(q[1], z);
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(qx - px), Math.abs(qy - py)) * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        mark(Math.floor(px + (qx - px) * t), Math.floor(py + (qy - py) * t));
      }
    }
  }

  // Pass 2: interior scanline fill on tile-centre rows.
  const yMin = lat2tile(b.north, z);
  const yMax = lat2tile(b.south, z);
  for (let y = yMin; y <= yMax; y++) {
    const rowLat = tile2lat(y + 0.5, z);
    const crossings = [];
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > rowLat) !== (yj > rowLat)) {
          crossings.push(xi + ((rowLat - yi) * (xj - xi)) / (yj - yi));
        }
      }
    }
    crossings.sort((a, c) => a - c);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const x0 = Math.ceil(lon2tileFloat(crossings[k], z) - 0.5);
      const x1 = Math.floor(lon2tileFloat(crossings[k + 1], z) - 0.5);
      for (let x = x0; x <= x1; x++) set.add(`${clampRange(x, maxIdx)},${clampRange(y, maxIdx)}`);
    }
  }
  return set;
}

/**
 * Pick a spread of sample tiles (for size estimation): biased to the
 * high-zoom levels because that is where the bytes are.
 */
export function sampleTiles(tiles, count) {
  if (tiles.length <= count) return tiles.slice();
  const out = [];
  const stride = tiles.length / count;
  for (let i = 0; i < count; i++) {
    // Skew index toward the end of the (low→high zoom ordered) list.
    const idx = Math.min(tiles.length - 1, Math.floor(Math.pow((i + 0.5) / count, 0.6) * tiles.length));
    out.push(tiles[idx]);
    void stride;
  }
  return out;
}
