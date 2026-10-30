'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBiliHttp } = require('../src/features/bili/http');
const { createBiliStore } = require('../src/features/bili/store');

const FIXED = new Date('2026-10-29T12:00:00');
const quiet = { log: function () {}, warn: function () {} };

function makeRes() {
  return { statusCode: 0, body: null };
}

function setup(overrides) {
  const opts = overrides || {};
  const store = createBiliStore({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'bili-http-')), now: function () { return FIXED; } });
  const ctx = { sendJson: function (res, status, payload) { res.statusCode = status; res.body = payload; } };
  const svc = Object.assign({
    running: function () { return false; },
    replying: function () { return false; },
    lastResult: function () { return null; },
    section: function () { return { interact: { enabled: true, maxLikes: 10, maxCoins: 2, maxFavorites: 3, maxReplies: 5, maxDynamics: 2 } }; },
    state: function () { return store.state(); },
    seenCount: function () { return 3; },
    interact: function () { return { section: {}, budget: { likes: { used: 0, limit: 10, left: 10 } }, log: [] }; },
    login: function () { return true; },
    mid: function () { return '9973677'; },
    replyCheckAt: function () { return ''; },
    startBrowse: function () {},
    startReplyCheck: function () { return { ok: true }; },
  }, opts.svc || {});
  const routes = createBiliHttp(svc, ctx);
  return { routes: routes, ctx: ctx };
}

function byPath(routes, pathname) {
  return routes.filter(function (route) { return route.pathname === pathname; })[0];
}

test('三条路由都带契约与摘要，路径与顺序稳定', function () {
  const env = setup();
  assert.deepEqual(env.routes.map(function (route) { return route.method + ' ' + route.pathname; }), [
    'GET /api/features/bili/state',
    'POST /api/features/bili/run',
    'POST /api/features/bili/check-replies',
    'GET /api/features/bili/follows',
    'POST /api/features/bili/follows',
    'POST /api/features/bili/follows/remove',
    'GET /api/features/bili/params',
    'POST /api/features/bili/params',
  ]);
  for (const route of env.routes) {
    assert.equal(typeof route.summary, 'string');
    assert.ok(route.summary.length > 0, route.pathname + ' 缺 summary');
    assert.equal(typeof route.contract.request, 'string');
    assert.equal(typeof route.contract.response, 'object');
  }
});

test('state 按契约回包：字段齐、额度与登录态透传', function () {
  const env = setup();
  const res = makeRes();
  byPath(env.routes, '/api/features/bili/state').handler({}, res);
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.deepEqual(Object.keys(body).sort(), [
    'interact', 'lastReplyCheckAt', 'lastResult', 'login', 'mid', 'ok', 'running', 'section', 'seen', 'state',
  ]);
  assert.equal(body.ok, true);
  assert.equal(body.login, true);
  assert.equal(body.mid, '9973677');
  assert.equal(body.seen, 3);
  assert.equal(body.interact.budget.likes.limit, 10);
});

test('run：空闲 202，忙时 409', function () {
  const started = [];
  const env = setup({ svc: { startBrowse: function (trigger) { started.push(trigger); } } });
  const res1 = makeRes();
  byPath(env.routes, '/api/features/bili/run').handler({}, res1);
  assert.equal(res1.statusCode, 202);
  assert.equal(res1.body.started, true);
  assert.deepEqual(started, ['manual']);

  const busy = setup({ svc: { running: function () { return true; } } });
  const res2 = makeRes();
  byPath(busy.routes, '/api/features/bili/run').handler({}, res2);
  assert.equal(res2.statusCode, 409);
  assert.match(res2.body.error, /还在跑/);
});

test('check-replies：未登录 400，忙 409，正常 202', function () {
  const anon = setup({ svc: { login: function () { return false; } } });
  const res1 = makeRes();
  byPath(anon.routes, '/api/features/bili/check-replies').handler({}, res1);
  assert.equal(res1.statusCode, 400);
  assert.match(res1.body.error, /没登录/);

  const busy = setup({ svc: { replying: function () { return true; } } });
  const res2 = makeRes();
  byPath(busy.routes, '/api/features/bili/check-replies').handler({}, res2);
  assert.equal(res2.statusCode, 409);

  const started = [];
  const ok = setup({ svc: { startReplyCheck: function () { started.push(1); return { ok: true }; } } });
  const res3 = makeRes();
  byPath(ok.routes, '/api/features/bili/check-replies').handler({}, res3);
  assert.equal(res3.statusCode, 202);
  assert.equal(started.length, 1);
});

test('startReplyCheck 抛错时接口转 409', function () {
  const env = setup({ svc: { startReplyCheck: function () { return { ok: false, error: '装配失败' }; } } });
  const res = makeRes();
  byPath(env.routes, '/api/features/bili/check-replies').handler({}, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /装配失败/);
});
