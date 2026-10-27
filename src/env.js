'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ENV_FILE = '.env';
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 极简 .env 解析：只支持 KEY=VALUE、# 注释、可选 export 前缀、成对引号。
 * 不做变量插值、不做多行值——这个项目用不到，少一层魔法少一处坑。
 */
function parseEnv(text) {
  const values = {};
  const lines = String(text == null ? '' : text).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();
    if (line === '' || line.charAt(0) === '#') continue;
    if (line.indexOf('export ') === 0) line = line.slice(7).trim();

    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    const first = value.charAt(0);
    const last = value.charAt(value.length - 1);
    if (value.length >= 2 && ((first === '"' && last === '"') || (first === "'" && last === "'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

/** 读 <root>/.env，没有就返回空对象 */
function loadEnvFile(root) {
  const file = path.join(root, ENV_FILE);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error('读取 ' + file + ' 失败（' + (err.code || err.message) + '）');
  }
  return parseEnv(text);
}

/** 进程环境优先，.env 只补空缺（与 dotenv 行为一致，方便临时用 WG_* 覆盖） */
function withProcessEnv(fileEnv, procEnv) {
  const merged = Object.assign({}, fileEnv);
  const env = procEnv || process.env;
  const keys = Object.keys(env);
  for (let i = 0; i < keys.length; i += 1) merged[keys[i]] = env[keys[i]];
  return merged;
}

module.exports = {
  ENV_FILE: ENV_FILE,
  parseEnv: parseEnv,
  loadEnvFile: loadEnvFile,
  withProcessEnv: withProcessEnv,
};
