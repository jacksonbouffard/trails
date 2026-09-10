/**
 * Point-to-point routing over the trail ways currently loaded.
 *
 * OSM ways share node coordinates exactly where they connect, so a graph
 * keyed on rounded coordinates reproduces the network topology without
 * needing node ids (which `out geom` doesn't give us). A* with a haversine
 * heuristic runs in well under a second on tens of thousands of vertices.
 */

import { haversine } from './geo.js';

const KEY_DECIMALS = 6; // ~0.1 m

export function nodeKey(lat, lng) {
  return `${lat.toFixed(KEY_DECIMALS)},${lng.toFixed(KEY_DECIMALS)}`;
}

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export class TrailGraph {
  constructor() {
    this.nodes = new Map();  // key → { lat, lng, edges: [{ to, w, way }] }
    this.grid = new Map();   // coarse spatial index for nearest-node lookups
    this.ways = new Map();
  }

  get size() { return this.nodes.size; }

  _node(lat, lng) {
    const k = nodeKey(lat, lng);
    let n = this.nodes.get(k);
    if (!n) {
      n = { key: k, lat, lng, edges: [] };
      this.nodes.set(k, n);
      const g = gridKey(lat, lng);
      if (!this.grid.has(g)) this.grid.set(g, []);
      this.grid.get(g).push(n);
    }
    return n;
  }

  /** Add a LineString feature (GeoJSON, [lng, lat] coords). */
  addFeature(feature) {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) return;
    const id = feature.properties?.id ?? feature.id;
    if (this.ways.has(id)) return;
    this.ways.set(id, { id, name: feature.properties?.name || null, highway: feature.properties?.highway || null });
    let prev = this._node(coords[0][1], coords[0][0]);
    for (let i = 1; i < coords.length; i++) {
      const cur = this._node(coords[i][1], coords[i][0]);
      const w = haversine([prev.lat, prev.lng], [cur.lat, cur.lng]);
      prev.edges.push({ to: cur, w, way: id });
      cur.edges.push({ to: prev, w, way: id });
      prev = cur;
    }
  }

  addCollection(fc) {
    for (const f of fc.features || []) this.addFeature(f);
  }

  /** Nearest graph node to [lat, lng] within maxM metres, or null. */
  nearestNode(lat, lng, maxM = 300) {
    let best = null, bestD = maxM;
    const cells = neighbourCells(lat, lng, maxM);
    for (const c of cells) {
      const bucket = this.grid.get(c);
      if (!bucket) continue;
      for (const n of bucket) {
        const d = haversine([lat, lng], [n.lat, n.lng]);
        if (d <= bestD) { bestD = d; best = n; }
      }
    }
    return best ? { node: best, distM: bestD } : null;
  }

  /**
   * A* shortest path between two node keys.
   * @returns {{ path: Array<[lat,lng]>, distanceM: number, segments: Array<{id,name,distM}> } | null}
   */
  route(fromKey, toKey) {
    const start = this.nodes.get(fromKey);
    const goal = this.nodes.get(toKey);
    if (!start || !goal) return null;
    if (start === goal) return { path: [[start.lat, start.lng]], distanceM: 0, segments: [] };

    const h = (n) => haversine([n.lat, n.lng], [goal.lat, goal.lng]);
    const g = new Map([[start.key, 0]]);
    const came = new Map();
    const open = new MinHeap();
    open.push({ f: h(start), node: start });
    const closed = new Set();

    while (open.size) {
      const { node } = open.pop();
      if (node === goal) break;
      if (closed.has(node.key)) continue;
      closed.add(node.key);
      const gn = g.get(node.key);
      for (const e of node.edges) {
        const tentative = gn + e.w;
        if (tentative < (g.get(e.to.key) ?? Infinity)) {
          g.set(e.to.key, tentative);
          came.set(e.to.key, { from: node, way: e.way, w: e.w });
          open.push({ f: tentative + h(e.to), node: e.to });
        }
      }
    }
    if (!came.has(goal.key)) return null;

    const path = [];
    const segments = [];
    let cur = goal;
    while (cur !== start) {
      path.push([cur.lat, cur.lng]);
      const step = came.get(cur.key);
      const last = segments[segments.length - 1];
      if (last && last.id === step.way) last.distM += step.w;
      else segments.push({ id: step.way, name: this.ways.get(step.way)?.name || null, distM: step.w });
      cur = step.from;
    }
    path.push([start.lat, start.lng]);
    path.reverse();
    segments.reverse();
    return { path, distanceM: g.get(goal.key), segments };
  }
}

const GRID_DEG = 0.01; // ~1.1 km cells

function gridKey(lat, lng) {
  return `${Math.floor(lat / GRID_DEG)}:${Math.floor(lng / GRID_DEG)}`;
}

function neighbourCells(lat, lng, maxM) {
  const span = Math.ceil(maxM / 111320 / GRID_DEG);
  const cy = Math.floor(lat / GRID_DEG), cx = Math.floor(lng / GRID_DEG);
  const out = [];
  for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) out.push(`${cy + dy}:${cx + dx}`);
  return out;
}
