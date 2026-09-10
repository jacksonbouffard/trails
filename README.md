# Trails

A personal, offline-first trail map. Public-land boundaries (PAD-US), OSM
trails with difficulty symbology, peaks/water/trailheads, elevation profiles,
routing over the trail network, your own notes, and saved areas that keep
working with the phone in airplane mode. Static files only — no build step,
no framework, no backend required (but a Django seam is ready when you want
one).

```
python3 -m http.server 8080      # then open http://localhost:8080
```

Add it to the iPhone home screen from Safari (Share → Add to Home Screen)
and it runs as a standalone app with its own storage.

## What it does

**Browse (online).** Pan and zoom anywhere; at zoom ≥ 9 public-land units
appear (filled by manager type, dashed for easements, grey for closed lands);
at zoom ≥ 12 every OSM path, footway, track and steps loads live from
Overpass, cased and coloured by `sac_scale`. Tap anything for details — a
trail shows surface, visibility, incline, access tags, the hiking routes it
belongs to, a link to OSM, and an on-demand elevation profile with gain/loss
and a Naismith time estimate. Unnamed paths render fainter and get a
"thinly mapped here" warning.

**Save an area.** Draw a polygon, use the current view, or tap a boundary
and choose *Use as download area*. Pick a basemap (OpenTopoMap, Esri
Topo/Imagery, USGS Topo/Imagery, Thunderforest with a key), optionally
hillshade, a detail level (z13–17) and a margin. The app counts exactly the
tiles inside the polygon (not its bounding box), shows an estimate in MB,
and can sample real tiles for a measured figure. Downloads run with
concurrency, retry with backoff, back off on HTTP 429, survive a lost
connection (marked *interrupted* and auto-resumed when the network returns),
can be paused/cancelled, and only re-fetch the gaps on resume. Trails,
boundaries and POIs inside the footprint are snapshotted alongside the
tiles. Tiles are reference-counted, so overlapping areas share storage and
deleting one never breaks another.

**Use it offline.** Offline mode swaps every live layer for the saved
snapshot, reads tiles from IndexedDB, and locks the map to the saved
footprint and zoom range so it can't wander into blank tiles (the edge is
"viscous" rather than a hard wall). It turns itself on when the phone loses
its connection and offers to come back when the signal returns. Multiple
areas can be saved; pick which one to show.

**On the trail.** The location button starts a battery-conscious tracker
(continuous while moving, slow polling once stationary, off while the app
is hidden). The readout shows *On trail · Mid State Trail* or *120 ft off
trail · nearest: …*, with accuracy, GPS altitude and heading. Optional
follow-me, compass (with the iOS permission prompt), and a session
breadcrumb exportable as GPX.

**Route.** Tap two points on loaded trails and A* finds a path over the
trail network, listing the segments by name with distance, and an elevation
profile for the whole route. Works offline over the snapshot.

**Notes.** Drop pins for junctions, hazards, water, camps, views — "the
junction is really 50 m north of the mapped line". Stored locally through
the backend seam; export/import as GeoJSON.

**Search.** Places via Nominatim (biased to the current view), loaded trails
by name, *Trails near me* / *Trails near <place>* with a radius picker, and
recent searches.

## Backlog → where it landed

| Backlog item | Implementation |
| --- | --- |
| Basemap toggle, captured at download time | `config.js` BASEMAPS; area panel picks the basemap; `SavedArea.layerIds` records it |
| Cased, difficulty-coded trail symbology | `map-trails.js` — two canvas panes (casing + line), colour/dash by `sac_scale`, `informal`, `highway=track/steps` |
| OpenTrailMap evaluation | Included as a browse-only vector basemap: MapLibre rendered inside Leaflet, lazily loaded (`map-tools.js`, `vendor/opentrailmap-foot-access.json`). Not downloadable — the style depends on live tile/glyph/sprite endpoints |
| OSM metadata popups + client-side length | Trail panel; `overpass.js` computes `lengthM` with haversine |
| Zoom/pan lock for offline tiles | `app.js` → `setMode('offline')`: `setMinZoom/setMaxZoom/setMaxBounds` + viscosity |
| Place search, "trails near X", routing | `panels.js` initSearch / initRouting; `graph.js` A* |
| Hillshade | Esri World Hillshade overlay, multiply-blended; downloadable with an area |
| Peaks / water / trailheads | `map-pois.js`; per-kind toggles; snapshotted for offline |
| Size estimate in MB | `downloader.estimate()` — per-layer average bytes, or sampled real tiles |
| Storage quota display | Saved panel + Settings, via `navigator.storage.estimate()` and a tile byte total |
| Download resilience | `downloader.js` — retries, 429 backoff, pause/cancel, interrupted → auto-resume, per-tile bookkeeping |
| Multiple saved areas via Django seam | `backend.js` LocalBackend / DjangoBackend; `backend/` Django app |
| Manual annotation layer | `annotations.js` + Notes panel + GeoJSON import/export |
| Sparse-data flag | `isSparse()` — unnamed ways dimmed and flagged in the detail panel |
| Off-trail distance readout | `gps.js` + `TrailLayer.nearest()` (grid index) |
| Breadcrumb | Session polyline in `gps.js`, GPX export |
| Battery-conscious GPS | Adaptive watch ↔ poll in `gps.js`, visibility-aware |
| Real app icons | `icons/` (generated, original artwork) + `manifest.webmanifest` |
| Quick-resume | Settings → *Open the last saved area on launch*; also auto-offline at launch with no network |

Extras that weren't on the list: elevation profiles (Open-Meteo, cached
per way for offline re-viewing), hiking route relations on trail details,
closed-to-public land toggle, a Thunderforest key field, GeoJSON
import/export of notes, a hard cap on tiles per area, an "Update trails"
action that re-snapshots vector data without re-downloading tiles, a
"reload for update" prompt when the app shell changes.

## Architecture

```
index.html ── css/app.css
   │
   └─ js/app.js            boot; map + panes; basemap/overlay management;
        │                   online ↔ offline mode; settings; service worker
        ├─ panels.js       every sheet panel: selection/download, saved areas,
        │                   search, trail/boundary/POI detail, routing, notes, GPS UI
        ├─ config.js       basemaps, overlays, endpoints, zoom thresholds, defaults
        ├─ store.js        IndexedDB: tiles (ref-counted), areas, areaData,
        │                   annotations, tracks, searches, settings, elevations
        ├─ backend.js      LocalBackend (IndexedDB) / DjangoBackend (write-through + sync)
        ├─ downloader.js   plan → estimate → resumable run; snapshots vector data
        ├─ tiles.js        tile math; polygon-clipped tile enumeration
        ├─ overpass.js     Overpass queries (with mirror failover) + parsers
        ├─ services.js     PAD-US, Nominatim, Open-Meteo elevation
        ├─ graph.js        trail network graph + A*
        ├─ geo.js          haversine, point-in-polygon, nearest-on-line, formatters
        ├─ map-layers.js   raster layers; OfflineTileLayer (IndexedDB → network fallback)
        ├─ map-trails.js   TrailLayer (canvas, casing, live/snapshot, search, nearest)
        ├─ map-boundaries.js / map-pois.js
        ├─ map-tools.js    OpenTrailMap (MapLibre-in-Leaflet); PolygonDraw
        ├─ gps.js          GpsTracker; annotations.js  AnnotationLayer; ui.js  Sheet/toasts/profile
sw.js                      precaches the shell (not tiles)
vendor/                    Leaflet, MapLibre, OpenTrailMap style (see vendor/README.md)
backend/                   optional Django app matching backend.js
tests/                     node --test: pure modules + a jsdom boot smoke test
```

Key decisions:

- **IndexedDB for tiles, not the Cache API.** Safari caps Cache storage
  at ~50 MB per origin; IndexedDB gets the general quota and survives when
  `navigator.storage.persist()` is granted (requested on first save).
- **Ref-counted tiles.** Each tile row carries the set of area ids that
  use it. Overlapping areas cost nothing extra and deletes are safe.
- **Polygon-clipped enumeration.** Tiles are enumerated per zoom by
  stepping along the polygon edges and scan-filling the interior, so a
  long diagonal park doesn't download its whole bounding box.
- **Live layers are viewport-driven with coverage tracking.** Each layer
  remembers the bounds it has fetched and only asks Overpass/PAD-US for new
  ground; big views are split into chunks.
- **Snapshot mode.** In offline mode layers stop fetching and render the
  data saved with the area. Search, nearest-trail and routing all run over
  the snapshot.
- **Backend seam.** `ctx.backend` is the only place areas/notes/tracks are
  persisted. `LocalBackend` is IndexedDB; `DjangoBackend` writes through to
  the server and falls back to local when it's unreachable, marking records
  dirty for the next sync.

## Hosting

It's static. Copy the folder (without `node_modules/`, `tests/`, `backend/`)
next to the other tools on the droplet:

```nginx
location /trails/ {
    alias /var/www/trails/;
    index index.html;
    add_header Service-Worker-Allowed "/trails/";
    # cache the shell briefly; the service worker handles offline
    add_header Cache-Control "public, max-age=300";
}
```

Serve over **HTTPS** — service workers, geolocation and the compass permission
all require a secure context (localhost is exempt for testing).

`sw.js` precaches the shell; bump `CACHE_VERSION` in `sw.js` (and
`APP_VERSION` in `config.js`) when you change any shipped file so installed
phones pick up the update. The app shows a *Reload* toast when a new worker
is ready.

### iOS specifics

- **Storage is per app.** Safari and the home-screen app are separate
  partitions. Save areas from the one you'll use on the trail.
- **Persistence.** The app calls `navigator.storage.persist()` on the first
  save. Even so, iOS can evict a site's storage after ~7 days of non-use in
  Safari; the home-screen app is treated more kindly. Re-open it now and then
  and keep the Django mirror if you want a belt-and-braces record of your
  areas (tiles are always re-downloadable from the recipe).
- **Background GPS.** Web apps don't get location while backgrounded. The
  tracker stops when the app is hidden and restarts on return; the
  breadcrumb will have a gap.
- **Compass** requires a tap (the Compass chip) to trigger the permission
  prompt.

## Data sources and etiquette

| Source | Used for | Notes |
| --- | --- | --- |
| Overpass API (overpass-api.de, kumi.systems, private.coffee mirrors with failover) | Trails, POIs | Chunked queries; live layers only fetch new ground |
| USGS PAD-US 4 Public Access (ArcGIS FeatureServer) | Boundaries | Paged `query` with geometry generalised by zoom |
| Nominatim | Place search / reverse geocoding | Throttled to 1 req/s as their policy asks |
| Open-Meteo elevation (Copernicus DEM 90 m) | Profiles | Batched 100 points per call; cached per way |
| OpenTopoMap, Esri, USGS, Thunderforest, OSM | Tiles | See `config.js` for each layer's attribution, max native zoom, and (where published) bulk-download limits. OpenTopoMap and OSM's own tiles are volunteer-run — the app warns above their suggested limits and won't download from `osm` at all. Keep areas to what you'll actually walk. |
| OpenTrailMap (tiles.openstreetmap.us) | Vector basemap | Browse only |

Everything is fetched from the browser, so each source must send CORS
headers — all of the above do. If a tile host ever changes that, the layer
still displays online but bulk download will fail; swap in another basemap.

## Django expansion

See `backend/README.md`. Short version: install `trailapp_api` into the
existing GeoDjango project, add the three URL routes, create a token, and
enter the server URL and token in **Settings → Backend**. Saved-area
recipes, notes and tracks then mirror to the server and sync between
devices; tiles never leave the phone.

## Development

```
npm install            # jsdom + fake-indexeddb, for tests only
npm test               # 38 tests: pure modules + jsdom boot smoke test
npm run serve          # http://localhost:8080
```

Debugging in the browser: `window.trailapp` is the app context (`.map`,
`.store`, `.trails`, `.downloader`, `.setMode('offline', areaId)`, …).

Simulating offline on a laptop: DevTools → Network → Offline, or just flip
the *Offline mode* switch in Saved.

## Known limits / next steps

- Routing only knows about ways that are loaded (viewport or snapshot); a
  route across an unloaded gap fails with a hint rather than a wrong answer.
- PAD-US geometry above zoom 15 is fetched un-generalised; very large units
  (national forests) can be slow to draw the first time.
- The OpenTrailMap basemap needs WebGL and is ~1 MB to load once; it's not
  precached beyond the shell so the first pick needs a connection.
- Track recording is session-only by design (no fitness features).
- A second device only learns about note deletions through the Django
  backend's soft-delete tombstones; without the backend, notes are per-device.
