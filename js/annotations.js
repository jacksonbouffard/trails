/**
 * Personal notes on the map — "the junction is really 50 m north of the
 * mapped line", "spring was dry in August", and so on. Stored locally
 * through the backend seam (so a Django backend can mirror them), and
 * exportable as GeoJSON.
 */

import { uid } from './geo.js';

const L = window.L;

export const NOTE_CATEGORIES = {
  junction: { label: 'Junction / routefinding', color: '#b0362b', glyph: '<svg viewBox="0 0 20 20"><path d="M10 2v16M4 8l6-6 6 6" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  hazard:   { label: 'Hazard',                  color: '#c8641b', glyph: '<svg viewBox="0 0 20 20"><path d="M10 4v7M10 14v1.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>' },
  water:    { label: 'Water',                   color: '#2f6fb0', glyph: '<svg viewBox="0 0 20 20"><path d="M10 3c2.5 3.5 5 6 5 9a5 5 0 0 1-10 0c0-3 2.5-5.5 5-9z" fill="#fff"/></svg>' },
  camp:     { label: 'Camp',                    color: '#8a5a2b', glyph: '<svg viewBox="0 0 20 20"><path d="M10 4 3 16h14z" fill="none" stroke="#fff" stroke-width="2"/></svg>' },
  view:     { label: 'View',                    color: '#6b4c9a', glyph: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4.5" fill="none" stroke="#fff" stroke-width="2"/><path d="M2 10c3-4 5-6 8-6s5 2 8 6c-3 4-5 6-8 6s-5-2-8-6z" fill="none" stroke="#fff" stroke-width="1.6"/></svg>' },
  other:    { label: 'Note',                    color: '#4f6b3a', glyph: '<svg viewBox="0 0 20 20"><path d="M5 5h10M5 10h10M5 15h6" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>' },
};

function iconFor(note) {
  const cat = NOTE_CATEGORIES[note.category] || NOTE_CATEGORIES.other;
  return L.divIcon({
    className: 'note-marker',
    html: `<span class="note-pin" style="background:${cat.color}">${cat.glyph}</span>`,
    iconSize: [26, 30],
    iconAnchor: [13, 28],
    popupAnchor: [0, -24],
  });
}

export class AnnotationLayer {
  constructor(map, { backend, onSelect } = {}) {
    this.map = map;
    this.backend = backend;
    this.onSelect = onSelect;
    this.notes = new Map();
    this.markers = new Map();
    this.group = L.layerGroup([], { pane: 'annotations' }).addTo(map);
  }

  setBackend(backend) { this.backend = backend; }

  async load() {
    this.group.clearLayers();
    this.markers.clear();
    this.notes.clear();
    for (const n of await this.backend.listAnnotations()) this._place(n);
    return this.notes.size;
  }

  _place(note) {
    this.notes.set(note.id, note);
    const existing = this.markers.get(note.id);
    if (existing) this.group.removeLayer(existing);
    const m = L.marker([note.lat, note.lng], { icon: iconFor(note), pane: 'annotations', title: note.title || 'Note', keyboard: false });
    m.on('click', () => this.onSelect?.(this.notes.get(note.id)));
    this.markers.set(note.id, m);
    m.addTo(this.group);
  }

  async add({ lat, lng, title, note, category }) {
    const rec = { id: uid(), lat, lng, title: title || '', note: note || '', category: category || 'other', createdAt: Date.now(), updatedAt: Date.now() };
    await this.backend.saveAnnotation(rec);
    this._place(rec);
    return rec;
  }

  async update(id, patch) {
    const cur = this.notes.get(id);
    if (!cur) return null;
    const rec = { ...cur, ...patch, updatedAt: Date.now() };
    await this.backend.saveAnnotation(rec);
    this._place(rec);
    return rec;
  }

  async remove(id) {
    await this.backend.deleteAnnotation(id);
    const m = this.markers.get(id);
    if (m) this.group.removeLayer(m);
    this.markers.delete(id);
    this.notes.delete(id);
  }

  list() { return [...this.notes.values()].sort((a, b) => b.updatedAt - a.updatedAt); }

  toGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: this.list().map((n) => ({
        type: 'Feature',
        properties: { id: n.id, title: n.title, note: n.note, category: n.category, createdAt: new Date(n.createdAt).toISOString(), updatedAt: new Date(n.updatedAt).toISOString() },
        geometry: { type: 'Point', coordinates: [n.lng, n.lat] },
      })),
    };
  }

  /** Import a GeoJSON FeatureCollection of points; returns count added. */
  async importGeoJSON(fc) {
    let added = 0;
    for (const f of fc.features || []) {
      if (f.geometry?.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates;
      const p = f.properties || {};
      const rec = {
        id: p.id && !this.notes.has(p.id) ? p.id : uid(),
        lat, lng,
        title: p.title || p.name || '',
        note: p.note || p.description || '',
        category: NOTE_CATEGORIES[p.category] ? p.category : 'other',
        createdAt: p.createdAt ? Date.parse(p.createdAt) : Date.now(),
        updatedAt: Date.now(),
      };
      await this.backend.saveAnnotation(rec);
      this._place(rec);
      added++;
    }
    return added;
  }
}
