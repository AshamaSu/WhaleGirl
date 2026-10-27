'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createBiliTools, formatCount, renderList } = require('../src/bilibili/tools');

function item(bvid, play, days) {
  return { bvid: bvid, title: '标题', author: 'UP', play: play, days: days, pubdate: 0 };
}

test('formatCount 用万/亿，好看且不丢精度感', function () {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(12345), '1.2万');
  assert.equal(formatCount(123456789), '1.2亿');
  assert.equal(formatCount(0), '0');
});

test('renderList 应用播放量与天数硬过滤', function () {
  const text = renderList([item('BV1aaaaaaaaa', 100, 1), item('BV1bbbbbbbbb', 99999, 2), item('BV1ccccccccc', 99999, 90)], 10, function (entry) {
    return entry.play >= 1000 && entry.days <= 30;
  });
  assert.match(text, /BV1bbbbbbbbb/);
  assert.doesNotMatch(text, /BV1aaaaaaaaa/);
  assert.doesNotMatch(text, /BV1ccccccccc/);
  assert.match(text, /已过滤 2 条/);
});

test('renderList 全被过滤时说人话，不返回空串', function () {
  assert.match(renderList([item('BV1aaaaaaaaa', 1, 1)], 10, function () { return false; }), /没有符合条件的视频/);
});

/** 假 api：只回预设列表，不碰网络 */
function fakeApi(list) {
  return {
    popular: async function () { return list; },
    search: async function () { return list; },
    video: async function () { return { bvid: 'BV1aaaaaaaaa', title: 't', author: 'u', play: 1, like: 1, days: 0, desc: '', typename: '' }; },
    subtitle: async function () { return { empty: true, reason: '没有公开字幕', text: '', count: 0 }; },
    comments: async function () { return []; },
  };
}

test('已经推荐过的 BV 直接不进候选（第二轮不再重复）', async function () {
  const seen = { BV1seen000001: true };
  const tools = createBiliTools(fakeApi([
    item('BV1seen000001', 99999, 1),
    item('BV1fresh00001', 99999, 1),
  ]), {
    minPlays: 1000,
    filterSeen: function (bvid) { return !!seen[bvid]; },
  });

  const text = await tools[0].execute({ ps: 5 });
  assert.match(text, /BV1fresh00001/);
  assert.doesNotMatch(text, /BV1seen000001/);
});

test('没有字幕时明确说"跳过"，不诱导模型重试', async function () {
  const tools = createBiliTools(fakeApi([]), {});
  const text = await tools[3].execute({ bvid: 'BV1aaaaaaaaa' });
  assert.match(text, /没有字幕/);
  assert.match(text, /按跳过处理/);
});

test('五个工具都带 schema 与 execute', function () {
  const tools = createBiliTools(fakeApi([]), {});
  assert.deepEqual(tools.map(function (tool) { return tool.name; }), [
    'bili_popular', 'bili_search', 'bili_video', 'bili_subtitle', 'bili_comments',
  ]);
  tools.forEach(function (tool) {
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 10);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  });
});
