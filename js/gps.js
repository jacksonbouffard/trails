/**
 * Live position. Deliberately not a fitness tracker: no pace, no stats.
 * What it does do — battery-consciously:
 *   - continuous watchPosition while the phone is actually moving,
 *   - a slow getCurrentPosition poll (20 s → 120 s) once it has been
 *     stationary for a while, snapping back to continuous on movement,
 *   - nothing at all while the page is hidden (iOS suspends it anyway).
 * Emits 'position' events; the app turns those into the off-trail readout.
 */

import { PALETTE } from './config.js';
import { haversine } from './geo.js';

const L = window.L;

const MOVE_THRESHOLD_M = 15;
const STILL_FIXES = 6;
const POLL_MIN_MS = 20000;
const POLL_MAX_MS = 120000;

export class GpsTracker extends EventTarget {
  constructor(map, { batterySaver = () => true } = {}) {
    super();
    this.map = map;
    this.batterySaver = batterySaver;
    this.running = false;
    this.position = null;
    this.watchId = null;
    this.pollTimer = 0;
    this.pollInterval = POLL_MIN_MS;
    this.stillCount = 0;
    this.anchor = null;
    this.follow = false;
    this.breadcrumbOn = false;
    this.breadcrumbPoints = [];
    this.headingDeg = null;
    this.compassOn = false;

    this.accuracyCircle = L.circle([0, 0], { pane: 'gps', radius: 0, color: PALETTE.gps, weight: 1, opacity: 0.5, fillOpacity: 0.08, interactive: false });
    this.marker = L.marker([0, 0], {
      pane: 'gps', keyboard: false, interactive: false,
      icon: L.divIcon({ className: 'gps-marker', html: '<span class="gps-heading"></span><span class="gps-dot"></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
    });
    this.breadcrumb = L.polyline([], { pane: 'gps', color: PALETTE.gps, weight: 3, opacity: 0.6, dashArray: '1 7', lineCap: 'round', interactive: false });

    this._onVisibility = () => {
      if (!this.running) return;
      if (document.hidden) this._stopSources();
      else this._startWatch();
    };
    this._onOrientation = (e) => {
      const deg = e.webkitCompassHeading ?? (e.alpha != null ? 360 - e.alpha : null);
      if (deg == null) return;
      this.headingDeg = deg;
      this._renderHeading();
    };
  }

  get available() { return typeof navigator !== 'undefined' && !!navigator.geolocation; }

  start() {
    if (!this.available) { this._emit('error', { message: 'Location is not available in this browser.' }); return; }
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this._onVisibility);
    this._startWatch();
    this._emit('state', { running: true });
  }

  stop() {
    this.running = false;
    this._stopSources();
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.map.removeLayer(this.marker);
    this.map.removeLayer(this.accuracyCircle);
    this._emit('state', { running: false });
  }

  toggle() { this.running ? this.stop() : this.start(); }

  _startWatch() {
    this._stopSources();
    this.stillCount = 0;
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onFix(pos, 'watch'),
      (err) => this._emit('error', { message: describeGeoError(err), code: err.code }),
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
    );
  }

  _startPolling() {
    this._stopSources();
    const poll = () => {
      navigator.geolocation.getCurrentPosition(
        (pos) => this._onFix(pos, 'poll'),
        (err) => this._emit('error', { message: describeGeoError(err), code: err.code }),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
      );
      this.pollInterval = Math.min(POLL_MAX_MS, this.pollInterval * 1.5);
      this.pollTimer = setTimeout(poll, this.pollInterval);
    };
    this.pollTimer = setTimeout(poll, this.pollInterval);
    this._emit('mode', { mode: 'polling', interval: this.pollInterval });
  }

  _stopSources() {
    if (this.watchId != null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = 0; }
  }

  _onFix(pos, source) {
    const c = pos.coords;
    const fix = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, altitude: c.altitude, heading: c.heading, speed: c.speed, ts: pos.timestamp || Date.now() };
    const moved = this.anchor ? haversine([this.anchor.lat, this.anchor.lng], [fix.lat, fix.lng]) : Infinity;
    this.position = fix;

    // Adaptive polling bookkeeping.
    if (this.batterySaver()) {
      if (moved < MOVE_THRESHOLD_M) {
        this.stillCount++;
        if (source === 'watch' && this.stillCount >= STILL_FIXES) {
          this.pollInterval = POLL_MIN_MS;
          this._startPolling();
        }
      } else {
        this.stillCount = 0;
        this.anchor = fix;
        if (source === 'poll') { this._startWatch(); this._emit('mode', { mode: 'watching' }); }
      }
    } else if (source === 'poll') {
      this._startWatch();
    }
    if (!this.anchor) this.anchor = fix;

    if (fix.heading != null && !Number.isNaN(fix.heading) && fix.speed > 0.5) { this.headingDeg = fix.heading; }
    this._render(fix);
    if (this.breadcrumbOn) this._crumb(fix);
    this._emit('position', fix);
  }

  _render(fix) {
    const ll = [fix.lat, fix.lng];
    if (!this.map.hasLayer(this.marker)) { this.accuracyCircle.addTo(this.map); this.marker.addTo(this.map); }
    this.marker.setLatLng(ll);
    this.accuracyCircle.setLatLng(ll).setRadius(fix.accuracy || 0);
    this._renderHeading();
    if (this.follow) this.map.panTo(ll, { animate: true, duration: 0.5 });
  }

  _renderHeading() {
    const el = this.marker.getElement?.();
    if (!el) return;
    const cone = el.querySelector('.gps-heading');
    if (!cone) return;
    if (this.headingDeg == null) { cone.style.display = 'none'; return; }
    cone.style.display = '';
    cone.style.transform = `rotate(${this.headingDeg}deg)`;
  }

  _crumb(fix) {
    const last = this.breadcrumbPoints[this.breadcrumbPoints.length - 1];
    if (last && haversine([last.lat, last.lng], [fix.lat, fix.lng]) < 8) return;
    this.breadcrumbPoints.push({ lat: fix.lat, lng: fix.lng, ts: fix.ts, ele: fix.altitude });
    this.breadcrumb.addLatLng([fix.lat, fix.lng]);
    if (!this.map.hasLayer(this.breadcrumb)) this.breadcrumb.addTo(this.map);
  }

  setBreadcrumb(on) {
    this.breadcrumbOn = on;
    if (!on) return;
    if (this.position) this._crumb(this.position);
  }

  clearBreadcrumb() {
    this.breadcrumbPoints = [];
    this.breadcrumb.setLatLngs([]);
    this.map.removeLayer(this.breadcrumb);
  }

  breadcrumbAsGpx(name = 'Trail app track') {
    const pts = this.breadcrumbPoints.map((p) => {
      const ele = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
      return `<trkpt lat="${p.lat.toFixed(6)}" lon="${p.lng.toFixed(6)}">${ele}<time>${new Date(p.ts).toISOString()}</time></trkpt>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="trailapp" xmlns="http://www.topografix.com/GPX/1/1">
<trk><name>${escapeXml(name)}</name><trkseg>
${pts}
</trkseg></trk></gpx>`;
  }

  setFollow(on) {
    this.follow = on;
    if (on && this.position) this.map.panTo([this.position.lat, this.position.lng]);
  }

  /** Compass needs an explicit permission gesture on iOS. */
  async enableCompass() {
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const state = await DeviceOrientationEvent.requestPermission();
        if (state !== 'granted') throw new Error('Compass permission was not granted.');
      }
      window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
      window.addEventListener('deviceorientation', this._onOrientation, true);
      this.compassOn = true;
      return true;
    } catch (err) {
      this._emit('error', { message: err.message });
      return false;
    }
  }

  disableCompass() {
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    this.compassOn = false;
    this.headingDeg = null;
    this._renderHeading();
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
}

function describeGeoError(err) {
  switch (err?.code) {
    case 1: return 'Location permission was denied. Allow it in your browser settings to see your position.';
    case 2: return 'Position unavailable — no GPS fix yet.';
    case 3: return 'Location timed out. Trying again.';
    default: return err?.message || 'Location error.';
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}
