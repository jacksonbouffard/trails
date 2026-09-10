/**
 * OpenStreetMap data via the Overpass API.
 *
 * Overpass is a shared volunteer resource: queries are bbox-scoped,
 * tag-filtered, and only sent when the map settles. Public instances fall
 * over routinely, so requests fail over across several mirrors, and big
 * areas are split into cells so a single query never runs long enough to
 * be killed.
 */

import { ENDPOINTS, DOWNLOAD } from './config.js';
import { lineLengthMeters, bboxString } from './geo.js';

const TRAIL_HIGHWAYS = '^(path|footway|track|bridleway|steps)$';

let endpointIndex = 0;

/** POST a query, failing over across mirrors on network / 429 / 5xx errors. */
export async function overpass(query, { signal, fetchImpl = fetch } = {}) {
  const endpoints = ENDPOINTS.overpass;
  let lastErr = null;
  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    const url = endpoints[(endpointIndex + attempt) % endpoints.length];
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (res.status === 429 || res.status === 504 || res.status === 502 || res.status === 503) {
        lastErr = new Error(`Overpass ${res.status} from ${new URL(url).host}`);
        continue;
      }
      if (!res.ok) throw new Error(`Overpass error ${res.status}`);
      const json = await res.json();
      if (json.remark && /timed out|runtime error/i.test(json.remark)) {
        lastErr = new Error(`Overpass: ${json.remark}`);
        continue;
      }
      endpointIndex = (endpointIndex + attempt) % endpoints.length; // stick with what worked
      return json;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error('Overpass unavailable');
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Trail ways (+ the hiking route relations that use them) in a bbox or radius. */
export function trailQuery({ bbox, around, timeout = 40 }) {
  const area = around ? `(around:${Math.round(around.radius)},${around.lat},${around.lng})` : `(${bboxString(bbox)})`;
  return `[out:json][timeout:${timeout}];
(
  way["highway"~"${TRAIL_HIGHWAYS}"]["foot"!~"^(no|private)$"]["access"!~"^(no|private)$"]${area};
  way["highway"~"${TRAIL_HIGHWAYS}"]["foot"~"^(yes|designated|permissive)$"]${area};
)->.w;
.w out tags geom;
rel(bw.w)["route"~"^(hiking|foot|walking)$"];
out body;`;
}

/** Points of interest useful when trip-planning. */
export function poiQuery({ bbox, timeout = 30 }) {
  const a = `(${bboxString(bbox)})`;
  return `[out:json][timeout:${timeout}];
(
  node["natural"~"^(peak|saddle|spring)$"]${a};
  node["amenity"="drinking_water"]${a};
  node["waterway"="waterfall"]${a};
  nwr["highway"="trailhead"]${a};
  nwr["tourism"~"^(camp_site|wilderness_hut|viewpoint)$"]${a};
  nwr["amenity"="shelter"]["shelter_type"!~"^(public_transport|weather_shelter)$"]${a};
);
out tags center;`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const TRAIL_TAGS = [
  'name', 'ref', 'highway', 'sac_scale', 'trail_visibility', 'surface', 'informal', 'foot', 'bicycle',
  'horse', 'dog', 'incline', 'operator', 'width', 'smoothness', 'tracktype', 'access', 'symbol',
  'osmc:symbol', 'wikipedia', 'wikidata', 'description', 'note', 'lit', 'motor_vehicle', 'atv',
  'snowmobile', 'ski', 'mtb:scale', 'wheelchair', 'abandoned', 'disused',
];

/** Overpass JSON → { trails: FeatureCollection<LineString>, relations: {id: {...}} } */
export function parseTrails(json) {
  const relations = {};
  const wayToRoutes = new Map();
  for (const el of json.elements || []) {
    if (el.type !== 'relation') continue;
    const t = el.tags || {};
    relations[el.id] = { id: el.id, name: t.name || null, ref: t.ref || null, network: t.network || null, symbol: t['osmc:symbol'] || null };
    for (const m of el.members || []) {
      if (m.type !== 'way') continue;
      if (!wayToRoutes.has(m.ref)) wayToRoutes.set(m.ref, []);
      wayToRoutes.get(m.ref).push(el.id);
    }
  }
  const features = [];
  for (const el of json.elements || []) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    const tags = el.tags || {};
    const props = { id: el.id };
    for (const k of TRAIL_TAGS) if (tags[k] != null) props[k] = tags[k];
    const coords = el.geometry.map((pt) => [pt.lon, pt.lat]);
    props.lengthM = lineLengthMeters(coords);
    props.routes = (wayToRoutes.get(el.id) || []).map((rid) => relations[rid]).filter(Boolean);
    features.push({ type: 'Feature', id: el.id, properties: props, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { trails: { type: 'FeatureCollection', features }, relations };
}

const POI_CLASS = [
  ['peak',      (t) => t.natural === 'peak' || t.natural === 'saddle'],
  ['water',     (t) => t.natural === 'spring' || t.amenity === 'drinking_water' || t.waterway === 'waterfall'],
  ['trailhead', (t) => t.highway === 'trailhead'],
  ['camp',      (t) => t.tourism === 'camp_site' || t.tourism === 'wilderness_hut' || t.amenity === 'shelter'],
  ['viewpoint', (t) => t.tourism === 'viewpoint'],
];

function poiSubtype(t) {
  if (t.natural === 'saddle') return 'saddle';
  if (t.natural === 'spring') return 'spring';
  if (t.amenity === 'drinking_water') return 'drinking water';
  if (t.waterway === 'waterfall') return 'waterfall';
  if (t.tourism === 'wilderness_hut') return 'hut';
  if (t.amenity === 'shelter') return t.shelter_type ? t.shelter_type.replace(/_/g, ' ') : 'shelter';
  if (t.tourism === 'camp_site') return 'campsite';
  return null;
}

/** Overpass JSON → FeatureCollection<Point> with `kind` property. */
export function parsePois(json) {
  const features = [];
  for (const el of json.elements || []) {
    const t = el.tags || {};
    const cls = POI_CLASS.find(([, test]) => test(t));
    if (!cls) continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    features.push({
      type: 'Feature',
      id: `${el.type[0]}${el.id}`,
      properties: {
        id: el.id,
        osmType: el.type,
        kind: cls[0],
        subtype: poiSubtype(t),
        name: t.name || null,
        ele: t.ele ? parseFloat(t.ele) : null,
        description: t.description || t.note || null,
        seasonal: t.seasonal || t.intermittent || null,
        drinkable: t.drinking_water || null,
        fee: t.fee || null,
        operator: t.operator || null,
        capacity: t.capacity || null,
      },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------
// High-level fetchers
// ---------------------------------------------------------------------------

export async function fetchTrails({ bbox, around, signal, fetchImpl }) {
  const json = await overpass(trailQuery({ bbox, around }), { signal, fetchImpl });
  return parseTrails(json);
}

export async function fetchPois({ bbox, signal, fetchImpl }) {
  const json = await overpass(poiQuery({ bbox }), { signal, fetchImpl });
  return parsePois(json);
}

/** Split bounds into cells no bigger than cellDeg on a side. */
export function splitBounds(b, cellDeg = DOWNLOAD.overpassCellDeg) {
  const cells = [];
  const nx = Math.max(1, Math.ceil((b.east - b.west) / cellDeg));
  const ny = Math.max(1, Math.ceil((b.north - b.south) / cellDeg));
  const dx = (b.east - b.west) / nx;
  const dy = (b.north - b.south) / ny;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      cells.push({ west: b.west + i * dx, east: b.west + (i + 1) * dx, south: b.south + j * dy, north: b.south + (j + 1) * dy });
    }
  }
  return cells;
}

/**
 * Fetch trails for large bounds cell-by-cell, merging ways by id (a way
 * spanning two cells comes back from both). Reports progress per cell.
 */
export async function fetchTrailsChunked(bounds, { signal, onProgress, fetchImpl, cellDeg } = {}) {
  const cells = splitBounds(bounds, cellDeg);
  const byId = new Map();
  const relations = {};
  let done = 0;
  for (const cell of cells) {
    const { trails, relations: rels } = await fetchTrails({ bbox: cell, signal, fetchImpl });
    for (const f of trails.features) byId.set(f.id, f);
    Object.assign(relations, rels);
    done++;
    onProgress?.(done, cells.length);
  }
  return { trails: { type: 'FeatureCollection', features: [...byId.values()] }, relations };
}

export async function fetchPoisChunked(bounds, { signal, onProgress, fetchImpl, cellDeg } = {}) {
  const cells = splitBounds(bounds, cellDeg);
  const byId = new Map();
  let done = 0;
  for (const cell of cells) {
    const fc = await fetchPois({ bbox: cell, signal, fetchImpl });
    for (const f of fc.features) byId.set(f.id, f);
    done++;
    onProgress?.(done, cells.length);
  }
  return { type: 'FeatureCollection', features: [...byId.values()] };
}
