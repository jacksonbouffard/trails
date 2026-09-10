# Trails — optional Django backend

The app runs entirely on the phone. This folder is the *seam*: a minimal
Django REST Framework app that mirrors saved-area recipes, notes and
breadcrumb tracks so a second device (or a laptop) can pull them, and so
nothing is lost if the phone's storage gets evicted.

It is not required for offline use, and it never stores tiles.

## What the client expects (contract)

Implemented in `js/backend.js` → `DjangoBackend`.

| Method | Path | Notes |
| --- | --- | --- |
| `PUT` | `/api/areas/{id}/` | Create-or-replace. Body: `{ id, name, geometry (GeoJSON), bounds, zoomMin, zoomMax, marginMeters, layerIds, tile_count, source, updated_at }` |
| `DELETE` | `/api/areas/{id}/` | Hard delete |
| `GET` | `/api/areas/?updated_since=ISO` | Everything changed since the last sync (omit the param for a full pull) |
| `PUT` | `/api/annotations/{id}/` | Body: `{ id, lat, lng, title, note, category, created_at?, updated_at }` |
| `DELETE` | `/api/annotations/{id}/` | **Soft** delete — the record comes back with `deleted: true` on incremental pulls so other devices drop it |
| `GET` | `/api/annotations/?updated_since=ISO` | |
| `PUT` / `DELETE` / `GET` | `/api/tracks/…` | Same shape; body `{ id, name, startedAt, points, updated_at }` |

Rules the server must keep:

- **Client owns the id.** Records are UUIDs minted on the phone; the server
  never renames them.
- **`updated_at` is client time.** Sync is last-writer-wins on that stamp.
  Don't `auto_now` it.
- **Token auth.** `Authorization: Token <token>`; one token per device.
- **CORS.** The static app and the API are on different origins.

## Install into an existing project

```bash
pip install -r requirements.txt
cp -r trailapp_api /path/to/your/django/project/
# then apply settings_snippet.py, add the URL include, and:
python manage.py migrate
python manage.py drf_create_token <your username>
```

Paste the token and `https://<host>/trailapp` into the app's
**Settings → Backend** panel, tap **Connect**. The app writes through to the
server on every save (falling back to local-only when the server is
unreachable) and **Sync now** pushes anything marked dirty and pulls changes.

## Upgrading to GeoDjango later

The land-suitability project already runs PostGIS. To move there, replace
`SavedArea.geometry` with a `PolygonField(srid=4326)` and have the serializer
read/write GeoJSON via `GEOSGeometry(json.dumps(...))` / `.json`. The phone
only ever sees GeoJSON, so nothing client-side changes.
