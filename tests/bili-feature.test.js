'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBiliModule, normalizeSection } = require('../src/features/bili');
const { createBiliStore } = require('../src/features/bili/store');
const { createBus } = require('../src/events');

const ROOT = path.join(__dirname, '..');
const FIXED = new Date('2026-10-27T21:40:00');
const PERSONA = path.join(ROOT, 'personas', 'whale.json');

const REPORT = ['### BV1gExu6GEjZ', '标题：鲸鱼观察', '为什么值得：好看。'].join('\n');

const quiet = { log: function () {}, warn: function () {} };

function fakeCtx(overrides) {
  const bus = createBus({ logger: quiet });
  const routes = [];
  const config = Object.assign({
    features: { bili: { enabled: true } },
    personaPath: PERSONA,
    requestTimeoutMs: 60000,
    providers: { fake: { name: 'fake' } },
    active: 'fake',
  }, overrides && overrides.config);
  const llmCalls = [];
  const env = (overrides && overrides.env) || {};

  const ctx = {
    root: ROOT,
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bili-feature-')),
    publicDir: path.join(ROOT, 'public'),
    logger: quiet,
    bus: bus,
    sendJson: function (res, status, payload) { res.statusCode = status; res.body = payload; },
    makeLlm: function () {
      return async function (input) {
        llmCalls.push(input);
        return '第一条像样的话\n\n第二条接下去';
      };
    },
    pushText: function (text, meta) {
      bus.emit('push', { target: 'web', text: text, source: (meta && meta.source) || 'plugin' });
    },
    persona: {
      compose: function () {
        return { messages: [{ role: 'system', content: '测试人设' }], reply: { maxBubbles: 3 } };
      },
    },
    makeAgent: function () {
      throw new Error('测试应直接传 runAgent');
    },
    getConfig: function () { return config; },
    getEnv: function () { return env; },
    route: function (method, pathname, handler) {
      routes.push({ method: method, pathname: pathname, handler: handler });
    },
    addPromptBlock: function () {},
    addAfterReply: function () {},
    readJson: async function () { return {}; },
    serveStatic: function () {},
  };
  return { ctx: ctx, bus: bus, routes: routes, llmCalls: llmCalls, config: config };
}

function fakeAgent(text) {
  return function () {
    return (async function* () {
      yield { type: 'final', text: text === undefined ? REPORT : text };
    })();
  };
}

function startModule(overrides) {
  const env = fakeCtx(overrides && overrides.ctx);
  const store = createBiliStore({ root: env.ctx.dataRoot, now: function () { return FIXED; } });
  const module = createBiliModule({
    now: function () { return FIXED; },
    store: store,
    provider: { name: 'fake' },
    runAgent: (overrides && overrides.runAgent) || fakeAgent(),
  });
  const handle = module.init(env.ctx);
  return Object.assign(env, { module: module, handle: handle, store: store });
}

test('开关只看 config.features.bili.enabled', function () {
  const module = createBiliModule();
  assert.equal(module.enabled({ features: { bili: { enabled: true } } }), true);
  assert.equal(module.enabled({ features: { bili: { enabled: false } } }), false);
  assert.equal(module.enabled({ features: {} }), false);
});

test('配置默认值：额度/时段/条数都有兜底', function () {
  const section = normalizeSection({});
  assert.equal(section.intervalMinutes, 180);
  assert.equal(section.dailyQuota, 4);
  assert.equal(section.itemsPerRound, 3);
  assert.deepEqual(section.activeWindows, ['12:00-14:00', '18:00-09:00']);
  assert.equal(section.announce, true);

  const custom = normalizeSection({ dailyQuota: 0, keywords: [' A ', ''], announce: false, minPlays: 0 });
  assert.equal(custom.dailyQuota, 0);
  assert.deepEqual(custom.keywords, ['A']);
  assert.equal(custom.announce, false);
  assert.equal(custom.minPlays, 0);
});

test('init 注册两个路由，state 能看运行状态', async function () {
  const env = startModule();
  try {
    const paths = env.routes.map(function (route) { return route.method + ' ' + route.pathname; });
    assert.deepEqual(paths, ['GET /api/features/bili/state', 'POST /api/features/bili/run', 'POST /api/features/bili/check-replies']);

    const res = {};
    await env.routes[0].handler({}, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.running, false);
    assert.equal(res.body.state.dayRounds, 0);
  } finally {
    env.handle.stop();
  }
});

test('手动一轮：报告落盘 + 主娘口吻两条推送', async function () {
  const env = startModule();
  const pushes = [];
  env.bus.on('push', function (payload) { pushes.push(payload); });

  try {
    const result = await env.handle.runOnce('manual');
    assert.equal(result.ok, true);
    assert.deepEqual(result.picked, ['BV1gExu6GEjZ']);

    assert.equal(env.llmCalls.length, 1, '播报要经过模型');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].source, 'bili');
    assert.equal(pushes[0].text, '第一条像样的话');
    assert.equal(env.store.state().lastResult.ok, true);
  } finally {
    env.handle.stop();
  }
});

test('announce=false 时只落盘不打扰', async function () {
  const env = startModule({ ctx: { config: { features: { bili: { enabled: true, announce: false } } } } });
  const pushes = [];
  env.bus.on('push', function (payload) { pushes.push(payload); });
  try {
    const result = await env.handle.runOnce('manual');
    assert.equal(result.ok, true);
    assert.equal(pushes.length, 0);
    assert.equal(env.llmCalls.length, 0);
  } finally {
    env.handle.stop();
  }
});

test('一轮还在跑时，第二次触发直接拒绝', async function () {
  let release;
  const gate = new Promise(function (resolve) { release = resolve; });
  const env = startModule({
    runAgent: function () {
      return (async function* () {
        await gate;
        yield { type: 'final', text: REPORT };
      })();
    },
  });

  try {
    const first = env.handle.runOnce('manual');
    const second = await env.handle.runOnce('manual');
    assert.equal(second.skipped, true);

    release();
    const result = await first;
    assert.equal(result.ok, true);
  } finally {
    env.handle.stop();
  }
});

test('POST /run 立即返回 202，不阻塞请求', async function () {
  const env = startModule();
  try {
    const res = {};
    await env.routes[1].handler({}, res);
    assert.equal(res.statusCode, 202);
    assert.equal(res.body.started, true);
  } finally {
    env.handle.stop();
  }
});

test('子代理失败不会把异常抛到装配层', async function () {
  const env = startModule({
    runAgent: function () {
      return (async function* () { throw new Error('模型挂了'); })();
    },
  });
  try {
    const result = await env.handle.runOnce('manual');
    assert.equal(result.ok, false);
    assert.match(result.error, /模型挂了/);
  } finally {
    env.handle.stop();
  }
});

test('B站 cookie 走 ctx.getEnv：.env 里配了 SESSDATA 就算登录', async function () {
  const run = startModule({ ctx: { env: { WG_BILI_SESSDATA: 'sess', WG_BILI_DEDE_USER_ID: '42' } } });
  try {
    const res = {};
    await run.routes[0].handler({}, res);
    assert.equal(res.body.login, true);
  } finally {
    run.handle.stop();
  }
});

test('没配 cookie 时 login 为 false，接口层按未登录降级', async function () {
  const run = startModule();
  try {
    const res = {};
    await run.routes[0].handler({}, res);
    assert.equal(res.body.login, false);
  } finally {
    run.handle.stop();
  }
});
