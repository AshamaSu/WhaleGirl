'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createFeatureHost, defaultModules } = require('../src/features');
const { createBus } = require('../src/events');

const QUIET = { log: function () {}, warn: function () {}, error: function () {} };

function makeContext() {
  return { logger: QUIET, bus: createBus({ logger: QUIET }), dataRoot: '/tmp/wg-test', root: '/tmp/wg-test' };
}

/** 一个记账用的假能力 */
function fakeModule(name, record) {
  return {
    name: name,
    init: function (ctx) {
      record.inits.push(name);
      ctx.route('GET', '/api/' + name, function (req, res) { ctx.sendJson(res, 200, { ok: true }); });
      ctx.addPromptBlock(function () { return '提示-' + name; });
      ctx.addAfterReply(function () { record.afterReply.push(name); });
      return {
        stop: function () { record.stops.push(name); },
      };
    },
  };
}

function freshRecord() {
  return { inits: [], stops: [], afterReply: [] };
}

test('未声明的能力不启动，声明 enabled:true 才启动', function () {
  const record = freshRecord();
  const host = createFeatureHost({
    logger: QUIET,
    context: makeContext(),
    modules: [fakeModule('mood', record), fakeModule('bili', record)],
  });

  host.sync({ features: {} });
  assert.deepStrictEqual(host.running(), []);
  assert.deepStrictEqual(host.state(), {
    mood: { enabled: false, error: '' },
    bili: { enabled: false, error: '' },
  });

  host.sync({ features: { mood: { enabled: true } } });
  assert.deepStrictEqual(host.running(), ['mood']);
  assert.deepStrictEqual(record.inits, ['mood']);

  // 重复 sync 不会重复 init
  host.sync({ features: { mood: { enabled: true } } });
  assert.deepStrictEqual(record.inits, ['mood']);
});

test('关掉开关会停掉能力，并清掉它注册的路由 / prompt / 钩子', async function () {
  const record = freshRecord();
  const host = createFeatureHost({
    logger: QUIET,
    context: makeContext(),
    modules: [fakeModule('mood', record)],
  });

  host.sync({ features: { mood: { enabled: true } } });
  assert.ok(host.matchRoute('GET', '/api/mood'));
  assert.strictEqual(host.promptText(), '提示-mood');

  host.sync({ features: { mood: { enabled: false } } });
  assert.deepStrictEqual(record.stops, ['mood']);
  assert.strictEqual(host.matchRoute('GET', '/api/mood'), null);
  assert.strictEqual(host.promptText(), '');

  await host.afterReply({});
  assert.deepStrictEqual(record.afterReply, [], '关掉之后不该再跑回复后处理');
});

test('init 抛错只记日志：sync 不抛、状态标 error、路由不残留', function () {
  const host = createFeatureHost({
    logger: QUIET,
    context: makeContext(),
    modules: [{
      name: 'broken',
      init: function (ctx) {
        ctx.route('GET', '/api/broken', function () {});
        throw new Error('配置写错了');
      },
    }],
  });

  assert.doesNotThrow(function () { host.sync({ features: { broken: { enabled: true } } }); });
  assert.deepStrictEqual(host.running(), []);
  assert.strictEqual(host.state().broken.enabled, false);
  assert.strictEqual(host.state().broken.error, '配置写错了');
  assert.strictEqual(host.matchRoute('GET', '/api/broken'), null);
});

test('能力可以自定义 enabled 判定', function () {
  const record = freshRecord();
  const module = fakeModule('custom', record);
  module.enabled = function (config) {
    return !!(config.features.custom && config.features.custom.mode === 'on');
  };

  const host = createFeatureHost({ logger: QUIET, context: makeContext(), modules: [module] });
  host.sync({ features: { custom: { enabled: false, mode: 'on' } } });
  assert.deepStrictEqual(host.running(), ['custom']);
});

test('promptText 跳过空片段，单个片段抛错不影响其他片段', function () {
  const host = createFeatureHost({
    logger: QUIET,
    context: makeContext(),
    modules: [
      {
        name: 'a',
        init: function (ctx) {
          ctx.addPromptBlock(function () { return '  '; });
          ctx.addPromptBlock(function () { return '甲'; });
        },
      },
      {
        name: 'b',
        init: function (ctx) {
          ctx.addPromptBlock(function () { throw new Error('片段坏了'); });
          ctx.addPromptBlock(function () { return '乙'; });
        },
      },
    ],
  });

  host.sync({ features: { a: { enabled: true }, b: { enabled: true } } });
  assert.strictEqual(host.promptText(), '甲\n\n乙');
});

test('afterReply 里单个能力失败不影响其他能力', async function () {
  const record = freshRecord();
  const host = createFeatureHost({
    logger: QUIET,
    context: makeContext(),
    modules: [
      {
        name: 'bad',
        init: function (ctx) {
          ctx.addAfterReply(async function () { throw new Error('判定失败'); });
        },
      },
      fakeModule('good', record),
    ],
  });

  host.sync({ features: { bad: { enabled: true }, good: { enabled: true } } });
  await assert.doesNotReject(function () { return host.afterReply({}); });
  assert.deepStrictEqual(record.afterReply, ['good']);
});

test('matchRoute 区分方法', function () {
  const host = createFeatureHost({
    logger: QUIET,
    context: makeContext(),
    modules: [{
      name: 'm',
      init: function (ctx) {
        ctx.route('POST', '/api/thing', function () {});
      },
    }],
  });

  host.sync({ features: { m: { enabled: true } } });
  assert.ok(host.matchRoute('POST', '/api/thing'));
  assert.ok(host.matchRoute('post', '/api/thing'), '方法大小写不敏感');
  assert.strictEqual(host.matchRoute('GET', '/api/thing'), null);
});

test('stopAll 把所有在跑的能力都停掉', function () {
  const record = freshRecord();
  const host = createFeatureHost({
    logger: QUIET,
    context: makeContext(),
    modules: [fakeModule('a', record), fakeModule('b', record)],
  });

  host.sync({ features: { a: { enabled: true }, b: { enabled: true } } });
  host.stopAll();
  assert.deepStrictEqual(record.stops.sort(), ['a', 'b']);
  assert.deepStrictEqual(host.running(), []);
});

test('默认注册表里只有已经实现的能力', function () {
  const names = defaultModules().map(function (module) { return module.name; });
  assert.deepStrictEqual(names, ['mood', 'memory', 'bili']);
});
