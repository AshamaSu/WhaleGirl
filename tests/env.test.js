'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseEnv, loadEnvFile, withProcessEnv } = require('../src/env');

test('解析基本的 KEY=VALUE，跳过注释与空行', function () {
  const env = parseEnv([
    '# 注释',
    '',
    'WG_ACTIVE=deepseek',
    'WG_PORT=8787',
    '  WG_HOST = 127.0.0.1  ',
  ].join('\n'));

  assert.deepStrictEqual(env, {
    WG_ACTIVE: 'deepseek',
    WG_PORT: '8787',
    WG_HOST: '127.0.0.1',
  });
});

test('支持 export 前缀与成对引号', function () {
  const env = parseEnv([
    'export WG_A=1',
    'WG_B="有空格 的值"',
    "WG_C='单引号'",
  ].join('\n'));

  assert.strictEqual(env.WG_A, '1');
  assert.strictEqual(env.WG_B, '有空格 的值');
  assert.strictEqual(env.WG_C, '单引号');
});

test('key 里带等号时只切第一个等号', function () {
  const env = parseEnv('WG_KEY=abc=def==');
  assert.strictEqual(env.WG_KEY, 'abc=def==');
});

test('不像赋值的行被忽略', function () {
  const env = parseEnv(['这不是赋值', '=nokey', '1BAD=x', 'GOOD=1'].join('\n'));
  assert.deepStrictEqual(env, { GOOD: '1' });
});

test('loadEnvFile 读根目录 .env，没有就返回空对象', function () {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-env-'));
  assert.deepStrictEqual(loadEnvFile(empty), {});

  fs.writeFileSync(path.join(empty, '.env'), 'WG_X=1\n');
  assert.deepStrictEqual(loadEnvFile(empty), { WG_X: '1' });
});

test('进程环境优先于 .env', function () {
  const merged = withProcessEnv({ WG_A: 'from-file', WG_B: 'from-file' }, { WG_A: 'from-proc' });

  assert.strictEqual(merged.WG_A, 'from-proc');
  assert.strictEqual(merged.WG_B, 'from-file');
});
