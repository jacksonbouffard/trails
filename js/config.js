/**
 * Central configuration. Everything a person might reasonably want to tweak
 * — tile sources, endpoints, caps, defaults — lives here, not scattered
 * through the modules.
 */

export const APP_VERSION = '2.0.0';
export const DB_NAME = 'trailapp';
export const DB_VERSION = 2;

/** CONUS view for first launch. */
export const HOME_VIEW = { center: [39.5, -98.35], zoom: 5 };

/**
 * Raster basemaps. Every entry is a plain Leaflet tile layer; `downloadable`
 * marks the ones whose usage policy is compatible with pre-caching tiles for
 * offline use. `avgTileBytes` seeds the size estimate before sampling refines
 * it. `concurrency` is the number of parallel tile fetches the downloader
 * will run against that server.
 */
export const BASEMAPS = [
  {
    id: 'opentopo',
    name: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    minZoom: 1,
    maxZoom: 17,
    attribution: 'Map data &copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM · Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    downloadable: true,
    avgTileBytes: 45000,
    concurrency: 3,
    maxTiles: 6000,
    note: 'Contours and shaded relief. Volunteer-run — keep offline areas modest.',
  },
  {
    id: 'esri-topo',
    name: 'Esri World Topo',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    minZoom: 1,
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, USGS, NPS and others',
    downloadable: true,
    avgTileBytes: 35000,
    concurrency: 8,
    maxTiles: 25000,
    note: 'Park and forest land-use shading is built into the cartography.',
  },
  {
    id: 'usgs-topo',
    name: 'USGS Topo',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
    minZoom: 1,
    maxZoom: 16,
    maxNativeZoom: 16,
    attribution: 'USGS The National Map (public domain)',
    downloadable: true,
    avgTileBytes: 40000,
    concurrency: 8,
    maxTiles: 25000,
    note: 'Quad-sheet style; US only; tiles top out at zoom 16.',
  },
  {
    id: 'usgs-imagery-topo',
    name: 'USGS Imagery + Topo',
    url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}',
    minZoom: 1,
    maxZoom: 16,
    maxNativeZoom: 16,
    attribution: 'USGS The National Map (public domain)',
    downloadable: true,
    avgTileBytes: 70000,
    concurrency: 8,
    maxTiles: 25000,
    note: 'Aerial imagery with topo linework; US only.',
  },
  {
    id: 'esri-imagery',
    name: 'Esri Imagery',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    minZoom: 1,
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    downloadable: true,
    avgTileBytes: 60000,
    concurrency: 8,
    maxTiles: 25000,
    note: 'Satellite. Heavy tiles — download at zoom 15 or lower unless the area is small.',
  },
  {
    id: 'thunderforest-outdoors',
    name: 'Thunderforest Outdoors',
    url: 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey={key}',
    subdomains: ['a', 'b', 'c'],
    minZoom: 1,
    maxZoom: 22,
    maxNativeZoom: 18,
    attribution: 'Maps &copy; <a href="https://www.thunderforest.com">Thunderforest</a>, Data &copy; OpenStreetMap contributors',
    downloadable: true,
    requiresKey: 'thunderforestKey',
    avgTileBytes: 30000,
    concurrency: 4,
    maxTiles: 10000,
    note: 'Needs a free API key — add it under Settings.',
  },
  {
    id: 'osm',
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    minZoom: 1,
    maxZoom: 19,
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    downloadable: false,
    avgTileBytes: 25000,
    concurrency: 2,
    note: 'Browse only — the OSM tile usage policy forbids bulk downloading.',
  },
  {
    id: 'opentrailmap',
    name: 'OpenTrailMap',
    kind: 'vector',
    style: './vendor/opentrailmap-foot-access.json',
    minZoom: 1,
    maxZoom: 20,
    attribution: 'Style: <a href="https://opentrailmap.us">OpenTrailMap</a> by OpenStreetMap US (CC0) · Data &copy; OpenStreetMap contributors',
    downloadable: false,
    note: 'Vector tiles by OpenStreetMap US — trail access and land boundaries done right. Browse only (no offline).',
  },
];

/** Raster overlays that stack on top of the basemap. */
export const OVERLAYS = [
  {
    id: 'esri-hillshade',
    name: 'Hillshade',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
    minZoom: 1,
    maxZoom: 19,
    maxNativeZoom: 16,
    opacity: 0.45,
    blend: 'multiply',
    attribution: 'Hillshade &copy; Esri',
    downloadable: true,
    avgTileBytes: 18000,
    concurrency: 8,
  },
];

export const TRAIL_LAYER_ID = 'trails';

/** Data endpoints. */
export const ENDPOINTS = {
  overpass: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ],
  // USGS PAD-US "Public Access" view — one national polygon layer for federal,
  // state, local, NGO and tribal lands, with public-access status per unit.
  padus: 'https://services.arcgis.com/v01gqwM5QqNysAAi/ArcGIS/rest/services/PADUS_Public_Access/FeatureServer/0/query',
  nominatim: 'https://nominatim.openstreetmap.org',
  elevation: 'https://api.open-meteo.com/v1/elevation',
};

/** Minimum zoom before live layers start fetching (keeps requests small). */
export const LIVE_ZOOM = {
  boundaries: 9,
  trails: 12,
  pois: 12,
};

export const DOWNLOAD = {
  minZoomDefault: 8,      // low zooms are cheap and give the offline map context
  maxZoomDefault: 15,
  maxZoomChoices: [13, 14, 15, 16, 17],
  marginChoices: [0, 500, 1000, 2000], // metres of padding around the selection
  warnTiles: 4000,
  hardCapTiles: 30000,    // user-adjustable in Settings
  overpassCellDeg: 0.25,  // chunk big areas so Overpass doesn't time out
  retries: 3,
  sampleTiles: 10,        // tiles fetched to refine the size estimate
};

export const DEFAULT_SETTINGS = {
  units: 'imperial',            // 'imperial' | 'metric'
  basemap: 'opentopo',
  hillshade: false,
  showBoundaries: true,
  showTrails: true,
  showClosedAccess: false,      // PAD-US Pub_Access = XA
  pois: { peak: true, water: true, trailhead: true, camp: false, viewpoint: false },
  resumeLastArea: true,
  breadcrumb: false,
  batterySaver: true,
  followMe: false,
  thunderforestKey: '',
  hardCapTiles: DOWNLOAD.hardCapTiles,
  backend: { mode: 'local', baseUrl: '', token: '' },
  lastSync: null,
};

/** OSM sac_scale → display + symbology. */
export const SAC_SCALE = {
  hiking:                    { label: 'Hiking (T1)',                   color: '#2e7d32', dash: null,   rank: 1 },
  mountain_hiking:           { label: 'Mountain hiking (T2)',          color: '#2a62b5', dash: null,   rank: 2 },
  demanding_mountain_hiking: { label: 'Demanding mountain hiking (T3)', color: '#1c1c1c', dash: '10 6', rank: 3 },
  alpine_hiking:             { label: 'Alpine hiking (T4)',            color: '#b0362b', dash: '10 6', rank: 4 },
  demanding_alpine_hiking:   { label: 'Demanding alpine (T5)',         color: '#8a1f1a', dash: '6 6',  rank: 5 },
  difficult_alpine_hiking:   { label: 'Difficult alpine (T6)',         color: '#5a0f0f', dash: '6 6',  rank: 6 },
};

/** Palette shared by trail/boundary rendering and the legend. */
export const PALETTE = {
  trailDefault: '#4f2e28',   // OpenTrailMap's trail brown
  trailTrack: '#7a5a3a',
  trailSteps: '#4f2e28',
  trailCasing: '#fbf8ee',
  trailHighlight: '#f4c430',
  route: '#0f7b8f',
  gps: '#2f6fb0',
  boundaryOutline: '#6e8f4e',
  boundaryFill: {
    Federal: '#a9c98a',
    State: '#8fbf9a',
    'Local Government': '#c9d9a1',
    'Non-Governmental Organization': '#d9cf9a',
    Private: '#dfd4a6',
    Tribal: '#d3bc98',
    Joint: '#b8c9a0',
    default: '#c3cfa8',
  },
  poi: {
    peak: '#5a3d1e',
    water: '#2f6fb0',
    trailhead: '#2e7d32',
    camp: '#8a5a2b',
    viewpoint: '#6b4c9a',
  },
};

export const POI_KINDS = {
  peak:      { label: 'Peaks & saddles', tags: ['natural=peak', 'natural=saddle'] },
  water:     { label: 'Water sources', tags: ['natural=spring', 'amenity=drinking_water', 'waterway=waterfall'] },
  trailhead: { label: 'Trailheads', tags: ['highway=trailhead'] },
  camp:      { label: 'Camps & shelters', tags: ['tourism=camp_site', 'tourism=wilderness_hut', 'amenity=shelter'] },
  viewpoint: { label: 'Viewpoints', tags: ['tourism=viewpoint'] },
};

export function basemapDef(id) { return BASEMAPS.find((b) => b.id === id); }
export function overlayDef(id) { return OVERLAYS.find((o) => o.id === id); }
