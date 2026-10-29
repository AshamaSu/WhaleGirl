'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-jsonc-'));
}

test('配置支持中文注释（// 与 /* */），且不破坏字符串里的 //', function () {
  const root = tmpRoot();
  const raw = [
    '{',
    '  // 服务监听',
    '  "server": { "host": "127.0.0.1", "port": 9001 },',
    '  "active": "deepseek", // 当前使用的服务商',
    '  /* 人设文件路径 */',
    '  "persona": "personas/whale.json",',
    '  "providers": {',
    '    "deepseek": {',
    '      "baseUrl": "https://api.deepseek.com/v1",',
    '      "apiKey": "sk-test",',
    '      "chatModel": "deepseek-chat"',
    '    }',
    '  }',
    '}',
    '// 文件末尾注释',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'config.json'), raw);

  const config = loadConfig({ root: root, env: {} });

  assert.strictEqual(config.port, 9001);
  assert.strictEqual(config.active, 'deepseek');
  assert.strictEqual(config.providers.deepseek.baseUrl, 'https://api.deepseek.com/v1');
  assert.strictEqual(config.providers.deepseek.apiKey, 'sk-test');
  assert.deepStrictEqual(config.warnings, []);
});

test('转义引号与块注释里的引号不影响解析', function () {
  const root = tmpRoot();
  const raw = [
    '{',
    '  /* 注释里带 \" 引号也不该影响 */',
    '  "server": { "host": "127.0.0.1", "port": 9002 },',
    '  "active": "deepseek",',
    '  "persona": "personas/whale.json",',
    '  "note": "he said \\\"hi\\\"",',
    '  "providers": { "deepseek": { "baseUrl": "https://a/v1", "apiKey": "k", "chatModel": "m" } }',
    '}',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'config.json'), raw);
  const config = loadConfig({ root: root, env: {} });
  assert.strictEqual(config.port, 9002);
});