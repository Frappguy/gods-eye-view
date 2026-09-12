/**
 * @module cctvViewportSelect
 *
 * Pure selection policy for viewport-scoped CCTV source delivery.
 *
 * With the world catalogs enabled the server registry holds several thousand
 * cameras. Shipping all of them on every page load is a multi-megabyte payload
 * and a client-side geometry storm, and the previous answer — truncate the
 * catalog to a flat cap — quietly reduced "worldwide cameras" to "whichever
 * cameras the merge happened to list first". These helpers let
 * `GET /api/cctv/sources` answer for the region the user is actually looking
 * at instead.
 *
 * Kept in `src/` rather than inline in `vite.config.js` so the logic that
 * decides which cameras a user can see is unit-testable without booting a
 * server (same split as `cctvLod.js` and `hudSummaryResponse.js`).
 *
 * Deliberately a linear scan rather than a spatial index: the registry is
 * refreshed at most once per CCTV_SOURCE_CACHE_MS and tops out in the low
 * thousands, so a full pass is microseconds. An R-tree here would be code to
 * maintain for no measurable gain.
 */

/** Cameras returned when the caller gives no explicit limit. */
export const DEFAULT_CCTV_VIEWPORT_LIMIT = 600;
/** Hard ceiling on a single /sources response, whatever the caller asks for. */
export const CCTV_VIEWPORT_LIMIT_MAX = 3000;

const EARTH_RADIUS_KM = 6371;

/**
 * Number() coercion that refuses the values JavaScript silently turns into 0.
 *
 * `Number(null)`, `Number('')`, `Number(false)` and `Number([])` are all 0,
 * which is a real coordinate (null island) and a real limit. Every numeric
 * field here comes from a query string or an upstream feed, so a record with
 * `lat: null` must be dropped rather than pinned to the equator.
 *
 * @param {unknown} value
 * @returns {number} The number, or NaN.
 */
function toFinite(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

/**
 * Great-circle distance in kilometres.
 *
 * Local to this module so the selection policy carries no dependency on the
 * server config file it is called from.
 *
 * @param {number} latA
 * @param {number} lonA
 * @param {number} latB
 * @param {number} lonB
 * @returns {number}
 */
function haversineKm(latA, lonA, latB, lonB) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(latB - latA);
  const dLon = toRad(lonB - lonA);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(latA)) * Math.cos(toRad(latB)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Clamp a caller-supplied `limit` query value into the servable range.
 *
 * @param {string|number|null|undefined} raw
 * @returns {number}
 */
export function clampCctvViewportLimit(raw) {
  const value = toFinite(raw);
  if (!Number.isFinite(value)) return DEFAULT_CCTV_VIEWPORT_LIMIT;
  return Math.max(1, Math.min(CCTV_VIEWPORT_LIMIT_MAX, Math.floor(value)));
}

/**
 * Parse a `bbox=minLat,minLon,maxLat,maxLon` query value.
 *
 * Returns null for anything malformed so the caller falls back to the global
 * sample rather than serving an empty layer — a typo in a query string should
 * degrade to "fewer cameras", never to "no cameras". A box whose minLon
 * exceeds maxLon is treated as crossing the antimeridian, which is a real view
 * on a globe and not an error.
 *
 * @param {string|null|undefined} raw
 * @returns {{minLat:number,minLon:number,maxLat:number,maxLon:number,wrapsDateline:boolean}|null}
 */
export function parseCctvBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map((piece) => Number(piece.trim()));
  if (parts.length !== 4 || !parts.every((n) => Number.isFinite(n))) return null;
  const [minLat, minLon, maxLat, maxLon] = parts;
  if (minLat > maxLat) return null;
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) return null;
  if (Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) return null;
  return { minLat, minLon, maxLat, maxLon, wrapsDateline: minLon > maxLon };
}

/**
 * True when a camera falls inside the box, honoring antimeridian wrap.
 *
 * @param {object} source
 * @param {{minLat:number,minLon:number,maxLat:number,maxLon:number,wrapsDateline:boolean}} box
 * @returns {boolean}
 */
export function cctvSourceInBbox(source, box) {
  const lat = toFinite(source?.lat);
  const lon = toFinite(source?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < box.minLat || lat > box.maxLat) return false;
  return box.wrapsDateline
    ? (lon >= box.minLon || lon <= box.maxLon)
    : (lon >= box.minLon && lon <= box.maxLon);
}

/**
 * Thin a camera list to `limit` entries while keeping geographic spread.
 *
 * Buckets sources into a coarse grid and takes them round-robin, one per cell
 * per pass. A plain slice() would hand back `limit` cameras all from whichever
 * dense metro sorted first; this returns cameras from as many distinct places
 * as possible, which is what the user means by "show me what's around here".
 *
 * The grid is sized to `bounds` rather than to the whole globe. That matters:
 * a globe-sized grid has cells roughly 20 degrees across, so an entire
 * metropolitan viewport lands in ONE cell and the spread degenerates back into
 * a slice. Sizing to the view keeps cells meaningful at every zoom level.
 *
 * Within a cell, and when choosing which cells to draw from first, entries
 * closest to `anchor` win — so a small limit still favours the middle of the
 * view while never collapsing onto it.
 *
 * Stable for a given (list order, limit, bounds, anchor): no randomness, so
 * repeated requests for an unchanged view return an unchanged set and the
 * client does not churn geometry.
 *
 * @param {Array<object>} list
 * @param {number} limit
 * @param {{bounds?:object|null, anchor?:{lat:number,lon:number}|null}} [options]
 * @returns {Array<object>}
 */
export function cctvSpreadSample(list, limit, options = {}) {
  if (!Array.isArray(list) || limit <= 0) return [];
  const usable = list.filter((source) => (
    Number.isFinite(toFinite(source?.lat)) && Number.isFinite(toFinite(source?.lon))
  ));
  if (usable.length <= limit) return usable;

  const bounds = options.bounds || null;
  const anchor = options.anchor || null;
  const originLat = bounds ? bounds.minLat : -90;
  const originLon = bounds ? bounds.minLon : -180;
  const latSpan = bounds ? Math.max(1e-6, bounds.maxLat - bounds.minLat) : 180;
  const lonSpan = bounds
    ? Math.max(1e-6, bounds.wrapsDateline
      ? (360 - bounds.minLon) + bounds.maxLon
      : bounds.maxLon - bounds.minLon)
    : 360;

  // Aim for a few cameras per occupied cell: many more cells than the limit
  // would degenerate into a slice, far fewer would cluster.
  const cells = Math.max(4, Math.ceil(Math.sqrt(limit) * 1.5));
  const latStep = latSpan / cells;
  const lonStep = lonSpan / cells;

  const buckets = new Map();
  for (const source of usable) {
    const lat = toFinite(source.lat);
    const lon = toFinite(source.lon);
    const lonOffset = bounds && bounds.wrapsDateline && lon < originLon
      ? (lon + 360) - originLon
      : lon - originLon;
    const key = `${Math.floor((lat - originLat) / latStep)}:${Math.floor(lonOffset / lonStep)}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(source);
  }

  const distTo = (source) => (anchor
    ? haversineKm(toFinite(source.lat), toFinite(source.lon), anchor.lat, anchor.lon)
    : 0);

  const ordered = Array.from(buckets.values());
  if (anchor) {
    // Order inside each cell, then order the cells themselves by their best
    // member, so a limit smaller than the cell count still lands centrally.
    for (const bucket of ordered) bucket.sort((a, b) => distTo(a) - distTo(b));
    ordered.sort((a, b) => distTo(a[0]) - distTo(b[0]));
  }

  const picked = [];
  for (let pass = 0; picked.length < limit; pass += 1) {
    let tookAny = false;
    for (const bucket of ordered) {
      if (pass >= bucket.length) continue;
      picked.push(bucket[pass]);
      tookAny = true;
      if (picked.length >= limit) break;
    }
    if (!tookAny) break;
  }
  return picked;
}

/**
 * Keep the `maxCount` cameras nearest a point, original order breaking ties.
 *
 * @param {Array<object>} cameras
 * @param {number} maxCount
 * @param {{lat:number, lon:number}} anchor
 * @returns {Array<object>}
 */
export function nearestCctvSources(cameras, maxCount, anchor) {
  const list = Array.isArray(cameras) ? cameras : [];
  if (!Number.isFinite(maxCount) || maxCount <= 0 || list.length <= maxCount) return list;
  return list
    .map((camera, idx) => {
      const lat = toFinite(camera?.lat);
      const lon = toFinite(camera?.lon);
      const distKm = Number.isFinite(lat) && Number.isFinite(lon)
        ? haversineKm(lat, lon, anchor.lat, anchor.lon)
        : Number.POSITIVE_INFINITY;
      return { camera, idx, distKm };
    })
    .sort((a, b) => (a.distKm !== b.distKm ? a.distKm - b.distKm : a.idx - b.idx))
    .slice(0, maxCount)
    .map((entry) => entry.camera);
}

/**
 * Longitude midpoint of a box, taking the short way round the dateline.
 *
 * @param {{minLon:number,maxLon:number,wrapsDateline:boolean}} box
 * @returns {number}
 */
export function cctvBboxCenterLon(box) {
  if (!box.wrapsDateline) return (box.minLon + box.maxLon) / 2;
  return (((box.minLon + box.maxLon + 360) / 2 + 180) % 360) - 180;
}

/**
 * Choose the cameras to serve for one /sources request.
 *
 * With a bbox: everything inside it, spread across the view with a bias toward
 * the centre. An earlier version took a nearest-the-centre shortlist and then
 * spread within it — which defeated itself, because at a wide zoom the whole
 * shortlist came from the single densest cluster and there was nothing left to
 * spread. Spreading over the full in-view set is what actually keeps the edges
 * of the viewport populated.
 *
 * Without a bbox: a globally spread sample, so a first paint at global altitude
 * shows worldwide coverage instead of whichever pack merged first.
 *
 * @param {Array<object>} sources Full registry.
 * @param {object|null} box Parsed bbox, or null for the global sample.
 * @param {number} limit Max entries to return.
 * @returns {{selected:Array<object>, matched:number}} matched = in-bbox count before limiting.
 */
export function selectCctvSourcesForView(sources, box, limit) {
  const all = Array.isArray(sources) ? sources : [];
  if (!box) return { selected: cctvSpreadSample(all, limit), matched: all.length };

  const inside = all.filter((source) => cctvSourceInBbox(source, box));
  if (inside.length <= limit) return { selected: inside, matched: inside.length };

  const anchor = { lat: (box.minLat + box.maxLat) / 2, lon: cctvBboxCenterLon(box) };
  return {
    selected: cctvSpreadSample(inside, limit, { bounds: box, anchor }),
    matched: inside.length,
  };
}
