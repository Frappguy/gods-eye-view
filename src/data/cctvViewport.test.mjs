// src/data/cctvViewport.test.mjs — viewport-scoped CCTV catalog growth.
//
// /api/cctv/sources now answers for a bbox/limit window instead of shipping the
// whole registry, and the client grows its catalog ADDITIVELY for whatever
// region the user settles on. The three policy decisions in that loop are pure
// functions precisely so they can be pinned here without a Cesium viewer:
//
//   1. bbox construction from the view rectangle — radians in, degrees out,
//      with the antimeridian (west > east) convention passed through UNSORTED
//      because the server reads minLon > maxLon as "wraps the dateline";
//   2. the hysteresis gate — a small pan/zoom must NOT cost a round trip, a
//      real move or zoom step must;
//   3. the eviction plan — furthest-from-view first, with the active camera,
//      any carded camera and any curated pose exempt.
//
// Everything here is pure math over plain objects (cctv.js imports Cesium, but
// only Cesium.Math.toDegrees is touched by the code under test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cctvBboxFromViewRectangle,
  cctvEvictionExempt,
  cctvSourceQueryString,
  cctvViewportChangedEnough,
  cctvViewportDescriptor,
  planCctvCatalogEviction,
} from './cctv.js';

const DEG = Math.PI / 180;

/** Builds a radian view rectangle from degree bounds, like Cesium.Rectangle. */
function rect(westDeg, southDeg, eastDeg, northDeg) {
  return {
    west: westDeg * DEG,
    south: southDeg * DEG,
    east: eastDeg * DEG,
    north: northDeg * DEG,
  };
}

// ---------------------------------------------------------------------------
// 1. bbox + query-string construction
// ---------------------------------------------------------------------------

test('cctvBboxFromViewRectangle converts radians to the server bbox order', () => {
  const bbox = cctvBboxFromViewRectangle(rect(-122.6, 37.6, -122.2, 37.9));
  assert.ok(Math.abs(bbox.minLat - 37.6) < 1e-9);
  assert.ok(Math.abs(bbox.minLon - -122.6) < 1e-9);
  assert.ok(Math.abs(bbox.maxLat - 37.9) < 1e-9);
  assert.ok(Math.abs(bbox.maxLon - -122.2) < 1e-9);
  assert.equal(bbox.wrapsDateline, false);
});

test('cctvBboxFromViewRectangle returns null for an unresolvable view rectangle', () => {
  // computeViewRectangle() hands back undefined when the globe is not fully
  // resolvable; the caller must then omit bbox so the server replies globally.
  assert.equal(cctvBboxFromViewRectangle(undefined), null);
  assert.equal(cctvBboxFromViewRectangle(null), null);
  assert.equal(cctvBboxFromViewRectangle({ west: 0, south: 0, east: 0 }), null);
  assert.equal(cctvBboxFromViewRectangle({ west: 0, south: NaN, east: 0, north: 0 }), null);
  // Inverted latitude band: the server rejects minLat > maxLat outright.
  assert.equal(cctvBboxFromViewRectangle(rect(-10, 40, 10, 30)), null);
});

test('cctvBboxFromViewRectangle keeps the antimeridian box unsorted', () => {
  // A window straddling 180°: Cesium encodes it west=175, east=-175.
  const bbox = cctvBboxFromViewRectangle(rect(175, -20, -175, -10));
  assert.ok(Math.abs(bbox.minLon - 175) < 1e-9);
  assert.ok(Math.abs(bbox.maxLon - -175) < 1e-9);
  assert.equal(bbox.wrapsDateline, true);
  // Sorting the bounds here would invert a 10° Pacific window into a 350° one.
  assert.ok(bbox.minLon > bbox.maxLon);
});

test('cctvBboxFromViewRectangle clamps out-of-range bounds', () => {
  const bbox = cctvBboxFromViewRectangle(rect(-200, -120, 200, 120));
  assert.equal(bbox.minLat, -90);
  assert.equal(bbox.maxLat, 90);
  assert.equal(bbox.minLon, -180);
  assert.equal(bbox.maxLon, 180);
});

test('cctvSourceQueryString serializes bbox as minLat,minLon,maxLat,maxLon', () => {
  const query = cctvSourceQueryString({
    bbox: { minLat: 37.6, minLon: -122.6, maxLat: 37.9, maxLon: -122.2 },
    limit: 600,
  });
  assert.equal(query, '?bbox=37.6,-122.6,37.9,-122.2&limit=600');
});

test('cctvSourceQueryString serializes an antimeridian bbox with minLon > maxLon', () => {
  const bbox = cctvBboxFromViewRectangle(rect(175, -20, -175, -10));
  assert.equal(
    cctvSourceQueryString({ bbox, limit: 600 }),
    '?bbox=-20,175,-10,-175&limit=600',
  );
});

test('cctvSourceQueryString omits bbox entirely when there is none', () => {
  // Omission is the contract for "give me the global sample" — an empty or
  // guessed world rectangle would be a different, wrong request.
  assert.equal(cctvSourceQueryString({ bbox: null, limit: 600 }), '?limit=600');
  assert.equal(cctvSourceQueryString({}), '');
  assert.equal(cctvSourceQueryString(), '');
  assert.equal(
    cctvSourceQueryString({ bbox: { minLat: 1, minLon: 2, maxLat: NaN, maxLon: 4 }, limit: 10 }),
    '?limit=10',
  );
});

test('cctvSourceQueryString rounds the float tail and floors the limit', () => {
  const query = cctvSourceQueryString({
    bbox: {
      minLat: 37.123456789, minLon: -122.987654321, maxLat: 37.2, maxLon: -122.9,
    },
    limit: 600.7,
  });
  assert.equal(query, '?bbox=37.12346,-122.98765,37.2,-122.9&limit=600');
});

test('cctvSourceQueryString drops a nonsense limit rather than sending it', () => {
  const bbox = { minLat: 0, minLon: 0, maxLat: 1, maxLon: 1 };
  assert.equal(cctvSourceQueryString({ bbox, limit: 0 }), '?bbox=0,0,1,1');
  assert.equal(cctvSourceQueryString({ bbox, limit: -5 }), '?bbox=0,0,1,1');
  assert.equal(cctvSourceQueryString({ bbox, limit: Number.NaN }), '?bbox=0,0,1,1');
});

// ---------------------------------------------------------------------------
// 2. hysteresis
// ---------------------------------------------------------------------------

test('cctvViewportDescriptor reduces a bbox to centre and span', () => {
  const view = cctvViewportDescriptor({
    minLat: 37.6, minLon: -122.6, maxLat: 37.9, maxLon: -122.2,
  });
  assert.ok(Math.abs(view.centerLat - 37.75) < 1e-9);
  assert.ok(Math.abs(view.centerLon - -122.4) < 1e-9);
  assert.ok(Math.abs(view.latSpan - 0.3) < 1e-9);
  assert.ok(Math.abs(view.lonSpan - 0.4) < 1e-9);
  assert.equal(cctvViewportDescriptor(null), null);
});

test('cctvViewportDescriptor measures an antimeridian span the short way round', () => {
  const view = cctvViewportDescriptor({
    minLat: -20, minLon: 175, maxLat: -10, maxLon: -175,
  });
  assert.ok(Math.abs(view.lonSpan - 10) < 1e-9, `lonSpan ${view.lonSpan}`);
  // Centre sits exactly on the dateline, normalized into [-180, 180).
  assert.ok(Math.abs(Math.abs(view.centerLon) - 180) < 1e-9, `centerLon ${view.centerLon}`);
});

/** A 1° x 1° window centred on (lat, lon). */
function view(lat, lon, span = 1) {
  return cctvViewportDescriptor({
    minLat: lat - span / 2,
    minLon: lon - span / 2,
    maxLat: lat + span / 2,
    maxLon: lon + span / 2,
  });
}

test('cctvViewportChangedEnough always fetches the very first time', () => {
  // undefined = never fetched; null = the last fetch was the global sample.
  assert.equal(cctvViewportChangedEnough(undefined, view(37.7, -122.4)), true);
  assert.equal(cctvViewportChangedEnough(undefined, null), true);
});

test('cctvViewportChangedEnough skips a small pan', () => {
  const last = view(37.7, -122.4, 1);
  // 0.1° of a 1° window = 10 % of span, well under the 35 % threshold.
  assert.equal(cctvViewportChangedEnough(last, view(37.8, -122.3, 1)), false);
  // Even a 30 % move in both axes at unchanged zoom stays inside the band.
  assert.equal(cctvViewportChangedEnough(last, view(37.99, -122.11, 1)), false);
});

test('cctvViewportChangedEnough skips a small zoom', () => {
  const last = view(37.7, -122.4, 1);
  assert.equal(cctvViewportChangedEnough(last, view(37.7, -122.4, 1.2)), false);
  assert.equal(cctvViewportChangedEnough(last, view(37.7, -122.4, 0.85)), false);
});

test('cctvViewportChangedEnough refetches after a big pan', () => {
  const last = view(37.7, -122.4, 1);
  // A whole window-width away.
  assert.equal(cctvViewportChangedEnough(last, view(38.7, -122.4, 1)), true);
  assert.equal(cctvViewportChangedEnough(last, view(37.7, -121.4, 1)), true);
  // Continental jump.
  assert.equal(cctvViewportChangedEnough(last, view(51.5, -0.12, 1)), true);
});

test('cctvViewportChangedEnough refetches on a real zoom step in either direction', () => {
  const last = view(37.7, -122.4, 1);
  assert.equal(cctvViewportChangedEnough(last, view(37.7, -122.4, 1.5)), true);
  assert.equal(cctvViewportChangedEnough(last, view(37.7, -122.4, 1 / 1.5)), true);
  // Symmetric: zooming out then back in trips at the same factor.
  assert.equal(cctvViewportChangedEnough(view(37.7, -122.4, 1.5), last), true);
});

test('cctvViewportChangedEnough scales the move threshold with zoom', () => {
  // The SAME 2° pan is a no-op at continental zoom and a refetch at city zoom.
  assert.equal(cctvViewportChangedEnough(view(37.7, -122.4, 20), view(39.7, -122.4, 20)), false);
  assert.equal(cctvViewportChangedEnough(view(37.7, -122.4, 1), view(39.7, -122.4, 1)), true);
});

test('cctvViewportChangedEnough treats a pan across the dateline as a small move', () => {
  // 179.9 -> -179.9 is 0.2° apart the short way round, not 359.8°. Measuring
  // it naively would refetch on every nudge near the antimeridian.
  assert.equal(cctvViewportChangedEnough(view(-15, 179.9, 1), view(-15, -179.9, 1)), false);
  // A genuinely large pan across the dateline still refetches.
  assert.equal(cctvViewportChangedEnough(view(-15, 179.9, 1), view(-15, -177, 1)), true);
});

test('cctvViewportChangedEnough treats global-sample transitions as scope changes', () => {
  const scoped = view(37.7, -122.4, 1);
  // Staying global two settles running is not a change.
  assert.equal(cctvViewportChangedEnough(null, null), false);
  // Crossing the global/scoped boundary either way is always worth one fetch.
  assert.equal(cctvViewportChangedEnough(null, scoped), true);
  assert.equal(cctvViewportChangedEnough(scoped, null), true);
});

test('cctvViewportChangedEnough honours caller thresholds', () => {
  const last = view(37.7, -122.4, 1);
  const next = view(37.9, -122.4, 1);
  assert.equal(cctvViewportChangedEnough(last, next), false);
  assert.equal(cctvViewportChangedEnough(last, next, { moveFraction: 0.1 }), true);
  assert.equal(
    cctvViewportChangedEnough(last, view(37.7, -122.4, 1.2), { spanRatio: 1.1 }),
    true,
  );
});

// ---------------------------------------------------------------------------
// 3. eviction policy
// ---------------------------------------------------------------------------

/** `count` entries named cam-000.., each 1 km further from the view. */
function catalog(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `cam-${String(index).padStart(3, '0')}`,
    distanceKm: index,
    poseSource: null,
    ...(overrides[index] || {}),
  }));
}

test('planCctvCatalogEviction evicts nothing under the ceiling', () => {
  assert.deepEqual(planCctvCatalogEviction(catalog(10), { limit: 10 }), []);
  assert.deepEqual(planCctvCatalogEviction(catalog(3), { limit: 10 }), []);
  assert.deepEqual(planCctvCatalogEviction([], { limit: 10 }), []);
  assert.deepEqual(planCctvCatalogEviction(undefined, { limit: 10 }), []);
});

test('planCctvCatalogEviction evicts the furthest cameras first', () => {
  // 12 entries, ceiling 10 → the two furthest (cam-011 at 11 km, cam-010) go.
  assert.deepEqual(
    planCctvCatalogEviction(catalog(12), { limit: 10 }),
    ['cam-011', 'cam-010'],
  );
});

test('planCctvCatalogEviction breaks distance ties on id for a stable plan', () => {
  const entries = [
    { id: 'b', distanceKm: 9 },
    { id: 'a', distanceKm: 9 },
    { id: 'near', distanceKm: 1 },
  ];
  assert.deepEqual(planCctvCatalogEviction(entries, { limit: 2 }), ['a']);
  assert.deepEqual(planCctvCatalogEviction(entries, { limit: 1 }), ['a', 'b']);
});

test('planCctvCatalogEviction never evicts the active camera', () => {
  // cam-011 is both the furthest and the active camera.
  const plan = planCctvCatalogEviction(catalog(12), {
    limit: 10,
    activeCameraId: 'cam-011',
  });
  assert.ok(!plan.includes('cam-011'));
  assert.deepEqual(plan, ['cam-010', 'cam-009']);
});

test('planCctvCatalogEviction never evicts a camera holding an ambient card', () => {
  const plan = planCctvCatalogEviction(catalog(12), {
    limit: 10,
    cardIds: new Set(['cam-011', 'cam-010']),
  });
  assert.deepEqual(plan, ['cam-009', 'cam-008']);
  // An array of ids is accepted too (the hover pin is merged in by the caller).
  assert.deepEqual(
    planCctvCatalogEviction(catalog(12), { limit: 10, cardIds: ['cam-011'] }),
    ['cam-010', 'cam-009'],
  );
});

test('planCctvCatalogEviction never evicts a curated pose', () => {
  const plan = planCctvCatalogEviction(
    catalog(12, { 11: { poseSource: 'curated' }, 10: { poseSource: 'curated' } }),
    { limit: 10 },
  );
  assert.deepEqual(plan, ['cam-009', 'cam-008']);
});

test('planCctvCatalogEviction stays over the ceiling rather than evicting exempt cameras', () => {
  // Every entry is exempt: the exemptions are correctness constraints, the
  // ceiling is only a budget, so the plan is empty instead of destroying
  // live state.
  const entries = catalog(12).map((entry) => ({ ...entry, poseSource: 'curated' }));
  assert.deepEqual(planCctvCatalogEviction(entries, { limit: 4 }), []);
});

test('planCctvCatalogEviction evicts only as many as the overflow', () => {
  const plan = planCctvCatalogEviction(catalog(100), { limit: 97 });
  assert.equal(plan.length, 3);
  assert.deepEqual(plan, ['cam-099', 'cam-098', 'cam-097']);
});

test('planCctvCatalogEviction ignores entries without an id', () => {
  const entries = [...catalog(12), { distanceKm: 9999 }, null];
  assert.deepEqual(planCctvCatalogEviction(entries, { limit: 10 }), ['cam-011', 'cam-010']);
});

test('cctvEvictionExempt states the three exemptions', () => {
  const plain = { id: 'cam-1', poseSource: null };
  assert.equal(cctvEvictionExempt(plain), false);
  assert.equal(cctvEvictionExempt(plain, { activeCameraId: 'cam-1' }), true);
  assert.equal(cctvEvictionExempt(plain, { activeCameraId: 'cam-2' }), false);
  assert.equal(cctvEvictionExempt(plain, { cardIds: new Set(['cam-1']) }), true);
  assert.equal(cctvEvictionExempt(plain, { cardIds: ['cam-1'] }), true);
  assert.equal(cctvEvictionExempt(plain, { cardIds: ['cam-9'] }), false);
  assert.equal(cctvEvictionExempt({ id: 'cam-1', poseSource: 'curated' }), true);
  // A malformed entry is exempt by default: better a stuck ceiling than a
  // teardown aimed at a record that cannot be identified.
  assert.equal(cctvEvictionExempt(null), true);
  assert.equal(cctvEvictionExempt({}), true);
});
