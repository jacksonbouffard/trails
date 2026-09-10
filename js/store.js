/**
 * IndexedDB storage layer.
 *
 * IndexedDB rather than the Cache API on purpose: on iOS the Cache API is
 * capped at ~50 MB per partition, while IndexedDB falls under the (much
 * larger) per-origin quota. Tiles blow through 50 MB quickly.
 *
 * Schema — db "trailapp" v2
 *   tiles        key "{layer}/{z}/{x}/{y}"   { blob, size, savedAt, areas: [areaId] }
 *   areas        key id                       saved-area metadata (see downloader.js)
 *   areaData     key areaId                   { trails, boundaries, pois, fetchedAt }
 *   annotations  key id                       personal pins/notes
 *   tracks       key id                       session breadcrumbs
 *   searches     key id                       recent place searches
 *   settings     key name                     arbitrary settings values
 *   elevations   key wayId                    cached elevation profiles
 *
 * Tiles are reference-counted by area (the `areas` array) so overlapping
 * saved areas share tiles and deleting one area never yanks tiles another
 * still needs.
 */

import { DB_NAME, DB_VERSION } from './config.js';

const STORES = ['tiles', 'areas', 'areaData', 'annotations', 'tracks', 'searches', 'settings', 'elevations'];

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export class Store {
  constructor({ indexedDB: idb } = {}) {
    this._idb = idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    this._dbPromise = null;
    this._settingsCache = null;
  }

  open() {
    if (this._dbPromise) return this._dbPromise;
    if (!this._idb) return Promise.reject(new Error('IndexedDB is not available in this browser.'));
    this._dbPromise = new Promise((resolve, reject) => {
      const request = this._idb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (ev) => {
        const db = request.result;
        // v1 (the first scaffold) had 'tiles' keyed by z/x/y and a single
        // 'meta' record. Neither is compatible, so start clean.
        if (ev.oldVersion < 2) {
          for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        }
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Database upgrade blocked by another open tab.'));
    });
    return this._dbPromise;
  }

  async _store(name, mode = 'readonly') {
    const db = await this.open();
    return db.transaction(name, mode).objectStore(name);
  }

  // --- generic helpers -----------------------------------------------------

  async get(store, key) { return req((await this._store(store)).get(key)); }
  async getAll(store) { return req((await this._store(store)).getAll()); }
  async getAllKeys(store, range) { return req((await this._store(store)).getAllKeys(range)); }
  async put(store, key, value) { return req((await this._store(store, 'readwrite')).put(value, key)); }
  async delete(store, key) { return req((await this._store(store, 'readwrite')).delete(key)); }
  async clear(store) { return req((await this._store(store, 'readwrite')).clear()); }
  async count(store) { return req((await this._store(store)).count()); }

  // --- tiles -----------------------------------------------------------------

  async getTile(key) {
    const rec = await this.get('tiles', key);
    return rec ? rec.blob : null;
  }

  /** Which of these keys already exist? → Set of keys. */
  async hasTiles(keys) {
    const found = new Set();
    if (!keys.length) return found;
    const db = await this.open();
    const CHUNK = 2000;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const tx = db.transaction('tiles', 'readonly');
      const os = tx.objectStore('tiles');
      const slice = keys.slice(i, i + CHUNK);
      slice.forEach((k) => {
        const r = os.getKey(k);
        r.onsuccess = () => { if (r.result !== undefined) found.add(k); };
      });
      await txDone(tx);
    }
    return found;
  }

  /** Store a tile blob, attaching it to an area (ref-count). */
  async putTile(key, blob, areaId) {
    const db = await this.open();
    const tx = db.transaction('tiles', 'readwrite');
    const os = tx.objectStore('tiles');
    const existing = await req(os.get(key));
    const areas = new Set(existing?.areas || []);
    if (areaId) areas.add(areaId);
    os.put({ blob, size: blob.size, savedAt: Date.now(), areas: [...areas] }, key);
    await txDone(tx);
    return blob.size;
  }

  /** Attach an already-stored tile to an additional area. */
  async refTiles(keys, areaId) {
    if (!keys.length) return;
    const db = await this.open();
    const CHUNK = 500;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const tx = db.transaction('tiles', 'readwrite');
      const os = tx.objectStore('tiles');
      for (const k of keys.slice(i, i + CHUNK)) {
        const r = os.get(k);
        r.onsuccess = () => {
          const rec = r.result;
          if (!rec) return;
          const areas = new Set(rec.areas || []);
          if (areas.has(areaId)) return;
          areas.add(areaId);
          os.put({ ...rec, areas: [...areas] }, k);
        };
      }
      await txDone(tx);
    }
  }

  /**
   * Detach an area from tiles, deleting tiles that no other area references.
   * @returns {{ deleted: number, kept: number, bytesFreed: number }}
   */
  async unrefTiles(keys, areaId) {
    const result = { deleted: 0, kept: 0, bytesFreed: 0 };
    if (!keys.length) return result;
    const db = await this.open();
    const CHUNK = 500;
    for (let i = 0; i < keys.length; i += CHUNK) {
      const tx = db.transaction('tiles', 'readwrite');
      const os = tx.objectStore('tiles');
      for (const k of keys.slice(i, i + CHUNK)) {
        const r = os.get(k);
        r.onsuccess = () => {
          const rec = r.result;
          if (!rec) return;
          const areas = (rec.areas || []).filter((a) => a !== areaId);
          if (areas.length) {
            os.put({ ...rec, areas }, k);
            result.kept++;
          } else {
            os.delete(k);
            result.deleted++;
            result.bytesFreed += rec.size || 0;
          }
        };
      }
      await txDone(tx);
    }
    return result;
  }

  /** Sum of stored tile bytes (walks the store — fine for tens of thousands). */
  async tileUsage() {
    const db = await this.open();
    const tx = db.transaction('tiles', 'readonly');
    const os = tx.objectStore('tiles');
    let bytes = 0, count = 0;
    await new Promise((resolve, reject) => {
      const cur = os.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        bytes += c.value.size || 0;
        count++;
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
    return { bytes, count };
  }

  // --- areas -----------------------------------------------------------------

  async listAreas() {
    const areas = await this.getAll('areas');
    return areas.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async getArea(id) { return this.get('areas', id); }
  async saveArea(area) {
    const rec = { ...area, updatedAt: area.updatedAt || Date.now() };
    await this.put('areas', rec.id, rec);
    return rec;
  }
  async deleteArea(id) {
    await this.delete('areas', id);
    await this.delete('areaData', id);
  }
  async getAreaData(id) { return this.get('areaData', id); }
  async saveAreaData(id, data) { return this.put('areaData', id, { ...data, areaId: id, fetchedAt: Date.now() }); }

  // --- annotations / tracks / searches --------------------------------------

  async listAnnotations() {
    const all = await this.getAll('annotations');
    return all.filter((a) => !a.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  async listAnnotationsIncludingDeleted() { return this.getAll('annotations'); }
  async saveAnnotation(a) { await this.put('annotations', a.id, a); return a; }
  async deleteAnnotation(id) { return this.delete('annotations', id); }

  async listTracks() { return (await this.getAll('tracks')).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)); }
  async saveTrack(t) { await this.put('tracks', t.id, t); return t; }
  async deleteTrack(id) { return this.delete('tracks', id); }

  async listSearches(limit = 15) {
    const all = await this.getAll('searches');
    return all.sort((a, b) => b.at - a.at).slice(0, limit);
  }
  async addSearch(entry) {
    // De-duplicate on the query text; keep the store small.
    const all = await this.getAll('searches');
    for (const s of all) {
      if (s.q.toLowerCase() === entry.q.toLowerCase()) await this.delete('searches', s.id);
    }
    await this.put('searches', entry.id, entry);
    const remaining = (await this.getAll('searches')).sort((a, b) => b.at - a.at);
    for (const s of remaining.slice(30)) await this.delete('searches', s.id);
  }
  async clearSearches() { return this.clear('searches'); }

  // --- elevations ------------------------------------------------------------

  async getElevation(id) { return this.get('elevations', id); }
  async saveElevation(id, profile) { return this.put('elevations', id, { ...profile, savedAt: Date.now() }); }

  // --- settings --------------------------------------------------------------

  async loadSettings(defaults) {
    const db = await this.open();
    const tx = db.transaction('settings', 'readonly');
    const os = tx.objectStore('settings');
    const keys = await req(os.getAllKeys());
    const values = await req(os.getAll());
    const stored = {};
    keys.forEach((k, i) => { stored[k] = values[i]; });
    this._settingsCache = { ...structuredClone(defaults), ...stored };
    return this._settingsCache;
  }
  getSetting(key, fallback) {
    const v = this._settingsCache ? this._settingsCache[key] : undefined;
    return v === undefined ? fallback : v;
  }
  async setSetting(key, value) {
    if (this._settingsCache) this._settingsCache[key] = value;
    return this.put('settings', key, value);
  }

  // --- whole-store maintenance ----------------------------------------------

  async wipeEverything() {
    const db = await this.open();
    const tx = db.transaction(STORES, 'readwrite');
    for (const name of STORES) tx.objectStore(name).clear();
    await txDone(tx);
    this._settingsCache = null;
  }

  // --- browser storage quota ------------------------------------------------

  async requestPersistence() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.persist) return await navigator.storage.persist();
    } catch { /* ignore */ }
    return false;
  }

  async estimateUsage() {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.estimate) return await navigator.storage.estimate();
    } catch { /* ignore */ }
    return null;
  }
}
