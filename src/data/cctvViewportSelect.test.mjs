import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CCTV_VIEWPORT_LIMIT_MAX,
  DEFAULT_CCTV_VIEWPORT_LIMIT,
  cctvBboxCenterLon,
  cctvSourceInBbox,
  cctvSpreadSample,
  clampCctvViewportLimit,
  nearestCctvSources,
  parseCctvBbox,
  selectCctvSourcesForView,
} from './cctvViewportSelect.js';

const cam = (id, lat, lon) => ({ id, lat, lon });

test('parseCctvBbox reads a well-formed box', () => {
  assert.deepEqual(parseCctvBbox('30,-98,31,-97'), {
    minLat: 30, minLon: -98, maxLat: 31, maxLon: -97, wrapsDateline: false,
  });
});

test('parseCctvBbox tolerates surrounding whitespace', () => {
  assert.equal(parseCctvBbox(' 30 , -98 , 31 , -97 ')?.minLat, 30);
});

test('parseCctvBbox flags an antimeridian crossing rather than rejecting it', () => {
  const box = parseCctvBbox('-40,170,-30,-170');
  assert.equal(box.wrapsDateline, true);
  assert.equal(box.minLon, 170);
  assert.equal(box.maxLon, -170);
});

test('parseCctvBbox returns null for malformed or out-of-range input', () => {
  // Null, not a throw and not an empty box: a typo must degrade to "fewer
  // cameras" via the global sample, never to a blank layer.
  for (const bad of ['', null, undefined, '1,2,3', '1,2,3,4,5', 'a,b,c,d', '31,-98,30,-97', '30,-98,91,-97', '30,-181,31,-97']) {
    assert.equal(parseCctvBbox(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('cctvSourceInBbox includes edges and excludes outside points', () => {
  const box = parseCctvBbox('30,-98,31,-97');
  assert.equal(cctvSourceInBbox(cam('a', 30, -98), box), true);
  assert.equal(cctvSourceInBbox(cam('b', 31, -97), box), true);
  assert.equal(cctvSourceInBbox(cam('c', 30.5, -97.5), box), true);
  assert.equal(cctvSourceInBbox(cam('d', 29.9, -97.5), box), false);
  assert.equal(cctvSourceInBbox(cam('e', 30.5, -96.9), box), false);
});

test('cctvSourceInBbox rejects records with unusable coordinates', () => {
  const box = parseCctvBbox('-90,-180,90,180');
  assert.equal(cctvSourceInBbox({ id: 'x' }, box), false);
  assert.equal(cctvSourceInBbox({ id: 'y', lat: 'nope', lon: 0 }, box), false);
});

test('cctvSourceInBbox wraps across the antimeridian', () => {
  const box = parseCctvBbox('-40,170,-30,-170');
  assert.equal(cctvSourceInBbox(cam('fiji', -35, 178), box), true);
  assert.equal(cctvSourceInBbox(cam('samoa', -35, -175), box), true);
  // The long way round the globe must NOT match.
  assert.equal(cctvSourceInBbox(cam('perth', -35, 115), box), false);
  assert.equal(cctvSourceInBbox(cam('chile', -35, -70), box), false);
});

test('cctvBboxCenterLon takes the short way round the dateline', () => {
  assert.equal(cctvBboxCenterLon(parseCctvBbox('30,-98,31,-97')), -97.5);
  assert.equal(Math.abs(cctvBboxCenterLon(parseCctvBbox("-40,170,-30,-170"))), 180, "the antimeridian is 180 or -180; both name the same meridian");
});

test('clampCctvViewportLimit defaults, floors and clamps', () => {
  assert.equal(clampCctvViewportLimit(null), DEFAULT_CCTV_VIEWPORT_LIMIT);
  assert.equal(clampCctvViewportLimit('nonsense'), DEFAULT_CCTV_VIEWPORT_LIMIT);
  assert.equal(clampCctvViewportLimit('250'), 250);
  assert.equal(clampCctvViewportLimit('12.9'), 12);
  assert.equal(clampCctvViewportLimit('0'), 1);
  assert.equal(clampCctvViewportLimit('-5'), 1);
  assert.equal(clampCctvViewportLimit('999999'), CCTV_VIEWPORT_LIMIT_MAX);
});

test('cctvSpreadSample passes through a list already inside the limit', () => {
  const list = [cam('a', 0, 0), cam('b', 1, 1)];
  // deepEqual, not equal: the function returns a coordinate-filtered copy, so
  // callers must not rely on getting the same array reference back.
  assert.deepEqual(cctvSpreadSample(list, 10), list);
});

test('cctvSpreadSample draws from many regions instead of one dense cluster', () => {
  // 500 cameras jammed into one city, 4 lone cameras spread worldwide. A
  // plain slice() would return 10 cameras all from the cluster; spreading
  // must surface the far-flung ones.
  const cluster = Array.from({ length: 500 }, (_, i) => cam(`cluster-${i}`, 30 + i * 0.0001, -97 + i * 0.0001));
  const outliers = [cam('tokyo', 35.7, 139.7), cam('oslo', 59.9, 10.7), cam('sydney', -33.9, 151.2), cam('lima', -12, -77)];
  const picked = cctvSpreadSample([...cluster, ...outliers], 10);
  assert.equal(picked.length, 10);
  const ids = new Set(picked.map((c) => c.id));
  for (const id of ['tokyo', 'oslo', 'sydney', 'lima']) {
    assert.ok(ids.has(id), `expected the spread sample to include ${id}`);
  }
});

test('cctvSpreadSample is deterministic so an unchanged view does not churn geometry', () => {
  const list = Array.from({ length: 300 }, (_, i) => cam(`c${i}`, (i % 90) - 45, (i * 7 % 360) - 180));
  assert.deepEqual(cctvSpreadSample(list, 40), cctvSpreadSample(list, 40));
});

test('cctvSpreadSample skips records with unusable coordinates', () => {
  const list = [cam('ok', 10, 10), { id: 'bad' }, cam('ok2', -20, 40), { id: 'bad2', lat: null, lon: 3 }];
  const picked = cctvSpreadSample(list, 3);
  assert.deepEqual(picked.map((c) => c.id).sort(), ['ok', 'ok2']);
});

test('nearestCctvSources keeps the closest and breaks ties by original order', () => {
  const list = [cam('far', 50, 50), cam('near', 0.1, 0.1), cam('tieA', 1, 0), cam('tieB', -1, 0)];
  const picked = nearestCctvSources(list, 3, { lat: 0, lon: 0 });
  assert.deepEqual(picked.map((c) => c.id), ['near', 'tieA', 'tieB']);
});

test('selectCctvSourcesForView without a bbox returns a globally spread sample', () => {
  const list = Array.from({ length: 200 }, (_, i) => cam(`c${i}`, (i % 90) - 45, (i * 13 % 360) - 180));
  const { selected, matched } = selectCctvSourcesForView(list, null, 25);
  assert.equal(matched, 200, 'matched reports the whole registry when unscoped');
  assert.equal(selected.length, 25);
});

test('selectCctvSourcesForView with a bbox returns only in-view cameras', () => {
  const list = [cam('in1', 30.2, -97.7), cam('in2', 30.4, -97.6), cam('out', 51.5, -0.1)];
  const { selected, matched } = selectCctvSourcesForView(list, parseCctvBbox('30,-98,31,-97'), 600);
  assert.equal(matched, 2);
  assert.deepEqual(selected.map((c) => c.id).sort(), ['in1', 'in2']);
});

test('selectCctvSourcesForView reports truncation via matched vs returned', () => {
  const list = Array.from({ length: 100 }, (_, i) => cam(`c${i}`, 30 + (i % 10) * 0.05, -98 + Math.floor(i / 10) * 0.05));
  const { selected, matched } = selectCctvSourcesForView(list, parseCctvBbox('29,-99,32,-96'), 20);
  assert.equal(matched, 100, 'matched counts everything in view, before limiting');
  assert.equal(selected.length, 20);
});

test('selectCctvSourcesForView never exceeds the limit', () => {
  const list = Array.from({ length: 5000 }, (_, i) => cam(`c${i}`, (i % 180) - 90, (i * 3 % 360) - 180));
  for (const limit of [1, 7, 600, 3000]) {
    assert.ok(selectCctvSourcesForView(list, null, limit).selected.length <= limit);
    assert.ok(selectCctvSourcesForView(list, parseCctvBbox('-90,-180,90,180'), limit).selected.length <= limit);
  }
});

test('selectCctvSourcesForView tolerates an empty or absent registry', () => {
  assert.deepEqual(selectCctvSourcesForView([], null, 600), { selected: [], matched: 0 });
  assert.deepEqual(selectCctvSourcesForView(undefined, null, 600), { selected: [], matched: 0 });
});

test('a dense in-view corner does not crowd out the rest of the view', () => {
  // Regression guard for the behaviour this whole change exists to fix:
  // pure nearest-first would return 20 cameras from the dense centre and
  // nothing from the edges of the viewport.
  const dense = Array.from({ length: 400 }, (_, i) => cam(`dense-${i}`, 30.0 + i * 0.0005, -97.0 + i * 0.0005));
  const edges = [cam('nw', 32.4, -99.4), cam('ne', 32.4, -95.4), cam('sw', 28.4, -99.4), cam('se', 28.4, -95.4)];
  const { selected } = selectCctvSourcesForView([...dense, ...edges], parseCctvBbox('28,-100,33,-95'), 20);
  const ids = new Set(selected.map((c) => c.id));
  const edgesKept = ['nw', 'ne', 'sw', 'se'].filter((id) => ids.has(id));
  assert.ok(edgesKept.length >= 2, `expected edge cameras to survive, kept ${edgesKept.join(',') || 'none'}`);
});
