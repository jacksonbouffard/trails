import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

import { Store } from '../js/store.js';
import { AreaDownloader } from '../js/downloader.js';
import { LocalBackend, DjangoBackend } from '../js/backend.js';
import { tileKey } from '../js/tiles.js';
import { DEFAULT_SETTINGS } from '../js/config.js';

const SQUARE = { type: 'Polygon', coordinates: [[[-77.9, 40.7], [-77.8, 40.7], [-77.8, 40.8], [-77.9, 40.8], [-77.9, 40.7]]] };

function freshStore() {
  return new Store({ indexedDB: new IDBFactory() });
}

const LAYERS = {
  base: { id: 'base', url: 'https://tiles.test/base/{z}/{x}/{y}.png', minZoom: 1, maxNativeZoom: 16, concurrency: 4, avgTileBytes: 1000 },
  hill: { id: 'hill', url: 'https://tiles.test/hill/{z}/{x}/{y}.png', minZoom: 1, maxNativeZoom: 12, concurrency: 4, avgTileBytes: 500 },
};

/** A fetch that serves 100-byte blobs, with optional scripted failures. */
function fakeFetch({ fail = () => false, missing = () => false, log = [] } = {}) {
  return async (url, opts = {}) => {
    log.push(url);
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (fail(url)) return { ok: false, status: 500, blob: async () => new Blob([]) };
    if (missing(url)) return { ok: false, status: 404 };
    return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(100)]) };
  };
}

let store;
beforeEach(() => { store = freshStore(); });

test('settings load with defaults and persist changes', async () => {
  const s = await store.loadSettings(DEFAULT_SETTINGS);
  assert.equal(s.units, 'imperial');
  await store.setSetting('units', 'metric');
  const s2 = await freshStoreFrom(store).loadSettings(DEFAULT_SETTINGS);
  assert.equal(s2.units, 'metric');
});

function freshStoreFrom(existing) {
  return new Store({ indexedDB: existing._idb });
}

test('tiles are reference-counted across areas', async () => {
  const k = tileKey('base', 14, 1, 2);
  await store.putTile(k, new Blob([new Uint8Array(10)]), 'A');
  await store.refTiles([k], 'B');
  assert.deepEqual([...(await store.hasTiles([k, 'nope']))], [k]);
  let r = await store.unrefTiles([k], 'A');
  assert.deepEqual(r, { deleted: 0, kept: 1, bytesFreed: 0 });
  assert.ok(await store.getTile(k));
  r = await store.unrefTiles([k], 'B');
  assert.equal(r.deleted, 1);
  assert.equal(r.bytesFreed, 10);
  assert.equal(await store.getTile(k), null);
  assert.deepEqual(await store.tileUsage(), { bytes: 0, count: 0 });
});

test('areas, annotations, searches CRUD', async () => {
  await store.saveArea({ id: 'a1', name: 'One', updatedAt: 1 });
  await store.saveArea({ id: 'a2', name: 'Two', updatedAt: 2 });
  const areas = await store.listAreas();
  assert.deepEqual(areas.map((a) => a.id), ['a2', 'a1']);
  await store.saveAreaData('a1', { trails: { features: [1] } });
  assert.equal((await store.getAreaData('a1')).trails.features.length, 1);
  await store.deleteArea('a1');
  assert.equal(await store.getAreaData('a1'), undefined);

  await store.saveAnnotation({ id: 'n1', title: 'Spring', updatedAt: 5 });
  await store.saveAnnotation({ id: 'n2', title: 'Gone', updatedAt: 6, deleted: true });
  assert.deepEqual((await store.listAnnotations()).map((n) => n.id), ['n1']);

  await store.addSearch({ id: 's1', q: 'Tussey', at: 1 });
  await store.addSearch({ id: 's2', q: 'tussey', at: 2 });
  const searches = await store.listSearches();
  assert.equal(searches.length, 1, 'case-insensitive de-dupe');
  assert.equal(searches[0].id, 's2');
});

test('downloader plans, estimates, downloads, reuses and deletes', async () => {
  const log = [];
  const dl = new AreaDownloader({ store, resolveLayer: (id) => LAYERS[id], fetchImpl: fakeFetch({ log }), snapshotData: false });
  const area = dl.plan({ name: 'Test', geometry: SQUARE }, { zoomMin: 10, zoomMax: 13, marginMeters: 0, layerIds: ['base', 'hill'] });
  assert.equal(area.status, 'planned');
  const counts = dl.countTiles(area);
  assert.equal(counts.perLayer.hill.byZoom[13], undefined, 'overlay capped at its native max zoom');
  assert.equal(area.tileCount, counts.total);
  const est = await dl.estimate(area);
  assert.equal(est.tileCount, counts.total);
  assert.equal(est.bytes, counts.perLayer.base.total * 1000 + counts.perLayer.hill.total * 500);

  const events = [];
  dl.addEventListener('progress', (e) => events.push(e.detail.done));
  const done = await dl.run(area);
  assert.equal(done.status, 'complete');
  assert.equal(done.downloadedTiles, area.tileCount);
  assert.equal(done.byteCount, area.tileCount * 100);
  assert.equal(log.length, area.tileCount);
  assert.equal(events[events.length - 1], area.tileCount);
  assert.equal((await store.tileUsage()).count, area.tileCount);

  // A second, overlapping area re-uses every tile without fetching.
  const area2 = dl.plan({ name: 'Same', geometry: SQUARE }, { zoomMin: 10, zoomMax: 12, layerIds: ['base'] });
  const before = log.length;
  await dl.run(area2);
  assert.equal(log.length, before, 'no new fetches');
  assert.equal((await store.getArea(area2.id)).status, 'complete');

  // Deleting the first area keeps tiles the second still references.
  const r = await dl.deleteArea(done);
  assert.equal(r.kept, area2.tileCount);
  assert.equal(r.deleted, area.tileCount - area2.tileCount);
  assert.equal(await store.getArea(area.id), undefined);
});

test('downloader records failures as partial and resumes only the gaps', async () => {
  let failing = true;
  const log = [];
  const dl = new AreaDownloader({ store, resolveLayer: (id) => LAYERS[id], retryDelayMs: 1, snapshotData: false,
    fetchImpl: fakeFetch({ log, fail: (u) => failing && parseInt(u.split('/').pop(), 10) % 7 === 0 }) });
  const area = dl.plan({ name: 'Flaky', geometry: SQUARE }, { zoomMin: 10, zoomMax: 12, layerIds: ['base'] });
  const first = await dl.run(area);
  assert.equal(first.status, 'partial');
  assert.ok(first.failedTiles > 0);
  const failedCount = first.failedTiles;
  failing = false;
  const fetched = log.length;
  const second = await dl.run(first);
  assert.equal(second.status, 'complete');
  assert.equal(second.failedTiles, 0);
  const uniqueRetried = new Set(log.slice(fetched)).size;
  assert.equal(uniqueRetried, failedCount, 'only the failed tiles were re-fetched');
});

test('404 tiles count as done, not failed', async () => {
  const dl = new AreaDownloader({ store, resolveLayer: (id) => LAYERS[id], fetchImpl: fakeFetch({ missing: () => true }), snapshotData: false });
  const area = dl.plan({ name: 'Edge', geometry: SQUARE }, { zoomMin: 11, zoomMax: 11, layerIds: ['base'] });
  const r = await dl.run(area);
  assert.equal(r.status, 'complete');
  assert.equal(r.byteCount, 0);
});

test('pause aborts mid-run and marks the area paused', async () => {
  let n = 0;
  const dl = new AreaDownloader({ store, resolveLayer: (id) => LAYERS[id], snapshotData: false,
    fetchImpl: async (url, opts) => {
      n++;
      if (n === 5) dl.pause('user');
      if (opts.signal?.aborted) { const e = new Error('x'); e.name = 'AbortError'; throw e; }
      return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(5)]) };
    } });
  const area = dl.plan({ name: 'Pause', geometry: SQUARE }, { zoomMin: 10, zoomMax: 13, layerIds: ['base'] });
  const r = await dl.run(area);
  assert.equal(r.status, 'paused');
  assert.ok(r.downloadedTiles < r.tileCount);
  assert.equal(dl.busy, false);
});

test('LocalBackend soft-deletes notes; DjangoBackend mirrors and syncs', async () => {
  const local = new LocalBackend(store);
  await local.saveAnnotation({ id: 'n1', lat: 1, lng: 2, title: 'x', note: '', category: 'other', createdAt: 1 });
  await local.deleteAnnotation('n1');
  assert.equal((await local.listAnnotations()).length, 0);
  assert.equal((await store.listAnnotationsIncludingDeleted()).length, 1, 'kept for sync');

  const calls = [];
  const remote = { areas: [], annotations: [{ id: 'srv1', lat: 3, lng: 4, title: 'From server', note: '', category: 'water', updated_at: new Date(5000).toISOString(), created_at: new Date(4000).toISOString() }] };
  const dj = new DjangoBackend(store, { baseUrl: 'https://api.test/', token: 'T' });
  dj.fetchImpl = async (url, opts) => {
    calls.push([opts.method, url]);
    assert.equal(opts.headers.Authorization, 'Token T');
    if (opts.method === 'GET') {
      const which = url.includes('/areas/') ? remote.areas : remote.annotations;
      return { ok: true, status: 200, json: async () => which };
    }
    if (opts.method === 'DELETE') return { ok: true, status: 204 };
    return { ok: true, status: 200, json: async () => JSON.parse(opts.body) };
  };
  await dj.saveArea({ id: 'a1', name: 'Area', geometry: SQUARE, bounds: {}, zoomMin: 10, zoomMax: 14, layerIds: ['base'], tileCount: 5, byteCount: 999, status: 'complete' });
  const putArea = calls.find(([m, u]) => m === 'PUT' && u.endsWith('/api/areas/a1/'));
  assert.ok(putArea);
  assert.equal((await store.getArea('a1')).dirty, false);

  const r = await dj.sync({ lastSync: null });
  assert.equal(r.pushed, 1, 'the soft-deleted note was pushed as a DELETE');
  assert.ok(calls.some(([m, u]) => m === 'DELETE' && u.endsWith('/api/annotations/n1/')));
  assert.equal((await store.listAnnotationsIncludingDeleted()).length, 1, 'server note pulled, local tombstone hard-deleted');
  assert.equal(r.pulled, 1);
  const pulled = await store.get('annotations', 'srv1');
  assert.equal(pulled.title, 'From server');
  assert.equal(pulled.updatedAt, 5000);
});
