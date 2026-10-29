'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBiliClient, BiliError } = require('../src/features/bili/vendor/client');
const { createBiliApi } = require('../src/features/bili/vendor/api');
const { createBiliTools } = require('../src/features/bili/vendor/tools');
const { createBiliStore } = require('../src/features/bili/store');
const { shouldCheckReplies } = require('../src/features/bili/schedule');
const { runReplyCheckRound, notifyLine } = require('../src/features/bili/runner');

const LOGIN_ENV = {
  WG_BILI_SESSDATA: 'sess',
  WG_BILI_BILI_JCT: 'jct-token',
  WG_BILI_DEDE_USER_ID: '42',
};

/** 极简 fetch 替身：按「方法 + 路径」返回预设 JSON，并记录调用 */
function makeFetch(table) {
  const calls = [];
  const impl = async function (url, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    calls.push({ method: method, url: String(url), headers: (init && init.headers) || {}, body: (init && init.body) || '' });
    const hit = table(method, String(url));
    if (!hit) return { ok: false, status: 404, json: async function () { return {}; } };
    return { ok: true, status: 200, json: async function () { return hit; } };
  };
  impl.calls = calls;
  return impl;
}

function navPayload() {
  return {
    code: 0,
    data: {
      isLogin: true,
      mid: 42,
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
      },
    },
  };
}

function tableFor(calls) {
  return function (method, url) {
    if (url.indexOf('/x/frontend/finger/spi') !== -1) return { code: 0, data: { b_3: 'BUVID-x' } };
    if (url.indexOf('/x/web-interface/wbi/search/type') !== -1) return { code: 0, data: { result: [] } };
    if (url.indexOf('/x/web-interface/nav') !== -1) return navPayload();
    if (url.indexOf('/x/web-interface/view') !== -1) {
      return { code: 0, data: { aid: 1001, cid: 11, bvid: 'BV1like00001', title: '标题', desc: '', owner: { name: 'UP' }, stat: { view: 10, like: 10 }, pubdate: 0, duration: '1:00', tname: '测试' } };
    }
    if (method === 'POST' && url.indexOf('/x/web-interface/archive/like/triple') !== -1) return { code: 0, data: { like: true, coin: true, fav: true } };
    if (method === 'POST' && url.indexOf('/x/web-interface/archive/like') !== -1) return { code: 0, data: {} };
    if (method === 'POST' && url.indexOf('/x/web-interface/coin/add') !== -1) return { code: 0, data: {} };
    if (method === 'POST' && url.indexOf('/x/v3/fav/resource/deal') !== -1) return { code: 0, data: {} };
    if (method === 'POST' && url.indexOf('/x/v3/fav/folder/add') !== -1) return { code: 0, data: { id: 7 } };
    if (url.indexOf('/x/v3/fav/folder/created/list-all') !== -1) return { code: 0, data: { list: [{ id: 7, title: '默认收藏夹' }] } };
    if (method === 'POST' && url.indexOf('/x/v2/reply/add') !== -1) return { code: 0, data: { rpid: 999 } };
    if (method === 'POST' && url.indexOf('/x/v2/reply/action') !== -1) return { code: 0, data: {} };
    if (url.indexOf('/x/relation/followings') !== -1) {
      return { code: 0, data: { list: [{ mid: 9973677, uname: '主人', sign: '喵' }, { mid: 5, uname: '路人', sign: '' }] } };
    }
    if (url.indexOf('/x/polymer/web-dynamic/v1/feed') !== -1) {
      return { code: 0, data: { items: [
        { modules: {
          module_author: { name: '主人', pub_time: '今天 12:00' },
          module_dynamic: { desc: { text: '转发：好看' }, major: { archive: { bvid: 'BV1dyna00001', aid: 2001, title: '主人在看的视频', duration_text: '3:21', stat: { play: 100, like: 50 } } } },
        } },
        { modules: {} },
      ] } };
    }
    if (url.indexOf('/x/msgfeed/reply') !== -1) {
      // 2026-10 实测的真实结构
      return { code: 0, data: { items: [
        { id: 1190711467122688, user: { mid: 9973677, nickname: '主人' }, item: { subject_id: 43660166, root_id: 322274546432, source_id: 318557538337, type: 'reply', business_id: 12, title: '文章标题', root_reply_content: '我们原来的评论', source_content: '谢谢投币！' } },
        { id: 'msg-2', user: { mid: 7, nickname: '网友' }, item: { subject_id: 1001, root_id: 0, source_id: 777, type: 'reply', business_id: 1, title: '视频标题', root_reply_content: '', source_content: '同好！' } },
      ] } };
    }
    return null;
  };
}

function newClient(fetchImpl, extra) {
  return createBiliClient(Object.assign({ fetchImpl: fetchImpl, intervalMs: 1, buvid3: 'BUVID-x', env: LOGIN_ENV }, extra || {}));
}

// ===== client.post =====

test('post 走表单 + 自动带 csrf', async function () {
  const fetchImpl = makeFetch(tableFor());
  const client = newClient(fetchImpl);

  await client.post('/x/web-interface/archive/like', { bvid: 'BV1like00001', like: 1 });

  const call = fetchImpl.calls[fetchImpl.calls.length - 1];
  assert.equal(call.method, 'POST');
  assert.match(call.headers['content-type'], /x-www-form-urlencoded/);
  assert.match(call.body, /bvid=BV1like00001/);
  assert.match(call.body, /like=1/);
  assert.match(call.body, /csrf=jct-token/);
});

test('没登录时 post 直接拒绝，不空打接口', async function () {
  const fetchImpl = makeFetch(tableFor());
  const client = createBiliClient({ fetchImpl: fetchImpl, intervalMs: 1, buvid3: 'x', env: {} });
  await assert.rejects(
    function () { return client.post('/x/web-interface/archive/like', { bvid: 'BV1like00001' }); },
    function (err) {
      assert.ok(err instanceof BiliError);
      assert.match(err.message, /没登录/);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('selfMid：cookie 里的 DedeUserID 兜底，nav 后取真值', async function () {
  const fetchImpl = makeFetch(tableFor());
  const client = newClient(fetchImpl);
  assert.equal(client.selfMid(), '42');
  await client.getSigned('/x/web-interface/wbi/search/type', { keyword: 'a' });
  assert.equal(client.selfMid(), '42');
});

// ===== api 写操作 =====

test('点赞/投币/三连/收藏/评论：参数与 csrf 都对', async function () {
  const fetchImpl = makeFetch(tableFor());
  const client = newClient(fetchImpl);
  const api = createBiliApi(client, {});

  await api.likeVideo({ bvid: 'BV1like00001' });
  await api.coin({ bvid: 'BV1like00001', multiply: 2 });
  await api.triple({ bvid: 'BV1like00001' });
  await api.favorite({ bvid: 'BV1like00001' });
  const replyed = await api.reply({ bvid: 'BV1like00001', message: '给你投币啦～' });

  const posts = fetchImpl.calls.filter(function (call) { return call.method === 'POST'; });
  assert.ok(posts.some(function (call) { return call.url.indexOf('/archive/like') !== -1 && /like=1/.test(call.body); }));
  assert.ok(posts.some(function (call) { return call.url.indexOf('/coin/add') !== -1 && /multiply=2/.test(call.body); }));
  assert.ok(posts.some(function (call) { return call.url.indexOf('/like/triple') !== -1; }));
  assert.ok(posts.some(function (call) { return call.url.indexOf('/fav/resource/deal') !== -1 && /rid=1001/.test(call.body) && /add_media_ids=7/.test(call.body); }));
  assert.ok(posts.some(function (call) { return call.url.indexOf('/v2/reply/add') !== -1 && /message=/.test(call.body) && /oid=1001/.test(call.body); }));
  assert.equal(replyed.rpid, 999);
});

test('文章评论走 oid+type=12 直发；parent 缺省回落 root', async function () {
  const fetchImpl = makeFetch(tableFor());
  const api = createBiliApi(newClient(fetchImpl), {});
  await api.reply({ oid: 43660166, type: 12, message: '主人来啦～', rootRpid: 322274546432 });
  const call = fetchImpl.calls.filter(function (entry) { return entry.url.indexOf('/v2/reply/add') !== -1; })[0];
  assert.match(call.body, /oid=43660166/);
  assert.match(call.body, /type=12/);
  assert.match(call.body, /root=322274546432/);
  assert.match(call.body, /parent=322274546432/);
});

test('楼中楼回复指定对方：parent 用 reply_rpid', async function () {
  const fetchImpl = makeFetch(tableFor());
  const api = createBiliApi(newClient(fetchImpl), {});
  await api.reply({ oid: 43660166, type: 12, message: '回复 @跃动的金币 : 主人好呀～', rootRpid: 322274546432, parentRpid: 318557538337 });
  const call = fetchImpl.calls.filter(function (entry) { return entry.url.indexOf('/v2/reply/add') !== -1; })[0];
  assert.match(call.body, /root=322274546432/);
  assert.match(call.body, /parent=318557538337/);
});

test('评论支持 aid 直发（通知里没有 bvid 的场景）', async function () {
  const fetchImpl = makeFetch(tableFor());
  const api = createBiliApi(newClient(fetchImpl), {});
  await api.reply({ aid: 1001, message: '回你啦', rootRpid: 555 });
  const call = fetchImpl.calls.filter(function (entry) { return entry.url.indexOf('/v2/reply/add') !== -1; })[0];
  assert.match(call.body, /oid=1001/);
  assert.match(call.body, /root=555/);
});

// ===== api 主人数源 =====

test('followings/masterDynamics/msgfeed 都归一化成干净字段', async function () {
  const fetchImpl = makeFetch(tableFor());
  const api = createBiliApi(newClient(fetchImpl), {});

  const follows = await api.followings({ vmid: 9973677 });
  assert.equal(follows[0].mid, 9973677);
  assert.equal(follows[0].uname, '主人');

  const dyn = await api.masterDynamics({ vmid: 9973677 });
  assert.equal(dyn.length, 1);
  assert.equal(dyn[0].bvid, 'BV1dyna00001');
  assert.equal(dyn[0].author, '主人');

  const feed = await api.msgfeedReplies({ ps: 10 });
  assert.equal(feed.length, 2);
  assert.equal(feed[0].fromMid, 9973677);
  assert.equal(feed[0].fromName, '主人');
  assert.equal(feed[0].oid, 43660166);
  assert.equal(feed[0].subjectType, 12);
  assert.equal(feed[0].rootRpid, 322274546432);
  assert.equal(feed[0].replyRpid, 318557538337);
  assert.equal(feed[0].text, '谢谢投币！');
  assert.equal(feed[1].subjectType, 1);
  assert.equal(feed[1].oid, 1001);
  assert.equal(feed[1].replyRpid, 777);
});

// ===== store：互动预算 =====

function tmpStore(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-interact-'));
  return createBiliStore({ root: dir, now: now, onWarn: function () {} });
}

test('recordInteract 记账，interactBudget 按剩余算', function () {
  const store = tmpStore();
  const limits = { maxLikes: 3, maxCoins: 2, maxFavorites: 1, maxReplies: 5 };

  store.recordInteract('likes', { bvid: 'BV1', detail: '测试' });
  store.recordInteract('coins', { bvid: 'BV1', detail: '投2枚' });
  store.recordInteract('coins', { bvid: 'BV1', detail: '投2枚' });

  const budget = store.interactBudget(limits);
  assert.equal(budget.likes.used, 1);
  assert.equal(budget.likes.left, 2);
  assert.equal(budget.coins.left, 0);
  assert.equal(budget.favorites.left, 1);
  assert.equal(budget.replies.left, 5);
  assert.equal(store.interactLog(10).length, 3);
});

test('换天互动额度归零', function () {
  let fake = new Date('2026-10-29T10:00:00');
  const store = tmpStore(function () { return fake; });
  const limits = { maxLikes: 3, maxCoins: 2, maxFavorites: 3, maxReplies: 5 };

  store.recordInteract('likes', { bvid: 'BV1', detail: '' });
  assert.equal(store.interactBudget(limits).likes.left, 2);

  fake = new Date('2026-10-30T09:00:00');
  assert.equal(store.interactBudget(limits).likes.left, 3);
});

test('notified 去重：mark 过的不再算新', function () {
  const store = tmpStore();
  assert.equal(store.hasNotified('msg-1'), false);
  store.markNotified(['msg-1', 'msg-2']);
  assert.equal(store.hasNotified('msg-1'), true);
  assert.equal(store.hasNotified('msg-2'), true);
  assert.equal(store.hasNotified('msg-3'), false);
});

// ===== schedule：轻量查回复节拍 =====

test('shouldCheckReplies：互动没开/时段不对/间隔未到都不跑', function () {
  const now = new Date('2026-10-29T20:00:00');
  const section = { interact: { enabled: true }, activeWindows: [], replyCheckIntervalMinutes: 30 };

  assert.equal(shouldCheckReplies({ state: {}, section: section, now: now }).run, true);

  const disabled = shouldCheckReplies({ state: {}, section: { interact: { enabled: false } }, now: now });
  assert.equal(disabled.run, false);

  const outWindow = shouldCheckReplies({
    state: {},
    section: { interact: { enabled: true }, activeWindows: ['01:00-02:00'], weekendAllDay: false },
    now: now,
  });
  assert.equal(outWindow.run, false);

  const tooSoon = shouldCheckReplies({
    state: { lastReplyCheckAt: new Date(now.getTime() - 5 * 60000).toISOString() },
    section: section,
    now: now,
  });
  assert.equal(tooSoon.run, false);
});

// ===== tools：额度闸门 =====

function fakeBudget(initial) {
  const left = Object.assign({ likes: 10, coins: 4, favorites: 3, replies: 5 }, initial || {});
  const recorded = [];
  return {
    recorded: recorded,
    remaining: function (type) { return left[type]; },
    record: function (type, cost) {
      left[type] -= cost;
      recorded.push({ type: type, cost: cost });
    },
  };
}

function toolByName(tools, name) {
  const hit = tools.filter(function (tool) { return tool.name === name; })[0];
  if (!hit) throw new Error('找不到工具 ' + name);
  return hit;
}

test('额度用完时写工具直接拒绝，不打接口', async function () {
  const fetchImpl = makeFetch(tableFor());
  const api = createBiliApi(newClient(fetchImpl), {});
  const budget = fakeBudget({ likes: 0 });
  const tools = createBiliTools(api, {
    interact: { enabled: true },
    budget: budget,
    masterMid: '9973677',
  });

  const text = await toolByName(tools, 'bili_like').execute({ bvid: 'BV1like00001', reason: '好' });
  assert.match(text, /额度用完了/);
  assert.equal(fetchImpl.calls.filter(function (call) { return call.method === 'POST'; }).length, 0);
});

test('成功互动会记账；投币 2 枚扣 2；三连扣点赞2硬币2收藏', async function () {
  const fetchImpl = makeFetch(tableFor());
  const api = createBiliApi(newClient(fetchImpl), {});
  const budget = fakeBudget();
  const tools = createBiliTools(api, {
    interact: { enabled: true },
    budget: budget,
    masterMid: '9973677',
  });

  const coinText = await toolByName(tools, 'bili_coin').execute({ bvid: 'BV1like00001', multiply: 2, reason: '神作' });
  assert.match(coinText, /投币 2 枚成功/);
  assert.deepEqual(budget.recorded[budget.recorded.length - 1], { type: 'coins', cost: 2 });

  const tripleText = await toolByName(tools, 'bili_triple').execute({ bvid: 'BV1like00001', reason: '必推' });
  assert.match(tripleText, /三连成功/);
  assert.deepEqual(budget.recorded.slice(-3).map(function (entry) { return entry.type; }), ['likes', 'coins', 'favorites']);

  const commentText = await toolByName(tools, 'bili_comment').execute({ bvid: 'BV1like00001', message: '给你投币啦～' });
  assert.match(commentText, /发送成功/);
});

test('互动没开时写工具说明原因，主人的评论会被标注', async function () {
  const fetchImpl = makeFetch(tableFor());
  const api = createBiliApi(newClient(fetchImpl), {});
  const budget = fakeBudget();
  const tools = createBiliTools(api, {
    interact: { enabled: false },
    budget: budget,
    masterMid: '9973677',
    isNewNotified: function () { return true; },
  });

  const text = await toolByName(tools, 'bili_like').execute({ bvid: 'BV1like00001', reason: '好' });
  assert.match(text, /互动功能没开/);

  const feed = await toolByName(tools, 'bili_check_replies').execute({});
  assert.match(feed, /【新】/);
  assert.match(feed, /主人（主人）|主人（\(主人\)）/);
  assert.match(feed, /root_rpid=322274546432/);
  assert.match(feed, /reply_rpid=318557538337/);
  assert.match(feed, /type=12/);
});

// ===== runner：轻量查回复轮 =====

test('没有新通知时一次模型都不调', async function () {
  const store = tmpStore();
  store.markNotified(['msg-1', 'msg-2']);
  let agentCalls = 0;

  const result = await runReplyCheckRound({
    store: store,
    section: { owner: '主人' },
    api: { msgfeedReplies: async function () { return [
      { id: 'msg-1', fromMid: 9973677, fromName: '主人', text: '谢谢投币', oid: 1001, subjectType: 1, subjectTitle: '标题', rootRpid: 555, rootText: '原评论', replyRpid: 888, timeAt: '' },
    ]; } },
    runAgent: function () { agentCalls += 1; return (async function* () {})(); },
    masterMid: '9973677',
    logger: { log: function () {}, warn: function () {} },
  });

  assert.equal(result.ok, true);
  assert.equal(result.newCount, 0);
  assert.equal(agentCalls, 0);
});

test('有新通知：交给工具循环处理，处理后不再算新', async function () {
  const store = tmpStore();
  let agentOptions = null;
  const runAgent = function (opts) {
    agentOptions = opts;
    return (async function* () {
      yield { type: 'tool' };
      yield { type: 'tool' };
      yield { type: 'final', text: '回完啦，主人的留言也打了招呼' };
    })();
  };

  const result = await runReplyCheckRound({
    store: store,
    section: { owner: '主人' },
    api: { msgfeedReplies: async function () { return [
      { id: 'msg-1', fromMid: 9973677, fromName: '主人', text: '谢谢投币', oid: 1001, subjectType: 1, subjectTitle: '标题', rootRpid: 555, rootText: '原评论', replyRpid: 888, timeAt: '' },
      { id: 'msg-9', fromMid: 7, fromName: '网友', text: '同好', oid: 1001, subjectType: 1, subjectTitle: '标题', rootRpid: 0, rootText: '', replyRpid: 999, timeAt: '' },
    ]; } },
    runAgent: runAgent,
    tools: [],
    masterMid: '9973677',
    logger: { log: function () {}, warn: function () {} },
  });

  assert.equal(result.ok, true);
  assert.equal(result.newCount, 2);
  assert.ok(agentOptions);
  assert.match(agentOptions.messages[1].content, /主人/);
  assert.equal(store.hasNotified('msg-1'), true);
  assert.equal(store.hasNotified('msg-9'), true);
  assert.ok(store.state().lastReplyCheckAt);
});

test('notifyLine 给主人的消息带标注', function () {
  const line = notifyLine({ fromMid: 9973677, fromName: '主人', text: '谢谢', oid: 1, subjectTitle: 'T', bvid: 'BV1', rootRpid: 9, rootText: '我们说的' }, '9973677');
  assert.match(line, /（主人）/);
  assert.match(line, /root_rpid=9/);
});
