/**
 * Small HTTP services: PAD-US boundaries (ArcGIS REST), Nominatim geocoding,
 * and Open-Meteo elevation. Each is a thin fetch wrapper; the map layers
 * that consume them live elsewhere.
 */

import { ENDPOINTS } from './config.js';
import { resampleLine } from './geo.js';

// ---------------------------------------------------------------------------
// PAD-US public-land boundaries
// ---------------------------------------------------------------------------

export const PADUS_FIELDS = 'Unit_Nm,Pub_Access,GAP_Sts,MngTp_Desc,MngNm_Desc,DesTp_Desc,BndryName,GIS_Acres,ST_Name,Category';

export const PUB_ACCESS = { OA: 'Open access', RA: 'Restricted access', XA: 'Closed to the public', UK: 'Unknown access' };
export const GAP_STATUS = {
  1: 'Managed for biodiversity — natural disturbance',
  2: 'Managed for biodiversity — disturbance suppressed',
  3: 'Multiple use (extraction allowed)',
  4: 'No known mandate for protection',
};

/**
 * Fetch PAD-US polygons intersecting bounds. Generalises geometry according
 * to zoom so state-level views don't pull megabytes of vertices, and pages
 * through results when the server caps a response.
 */
export async function fetchBoundaries(bounds, { zoom = 12, includeClosed = false, signal, fetchImpl = fetch, maxPages = 4 } = {}) {
  const envelope = {
    xmin: bounds.west, ymin: bounds.south, xmax: bounds.east, ymax: bounds.north,
    spatialReference: { wkid: 4326 },
  };
  // Degrees of allowable offset: ~2 px at the given zoom.
  const degPerPx = 360 / (256 * Math.pow(2, zoom));
  const offset = zoom >= 15 ? 0 : degPerPx * 2;
  const where = includeClosed ? '1=1' : "Pub_Access IN ('OA','RA','UK')";

  const features = [];
  let resultOffset = 0;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      f: 'geojson',
      where,
      geometry: JSON.stringify(envelope),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: PADUS_FIELDS,
      returnGeometry: 'true',
      geometryPrecision: '5',
      resultRecordCount: '500',
      resultOffset: String(resultOffset),
    });
    if (offset) params.set('maxAllowableOffset', offset.toFixed(6));
    const res = await fetchImpl(`${ENDPOINTS.padus}?${params}`, { signal });
    if (!res.ok) throw new Error(`PAD-US request failed (${res.status})`);
    const json = await res.json();
    if (json.error) throw new Error(`PAD-US: ${json.error.message || 'query error'}`);
    features.push(...(json.features || []));
    const more = json.properties?.exceededTransferLimit || json.exceededTransferLimit;
    if (!more || !(json.features || []).length) break;
    resultOffset += json.features.length;
  }
  for (const f of features) {
    f.id = f.id ?? f.properties?.OBJECTID ?? `${f.properties?.Unit_Nm}-${f.properties?.MngNm_Desc}`;
  }
  return { type: 'FeatureCollection', features };
}

export function boundaryDisplayName(props = {}) {
  return props.Unit_Nm || props.BndryName || props.DesTp_Desc || 'Protected area';
}

// ---------------------------------------------------------------------------
// Nominatim geocoding — respects the 1 request / second policy
// ---------------------------------------------------------------------------

let nominatimChain = Promise.resolve();
let lastNominatimAt = 0;

function throttled(fn) {
  const run = nominatimChain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastNominatimAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    return fn();
  });
  nominatimChain = run.catch(() => {});
  return run;
}

/**
 * Geocode a place name. Biased to the current view when `viewbox` is given,
 * limited to the US by default (this is a US-lands app).
 */
export function geocode(q, { limit = 8, countrycodes = 'us', viewbox, signal, fetchImpl = fetch } = {}) {
  return throttled(async () => {
    const params = new URLSearchParams({ q, format: 'jsonv2', limit: String(limit), addressdetails: '1', extratags: '0' });
    if (countrycodes) params.set('countrycodes', countrycodes);
    if (viewbox) params.set('viewbox', `${viewbox.west},${viewbox.north},${viewbox.east},${viewbox.south}`);
    const res = await fetchImpl(`${ENDPOINTS.nominatim}/search?${params}`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const rows = await res.json();
    return rows.map((r) => ({
      id: `${r.osm_type}-${r.osm_id}`,
      name: r.name || r.display_name.split(',')[0],
      displayName: r.display_name,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      type: r.type,
      category: r.category || r.class,
      bounds: r.boundingbox ? { south: +r.boundingbox[0], north: +r.boundingbox[1], west: +r.boundingbox[2], east: +r.boundingbox[3] } : null,
      state: r.address?.state || null,
      county: r.address?.county || null,
    }));
  });
}

/** Reverse-geocode a point → short place description (for naming drawn areas). */
export function reverseGeocode(lat, lng, { zoom = 12, signal, fetchImpl = fetch } = {}) {
  return throttled(async () => {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', zoom: String(zoom) });
    const res = await fetchImpl(`${ENDPOINTS.nominatim}/reverse?${params}`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Reverse geocode failed (${res.status})`);
    const r = await res.json();
    const a = r.address || {};
    const parts = [a.village || a.town || a.city || a.hamlet || a.municipality, a.county, a.state].filter(Boolean);
    return parts.length ? parts.slice(0, 2).join(', ') : r.display_name?.split(',').slice(0, 2).join(',') || null;
  });
}

// ---------------------------------------------------------------------------
// Elevation (Open-Meteo, Copernicus DEM 90 m) — free, no key
// ---------------------------------------------------------------------------

/** Elevations (m) for [[lat, lng], ...], batched 100 per request. */
export async function fetchElevations(points, { signal, fetchImpl = fetch } = {}) {
  const out = new Array(points.length).fill(null);
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const params = new URLSearchParams({
      latitude: chunk.map((p) => p[0].toFixed(6)).join(','),
      longitude: chunk.map((p) => p[1].toFixed(6)).join(','),
    });
    const res = await fetchImpl(`${ENDPOINTS.elevation}?${params}`, { signal });
    if (!res.ok) throw new Error(`Elevation request failed (${res.status})`);
    const json = await res.json();
    (json.elevation || []).forEach((e, j) => { out[i + j] = e; });
  }
  return out;
}

/**
 * Build an elevation profile for a line ([lng, lat]...).
 * Gain/loss use a 3 m hysteresis so 90 m DEM noise doesn't inflate them.
 */
export async function profileForLine(coords, { stepM = 40, maxSamples = 200, signal, fetchImpl } = {}) {
  const samples = resampleLine(coords, stepM, maxSamples);
  const eles = await fetchElevations(samples.map((s) => [s.lat, s.lng]), { signal, fetchImpl });
  samples.forEach((s, i) => { s.ele = eles[i]; });
  return summarizeProfile(samples);
}

export function summarizeProfile(samples) {
  const valid = samples.filter((s) => s.ele != null);
  let gain = 0, loss = 0, min = Infinity, max = -Infinity;
  let anchor = valid.length ? valid[0].ele : null;
  const THRESH = 3;
  for (const s of valid) {
    if (s.ele < min) min = s.ele;
    if (s.ele > max) max = s.ele;
    const diff = s.ele - anchor;
    if (diff >= THRESH) { gain += diff; anchor = s.ele; }
    else if (diff <= -THRESH) { loss -= diff; anchor = s.ele; }
  }
  return {
    samples,
    distanceM: samples.length ? samples[samples.length - 1].d : 0,
    gain, loss,
    min: valid.length ? min : null,
    max: valid.length ? max : null,
  };
}
