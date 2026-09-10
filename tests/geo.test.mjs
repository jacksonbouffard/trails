import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  haversine, lineLengthMeters, pointInRing, pointInGeometry, geometryBounds, bufferBounds,
  nearestOnLine, resampleLine, formatDistance, formatBytes, geometryAreaKm2, naismithMinutes, bearing, compassPoint,
} from '../js/geo.js';
import { lon2tile, lat2tile, tile2lon, tile2lat, tilesForGeometry, countTilesForGeometry, tileUrl, tileKey, parseTileKey, sampleTiles } from '../js/tiles.js';
import { TrailGraph, nodeKey } from '../js/graph.js';
import { parseTrails, parsePois, trailQuery, splitBounds } from '../js/overpass.js';
import { summarizeProfile } from '../js/services.js';

// State College, PA ↔ Rothrock-ish square used throughout.
const SQUARE = {
  type: 'Polygon',
  coordinates: [[[-77.9, 40.7], [-77.8, 40.7], [-77.8, 40.8], [-77.9, 40.8], [-77.9, 40.7]]],
};

test('haversine: State College → Philadelphia ≈ 250 km', () => {
  const d = haversine([40.7934, -77.8600], [39.9526, -75.1652]);
  assert.ok(d > 245000 && d < 255000, `got ${d}`);
});

test('lineLengthMeters sums segments', () => {
  const coords = [[-77.86, 40.79], [-77.85, 40.79], [-77.85, 40.80]];
  const len = lineLengthMeters(coords);
  assert.ok(len > 1900 && len < 2000, `got ${len}`);
});

test('bearing + compass point', () => {
  assert.equal(compassPoint(bearing([40, -77], [41, -77])), 'N');
  assert.equal(compassPoint(bearing([40, -77], [40, -76])), 'E');
});

test('point in ring / geometry with holes', () => {
  const ring = SQUARE.coordinates[0];
  assert.equal(pointInRing([-77.85, 40.75], ring), true);
  assert.equal(pointInRing([-77.95, 40.75], ring), false);
  const withHole = { type: 'Polygon', coordinates: [ring, [[-77.86, 40.74], [-77.84, 40.74], [-77.84, 40.76], [-77.86, 40.76], [-77.86, 40.74]]] };
  assert.equal(pointInGeometry([-77.85, 40.75], withHole), false, 'inside hole');
  assert.equal(pointInGeometry([-77.81, 40.71], withHole), true);
  const multi = { type: 'MultiPolygon', coordinates: [SQUARE.coordinates, [[[-78.5, 41], [-78.4, 41], [-78.4, 41.1], [-78.5, 41]]]] };
  assert.equal(pointInGeometry([-78.45, 41.02], multi), true);
});

test('geometryBounds + bufferBounds', () => {
  const b = geometryBounds(SQUARE);
  assert.deepEqual(b, { south: 40.7, west: -77.9, north: 40.8, east: -77.8 });
  const bb = bufferBounds(b, 1000);
  assert.ok(bb.north > b.north && bb.south < b.south && bb.east > b.east && bb.west < b.west);
  assert.ok(Math.abs((bb.north - b.north) - 1000 / 111320) < 1e-6);
});

test('geometryAreaKm2 of a 0.1° square near 40.75° N ≈ 94 km²', () => {
  const a = geometryAreaKm2(SQUARE);
  assert.ok(a > 90 && a < 98, `got ${a}`);
});

test('nearestOnLine returns distance and snapped point', () => {
  const line = [[-77.86, 40.79], [-77.84, 40.79]];
  const r = nearestOnLine([40.7905, -77.85], line);
  assert.ok(r.dist > 50 && r.dist < 60, `got ${r.dist}`);
  assert.ok(Math.abs(r.point[0] - 40.79) < 1e-6);
  assert.equal(r.segment, 0);
});

test('resampleLine spaces samples and ends on the last vertex', () => {
  const line = [[-77.86, 40.79], [-77.84, 40.79]]; // ~1.7 km
  const s = resampleLine(line, 100, 500);
  assert.ok(s.length > 15 && s.length < 20, `got ${s.length}`);
  assert.equal(s[0].d, 0);
  assert.ok(Math.abs(s[s.length - 1].lng - -77.84) < 1e-9);
  const capped = resampleLine(line, 10, 20);
  assert.ok(capped.length <= 21);
});

test('formatters', () => {
  assert.equal(formatDistance(1609.34), '1.00 mi');
  assert.equal(formatDistance(150), '492 ft');
  assert.equal(formatDistance(1500, 'metric'), '1.50 km');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.ok(naismithMinutes(5000, 600) > 119 && naismithMinutes(5000, 600) < 121);
});

test('summarizeProfile applies hysteresis to gain/loss', () => {
  const samples = [100, 101, 102, 101, 110, 109, 120, 100].map((ele, i) => ({ d: i * 50, ele, lat: 0, lng: 0 }));
  const p = summarizeProfile(samples);
  assert.equal(p.gain, 20);
  assert.equal(p.loss, 20);
  assert.equal(p.min, 100);
  assert.equal(p.max, 120);
});

// --- tiles ---------------------------------------------------------------

test('tile math round-trips', () => {
  const z = 14;
  const x = lon2tile(-77.86, z), y = lat2tile(40.79, z);
  assert.ok(tile2lon(x, z) <= -77.86 && tile2lon(x + 1, z) > -77.86);
  assert.ok(tile2lat(y, z) >= 40.79 && tile2lat(y + 1, z) < 40.79);
  assert.equal(tileUrl('https://{s}.example/{z}/{x}/{y}.png?k={key}', { z, x, y }, { subdomains: ['a', 'b'], key: 'K' }), `https://${['a', 'b'][(x + y) % 2]}.example/${z}/${x}/${y}.png?k=K`);
  assert.deepEqual(parseTileKey(tileKey('esri-topo', z, x, y)), { layerId: 'esri-topo', z, x, y });
});

test('tilesForGeometry covers a square exactly like the bbox does', () => {
  const tiles = tilesForGeometry(SQUARE, 12, 14);
  const b = geometryBounds(SQUARE);
  let expected = 0;
  for (let z = 12; z <= 14; z++) {
    expected += (lon2tile(b.east, z) - lon2tile(b.west, z) + 1) * (lat2tile(b.south, z) - lat2tile(b.north, z) + 1);
  }
  assert.equal(tiles.length, expected);
  assert.equal(countTilesForGeometry(SQUARE, 12, 14).total, expected);
  assert.equal(tiles[0].z, 12, 'low zoom first');
});

test('tilesForGeometry clips to the polygon, not its bbox', () => {
  // A thin diagonal sliver: bbox-based enumeration would grab far more tiles.
  const sliver = { type: 'Polygon', coordinates: [[[-78.0, 40.5], [-77.99, 40.5], [-77.5, 41.0], [-77.51, 41.0], [-78.0, 40.5]]] };
  const clipped = countTilesForGeometry(sliver, 14, 14).total;
  const bb = geometryBounds(sliver);
  const bboxCount = (lon2tile(bb.east, 14) - lon2tile(bb.west, 14) + 1) * (lat2tile(bb.south, 14) - lat2tile(bb.north, 14) + 1);
  assert.ok(clipped < bboxCount / 4, `clipped ${clipped} vs bbox ${bboxCount}`);
  assert.ok(clipped > 20);
});

test('margin grows the tile set; holes are respected', () => {
  const base = countTilesForGeometry(SQUARE, 14, 14).total;
  const padded = countTilesForGeometry(SQUARE, 14, 14, { marginMeters: 1000 }).total;
  assert.ok(padded > base);
  const withHole = { type: 'Polygon', coordinates: [SQUARE.coordinates[0], [[-77.87, 40.72], [-77.83, 40.72], [-77.83, 40.78], [-77.87, 40.78], [-77.87, 40.72]]] };
  const holey = countTilesForGeometry(withHole, 15, 15).total;
  assert.ok(holey < countTilesForGeometry(SQUARE, 15, 15).total);
});

test('sampleTiles picks a spread capped at count', () => {
  const tiles = tilesForGeometry(SQUARE, 10, 14);
  const s = sampleTiles(tiles, 10);
  assert.equal(s.length, 10);
  assert.ok(s.every((t) => tiles.includes(t)));
  assert.equal(sampleTiles(tiles.slice(0, 3), 10).length, 3);
});

// --- overpass parsing --------------------------------------------------------

const OVERPASS_JSON = {
  elements: [
    { type: 'way', id: 1, tags: { highway: 'path', name: 'Ridge Trail', sac_scale: 'hiking' }, geometry: [{ lat: 40.79, lon: -77.86 }, { lat: 40.79, lon: -77.85 }] },
    { type: 'way', id: 2, tags: { highway: 'path' }, geometry: [{ lat: 40.79, lon: -77.85 }, { lat: 40.80, lon: -77.85 }] },
    { type: 'way', id: 3, tags: { highway: 'track' }, geometry: [{ lat: 40.81, lon: -77.80 }, { lat: 40.82, lon: -77.80 }] },
    { type: 'relation', id: 9, tags: { route: 'hiking', name: 'Mid State Trail', ref: 'MST' }, members: [{ type: 'way', ref: 1, role: '' }, { type: 'way', ref: 2, role: '' }] },
    { type: 'node', id: 5, lat: 40.795, lon: -77.855, tags: { natural: 'peak', name: 'Big Knob', ele: '610' } },
    { type: 'way', id: 6, center: { lat: 40.79, lon: -77.84 }, tags: { tourism: 'camp_site', name: 'Site 4' } },
    { type: 'node', id: 7, lat: 40.7, lon: -77.8, tags: { amenity: 'shelter', shelter_type: 'lean_to' } },
  ],
};

test('parseTrails normalises tags, computes length, attaches route relations', () => {
  const { trails, relations } = parseTrails(OVERPASS_JSON);
  assert.equal(trails.features.length, 3);
  const f = trails.features[0];
  assert.equal(f.properties.name, 'Ridge Trail');
  assert.ok(f.properties.lengthM > 800 && f.properties.lengthM < 900);
  assert.equal(f.properties.routes[0].name, 'Mid State Trail');
  assert.equal(trails.features[2].properties.routes.length, 0);
  assert.equal(relations[9].ref, 'MST');
});

test('parsePois classifies kinds and uses centers for ways', () => {
  const fc = parsePois(OVERPASS_JSON);
  const kinds = fc.features.map((f) => f.properties.kind).sort();
  assert.deepEqual(kinds, ['camp', 'camp', 'peak']);
  const camp = fc.features.find((f) => f.properties.name === 'Site 4');
  assert.deepEqual(camp.geometry.coordinates, [-77.84, 40.79]);
  assert.equal(fc.features.find((f) => f.properties.kind === 'peak').properties.ele, 610);
  assert.equal(fc.features.find((f) => f.properties.subtype === 'lean to').properties.kind, 'camp');
});

test('trailQuery builds bbox and radius forms', () => {
  const q1 = trailQuery({ bbox: { south: 40.7, west: -77.9, north: 40.8, east: -77.8 } });
  assert.ok(q1.includes('(40.700000,-77.900000,40.800000,-77.800000)'));
  assert.ok(q1.includes('rel(bw.w)'));
  const q2 = trailQuery({ around: { lat: 40.79, lng: -77.86, radius: 5000 } });
  assert.ok(q2.includes('(around:5000,40.79,-77.86)'));
});

test('splitBounds cells cover the parent', () => {
  const cells = splitBounds({ south: 40, west: -78, north: 40.6, east: -77.4 }, 0.25);
  assert.equal(cells.length, 9);
  assert.ok(cells.every((c) => c.north - c.south <= 0.25 + 1e-9));
});

// --- routing graph ----------------------------------------------------------

test('TrailGraph routes across connected ways and reports segments', () => {
  const { trails } = parseTrails(OVERPASS_JSON);
  const g = new TrailGraph();
  g.addCollection(trails);
  const start = g.nearestNode(40.79, -77.86, 100);
  const end = g.nearestNode(40.80, -77.85, 100);
  assert.ok(start && end);
  const r = g.route(start.node.key, end.node.key);
  assert.ok(r, 'route found');
  assert.equal(r.path.length, 3);
  assert.ok(r.distanceM > 1900 && r.distanceM < 2000);
  assert.deepEqual(r.segments.map((s) => s.id), [1, 2]);
  assert.equal(r.segments[0].name, 'Ridge Trail');
  // The lone track (way 3) is disconnected.
  const far = g.nearestNode(40.81, -77.80, 100);
  assert.equal(g.route(start.node.key, far.node.key), null);
  assert.equal(g.nearestNode(45, -100, 300), null);
  assert.equal(nodeKey(40.79, -77.86), '40.790000,-77.860000');
});
