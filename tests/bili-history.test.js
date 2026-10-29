'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBiliStore } = require('../src/features/bili/store');
const { parsePickedItems } = require('../src/features/bili/runner');
const { historyPrompt } = require('../src/features/bili');

const NL = String.fromCharCode(10);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bili-history-'));
}

function at(text) {
  return function () { return new Date(text); };
}

const REPORT = [
  '## 2026-10-29 15:11 · 手动',
  '### BV1ocsd6jErz',
  '标题：韦维尔的疯人院 英属印度·1914',
  'UP：小约翰可汗',
  '链接：https://www.bilibili.com/video/BV1ocsd6jErz',
  '播放：27万',
  '',
  '### BV1cBx36TEEK',
  '标题：武林外传续集',
  'UP：墨小郎',
  '',
].join(NL);

test('parsePickedItems 从报告取出标题/UP/链接，缺链接时补默认地址', function () {
  const items = parsePickedItems(REPORT);
  assert.equal(items.length, 2);
  assert.deepStrictEqual(items[0], {
    bvid: 'BV1ocsd6jErz',
    title: '韦维尔的疯人院 英属印度·1914',
    up: '小约翰可汗',
    link: 'https://www.bilibili.com/video/BV1ocsd6jErz',
  });
  assert.equal(items[1].link, 'https://www.bilibili.com/video/BV1cBx36TEEK');
});

test('浏览历史：追加后可倒序取回，坏行被跳过', function () {
  const root = tmpDir();
  const store = createBiliStore({ root: root, now: at('2026-10-29T15:11:00') });
  store.appendHistory([{ bvid: 'BV1ocsd6jErz', title: 'A', up: 'U1', link: 'L1' }], { at: new Date('2026-10-29T15:11:00'), trigger: 'manual' });
  store.appendHistory([{ bvid: 'BV1cBx36TEEK', title: 'B', up: 'U2' }], { at: new Date('2026-10-29T16:00:00'), trigger: 'auto' });
  fs.appendFileSync(store.historyPath, '{not json}' + NL);

  const rows = store.recentHistory(5, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].bvid, 'BV1cBx36TEEK');
  assert.equal(rows[0].trigger, 'auto');
  assert.equal(rows[0].link, 'https://www.bilibili.com/video/BV1cBx36TEEK');
  assert.equal(rows[1].title, 'A');
});

test('浏览历史：limit 与天数过滤生效', function () {
  const root = tmpDir();
  const store = createBiliStore({ root: root, now: at('2026-10-29T12:00:00') });
  store.appendHistory([{ bvid: 'BVaaaaaaaaa', title: 'old' }], { at: new Date('2026-10-01T10:00:00'), trigger: 'manual' });
  store.appendHistory([{ bvid: 'BVbbbbbbbbb', title: 'new' }], { at: new Date('2026-10-29T10:00:00'), trigger: 'manual' });

  assert.equal(store.recentHistory(5, 7).length, 1);
  assert.equal(store.recentHistory(1, 0).length, 1);
  assert.equal(store.recentHistory(5, 0).length, 2);
});

test('historyPrompt 生成对话片段；没有历史时返回空串', function () {
  const empty = historyPrompt({ recentHistory: function () { return []; } });
  assert.equal(empty, '');

  const text = historyPrompt({
    recentHistory: function () {
      return [{ date: '2026-10-29', title: 'T', up: 'U', link: 'https://x/BV1' }];
    },
  });
  assert.ok(text.indexOf('最近在 B 站看过') !== -1);
  assert.ok(text.indexOf('10-29 《T》（UP：U） https://x/BV1') !== -1);
});