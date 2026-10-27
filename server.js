'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadConfig,
  resolveProvider,
  describeProvider,
} = require('./src/config');
const { loadPersona, buildMessages } = require('./src/persona');
const { streamChat } = require('./src/llm');
const { loadEnvFile, withProcessEnv } = require('./src/env');

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 40;
const MAX_CONTENT_CHARS = 4000;
const MAX_HISTORY = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (chunk) {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, '请求体太大（上限 ' + limit + ' 字节）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', function (err) {
      reject(new HttpError(400, '读取请求体失败：' + err.message));
    });
  });
}

function parseJsonBody(text) {
  if (text.trim() === '') throw new HttpError(400, '请求体是空的，需要 JSON');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, '请求体不是合法 JSON：' + err.message);
  }
}

/**
 * 只接受 user / assistant 两种角色：
 * 客户端传来的 system 消息会被拒绝，避免绕开人设直接改系统提示。
 */
function pickMessages(body) {
  const raw = body && Array.isArray(body.messages) ? body.messages : null;
  if (!raw) throw new HttpError(400, '请求体格式应为 {"messages":[{"role":"user","content":"你好"}]}');
  if (raw.length === 0) throw new HttpError(400, 'messages 是空的');
  if (raw.length > MAX_MESSAGES) throw new HttpError(400, '消息条数太多了（上限 ' + MAX_MESSAGES + ' 条）');

  const messages = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    const index = i + 1;
    if (!item || typeof item !== 'object') throw new HttpError(400, '第 ' + index + ' 条消息不是对象');
    if (item.role !== 'user' && item.role !== 'assistant') {
      throw new HttpError(400, '第 ' + index + ' 条消息的 role 只能是 user 或 assistant');
    }
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content === '') throw new HttpError(400, '第 ' + index + ' 条消息 content 为空');
    if (content.length > MAX_CONTENT_CHARS) {
      throw new HttpError(400, '第 ' + index + ' 条消息太长（上限 ' + MAX_CONTENT_CHARS + ' 字）');
    }
    messages.push({ role: item.role, content: content });
  }
  return messages;
}

function serveStatic(req, res, pathname, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const base = path.resolve(publicDir);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(base, relative);

  // 防目录穿越：解析后的路径必须还在 public/ 里面
  if (target !== base && target.indexOf(base + path.sep) !== 0) {
    sendText(res, 404, '页面不存在');
    return;
  }

  fs.stat(target, function (err, stat) {
    if (err || !stat.isFile()) {
      sendText(res, 404, '页面不存在');
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const stream = fs.createReadStream(target);
    stream.on('error', function () {
      res.destroy();
    });
    stream.pipe(res);
  });
}

function createServer(config, deps) {
  const options = deps || {};
  const root = options.root || config.root || __dirname;
  const publicDir = options.publicDir || path.join(root, 'public');
  const chatStream = options.streamChat || streamChat;
  const logger = options.logger || console;
  const configLoader = options.loadConfig || loadConfig;
  const personaLoader = options.loadPersona || loadPersona;
  const envLoader = options.loadEnvFile || loadEnvFile;

  // 热加载开关本身只在启动时读一次：关掉之后配置就不会再变，改了得重启
  const hotReload = config.hotReload !== false;
  let cached = null;

  /** 按开关决定"每次现读"还是"用启动时缓存" */
  function resolveLive() {
    if (!hotReload && cached) return cached;

    const env = withProcessEnv(envLoader(root));
    const liveConfig = configLoader({ root: root, env: env });
    const resolved = {
      config: liveConfig,
      provider: resolveProvider(liveConfig, liveConfig.active),
      persona: personaLoader(liveConfig.personaPath),
    };
    if (!hotReload) cached = resolved;
    return resolved;
  }

  async function handleChat(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }

    const body = parseJsonBody(await readBody(req, MAX_BODY_BYTES));
    const history = pickMessages(body);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const controller = new AbortController();
    res.on('close', function () {
      if (!res.writableEnded) controller.abort(new Error('client closed'));
    });

    const send = function (payload) {
      if (res.writableEnded || res.destroyed) return;
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    const startedAt = Date.now();
    let text = '';

    try {
      // 热加载开着就每次现读 .env / config.json / 人设，关着就用启动时的缓存
      const live = resolveLive();
      const liveConfig = live.config;
      const provider = live.provider;
      const persona = live.persona;

      send({
        type: 'meta',
        persona: persona.name,
        provider: provider.name,
        model: provider.chatModel,
        maxBubbles: persona.reply.maxBubbles,
      });

      const messages = buildMessages(persona, history, { maxHistory: MAX_HISTORY });
      const stream = chatStream({
        provider: provider,
        messages: messages,
        timeoutMs: liveConfig.requestTimeoutMs,
        signal: controller.signal,
      });

      for await (const delta of stream) {
        text += delta;
        send({ type: 'delta', text: delta });
      }

      send({ type: 'done', ok: true, text: text, ms: Date.now() - startedAt });
      logger.log(
        '[chat] ' + provider.name + '/' + provider.chatModel +
          ' 入 ' + history.length + ' 条 → 出 ' + text.length + ' 字 / ' + (Date.now() - startedAt) + 'ms'
      );
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const code = err && err.code ? err.code : 'unknown';
      send({ type: 'error', message: message, code: code, partial: text });
      send({ type: 'done', ok: false });
      logger.error('[chat] 失败（' + code + '）：' + message);
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  async function handle(req, res) {
    let pathname;
    try {
      const url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch (err) {
      throw new HttpError(400, '请求路径不合法');
    }

    if (pathname === '/api/health') {
      let live;
      try {
        live = resolveLive();
      } catch (err) {
        live = { config: config, provider: config.providers[config.active], persona: null };
      }
      sendJson(res, 200, {
        ok: true,
        provider: live.provider.name,
        model: live.provider.chatModel,
        persona: live.config.personaPath,
        hotReload: hotReload,
      });
      return;
    }

    if (pathname === '/api/chat') {
      await handleChat(req, res);
      return;
    }

    if (pathname.indexOf('/api/') === 0) {
      sendJson(res, 404, { ok: false, error: '没有这个接口：' + pathname });
      return;
    }

    serveStatic(req, res, pathname, publicDir);
  }

  const server = http.createServer(function (req, res) {
    handle(req, res).catch(function (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err && err.message ? err.message : '服务器内部错误';
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (status >= 500) logger.error('[http] ' + message);
      sendJson(res, status, { ok: false, error: message });
    });
  });

  server.on('clientError', function (err, socket) {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return server;
}

function main() {
  let fileEnv;
  let config;
  try {
    fileEnv = loadEnvFile(__dirname);
    config = loadConfig({ root: __dirname, env: withProcessEnv(fileEnv) });
  } catch (err) {
    console.error('启动失败：' + err.message);
    process.exit(1);
    return;
  }

  for (let i = 0; i < config.warnings.length; i += 1) console.warn('提示：' + config.warnings[i]);

  const server = createServer(config, { root: __dirname });

  server.on('error', function (err) {
    if (err.code === 'EADDRINUSE') {
      console.error('端口 ' + config.port + ' 被占用了：关掉旧进程，或改 config.json 的 server.port');
    } else {
      console.error('服务出错：' + (err.message || err));
    }
    process.exit(1);
  });

  server.listen(config.port, config.host, function () {
    const provider = config.providers[config.active];
    console.log('小鲸已启动 → http://' + config.host + ':' + config.port);
    console.log('  配置：' + config.source + ' · ' + describeProvider(provider));
    const envCount = Object.keys(fileEnv || {}).length;
    console.log('  .env：' + (envCount > 0 ? '已加载 ' + envCount + ' 项（进程环境优先）' : '没找到，只用 config.json'));
    console.log('  热加载：' + (config.hotReload
      ? '开（改 .env / config.json / 人设，下一句就生效）'
      : '关（改完需要重启）'));
    if (!provider.apiKey) {
      console.warn('  警告：' + provider.name + ' 还没填 API key，发消息会直接报错（改 config.json 后不必重启）');
    }
    if (config.host === '0.0.0.0' || config.host === '::') {
      console.warn('  警告：已绑定 ' + config.host + '，公网可访问前必须先加登录鉴权');
    }
    console.log('  Ctrl+C 停止');
  });

  const shutdown = function () {
    console.log('\n正在关闭…');
    server.close(function () {
      process.exit(0);
    });
    setTimeout(function () {
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = {
  createServer: createServer,
  main: main,
};
