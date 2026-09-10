/**
 * Saves an area for offline use: basemap (and optional overlay) tiles into
 * IndexedDB, plus a snapshot of the vector data (trails, boundaries, POIs)
 * for the same footprint.
 *
 * Resumable by design — a job records progress in the area's meta record,
 * skips tiles that already exist (from an earlier attempt or an overlapping
 * area), and can be paused/cancelled through an AbortController. A dropped
 * connection marks the area `interrupted` so the app can pick it back up
 * when the network returns.
 *
 * Area meta record (stored in `areas`):
 * {
 *   id, name, geometry, bounds, zoomMin, zoomMax, marginMeters,
 *   layerIds: ['opentopo', 'esri-hillshade'],
 *   tileCount, downloadedTiles, byteCount, failedTiles,
 *   status: 'planned'|'downloading'|'paused'|'complete'|'partial'|'interrupted',
 *   dataStatus: 'pending'|'complete'|'partial',
 *   createdAt, updatedAt, lastOpenedAt, origin: 'local'|'server', dirty
 * }
 */

import { DOWNLOAD } from './config.js';
import { geometryBounds, bufferBounds, uid } from './geo.js';
import { tilesForGeometry, countTilesForGeometry, tileKey, tileUrl, sampleTiles } from './tiles.js';
import { fetchTrailsChunked, fetchPoisChunked } from './overpass.js';
import { fetchBoundaries } from './services.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AreaDownloader extends EventTarget {
  /**
   * @param {object} deps
   * @param {import('./store.js').Store} deps.store
   * @param {(id:string)=>object|null} deps.resolveLayer  id → { url, subdomains, key, minZoom, maxNativeZoom, concurrency, avgTileBytes }
   * @param {typeof fetch} [deps.fetchImpl]
   * @param {boolean} [deps.snapshotData]  fetch trails/boundaries/POIs (default true)
   */
  constructor({ store, resolveLayer, fetchImpl, snapshotData = true, retryDelayMs = 750 }) {
    super();
    this.store = store;
    this.resolveLayer = resolveLayer;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this.snapshotData = snapshotData;
    this.retryDelayMs = retryDelayMs;
    this.job = null;
    this.sampledAvg = new Map(); // layerId → bytes/tile from sampling
  }

  get busy() { return !!this.job; }

  // --- planning ------------------------------------------------------------

  /** Build (but don't save) an area record from a selection. */
  plan(selection, { zoomMin, zoomMax, marginMeters = 0, layerIds, name }) {
    const bounds = bufferBounds(geometryBounds(selection.geometry), marginMeters);
    const area = {
      id: uid(),
      name: name || selection.name || 'Saved area',
      geometry: selection.geometry,
      bounds,
      zoomMin, zoomMax, marginMeters,
      layerIds: [...layerIds],
      tileCount: 0, downloadedTiles: 0, byteCount: 0, failedTiles: 0,
      status: 'planned', dataStatus: 'pending',
      createdAt: Date.now(), updatedAt: Date.now(), lastOpenedAt: null,
      origin: 'local', dirty: true,
    };
    area.tileCount = this.countTiles(area).total;
    return area;
  }

  /** Tile counts for an area across its layers → { total, perLayer: {id: {total, byZoom}} }. */
  countTiles(area) {
    const perLayer = {};
    let total = 0;
    for (const id of area.layerIds) {
      const layer = this.resolveLayer(id);
      if (!layer) continue;
      const zMax = Math.min(area.zoomMax, layer.maxNativeZoom ?? area.zoomMax);
      const zMin = Math.max(area.zoomMin, layer.minZoom ?? 0);
      const c = zMax >= zMin ? countTilesForGeometry(area.geometry, zMin, zMax, { marginMeters: area.marginMeters }) : { total: 0, byZoom: {} };
      perLayer[id] = c;
      total += c.total;
    }
    return { total, perLayer };
  }

  /** All tiles for an area → [{ layerId, z, x, y, key }]. */
  tilesForArea(area) {
    const out = [];
    for (const id of area.layerIds) {
      const layer = this.resolveLayer(id);
      if (!layer) continue;
      const zMax = Math.min(area.zoomMax, layer.maxNativeZoom ?? area.zoomMax);
      const zMin = Math.max(area.zoomMin, layer.minZoom ?? 0);
      if (zMax < zMin) continue;
      for (const t of tilesForGeometry(area.geometry, zMin, zMax, { marginMeters: area.marginMeters })) {
        out.push({ layerId: id, ...t, key: tileKey(id, t.z, t.x, t.y) });
      }
    }
    return out;
  }

  /**
   * Estimate download size. With `sample: true`, fetches a handful of real
   * tiles per layer to measure average bytes instead of trusting the
   * configured guess.
   */
  async estimate(area, { sample = false, signal } = {}) {
    const counts = this.countTiles(area);
    const perLayer = {};
    let bytes = 0;
    let sampled = false;
    for (const id of area.layerIds) {
      const layer = this.resolveLayer(id);
      const count = counts.perLayer[id]?.total || 0;
      let avg = this.sampledAvg.get(id) || layer?.avgTileBytes || 30000;
      if (sample && !this.sampledAvg.has(id) && count > 0 && layer?.url) {
        const measured = await this._sampleLayer(area, id, layer, signal);
        if (measured) { avg = measured; this.sampledAvg.set(id, measured); }
      }
      if (this.sampledAvg.has(id)) sampled = true;
      perLayer[id] = { count, avg, bytes: count * avg };
      bytes += count * avg;
    }
    return { tileCount: counts.total, bytes, sampled, perLayer, byZoom: counts.perLayer };
  }

  async _sampleLayer(area, id, layer, signal) {
    const zMax = Math.min(area.zoomMax, layer.maxNativeZoom ?? area.zoomMax);
    const zMin = Math.max(area.zoomMin, layer.minZoom ?? 0);
    if (zMax < zMin) return null;
    const tiles = tilesForGeometry(area.geometry, zMin, zMax, { marginMeters: area.marginMeters });
    const picks = sampleTiles(tiles, DOWNLOAD.sampleTiles);
    const sizes = [];
    await Promise.all(picks.map(async (t) => {
      try {
        const res = await this.fetchImpl(tileUrl(layer.url, t, layer), { signal });
        if (res.ok) sizes.push((await res.blob()).size);
      } catch { /* skip */ }
    }));
    if (sizes.length < 3) return null;
    return Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
  }

  // --- running -------------------------------------------------------------

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Start (or resume) downloading an area. Resolves when the job ends. */
  async run(area, { skipData = false } = {}) {
    if (this.job) throw new Error('A download is already running.');
    const job = { area, abort: new AbortController(), reason: null, saveTimer: 0 };
    this.job = job;
    const { signal } = job.abort;

    try {
      area.status = 'downloading';
      area.interrupted = false;
      await this.store.saveArea(area);
      await this.store.requestPersistence();

      if (this.snapshotData && !skipData && area.dataStatus !== 'complete') {
        await this._snapshotData(area, signal);
        await this.store.saveArea(area);
      }

      const tiles = this.tilesForArea(area);
      area.tileCount = tiles.length;
      const existing = await this.store.hasTiles(tiles.map((t) => t.key));
      const reuse = tiles.filter((t) => existing.has(t.key)).map((t) => t.key);
      await this.store.refTiles(reuse, area.id);
      const queue = tiles.filter((t) => !existing.has(t.key));

      const progress = { done: existing.size, total: tiles.length, failed: 0, bytes: area.byteCount || 0 };
      area.downloadedTiles = progress.done;
      area.failedTiles = 0;
      this._emit('progress', { area, ...progress, phase: 'tiles' });

      let idx = 0;
      let lastEmit = 0;
      let rate429Until = 0;
      const concurrency = Math.max(1, Math.min(...area.layerIds.map((id) => this.resolveLayer(id)?.concurrency || 4)));

      const worker = async () => {
        while (idx < queue.length && !signal.aborted) {
          const t = queue[idx++];
          const layer = this.resolveLayer(t.layerId);
          if (!layer?.url) { progress.done++; continue; }
          if (Date.now() < rate429Until) await sleep(rate429Until - Date.now());
          let result;
          try {
            result = await this._fetchTile(tileUrl(layer.url, t, layer), signal, () => { rate429Until = Date.now() + 4000; });
          } catch (err) {
            if (err.name === 'AbortError' || signal.aborted) break;
            throw err;
          }
          if (signal.aborted) break;
          if (result === 'failed') {
            progress.failed++;
          } else if (result) {
            const size = await this.store.putTile(t.key, result, area.id);
            progress.bytes += size;
          }
          progress.done++;
          const now = Date.now();
          if (now - lastEmit > 200 || progress.done === progress.total) {
            lastEmit = now;
            area.downloadedTiles = progress.done;
            area.byteCount = progress.bytes;
            area.failedTiles = progress.failed;
            this._emit('progress', { area, ...progress, phase: 'tiles' });
          }
          if (progress.done % 200 === 0) await this.store.saveArea(area);
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));

      area.downloadedTiles = progress.done;
      area.byteCount = progress.bytes;
      area.failedTiles = progress.failed;
      if (signal.aborted) {
        area.status = job.reason === 'offline' ? 'interrupted' : 'paused';
        area.interrupted = job.reason === 'offline';
      } else {
        area.status = progress.failed === 0 && area.dataStatus !== 'partial' ? 'complete' : 'partial';
      }
      area.updatedAt = Date.now();
      area.dirty = true;
      await this.store.saveArea(area);
      this._emit('done', { area, ...progress });
      return area;
    } catch (err) {
      if (err.name !== 'AbortError') {
        area.status = 'partial';
        area.updatedAt = Date.now();
        await this.store.saveArea(area).catch(() => {});
        this._emit('error', { area, error: err });
      }
      throw err;
    } finally {
      this.job = null;
    }
  }

  pause(reason = 'user') {
    if (!this.job) return;
    this.job.reason = reason;
    this.job.abort.abort();
  }

  /** Abort the running job and mark it cancelled. Caller decides whether to delete. */
  cancel() { this.pause('cancel'); }

  async _fetchTile(url, signal, on429) {
    for (let attempt = 0; attempt <= DOWNLOAD.retries; attempt++) {
      try {
        const res = await this.fetchImpl(url, { signal });
        if (res.status === 404) return null;           // genuinely no tile here (e.g. outside coverage)
        if (res.ok) return await res.blob();
        if (res.status === 429) on429?.();
        if (res.status === 429 || res.status >= 500) {
          await sleep(this.retryDelayMs * Math.pow(2, attempt));
          continue;
        }
        return 'failed';
      } catch (err) {
        if (err.name === 'AbortError' || signal.aborted) throw err;
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          this.job && (this.job.reason = 'offline');
          this.job?.abort.abort();
          throw err;
        }
        await sleep(this.retryDelayMs * Math.pow(2, attempt));
      }
    }
    return 'failed';
  }

  async _snapshotData(area, signal) {
    const data = { trails: null, boundaries: null, pois: null, relations: {} };
    let partial = false;
    this._emit('progress', { area, phase: 'data', label: 'Fetching trails…' });
    try {
      const { trails, relations } = await fetchTrailsChunked(area.bounds, {
        signal, fetchImpl: this.fetchImpl,
        onProgress: (d, n) => this._emit('progress', { area, phase: 'data', label: `Fetching trails… ${d}/${n}` }),
      });
      data.trails = trails;
      data.relations = relations;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      partial = true;
      data.trails = { type: 'FeatureCollection', features: [] };
    }
    this._emit('progress', { area, phase: 'data', label: 'Fetching boundaries…' });
    try {
      data.boundaries = await fetchBoundaries(area.bounds, { zoom: 15, includeClosed: true, signal, fetchImpl: this.fetchImpl, maxPages: 10 });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      partial = true;
      data.boundaries = { type: 'FeatureCollection', features: [] };
    }
    this._emit('progress', { area, phase: 'data', label: 'Fetching peaks, water, trailheads…' });
    try {
      data.pois = await fetchPoisChunked(area.bounds, { signal, fetchImpl: this.fetchImpl });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      partial = true;
      data.pois = { type: 'FeatureCollection', features: [] };
    }
    await this.store.saveAreaData(area.id, data);
    area.dataStatus = partial ? 'partial' : 'complete';
    area.trailCount = data.trails.features.length;
  }

  // --- deletion ------------------------------------------------------------

  /** Remove an area and any tiles no other area still references. */
  async deleteArea(area) {
    const keys = this.tilesForArea(area).map((t) => t.key);
    const result = await this.store.unrefTiles(keys, area.id);
    await this.store.deleteArea(area.id);
    return result;
  }
}
