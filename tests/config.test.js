'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, resolveProvider, ConfigError, isPlaceholder } = require('../src/config');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-config-'));
}

function writeConfig(root, name, data) {
  const file = path.join(root, name);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

function baseRaw(overrides) {
  const raw = {
    server: { host: '127.0.0.1', port: 8787 },
    active: 'deepseek',
    persona: 'personas/whale.json',
    requestTimeoutMs: 60000,
    providers: {
      deepseek: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-real-key-123456',
        chatModel: 'deepseek-chat',
        temperature: 1.2,
      },
    },
  };
  return Object.assign(raw, overrides || {});
}

test('读 config.json 并归一化 provider', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw());

  const config = loadConfig({ root: root, env: {} });

  assert.strictEqual(config.source, 'config.json');
  assert.strictEqual(config.host, '127.0.0.1');
  assert.strictEqual(config.port, 8787);
  assert.strictEqual(config.active, 'deepseek');
  assert.strictEqual(config.personaPath, path.join(root, 'personas/whale.json'));
  assert.strictEqual(config.providers.deepseek.apiKey, 'sk-real-key-123456');
  assert.strictEqual(config.providers.deepseek.temperature, 1.2);
  assert.deepStrictEqual(config.warnings, []);
});

test('没有 config.json 时回退 config.example.json 并告警', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.example.json', baseRaw());

  const config = loadConfig({ root: root, env: {} });

  assert.strictEqual(config.source, 'config.example.json');
  assert.ok(config.warnings.some(function (w) { return w.indexOf('config.example.json') !== -1; }));
});

test('两份配置都没有时报 ConfigError', function () {
  assert.throws(function () {
    loadConfig({ root: tmpRoot(), env: {} });
  }, ConfigError);
});

test('环境变量优先于 config.json', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw());
  fs.mkdirSync(path.join(root, 'personas'));
  fs.writeFileSync(path.join(root, 'personas', 'other.json'), '{}');

  const config = loadConfig({
    root: root,
    env: {
      WG_HOST: '0.0.0.0',
      WG_PORT: '9000',
      WG_ACTIVE: 'deepseek',
      WG_PERSONA: 'personas/other.json',
      WG_TIMEOUT_MS: '1500',
      WG_DEEPSEEK_API_KEY: 'sk-from-env-9999',
      WG_DEEPSEEK_CHAT_MODEL: 'deepseek-reasoner',
    },
  });

  assert.strictEqual(config.host, '0.0.0.0');
  assert.strictEqual(config.port, 9000);
  assert.strictEqual(config.requestTimeoutMs, 1500);
  assert.strictEqual(config.providers.deepseek.apiKey, 'sk-from-env-9999');
  assert.strictEqual(config.providers.deepseek.chatModel, 'deepseek-reasoner');
  assert.strictEqual(config.personaPath, path.join(root, 'personas/other.json'));
});

test('占位 key 当成未配置', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw({
    providers: {
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'your-key-here', chatModel: 'deepseek-chat' },
      zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: '<在这里填>', chatModel: 'glm-4-flash' },
    },
  }));

  const config = loadConfig({ root: root, env: {} });

  assert.strictEqual(config.providers.deepseek.apiKey, '');
  assert.strictEqual(config.providers.zhipu.apiKey, '');
  assert.strictEqual(isPlaceholder('sk-xxxx'), true);
});

test('active 不存在时回退第一个 provider 并告警', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw({ active: 'openai' }));

  const config = loadConfig({ root: root, env: {} });

  assert.strictEqual(config.active, 'deepseek');
  assert.ok(config.warnings.some(function (w) { return w.indexOf('openai') !== -1; }));
});

test('缺 baseUrl 或 chatModel 的 provider 被忽略，其余照常可用', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw({
    providers: {
      broken: { apiKey: 'x', chatModel: 'x' },
      noModel: { baseUrl: 'https://example.com/v1' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', chatModel: 'deepseek-chat' },
    },
  }));

  const config = loadConfig({ root: root, env: {} });

  assert.deepStrictEqual(Object.keys(config.providers), ['deepseek']);
  assert.strictEqual(config.warnings.length, 2);
});

test('所有 provider 都不可用时报 ConfigError', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw({ providers: { broken: { apiKey: 'x' } } }));

  assert.throws(function () {
    loadConfig({ root: root, env: {} });
  }, /没有任何可用的 provider/);
});

test('端口非法时报 ConfigError', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw());
  assert.throws(function () {
    loadConfig({ root: root, env: { WG_PORT: '99999' } });
  }, /端口不合法/);
});

test('baseUrl 末尾斜杠被清理', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw({
    providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1///', apiKey: 'k', chatModel: 'deepseek-chat' } },
  }));

  const config = loadConfig({ root: root, env: {} });
  assert.strictEqual(config.providers.deepseek.baseUrl, 'https://api.deepseek.com/v1');
});

test('配置文件不是合法 JSON 时报中文错误', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', '{ "providers": ');
  assert.throws(function () {
    loadConfig({ root: root, env: {} });
  }, /不是合法 JSON/);
});

test('resolveProvider 找不到时列出可用项', function () {
  const root = tmpRoot();
  writeConfig(root, 'config.json', baseRaw());
  const config = loadConfig({ root: root, env: {} });

  assert.strictEqual(resolveProvider(config).name, 'deepseek');
  assert.throws(function () {
    resolveProvider(config, 'nope');
  }, /可用：deepseek/);
});

