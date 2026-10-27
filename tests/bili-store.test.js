'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBiliStore } = require('../src/features/bili/store');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bili-store-'));
}

function at(text) {
  return function () { return new Date(text); };
}

test('换天后当日轮数归零', function () {
  const root = tmpDir();
  const day1 = createBiliStore({ root: root, now: at('2026-10-27T10:00:00') });
  day1.recordRun({ auto: true, ok: true, picked: 1 });
  day1.recordRun({ auto: true, ok: true, picked: 2 });
  assert.equal(day1.state().dayRounds, 2);

  const day2 = createBiliStore({ root: root, now: at('2026-10-28T09:00:00') });
  assert.equal(day2.state().dayRounds, 0);
  assert.equal(day2.state().dayKey, '2026-10-28');
});

test('手动轮不扣额度，自动轮失败也不扣', function () {
  const store = createBiliStore({ root: tmpDir(), now: at('2026-10-27T10:00:00') });
  store.recordRun({ auto: false, ok: true, picked: 3 });
  store.recordRun({ auto: true, ok: false, error: '接口全挂' });
  store.recordRun({ auto: true, ok: true, picked: 1 });
  assert.equal(store.state().dayRounds, 1);
  assert.equal(store.state().lastResult.ok, true);
});

test('判重表：记过就是看过，重复记只留一条', function () {
  const store = createBiliStore({ root: tmpDir(), now: at('2026-10-27T10:00:00') });
  store.markSeen(['BV1gExu6GEjZ', 'BV1gExu6GEjZ', 'BV1aaaaaaaaa'], 'picked');
  assert.equal(store.hasSeen('BV1gExu6GEjZ'), true);
  assert.equal(store.hasSeen('BV1zzzzzzzzz'), false);

  const lines = store.seenLines(10);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^BV1/);
  assert.match(lines[0], /2026-10-27/);
});

test('判重表超过上限时丢掉最旧的', function () {
  const store = createBiliStore({ root: tmpDir(), now: at('2026-10-27T10:00:00') });
  const list = [];
  for (let i = 0; i < 520; i += 1) list.push('BV' + String(i).padStart(10, '0'));
  store.markSeen(list, 'picked');

  const kept = store.seenLines(1000).length;
  assert.equal(kept, 500);
  assert.equal(store.hasSeen('BV0000000000'), false);
});

test('报告按天追加，不覆盖', function () {
  const store = createBiliStore({ root: tmpDir(), now: at('2026-10-27T10:00:00') });
  store.appendReport('## 第一轮\n### BV1gExu6GEjZ\n');
  store.appendReport('## 第二轮\n');

  const file = store.reportPath(new Date('2026-10-27T23:00:00'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /第一轮/);
  assert.match(text, /第二轮/);
  assert.ok(file.endsWith(path.join('data', 'bili', 'out', '2026-10-27.md')));
});

test('月度归档按月份建文件', function () {
  const store = createBiliStore({ root: tmpDir(), now: at('2026-10-27T10:00:00') });
  store.appendDigest('归档一段\n');
  const file = path.join(store.digestDir, '2026-10.md');
  assert.match(fs.readFileSync(file, 'utf8'), /归档一段/);
});

test('状态文件损坏时备份并从零开始', function () {
  const root = tmpDir();
  const dir = path.join(root, 'data', 'bili');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{ 不是 json');

  const warnings = [];
  const store = createBiliStore({ root: root, onWarn: function (msg) { warnings.push(msg); } });
  assert.equal(store.state().dayRounds, 0);
  assert.equal(warnings.length, 1);
  assert.ok(fs.readdirSync(dir).some(function (name) { return name.indexOf('state.json.corrupt-') === 0; }));
});
