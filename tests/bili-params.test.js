'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createBiliModule } = require('../src/features/bili');
const { createBiliStore } = require('../src/features/bili/store');
const { createBus } = require('../src/events');
const { stripComments } = require('../src/config-edit');

const ROOT = path.join(__dirname, '..');
const FIXED = new Date('2026-10-29T12:00:00');
const quiet = { log: function () {}, warn: function () {} };

const CONFIG_JSONC = [
  '{',
  '  // 主配置',
  '  "active": "deepseek",',
  '  "requestTimeoutMs": 60000,',
  '  "features": {',
  '    "bili": {',
  '      // 是否启用',
  '      "enabled": true,',
  '      "intervalMinutes": 180,',
  '      "interact": {',
  '        "enabled": true,',
  '        "maxLikes": 10',
  '      }',
  '    }',
  '  }',
  '}',
].join('\n');

function start(params) {
  params = params || {};
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-params-'));
  fs.writeFileSync(path.join(root, 'config.json'), params.configText || CONFIG_JSONC, { mode: 0o600 });
  let configText = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
  const readConfig = function () {
    configText = fs.readFileSync(path.join(root, 'config.json'), 'utf8');
    return JSON.parse(stripComments(configText));
  };

  const routes = [];
  const ctx = {
    root: root,
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'bili-params-data-')),
    publicDir: path.join(ROOT, 'public'),
    logger: quiet,
    bus: createBus({ logger: quiet }),
    sendJson: function (res, status, payload) { res.statusCode = status; res.body = payload; },
    makeLlm: function () { return async function () { return '好呀'; }; },
    pushText: function () {},
    persona: { compose: function () { return { messages: [], reply: { maxBubbles: 3 } }; } },
    makeAgent: function () { throw new Error('测试直接传 runAgent'); },
    getConfig: readConfig,
    getEnv: function () { return {}; },
    route: function (method, pathname, handler) { routes.push({ method: method, pathname: pathname, handler: handler }); },
    addPromptBlock: function () {},
    addAfterReply: function () {},
    readJson: async function () { return {}; },
    serveStatic: function () {},
  };
  const store = createBiliStore({ root: ctx.dataRoot, now: function () { return FIXED; } });
  const module = createBiliModule({
    now: function () { return FIXED; },
    store: store,
    provider: { name: 'fake' },
    runAgent: function () {
      return (async function* () { yield { type: 'final', text: '' }; })();
    },
  });
  const handle = module.init(ctx);
  return { root: root, ctx: ctx, handle: handle, routes: routes, readConfigText: function () { return fs.readFileSync(path.join(root, 'config.json'), 'utf8'); } };
}

test('specs 齐全：19 个参数，键含 interact 点路径', function () {
  const env = start();
  const specs = env.handle.specs();
  assert.equal(specs.length, 19);
  const keys = specs.map(function (spec) { return spec.key; });
  assert.ok(keys.indexOf('intervalMinutes') !== -1);
  assert.ok(keys.indexOf('interact.maxCoins') !== -1);
  for (const spec of specs) {
    assert.equal(typeof spec.label, 'string');
    assert.ok(spec.label.length > 0);
  }
});

test('写参数：写回 config.json 且保注释，运行段热生效', function () {
  const env = start();
  const result = env.handle.applyParams({ intervalMinutes: 90, 'interact.maxCoins': 1, dailyQuota: 6 });
  assert.deepEqual(result.errors, undefined);
  assert.equal(result.ok, true);

  const text = env.readConfigText();
  assert.match(text, /\/\/ 是否启用/);
  assert.match(text, /"intervalMinutes": 90/);
  assert.match(text, /"maxCoins": 1/);
  assert.match(text, /"dailyQuota": 6/);
  const parsed = JSON.parse(stripComments(text));
  assert.equal(parsed.features.bili.intervalMinutes, 90);

  // 运行段热生效（handle.section 是原位更新的对象）
  assert.equal(env.handle.section.intervalMinutes, 90);
  assert.equal(env.handle.section.interact.maxCoins, 1);
});

test('校验拒绝：越界/未知键/坏时段格式，且不落盘', function () {
  const env = start();
  const before = env.readConfigText();
  const result = env.handle.applyParams({
    intervalMinutes: 99999,
    dailyQuota: -1,
    'interact.maxCoins': '很多',
    unknownKey: 1,
    activeWindows: ['25:00-26:00'],
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 5);
  assert.match(result.errors.join('\n'), /不能大于 1440/);
  assert.match(result.errors.join('\n'), /不能小于 0/);
  assert.match(result.errors.join('\n'), /必须是数字/);
  assert.match(result.errors.join('\n'), /未知参数/);
  assert.match(result.errors.join('\n'), /时段格式/);
  assert.equal(env.readConfigText(), before);
});

test('enabled 开关走同一入口写回', function () {
  const env = start();
  const result = env.handle.applyParams({ enabled: false });
  assert.equal(result.ok, true);
  const parsed = JSON.parse(stripComments(env.readConfigText()));
  assert.equal(parsed.features.bili.enabled, false);
});
