/**
 * Boot smoke test. Runs the real index.html + app.js inside jsdom with the
 * network, geolocation, canvas and IndexedDB stubbed, then pokes the UI the
 * way a person would. It can't check pixels, but it catches the whole class
 * of "wrong element id / method name / undefined ctx.*" bugs that unit tests
 * of pure modules never see.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const OVERPASS_TRAILS = {
  elements: [
    { type: 'way', id: 101, tags: { highway: 'path', name: 'Smoke Trail', sac_scale: 'hiking' }, geometry: [{ lat: 40.790, lon: -77.860 }, { lat: 40.791, lon: -77.855 }, { lat: 40.792, lon: -77.850 }] },
    { type: 'way', id: 102, tags: { highway: 'path' }, geometry: [{ lat: 40.792, lon: -77.850 }, { lat: 40.795, lon: -77.848 }] },
    { type: 'node', id: 201, lat: 40.7935, lon: -77.851, tags: { natural: 'peak', name: 'Smoke Knob', ele: '600' } },
  ],
};
const PADUS = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', id: 1, properties: { OBJECTID: 1, Unit_Nm: 'Smoke State Forest', MngTp_Desc: 'State', MngNm_Desc: 'PA DCNR', DesTp_Desc: 'State Forest', Pub_Access: 'OA', GAP_Sts: '3', GIS_Acres: 1000, ST_Name: 'Pennsylvania', Category: 'Fee' },
    geometry: { type: 'Polygon', coordinates: [[[-77.87, 40.78], [-77.84, 40.78], [-77.84, 40.80], [-77.87, 40.80], [-77.87, 40.78]]] } }],
};

const fetchLog = [];
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  fetchLog.push(u);
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, blob: async () => new Blob([JSON.stringify(obj)]), text: async () => JSON.stringify(obj) });
  if (u.includes('overpass') || u.includes('interpreter')) return json(OVERPASS_TRAILS);
  if (u.includes('PADUS')) return json(PADUS);
  if (u.includes('nominatim')) return json([{ osm_type: 'node', osm_id: 1, name: 'Tussey Mountain', display_name: 'Tussey Mountain, Centre County, Pennsylvania', lat: '40.75', lon: '-77.8', type: 'peak', class: 'natural', boundingbox: ['40.74', '40.76', '-77.81', '-77.79'], address: { state: 'Pennsylvania', county: 'Centre County' } }]);
  if (u.includes('open-meteo')) { const n = new URL(u).searchParams.get('latitude').split(',').length; return json({ elevation: Array.from({ length: n }, (_, i) => 400 + i * 3) }); }
  // tiles
  return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(64)]) };
}

let window, document, ctx;

before(async () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8')
    .replace(/<script[^>]*src="js\/app.js"[^>]*><\/script>/, '')
    .replace(/<script[^>]*src="vendor\/leaflet\/leaflet.js"[^>]*><\/script>/, '');
  const dom = new JSDOM(html, { url: 'http://localhost:8080/', pretendToBeVisual: true, runScripts: 'outside-only' });
  window = dom.window;
  document = window.document;

  // --- browser API stubs ---
  window.indexedDB = new IDBFactory();
  window.IDBKeyRange = IDBKeyRange;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.fetch = fakeFetch;
  window.navigator.geolocation = { watchPosition: () => 1, clearWatch() {}, getCurrentPosition() {} };
  Object.defineProperty(window.navigator, 'onLine', { value: true, configurable: true });
  window.navigator.storage = { persist: async () => true, estimate: async () => ({ usage: 1000, quota: 1e9 }) };
  window.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({ canvas: this }, { get: (t, k) => (k in t ? t[k] : () => ({ width: 10 })), set: () => true }); };
  window.URL.createObjectURL = () => 'blob:fake';
  window.URL.revokeObjectURL = () => {};
  window.confirm = () => true;
  const mapEl = document.getElementById('map');
  Object.defineProperty(mapEl, 'clientWidth', { value: 800 });
  Object.defineProperty(mapEl, 'clientHeight', { value: 600 });
  window.serviceWorker = undefined;

  // Expose jsdom globals to the ES modules (they read window.* / document.*).
  for (const k of ['window', 'document', 'navigator', 'location', 'HTMLElement', 'HTMLCanvasElement', 'Element', 'Node', 'CustomEvent', 'Event', 'EventTarget', 'DeviceOrientationEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'Blob', 'FileReader', 'indexedDB', 'IDBKeyRange', 'confirm', 'alert', 'matchMedia', 'CSS']) {
    if (window[k] !== undefined) Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
  }
  globalThis.fetch = fakeFetch;
  globalThis.self = window;

  // Leaflet expects to be evaluated with window/document globals.
  const leafletSrc = readFileSync(path.join(ROOT, 'vendor/leaflet/leaflet.js'), 'utf8');
  window.eval(leafletSrc);
  assert.ok(window.L, 'Leaflet loaded');

  await import(pathToFileURL(path.join(ROOT, 'js/app.js')).href);
  // boot() is async; wait for ctx to appear and settle.
  for (let i = 0; i < 100 && !window.trailapp?.areas; i++) await new Promise((r) => setTimeout(r, 20));
  ctx = window.trailapp;
  await new Promise((r) => setTimeout(r, 100));
});

test('app boots: map, layers, panes, sheet', () => {
  assert.ok(ctx, 'ctx exposed');
  assert.ok(ctx.map.getPane('trails'));
  assert.equal(ctx.basemapId, 'opentopo');
  assert.equal(ctx.mode, 'online');
  assert.equal(document.querySelector('#statusText').textContent, 'Online · live map');
  assert.equal(document.querySelectorAll('#basemapList label').length, 8);
  assert.equal(document.querySelectorAll('#poiToggles input').length, 5);
});

test('live trails + boundaries + pois load when zoomed in', async () => {
  ctx.map.setView([40.791, -77.855], 15);
  await ctx.trails.refreshLive(true);
  await ctx.boundaries.refreshLive();
  await ctx.pois.refreshLive();
  assert.equal(ctx.trails.count, 2);
  assert.equal(ctx.boundaries.features.size, 1);
  assert.equal(ctx.pois.features.size, 1);
  assert.ok(fetchLog.some((u) => u.includes('PADUS')));
});

test('tap a trail → detail panel with badges, meta, elevation profile', async () => {
  const f = ctx.trails.features.get(101);
  ctx.onTrailSelect(f, window.L.latLng(40.791, -77.855));
  assert.equal(ctx.sheet.current, 'trail');
  assert.equal(document.querySelector('#trailName').textContent, 'Smoke Trail');
  assert.ok(document.querySelector('#trailBadges').textContent.includes('Hiking (T1)'));
  assert.ok(document.querySelector('#trailOsmLink').href.endsWith('/way/101'));
  document.querySelector('#trailProfileBtn').click();
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(document.querySelector('#trailProfileStats').textContent.includes('Gain'));
  assert.ok((await ctx.store.getElevation('way-101')), 'profile cached');
  const unnamed = ctx.trails.features.get(102);
  ctx.showTrail(unnamed);
  assert.ok(document.querySelector('#trailName').textContent.startsWith('Unnamed'));
  assert.ok(!document.querySelector('#trailWarn').classList.contains('hidden'));
});

test('boundary → use as area → area panel plans a download', async () => {
  const b = [...ctx.boundaries.features.values()][0];
  ctx.onBoundarySelect(b, window.L.latLng(40.79, -77.85));
  assert.equal(ctx.sheet.current, 'boundary');
  assert.equal(document.querySelector('#boundaryName').textContent, 'Smoke State Forest');
  document.querySelector('#boundaryUse').click();
  assert.equal(ctx.sheet.current, 'area');
  assert.equal(document.querySelector('#areaName').value, 'Smoke State Forest');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(/tiles/.test(document.querySelector('#areaEstimate').textContent));
  assert.ok(document.querySelectorAll('#areaZoom option').length >= 3);
});

test('download runs to completion, saved list updates, offline mode locks the map', async () => {
  document.querySelector('#areaZoom').value = '13';
  document.querySelector('#areaZoom').dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 30));
  const done = new Promise((resolve) => ctx.downloader.addEventListener('done', resolve, { once: true }));
  document.querySelector('#areaDownload').click();
  const ev = await done;
  assert.equal(ev.detail.area.status, 'complete');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ctx.areas.length, 1);
  assert.ok(document.querySelector('#savedList').textContent.includes('Smoke State Forest'));
  assert.ok(document.querySelector('#savedList').textContent.includes('Ready'));
  const data = await ctx.store.getAreaData(ctx.areas[0].id);
  assert.equal(data.trails.features.length, 2);
  assert.equal(data.boundaries.features.length, 1);

  await ctx.setMode('offline', ctx.areas[0].id);
  assert.equal(ctx.mode, 'offline');
  assert.equal(ctx.map.getMaxZoom(), 13);
  assert.ok(ctx.map.options.maxBounds, 'pan lock set');
  assert.ok(document.querySelector('#statusText').textContent.includes('Offline mode'));
  assert.equal(ctx.trails.mode, 'snapshot');
  assert.equal(ctx.trails.count, 2, 'snapshot trails rendered');
  assert.ok(ctx.offlineBasemapLayer);

  await ctx.setMode('online');
  assert.equal(ctx.map.options.maxBounds, null);
  assert.equal(ctx.trails.mode, 'live');
});

test('search hits Nominatim and lists loaded trails first', async () => {
  ctx.map.setView([40.791, -77.855], 15);
  await ctx.trails.refreshLive(true);
  document.querySelector('#searchInput').value = 'smoke';
  document.querySelector('#searchForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(ctx.sheet.current, 'results');
  const text = document.querySelector('#resultsList').textContent;
  assert.ok(text.includes('Smoke Trail'), 'loaded trail listed');
  assert.ok(text.includes('Tussey Mountain'), 'geocode result listed');
});

test('routing snaps two taps to the graph and draws a path', async () => {
  document.querySelector('#routeBtn').click();
  assert.ok(ctx.placing, 'placement mode on');
  ctx.map.fire('click', { latlng: window.L.latLng(40.790, -77.860) });
  assert.ok(ctx.placing, 'waiting for end point');
  ctx.map.fire('click', { latlng: window.L.latLng(40.795, -77.848) });
  assert.equal(ctx.sheet.current, 'route');
  assert.ok(document.querySelector('#routeStats').textContent.includes('Distance'));
  assert.equal(document.querySelectorAll('#routeSegments li').length, 2);
  document.querySelector('#routeClear').click();
  assert.equal(document.querySelectorAll('#routeSegments li').length, 0);
});

test('notes: add via tap, edit, list, export', async () => {
  document.querySelector('#noteBtn').click();
  ctx.map.fire('click', { latlng: window.L.latLng(40.7915, -77.853) });
  assert.equal(ctx.sheet.current, 'noteEdit');
  document.querySelector('#noteTitle').value = 'Junction is 50 m north';
  document.querySelector('#noteCategory').value = 'junction';
  document.querySelector('#noteSave').click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctx.annotations.list().length, 1);
  assert.ok(document.querySelector('#notesList').textContent.includes('Junction is 50 m north'));
  assert.equal(ctx.annotations.toGeoJSON().features[0].properties.category, 'junction');
});

test('GPS fix drives the off-trail readout', async () => {
  ctx.gps.start();
  ctx.gps._onFix({ coords: { latitude: 40.7912, longitude: -77.855, accuracy: 8, altitude: 420, heading: null, speed: 0 }, timestamp: Date.now() }, 'watch');
  assert.ok(!document.querySelector('#readout').classList.contains('hidden'));
  const dist = document.querySelector('#readoutDistance').textContent;
  assert.ok(dist === 'On trail' || /ft|m/.test(dist), dist);
  assert.ok(document.querySelector('#readoutSub').textContent.includes('±8 m'));
  ctx.gps.stop();
});

test('settings changes persist', async () => {
  document.querySelector('#setUnits').value = 'metric';
  document.querySelector('#setUnits').dispatchEvent(new window.Event('change'));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ctx.settings.units, 'metric');
  assert.equal(await ctx.store.get('settings', 'units'), 'metric');
});
