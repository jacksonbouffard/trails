/**
 * Pure geometry helpers. No DOM, no Leaflet — importable from node tests.
 *
 * Conventions: GeoJSON coordinates are [lng, lat]; "latlng" arguments are
 * [lat, lng] (Leaflet order). Function names say which they take.
 */

export const EARTH_RADIUS = 6371008.8; // metres, mean radius

const DEG = Math.PI / 180;

export function toRad(deg) { return deg * DEG; }

/** Great-circle distance in metres between two [lat, lng] points. */
export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * s2 * s2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Length in metres of a GeoJSON LineString coordinate array ([lng, lat]...). */
export function lineLengthMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversine([coords[i - 1][1], coords[i - 1][0]], [coords[i][1], coords[i][0]]);
  }
  return total;
}

/** Initial bearing in degrees (0-360) from a to b, both [lat, lng]. */
export function bearing(a, b) {
  const φ1 = toRad(a[0]), φ2 = toRad(b[0]);
  const Δλ = toRad(b[1] - a[1]);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassPoint(deg) {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/** Destination point given start [lat, lng], bearing (deg) and distance (m). */
export function destination(start, bearingDeg, distM) {
  const δ = distM / EARTH_RADIUS;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(start[0]), λ1 = toRad(start[1]);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return [φ2 / DEG, ((λ2 / DEG + 540) % 360) - 180];
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

/** Ray-casting test: is [lng, lat] inside a single ring ([lng, lat]...)? */
export function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Point in a Polygon coordinate array (outer ring + holes). */
export function pointInPolygon(pt, polygon) {
  if (!pointInRing(pt, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(pt, polygon[i])) return false;
  }
  return true;
}

/** Point ([lng, lat]) in a GeoJSON Polygon or MultiPolygon geometry. */
export function pointInGeometry(pt, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return pointInPolygon(pt, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((poly) => pointInPolygon(pt, poly));
  return false;
}

/** All rings of a Polygon/MultiPolygon as a flat array of rings. */
export function geometryRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

/** Bounds of any GeoJSON geometry → { south, west, north, east }. */
export function geometryBounds(geometry) {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < west) west = c[0];
      if (c[0] > east) east = c[0];
      if (c[1] < south) south = c[1];
      if (c[1] > north) north = c[1];
    } else {
      c.forEach(visit);
    }
  };
  if (geometry.type === 'GeometryCollection') geometry.geometries.forEach((g) => visit(g.coordinates));
  else visit(geometry.coordinates);
  return { south, west, north, east };
}

/** Bounds of a FeatureCollection. */
export function collectionBounds(fc) {
  let b = null;
  for (const f of fc.features || []) {
    if (!f.geometry) continue;
    const g = geometryBounds(f.geometry);
    b = b ? unionBounds(b, g) : g;
  }
  return b;
}

export function unionBounds(a, b) {
  return {
    south: Math.min(a.south, b.south), west: Math.min(a.west, b.west),
    north: Math.max(a.north, b.north), east: Math.max(a.east, b.east),
  };
}

export function boundsIntersect(a, b) {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

export function boundsContain(outer, inner) {
  return inner.west >= outer.west && inner.east <= outer.east && inner.south >= outer.south && inner.north <= outer.north;
}

/** Expand bounds by a distance in metres (approximate, fine at hiking scales). */
export function bufferBounds(b, metres) {
  const dLat = metres / 111320;
  const midLat = (b.north + b.south) / 2;
  const dLng = metres / (111320 * Math.max(0.05, Math.cos(toRad(midLat))));
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLng, east: b.east + dLng };
}

/** Expand bounds by a fraction of their size (like Leaflet's pad). */
export function padBounds(b, fraction) {
  const dLat = (b.north - b.south) * fraction;
  const dLng = (b.east - b.west) * fraction;
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLng, east: b.east + dLng };
}

export function boundsToPolygon(b) {
  return {
    type: 'Polygon',
    coordinates: [[[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]]],
  };
}

/** Bounds → Overpass bbox string "south,west,north,east". */
export function bboxString(b) {
  return `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
}

/** Approximate planar area (km²) of a Polygon/MultiPolygon — for display only. */
export function geometryAreaKm2(geometry) {
  let total = 0;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  for (const poly of polys) {
    poly.forEach((ring, idx) => {
      const a = Math.abs(ringAreaM2(ring));
      total += idx === 0 ? a : -a;
    });
  }
  return total / 1e6;
}

function ringAreaM2(ring) {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, c) => s + c[1], 0) / ring.length;
  const kx = 111320 * Math.cos(toRad(lat0));
  const ky = 111320;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * kx, yi = ring[i][1] * ky;
    const xj = ring[j][0] * kx, yj = ring[j][1] * ky;
    sum += xj * yi - xi * yj;
  }
  return sum / 2;
}

// ---------------------------------------------------------------------------
// Point-to-line
// ---------------------------------------------------------------------------

/**
 * Nearest point on segment a-b to p, all [lat, lng]. Uses a local
 * equirectangular projection — accurate to well under a metre at the
 * distances that matter for "am I on the trail".
 */
export function nearestPointOnSegment(p, a, b) {
  const kx = 111320 * Math.cos(toRad(p[0]));
  const ky = 111320;
  const ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
  const bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const nx = ax + t * dx, ny = ay + t * dy;
  return {
    point: [p[0] + ny / ky, p[1] + nx / kx],
    dist: Math.sqrt(nx * nx + ny * ny),
    t,
  };
}

/** Nearest point on a GeoJSON line ([lng, lat]...) to p ([lat, lng]). */
export function nearestOnLine(p, coords) {
  let best = null;
  for (let i = 1; i < coords.length; i++) {
    const r = nearestPointOnSegment(p, [coords[i - 1][1], coords[i - 1][0]], [coords[i][1], coords[i][0]]);
    if (!best || r.dist < best.dist) best = { ...r, segment: i - 1 };
  }
  return best;
}

/** Quick rejection helper: distance from p ([lat, lng]) to a bounds box, in metres (0 if inside). */
export function distanceToBounds(p, b) {
  const lat = Math.max(b.south, Math.min(b.north, p[0]));
  const lng = Math.max(b.west, Math.min(b.east, p[1]));
  return haversine(p, [lat, lng]);
}

/**
 * Resample a line ([lng, lat]...) at roughly `stepM` metres, capped at
 * `maxSamples` points. Returns [{ lat, lng, d }] with cumulative distance.
 */
export function resampleLine(coords, stepM = 50, maxSamples = 200) {
  const total = lineLengthMeters(coords);
  if (coords.length === 0) return [];
  const step = Math.max(stepM, total / Math.max(1, maxSamples - 1));
  const out = [{ lng: coords[0][0], lat: coords[0][1], d: 0 }];
  let next = step;
  let cum = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = [coords[i - 1][1], coords[i - 1][0]];
    const b = [coords[i][1], coords[i][0]];
    const seg = haversine(a, b);
    while (seg > 0 && next <= cum + seg) {
      const t = (next - cum) / seg;
      out.push({ lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t, d: next });
      next += step;
    }
    cum += seg;
  }
  const last = coords[coords.length - 1];
  if (out[out.length - 1].d < total - 1) out.push({ lng: last[0], lat: last[1], d: total });
  return out;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const FT_PER_M = 3.28084;
const MI_PER_M = 0.000621371;

export function formatDistance(metres, units = 'imperial') {
  if (metres == null || Number.isNaN(metres)) return '—';
  if (units === 'metric') {
    return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)} km`;
  }
  const ft = metres * FT_PER_M;
  if (ft < 1000) return `${Math.round(ft)} ft`;
  const mi = metres * MI_PER_M;
  return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`;
}

export function formatElevation(metres, units = 'imperial') {
  if (metres == null || Number.isNaN(metres)) return '—';
  return units === 'metric' ? `${Math.round(metres)} m` : `${Math.round(metres * FT_PER_M).toLocaleString()} ft`;
}

export function formatArea(km2, units = 'imperial') {
  if (km2 == null) return '—';
  if (units === 'metric') return `${km2 < 10 ? km2.toFixed(1) : Math.round(km2)} km²`;
  const mi2 = km2 * 0.386102;
  return `${mi2 < 10 ? mi2.toFixed(1) : Math.round(mi2)} mi²`;
}

export function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(minutes) {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? `${h} h ${m.toString().padStart(2, '0')} min` : `${m} min`;
}

/** Naismith's rule with a gentle descent allowance: minutes for a hike. */
export function naismithMinutes(distM, gainM = 0, lossM = 0) {
  return (distM / 1000) * 12 + (gainM / 100) * 10 + (lossM / 300) * 5;
}

/** Cheap unique id (client-generated so records can be upserted server-side). */
export function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
