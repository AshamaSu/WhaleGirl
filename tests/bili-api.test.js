'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createBiliApi, stripTags, toSeconds, assertBvid } = require('../src/bilibili/api');
const { createBiliClient } = require('../src/bilibili/client');

const NOW = new Date('2026-10-27T12:00:00Z');
const now = function () { return NOW; };

/** 按 url 片段路由的 fetch 替身，记调用次数 */
function makeFetch(routes) {
  const calls = [];
  const impl = async function (url) {
    calls.push(String(url));
    const keys = Object.keys(routes);
    for (let i = 0; i < keys.length; i += 1) {
      if (String(url).indexOf(keys[i]) !== -1) {
        const payload = typeof routes[keys[i]] === 'function' ? routes[keys[i]](String(url)) : routes[keys[i]];
        return { ok: true, status: 200, json: async function () { return payload; } };
      }
    }
    return { ok: false, status: 404, json: async function () { return {}; } };
  };
  impl.calls = calls;
  impl.count = function (part) { return calls.filter(function (url) { return url.indexOf(part) !== -1; }).length; };
  return impl;
}

function apiWith(routes) {
  const fetchImpl = makeFetch(routes);
  const client = createBiliClient({ fetchImpl: fetchImpl, intervalMs: 1, buvid3: 'buvid', now: now });
  return { api: createBiliApi(client, { now: now }), fetchImpl: fetchImpl };
}

test('stripTags 去掉搜索结果里的高亮标签', function () {
  assert.equal(stripTags('鲸鱼<em class="keyword">娘</em> 日常'), '鲸鱼娘 日常');
});

test('toSeconds 兼容 "12:34" 与纯秒数', function () {
  assert.equal(toSeconds('12:34'), 754);
  assert.equal(toSeconds('1:02:03'), 3723);
  assert.equal(toSeconds(90), 90);
  assert.equal(toSeconds(''), 0);
});

test('assertBvid 只放合法 BV 号', function () {
  assert.equal(assertBvid(' BV1gExu6GEjZ '), 'BV1gExu6GEjZ');
  assert.throws(function () { assertBvid('av123'); }, /bvid 不合法/);
  assert.throws(function () { assertBvid(''); }, /bvid 不合法/);
});

test('popular 归一化：播放量、发布天数、标题去标签', async function () {
  const { api } = apiWith({
    '/x/web-interface/popular': {
      code: 0,
      data: {
        list: [{
          bvid: 'BV1gExu6GEjZ', aid: 1, title: '<em>鲸鱼</em>观察',
          owner: { name: '某UP' }, stat: { view: 123456 }, pubdate: 1793000000, duration: 754,
        }],
      },
    },
  });

  const list = await api.popular({ ps: 5 });
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    bvid: 'BV1gExu6GEjZ', aid: 1, title: '鲸鱼观察', author: '某UP',
    play: 123456, pubdate: 1793000000, days: 1, seconds: 754, desc: '', typename: '',
  });
});

test('search 只留视频结果，并带上签名参数', async function () {
  const { api, fetchImpl } = apiWith({
    '/x/web-interface/nav': {
      code: -101,
      data: { wbi_img: { img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png' } },
    },
    '/x/web-interface/wbi/search/type': {
      code: 0,
      data: {
        result: [
          { type: 'video', bvid: 'BV1gExu6GEjZ', title: 'A<em>鲸</em>', author: 'up1', play: 9000, pubdate: 1793000000, duration: '12:34' },
          { type: 'bili_user', mid: 1, uname: '不算' },
        ],
      },
    },
  });

  const list = await api.search({ keyword: '鲸鱼', ps: 10 });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'A鲸');
  assert.equal(list[0].seconds, 754);

  const searchCall = fetchImpl.calls.filter(function (url) { return url.indexOf('search/type') !== -1; })[0];
  assert.match(searchCall, /w_rid=/);
  assert.match(searchCall, /search_type=video/);
  assert.match(searchCall, /keyword=/);
});

test('search 缺 keyword 直接报错，不发请求', async function () {
  const { api, fetchImpl } = apiWith({});
  await assert.rejects(function () { return api.search({ keyword: '  ' }); }, /需要 keyword/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('video 十分钟内复用缓存，不重复请求', async function () {
  const { api, fetchImpl } = apiWith({
    '/x/web-interface/view': {
      code: 0,
      data: {
        bvid: 'BV1gExu6GEjZ', aid: 9, cid: 77, title: '标题', desc: '简介',
        owner: { name: 'up' }, stat: { view: 10, like: 2 }, pubdate: 1793000000, duration: 100, tname: '生活',
      },
    },
  });

  const first = await api.video({ bvid: 'BV1gExu6GEjZ' });
  const second = await api.video({ bvid: 'BV1gExu6GEjZ' });
  assert.equal(first.cid, 77);
  assert.equal(second.typename, '生活');
  assert.equal(fetchImpl.count('/x/web-interface/view'), 1);
});

test('没有字幕时返回 empty 而不是抛错', async function () {
  const { api } = apiWith({
    '/x/web-interface/view': { code: 0, data: { bvid: 'BV1gExu6GEjZ', aid: 1, cid: 5, title: 't', pubdate: 1793000000 } },
    '/x/player/v2': { code: 0, data: { subtitle: { subtitles: [] } } },
  });

  const result = await api.subtitle({ bvid: 'BV1gExu6GEjZ' });
  assert.equal(result.empty, true);
  assert.match(result.reason, /字幕/);
});

test('有字幕时拼成全文', async function () {
  const { api } = apiWith({
    '/x/player/v2': {
      code: 0,
      data: { subtitle: { subtitles: [{ lan: 'zh-CN', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/bfs/ai_subtitle/x.json' }] } },
    },
    'aisubtitle.hdslb.com': {
      body: [{ from: 0, to: 1, content: '第一句' }, { from: 1, to: 2, content: '第二句' }],
    },
  });

  const result = await api.subtitle({ bvid: 'BV1gExu6GEjZ', cid: 5 });
  assert.equal(result.empty, false);
  assert.equal(result.text, '第一句\n第二句');
  assert.equal(result.count, 2);
  assert.match(result.lan, /中文/);
});

test('comments 归一化作者/内容/点赞', async function () {
  const { api } = apiWith({
    '/x/web-interface/view': { code: 0, data: { bvid: 'BV1gExu6GEjZ', aid: 88, cid: 5, title: 't', pubdate: 1793000000 } },
    '/x/v2/reply/main': {
      code: 0,
      data: { replies: [{ member: { uname: '阿甲' }, content: { message: '哈哈哈' }, like: 12 }] },
    },
  });

  const list = await api.comments({ bvid: 'BV1gExu6GEjZ', ps: 3 });
  assert.deepEqual(list, [{ author: '阿甲', content: '哈哈哈', like: 12 }]);
});

test('多语言字幕轨优先中文，而不是阵列里第一条', async function () {
  const { api } = apiWith({
    '/x/player/v2': {
      code: 0,
      data: {
        subtitle: {
          subtitles: [
            { lan: 'en-US', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/en.json' },
            { lan: 'ai-zh', lan_doc: '中文（自动生成）', subtitle_url: '//aisubtitle.hdslb.com/zh.json' },
          ],
        },
      },
    },
    '/en.json': { body: [{ from: 0, to: 1, content: 'english line' }] },
    '/zh.json': { body: [{ from: 0, to: 1, content: '中文那一行' }] },
  });

  const result = await api.subtitle({ bvid: 'BV1gExu6GEjZ', cid: 5 });
  assert.equal(result.text, '中文那一行');
  assert.equal(result.lan, '中文（自动生成）');
});
