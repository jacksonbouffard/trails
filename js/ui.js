/**
 * UI primitives shared by app.js: tiny DOM helpers, the bottom sheet (with
 * drag-to-snap and a panel back-stack), toasts, and the elevation profile
 * drawing. Nothing here knows about maps or storage.
 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function downloadFile(name, content, type = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastRoot = null;
export function toast(message, { kind = 'info', duration = 3500, action } = {}) {
  if (!toastRoot) toastRoot = $('#toasts');
  const node = el(`<div class="toast toast-${kind}" role="status"><span class="toast-msg"></span></div>`);
  node.querySelector('.toast-msg').textContent = message;
  if (action) {
    const btn = el(`<button type="button" class="toast-action"></button>`);
    btn.textContent = action.label;
    btn.addEventListener('click', () => { action.onClick?.(); node.remove(); });
    node.appendChild(btn);
  }
  toastRoot.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  if (duration > 0) setTimeout(() => { node.classList.remove('show'); setTimeout(() => node.remove(), 250); }, duration);
  return node;
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

const SNAPS = ['peek', 'half', 'full'];

export class Sheet {
  constructor(root, { onPanel } = {}) {
    this.root = root;
    this.handle = $('.sheet-handle', root);
    this.tabs = $$('[data-tab]', root);
    this.panels = new Map($$('[data-panel]', root).map((p) => [p.dataset.panel, p]));
    this.stack = [];
    this.current = null;
    this.snap = 'peek';
    this.onPanel = onPanel;
    this._bindDrag();
    this.tabs.forEach((t) => t.addEventListener('click', () => {
      this.show(t.dataset.tab, { reset: true });
      if (this.snap === 'peek') this.setSnap('half');
    }));
    $$('[data-back]', root).forEach((b) => b.addEventListener('click', () => this.back()));
    this.handle.addEventListener('click', () => this.setSnap(this.snap === 'peek' ? 'half' : 'peek'));
  }

  get isDesktop() { return window.matchMedia('(min-width: 900px)').matches; }

  setSnap(snap) {
    if (!SNAPS.includes(snap)) return;
    this.snap = snap;
    SNAPS.forEach((s) => this.root.classList.toggle(`snap-${s}`, s === snap));
    document.body.classList.toggle('sheet-open', snap !== 'peek');
  }

  /** Show a panel. `reset` clears the back-stack (tab switch); otherwise push. */
  show(id, { reset = false, snap } = {}) {
    if (!this.panels.has(id)) return;
    if (reset) this.stack = [];
    else if (this.current && this.current !== id) this.stack.push(this.current);
    if (this.stack.length > 12) this.stack.shift();
    this._activate(id, snap);
  }

  back() {
    const prev = this.stack.pop();
    this._activate(prev || 'explore', this.snap);
  }

  _activate(id, snap) {
    this.current = id;
    for (const [pid, p] of this.panels) p.classList.toggle('active', pid === id);
    const tabFor = this.panels.get(id).dataset.tabgroup || id;
    this.tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === tabFor));
    if (snap) this.setSnap(snap);
    else if (this.snap === 'peek') this.setSnap('half');
    $('.sheet-body', this.root).scrollTop = 0;
    this.onPanel?.(id);
  }

  _bindDrag() {
    let startY = 0, startSnap = null, dragging = false, moved = false;
    const body = $('.sheet-body', this.root);
    const onStart = (e) => {
      if (this.isDesktop) return;
      // Only drag from the handle/tabs, or from the body when scrolled to top.
      const fromHandle = e.target.closest('.sheet-handle, .tabs');
      if (!fromHandle && !(body.contains(e.target) && body.scrollTop === 0)) return;
      startY = e.touches ? e.touches[0].clientY : e.clientY;
      startSnap = this.snap;
      dragging = true;
      moved = false;
    };
    const onMove = (e) => {
      if (!dragging) return;
      const y = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = y - startY;
      if (Math.abs(dy) > 12) moved = true;
      if (moved && body.contains(e.target) && dy < 0 && body.scrollTop > 0) { dragging = false; return; }
      if (moved && e.cancelable && !(body.contains(e.target) && dy < 0 && this.snap === 'full')) e.preventDefault();
    };
    const onEnd = (e) => {
      if (!dragging) return;
      dragging = false;
      if (!moved) return;
      const y = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
      const dy = y - startY;
      const idx = SNAPS.indexOf(startSnap);
      if (dy < -40) this.setSnap(SNAPS[Math.min(2, idx + 1)]);
      else if (dy > 40) this.setSnap(SNAPS[Math.max(0, idx - 1)]);
    };
    this.root.addEventListener('touchstart', onStart, { passive: true });
    this.root.addEventListener('touchmove', onMove, { passive: false });
    this.root.addEventListener('touchend', onEnd);
  }
}

// ---------------------------------------------------------------------------
// Elevation profile
// ---------------------------------------------------------------------------

/**
 * Draw a profile onto a canvas. `profile` is from services.summarizeProfile;
 * `units` picks feet/miles or metres/km for the axis labels.
 */
export function drawProfile(canvas, profile, { units = 'imperial', accent = '#3f6b3a', ink = '#26221c', muted = '#8a8478' } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 320;
  const cssH = canvas.clientHeight || 140;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const pts = profile.samples.filter((s) => s.ele != null);
  if (pts.length < 2) {
    ctx.fillStyle = muted;
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('No elevation data', 10, cssH / 2);
    return;
  }
  const pad = { l: 40, r: 10, t: 10, b: 22 };
  const w = cssW - pad.l - pad.r, h = cssH - pad.t - pad.b;
  const eleScale = units === 'metric' ? 1 : 3.28084;
  const distScale = units === 'metric' ? 1 / 1000 : 0.000621371;
  const minE = Math.floor((profile.min * eleScale) / 50) * 50;
  const maxE = Math.ceil((profile.max * eleScale) / 50) * 50 || minE + 50;
  const totalD = profile.distanceM;
  const x = (d) => pad.l + (d / totalD) * w;
  const y = (e) => pad.t + h - ((e * eleScale - minE) / (maxE - minE)) * h;

  // gridlines
  ctx.strokeStyle = 'rgba(128,128,128,0.25)';
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = muted;
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const e = minE + ((maxE - minE) * i) / steps;
    const yy = pad.t + h - (i / steps) * h;
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(cssW - pad.r, yy); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(Math.round(e).toLocaleString(), pad.l - 6, yy + 4);
  }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const d = (totalD * i) / 4;
    ctx.fillText((d * distScale).toFixed(1) + (units === 'metric' ? ' km' : ' mi'), x(d), cssH - 6);
  }

  // area + line
  ctx.beginPath();
  ctx.moveTo(x(pts[0].d), y(pts[0].ele));
  for (const p of pts) ctx.lineTo(x(p.d), y(p.ele));
  ctx.lineTo(x(pts[pts.length - 1].d), pad.t + h);
  ctx.lineTo(x(pts[0].d), pad.t + h);
  ctx.closePath();
  ctx.fillStyle = accent + '33';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x(pts[0].d), y(pts[0].ele));
  for (const p of pts) ctx.lineTo(x(p.d), y(p.ele));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();
  void ink;
}
