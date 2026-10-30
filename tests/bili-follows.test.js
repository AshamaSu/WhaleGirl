'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBiliStore } = require('../src/features/bili/store');
const { createBiliModule } = require('../src/features/bili/index');

const ROOT = path.join(__dirname, '..');
const QUIET = { log: function () {}, warn: function () {}, error: function () {} };
const FIXED = new Date('2026-10-30T12:00:00+08:00');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bili-follows-'));
}

test('follows.json 存储新增/更新/移除/按 mid 查找', function () {
  const root = tmpRoot();
  const store = createBiliStore({ root: root, now: function () { return FIXED; } });
  assert.deepEqual(store.getFollows(), []);

  const record = store.addFollow({ mid: 333, uname: '小明', remark: '球友', special: false });
  assert.equal(record.followedAt !== '', true);
  assert.equal(store.findFollow(333).uname, '小明');

  // 重复添加 = 更新（保留 followedAt，补 special）
  store.addFollow({ mid: 333, special: true });
  const again = store.findFollow(333);
  assert.equal(again.special, true, 'special 一经标记不回落');
  assert.equal(again.remark, '球友', '备注保留');

  const removed = store.removeFollow(333);
  assert.equal(removed.mid, 333);
  assert.equal(store.findFollow(333), null);
  assert.equal(store.removeFollow(333), null);
});

function fakeFollowings(pages) {
  const calls = [];
  return {
    calls: calls,
    api: {
      followings: async function (params) {
        calls.push({ kind: 'followings', params: params });
        return pages[params.pn] || [];
      },
      relationModify: async function (fid, act) {
        calls.push({ kind: 'modify', fid: fid, act: act });
        return true;
      },
    },
  };
}

function boot(overrides) {
  const opts = overrides || {};
  const fake = fakeFollowings(opts.pages || {});
  const root = tmpRoot();
  const busCalls = [];
  const ctx = {
    root: root,
    dataRoot: root,
    publicDir: path.join(ROOT, 'public'),
    logger: QUIET,
    bus: { on: function () {}, emit: function () {} },
    sendJson: function (res, status, payload) { res.statusCode = status; res.body = payload; },
    makeLlm: function () { return null; },
    pushText: function () {},
    persona: { compose: function () { return { messages: [], reply: { maxBubbles: 3 } }; } },
    makeAgent: function () { throw new Error('不该用子代理'); },
    getConfig: function () { return { features: { bili: Object.assign({ dutyFile: path.join(ROOT, 'prompts', 'bili-duty.md') }, opts.section || {}) } }; },
    getEnv: function () { return {}; },
    route: function (method, pathname, handler) { routes.push({ method: method, pathname: pathname, handler: handler }); },
    addPromptBlock: function () {},
    addAfterReply: function () {},
    addTool: function (def) { tools.push(def); },
    addMemoryFact: function (text, source) { memoryFacts.push({ text: text, source: source }); },
    readJson: async function (req, limit) { return ctx._body || {}; },
    serveStatic: function () {},
  };
  const routes = [];
  const tools = [];
  const memoryFacts = [];
  const store = createBiliStore({ root: root, now: function () { return FIXED; } });
  const module = createBiliModule({
    now: function () { return FIXED; },
    store: store,
    client: { hasLogin: function () { return true; }, mid: function () { return 9973677; }, selfMid: function () { return 9973677; } },
    api: fake.api,
    provider: { name: 'fake' },
    runAgent: opts.runAgent || function () { return (async function* () { yield { type: 'final', text: '' }; })(); },
  });
  const handle = module.init(ctx);
  return { handle: handle, store: store, calls: fake.calls, routes: routes, tools: tools, memoryFacts: memoryFacts };
}

test('网页端关注：成功写入名单并计额度；重复关注给人话提示', async function () {
  const env = boot({ pages: { 1: [{ mid: 111, uname: '老王', special: false }] } });
  const section = env.handle.section;
  section.interact.maxFollows = 5;

  const ok = await env.handle.follow(222, '球友');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.follow.uname, '', '回读列表里没有 222，先记空名');
  assert.equal(env.store.findFollow(222).remark, '球友');
  assert.equal(env.calls.some(function (c) { return c.kind === 'modify' && c.fid === 222 && c.act === 1; }), true);
  assert.equal(env.store.interactBudget(section.interact).follows.used, 1, '关注计入当日额度');

  const dup = await env.handle.follow(111);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /已经关注/);
  assert.equal(env.store.findFollow(111).uname, '老王', '已关注的也补进名单');
});

test('额度打穿：maxFollows 用完后关注被拒', async function () {
  const env = boot({ pages: { 1: [] } });
  const section = env.handle.section;
  section.interact.maxFollows = 1;

  const first = await env.handle.follow(1001);
  assert.equal(first.ok, true);
  const second = await env.handle.follow(1002);
  assert.equal(second.ok, false);
  assert.match(second.error, /额度/);
});

test('取关保护：特别关注组账号拒绝；普通账号放行；没关注的人提示对账', async function () {
  const env = boot({ pages: { 1: [{ mid: 222, uname: '特别的老王', special: true }, { mid: 111, uname: '老王', special: false }] } });

  const special = await env.handle.unfollow(222);
  assert.equal(special.ok, false);
  assert.match(special.error, /特别关注/);
  assert.equal(env.calls.some(function (c) { return c.kind === 'modify' && c.act === 2; }), false, '拒绝时绝不发写请求');

  const normal = await env.handle.unfollow(111);
  assert.equal(normal.ok, true, JSON.stringify(normal));
  assert.equal(env.calls.some(function (c) { return c.kind === 'modify' && c.fid === 111 && c.act === 2; }), true);

  const ghost = await env.handle.unfollow(999);
  assert.equal(ghost.ok, false);
  assert.match(ghost.error, /没有关注/);
});


// —— A4：browse_recall 查询工具 ——

test('init 注册 plugin_bili_browse_recall 只读工具，execute 聚合三类本地记录', async function () {
  const env = boot({ pages: { 1: [] } });
  const tool = env.tools.find(function (item) { return item.name === 'plugin_bili_browse_recall'; });
  assert.ok(tool, '工具已注册');
  assert.match(tool.description, /仅当主人明确问起/, 'description 写明触发纪律');

  const store = env.store;
  store.appendHistory([{ bvid: 'BV1gExu6GEjZ', title: '深海养鱼指南', up: '蓝色小肥鱼', link: 'x' }], { at: FIXED });
  store.addFollow({ mid: 222, uname: '特别的老王', remark: '球友', special: true });
  store.recordInteract('replies', { detail: '评论：这个卡点也太丝滑了吧' });

  const browse = await tool.execute({ topic: 'browse' });
  assert.match(browse, /深海养鱼指南/);
  assert.match(browse, /蓝色小肥鱼/);

  const follows = await tool.execute({ topic: 'follows' });
  assert.match(follows, /特别的老王/);
  assert.match(follows, /球友/);
  assert.match(follows, /特别关注/);

  const replies = await tool.execute({ topic: 'replies' });
  assert.match(replies, /丝滑/);

  const summary = await tool.execute({ topic: 'summary', keyword: '深海' });
  assert.match(summary, /深海养鱼指南/);
  assert.match(summary, /名单是空的/, 'keyword 过滤后关注名单为空');

  const miss = await tool.execute({ topic: 'browse', keyword: '不存在的词' });
  assert.match(miss, /没有看过/);
});


// —— A3：概念总结进宿主记忆 ——

test('浏览轮有入选结果时，概念总结以 source=bili 写入宿主记忆', async function () {
  const env = boot({
    pages: { 1: [] },
    runAgent: function () {
      return (async function* () {
        yield { type: 'final', text: '### BV1gExu6GEjZ\n标题：鲸鱼观察日记\nUP：某UP主\n链接：x\n播放：12.3万\n为什么值得：拍得干净。\n' };
      })();
    },
  });
  const result = await env.handle.runOnce('manual');
  assert.equal(result.ok, true, JSON.stringify({ error: result.error }));
  assert.equal(env.memoryFacts.length, 1, '本轮写了一条概念记忆');
  assert.match(env.memoryFacts[0].text, /鲸鱼观察日记/);
  assert.equal(env.memoryFacts[0].source, 'bili');
});

test('浏览轮没有入选结果时，不写概念记忆', async function () {
  const env = boot({ pages: { 1: [] } });
  await env.handle.runOnce('manual');
  assert.equal(env.memoryFacts.length, 0);
});

