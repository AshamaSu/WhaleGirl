'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CONFIG_FILE = 'config.json';
const EXAMPLE_FILE = 'config.example.json';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_PERSONA = 'personas/whale.json';
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_TEMPERATURE = 1.1;

/** 模板里的占位 key，等同未填 */
const PLACEHOLDER_KEY = /^(?:your[-_ ]?key.*|sk-xxx.*|<.*>)$/i;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readJsonFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new ConfigError('读取配置文件失败：' + filePath + '（' + (err.code || err.message) + '）');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ConfigError('配置文件不是合法 JSON：' + filePath + '（' + err.message + '）');
  }
}

/** provider 名 -> 环境变量片段：deepseek -> DEEPSEEK */
function envName(name) {
  return String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function firstDefined() {
  for (let i = 0; i < arguments.length; i += 1) {
    const value = arguments[i];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isPlaceholder(value) {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  return trimmed === '' || PLACEHOLDER_KEY.test(trimmed);
}

/**
 * 单个 provider 归一化。缺 baseUrl / chatModel 的条目直接忽略并给出告警，
 * 这样 config.json 里留半份没填完的模板不会把整个服务搞挂。
 */
function normalizeProvider(name, raw, env, warnings) {
  if (!raw || typeof raw !== 'object') {
    warnings.push('providers.' + name + ' 不是对象，已忽略');
    return null;
  }

  const prefix = 'WG_' + envName(name) + '_';
  const baseUrl = firstDefined(env[prefix + 'BASE_URL'], raw.baseUrl);
  if (typeof baseUrl !== 'string' || !/^https?:\/\//i.test(baseUrl)) {
    warnings.push('providers.' + name + ' 缺少合法的 baseUrl（需 http/https 开头），已忽略');
    return null;
  }

  const chatModel = firstDefined(env[prefix + 'CHAT_MODEL'], raw.chatModel);
  if (typeof chatModel !== 'string' || chatModel.trim() === '') {
    warnings.push('providers.' + name + ' 缺少 chatModel，已忽略');
    return null;
  }

  const rawKey = firstDefined(env[prefix + 'API_KEY'], raw.apiKey, '');
  const apiKey = isPlaceholder(rawKey) ? '' : String(rawKey).trim();

  return {
    name: name,
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    apiKey: apiKey,
    chatModel: chatModel.trim(),
    visionModel: String(firstDefined(env[prefix + 'VISION_MODEL'], raw.visionModel, '')).trim(),
    temperature: clamp(
      toNumber(firstDefined(env[prefix + 'TEMPERATURE'], raw.temperature), DEFAULT_TEMPERATURE),
      0,
      2
    ),
  };
}

/**
 * 读取并归一化配置。
 * 优先级：环境变量 WG_* > config.json > config.example.json
 */
function loadConfig(options) {
  const opts = options || {};
  const root = opts.root || process.cwd();
  const env = opts.env || process.env;
  const warnings = [];

  const mainPath = path.join(root, CONFIG_FILE);
  const examplePath = path.join(root, EXAMPLE_FILE);

  let raw = readJsonFile(mainPath);
  let source = CONFIG_FILE;

  if (!raw) {
    raw = readJsonFile(examplePath);
    source = EXAMPLE_FILE;
    if (!raw) {
      throw new ConfigError('找不到配置：目录 ' + root + ' 下既没有 ' + CONFIG_FILE + ' 也没有 ' + EXAMPLE_FILE);
    }
    warnings.push('没有 ' + CONFIG_FILE + '，已回退到 ' + EXAMPLE_FILE + '（只读模板）。建议 cp ' + EXAMPLE_FILE + ' ' + CONFIG_FILE + ' 后填 key');
  }

  const server = raw.server && typeof raw.server === 'object' ? raw.server : {};
  const host = String(firstDefined(env.WG_HOST, server.host, DEFAULT_HOST));
  const port = toNumber(firstDefined(env.WG_PORT, server.port), DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError('端口不合法：' + port + '（应为 0~65535 的整数）');
  }

  const providers = {};
  const rawProviders = raw.providers && typeof raw.providers === 'object' ? raw.providers : {};
  const names = Object.keys(rawProviders);
  for (let i = 0; i < names.length; i += 1) {
    const provider = normalizeProvider(names[i], rawProviders[names[i]], env, warnings);
    if (provider) providers[names[i]] = provider;
  }

  const providerNames = Object.keys(providers);
  if (providerNames.length === 0) {
    throw new ConfigError('没有任何可用的 provider：请检查 config.json 的 providers（至少需要 baseUrl + chatModel）');
  }

  let active = String(firstDefined(env.WG_ACTIVE, raw.active, providerNames[0]));
  if (!providers[active]) {
    warnings.push('active="' + active + '" 不在 providers 里，已回退到 "' + providerNames[0] + '"');
    active = providerNames[0];
  }

  const personaFile = String(firstDefined(env.WG_PERSONA, raw.persona, DEFAULT_PERSONA));

  return {
    root: root,
    source: source,
    host: host,
    port: port,
    active: active,
    personaPath: path.isAbsolute(personaFile) ? personaFile : path.join(root, personaFile),
    requestTimeoutMs: toNumber(firstDefined(env.WG_TIMEOUT_MS, raw.requestTimeoutMs), DEFAULT_TIMEOUT_MS),
    providers: providers,
    warnings: warnings,
  };
}

function resolveProvider(config, name) {
  const target = name || config.active;
  const provider = config.providers[target];
  if (!provider) {
    const available = Object.keys(config.providers).join(', ');
    throw new ConfigError('没有名为 "' + target + '" 的 provider，可用：' + available);
  }
  return provider;
}

/** 日志用，别把 key 打出去 */
function maskKey(key) {
  if (!key) return '(未配置)';
  if (key.length <= 8) return '***';
  return key.slice(0, 4) + '***' + key.slice(-4);
}

function describeProvider(provider) {
  return provider.name + ' · ' + provider.chatModel + ' · key=' + maskKey(provider.apiKey) + ' · temp=' + provider.temperature;
}

module.exports = {
  ConfigError: ConfigError,
  loadConfig: loadConfig,
  resolveProvider: resolveProvider,
  maskKey: maskKey,
  describeProvider: describeProvider,
  isPlaceholder: isPlaceholder,
  CONFIG_FILE: CONFIG_FILE,
  EXAMPLE_FILE: EXAMPLE_FILE,
};
