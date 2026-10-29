'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createMoodStore,
  moodLabel,
  profileOf,
  displayOf,
  MOOD_PROFILES,
  MAX_DELTA,
} = require('../src/features/mood');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mood-display-'));
}

function fixedClock(text) {
  let ms = new Date(text).getTime();
  return function () { return new Date(ms); };
}

function advance(clock, minutes) {
  const next = clock().getTime() + minutes * 60 * 1000;
  return function () { return new Date(next); };
}

function lum(hex) {
  const text = String(hex).replace('#', '');
  const parts = [0, 2, 4].map(function (i) {
    const v = parseInt(text.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}

function contrastOnWhite(hex) {
  const l = lum(hex);
  return (1.05) / (l + 0.05);
}

test('档位边界：20/21、40/41、60/61、80/81', function () {
  assert.strictEqual(moodLabel(20), '低落');
  assert.strictEqual(moodLabel(21), '有点丧');
  assert.strictEqual(moodLabel(40), '有点丧');
  assert.strictEqual(moodLabel(41), '平静');
  assert.strictEqual(moodLabel(60), '平静');
  assert.strictEqual(moodLabel(61), '心情不错');
  assert.strictEqual(moodLabel(80), '心情不错');
  assert.strictEqual(moodLabel(81), '特别开心');
});

test('迟滞：79→81 不切档，83 才切；跌回按边界-2', function () {
  assert.strictEqual(profileOf(81, 'good').id, 'good');
  assert.strictEqual(profileOf(83, 'good').id, 'great');
  assert.strictEqual(profileOf(79, 'great').id, 'good');
  assert.strictEqual(profileOf(81, 'great').id, 'great');
});

test('display 五档齐全，色值与档位点符合方案', function () {
  const calm = displayOf(60, null);
  assert.deepStrictEqual({ id: calm.id, accent: calm.accent, ink: calm.ink, dots: calm.dots }, {
    id: 'calm', accent: '#2F7FD6', ink: '#2B76C7', dots: 3,
  });
  const good = displayOf(71, null);
  assert.strictEqual(good.id, 'good');
  assert.strictEqual(good.ink, '#1F7E94');
  assert.strictEqual(good.dots, 4);
  const great = displayOf(90, null);
  assert.strictEqual(great.id, 'great');
  assert.strictEqual(great.dots, 5);
  assert.ok(great.hint.length > 0);
});

test('ink 在白底上对比度 ≥ 4.5', function () {
  MOOD_PROFILES.forEach(function (profile) {
    const ratio = contrastOnWhite(profile.ink);
    assert.ok(ratio >= 4.5, profile.id + ' 的 ink 对比度只有 ' + ratio.toFixed(2));
  });
});

test('回落：闲置 6 小时 90 → 78；不足 1 小时不动', function () {
  const root = tmpRoot();
  let clock = fixedClock('2026-10-29T10:00:00Z');
  const store = createMoodStore({ root: root, now: function () { return clock(); } });
  store.apply(8, '开心');
  store.apply(8, '更开心');
  store.apply(8, '非常开心');
  store.apply(6, '还是很开心');
  assert.strictEqual(store.snapshot(24).value, 90);

  const base = clock().getTime();
  clock = function () { return new Date(base + 30 * 60 * 1000); };
  const halfHour = createMoodStore({ root: root, now: clock });
  assert.strictEqual(halfHour.snapshot(24).value, 90, '不到 1 小时不回落');

  clock = function () { return new Date(base + 6 * 60 * 60 * 1000); };
  const later = createMoodStore({ root: root, now: clock });
  assert.strictEqual(later.snapshot(24).value, 78, '每小时 -2，6 小时掉 12');
});

test('MAX_DELTA 提升到 8', function () {
  assert.strictEqual(MAX_DELTA, 8);
});