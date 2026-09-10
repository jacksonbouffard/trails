/**
 * The backend seam.
 *
 * Every read/write of user-owned records (saved areas, notes, tracks) goes
 * through a Backend. `LocalBackend` is IndexedDB only — the default, and all
 * the app needs. `DjangoBackend` keeps the exact same local behaviour and
 * additionally mirrors records to a Django REST API so the list of saved
 * areas / notes survives a phone wipe and can be re-downloaded elsewhere.
 * Tiles never leave the device; only metadata does.
 *
 * Switching backends is a Settings toggle, not a code change. The API
 * contract the Django adapter expects is documented in backend/README.md.
 */

export class LocalBackend {
  constructor(store) { this.store = store; }
  get kind() { return 'local'; }

  listAreas() { return this.store.listAreas(); }
  getArea(id) { return this.store.getArea(id); }
  async saveArea(area) { return this.store.saveArea({ ...area, updatedAt: Date.now(), dirty: true }); }
  async deleteArea(id) { return this.store.deleteArea(id); }

  listAnnotations() { return this.store.listAnnotations(); }
  async saveAnnotation(a) { return this.store.saveAnnotation({ ...a, updatedAt: Date.now(), dirty: true }); }
  async deleteAnnotation(id) {
    // Soft delete so a sync can propagate it; hard-deleted after it's pushed.
    const existing = await this.store.get('annotations', id);
    if (existing) await this.store.saveAnnotation({ ...existing, deleted: true, updatedAt: Date.now(), dirty: true });
  }

  listTracks() { return this.store.listTracks(); }
  async saveTrack(t) { return this.store.saveTrack({ ...t, updatedAt: Date.now(), dirty: true }); }
  deleteTrack(id) { return this.store.deleteTrack(id); }

  /** No-op for local; returns a summary the UI can show. */
  async sync() { return { ok: true, pushed: 0, pulled: 0, skipped: true }; }
}

export class DjangoBackend extends LocalBackend {
  constructor(store, { baseUrl, token }) {
    super(store);
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.token = token || '';
    this.fetchImpl = (...a) => fetch(...a);
  }
  get kind() { return 'django'; }

  async _request(path, { method = 'GET', body } = {}) {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Token ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      credentials: this.token ? 'omit' : 'include',
    });
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`Server ${method} ${path} → ${res.status}`);
    return res.json();
  }

  // Server records only ever carry metadata — strip anything bulky/local.
  static areaPayload(area) {
    const { dirty, downloadedTiles, byteCount, failedTiles, status, dataStatus, interrupted, lastOpenedAt, ...rest } = area;
    return { ...rest, tile_count: area.tileCount, updated_at: new Date(area.updatedAt || Date.now()).toISOString() };
  }
  static areaFromServer(rec, local) {
    return {
      ...(local || {}),
      id: rec.id,
      name: rec.name,
      geometry: rec.geometry,
      bounds: rec.bounds,
      zoomMin: rec.zoomMin ?? rec.zoom_min,
      zoomMax: rec.zoomMax ?? rec.zoom_max,
      marginMeters: rec.marginMeters ?? rec.margin_meters ?? 0,
      layerIds: rec.layerIds ?? rec.layer_ids ?? [],
      tileCount: rec.tileCount ?? rec.tile_count ?? local?.tileCount ?? 0,
      createdAt: rec.created_at ? Date.parse(rec.created_at) : local?.createdAt ?? Date.now(),
      updatedAt: rec.updated_at ? Date.parse(rec.updated_at) : Date.now(),
      status: local?.status || 'planned',
      dataStatus: local?.dataStatus || 'pending',
      downloadedTiles: local?.downloadedTiles || 0,
      byteCount: local?.byteCount || 0,
      origin: local ? local.origin : 'server',
      dirty: false,
    };
  }

  async saveArea(area) {
    const saved = await super.saveArea(area);
    try {
      await this._request(`/api/areas/${saved.id}/`, { method: 'PUT', body: DjangoBackend.areaPayload(saved) });
      await this.store.saveArea({ ...saved, dirty: false });
    } catch (err) {
      console.warn('Area not pushed to server yet (will retry on sync):', err.message);
    }
    return saved;
  }

  async deleteArea(id) {
    await super.deleteArea(id);
    try { await this._request(`/api/areas/${id}/`, { method: 'DELETE' }); }
    catch (err) { console.warn('Server delete deferred:', err.message); }
  }

  async saveAnnotation(a) {
    const saved = await super.saveAnnotation(a);
    try {
      await this._request(`/api/annotations/${saved.id}/`, { method: 'PUT', body: { ...saved, updated_at: new Date(saved.updatedAt).toISOString() } });
      await this.store.saveAnnotation({ ...saved, dirty: false });
    } catch (err) {
      console.warn('Note not pushed to server yet:', err.message);
    }
    return saved;
  }

  async deleteAnnotation(id) {
    await super.deleteAnnotation(id);
    try {
      await this._request(`/api/annotations/${id}/`, { method: 'DELETE' });
      await this.store.deleteAnnotation(id);
    } catch (err) {
      console.warn('Server delete deferred:', err.message);
    }
  }

  async saveTrack(t) {
    const saved = await super.saveTrack(t);
    try {
      await this._request(`/api/tracks/${saved.id}/`, { method: 'PUT', body: { ...saved, updated_at: new Date(saved.updatedAt).toISOString() } });
      await this.store.saveTrack({ ...saved, dirty: false });
    } catch (err) {
      console.warn('Track not pushed to server yet:', err.message);
    }
    return saved;
  }

  /**
   * Two-way sync: push everything marked dirty, pull anything changed on the
   * server since the last sync. Last-write-wins on updatedAt.
   */
  async sync({ lastSync } = {}) {
    let pushed = 0, pulled = 0;

    for (const area of await this.store.listAreas()) {
      if (!area.dirty) continue;
      await this._request(`/api/areas/${area.id}/`, { method: 'PUT', body: DjangoBackend.areaPayload(area) });
      await this.store.saveArea({ ...area, dirty: false });
      pushed++;
    }
    for (const note of await this.store.listAnnotationsIncludingDeleted()) {
      if (!note.dirty) continue;
      if (note.deleted) {
        await this._request(`/api/annotations/${note.id}/`, { method: 'DELETE' });
        await this.store.deleteAnnotation(note.id);
      } else {
        await this._request(`/api/annotations/${note.id}/`, { method: 'PUT', body: { ...note, updated_at: new Date(note.updatedAt).toISOString() } });
        await this.store.saveAnnotation({ ...note, dirty: false });
      }
      pushed++;
    }
    for (const track of await this.store.listTracks()) {
      if (!track.dirty) continue;
      await this._request(`/api/tracks/${track.id}/`, { method: 'PUT', body: { ...track, updated_at: new Date(track.updatedAt).toISOString() } });
      await this.store.saveTrack({ ...track, dirty: false });
      pushed++;
    }

    const since = lastSync ? `?updated_since=${encodeURIComponent(new Date(lastSync).toISOString())}` : '';
    const areas = await this._request(`/api/areas/${since}`);
    for (const rec of areas?.results || areas || []) {
      const local = await this.store.getArea(rec.id);
      if (local && local.updatedAt >= Date.parse(rec.updated_at)) continue;
      await this.store.saveArea(DjangoBackend.areaFromServer(rec, local));
      pulled++;
    }
    const notes = await this._request(`/api/annotations/${since}`);
    for (const rec of notes?.results || notes || []) {
      const local = await this.store.get('annotations', rec.id);
      const remoteAt = Date.parse(rec.updated_at);
      if (local && local.updatedAt >= remoteAt) continue;
      if (rec.deleted) {
        // Deleted on another device (server soft-delete) — drop our copy.
        if (local) await this.store.deleteAnnotation(rec.id);
        continue;
      }
      await this.store.saveAnnotation({
        id: rec.id, lat: rec.lat, lng: rec.lng, title: rec.title, note: rec.note, category: rec.category,
        createdAt: rec.created_at ? Date.parse(rec.created_at) : remoteAt, updatedAt: remoteAt, dirty: false,
      });
      pulled++;
    }
    return { ok: true, pushed, pulled, at: Date.now() };
  }
}

/** Build the backend the settings ask for. */
export function createBackend(store, settings) {
  const cfg = settings?.backend || {};
  if (cfg.mode === 'django' && cfg.baseUrl) return new DjangoBackend(store, cfg);
  return new LocalBackend(store);
}
