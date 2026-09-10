# Vendored libraries

Everything the app needs at runtime lives here so the service worker can
precache it and the app launches with no network at all.

| Path | What | License |
|---|---|---|
| `leaflet/` | Leaflet 1.9.4 | BSD-2-Clause |
| `maplibre/maplibre-gl*.mjs`, `.css` | MapLibre GL JS 6.9.0 (ESM build; the worker is resolved relative to `maplibre-gl.mjs`, so keep these three files together) | BSD-3-Clause |
| `maplibre/leaflet-maplibre-gl.js` | @maplibre/maplibre-gl-leaflet 0.1.4 — embeds a MapLibre map inside a Leaflet map | ISC |
| `opentrailmap-foot-access.json` | OpenTrailMap style (hiking travel mode, "access" lens) generated from github.com/osmus/OpenTrailMap (`style/` + `js/styleGenerator.js`). Style is CC0; the generator code is MIT (OpenStreetMap US). Tiles, glyphs and hillshade are served live by tiles.openstreetmap.us; sprites by opentrailmap.us — so this basemap is browse-only. | CC0 / MIT |

MapLibre is only loaded (lazily) when the OpenTrailMap basemap is chosen;
Leaflet is loaded on every launch.

## Regenerating the OpenTrailMap style

OpenTrailMap builds its style at runtime from ES modules rather than
shipping a `style.json`. To refresh the vendored copy after upstream changes:

```sh
git clone https://github.com/osmus/OpenTrailMap && cd OpenTrailMap
echo '{"type":"module"}' > package.json
node -e 'import("./style/style.js").then(async s => {
  const g = await import("./js/styleGenerator.js");
  const st = g.generateStyle(s.style, "foot", "access");
  st.sprite = "https://opentrailmap.us/sprites/opentrailmap";
  process.stdout.write(JSON.stringify(st));
})' > ../trailapp/vendor/opentrailmap-foot-access.json
```
