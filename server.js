'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadConfig,
  resolveProvider,
  resolveVisionProvider,
  describeProvider,
} = require('./src/config');
const { loadPersona, validatePersona, buildMessages } = require('./src/persona');
const { streamChat } = require('./src/llm');
const { runAgent } = require('./src/agent');
const { createTools } = require('./src/tools');
const { openMemory, extractFacts, summarizeTurns, safeSessionId } = require('./src/memory');
const { loadEnvFile, withProcessEnv } = require('./src/env');
const { createBus } = require('./src/events');
const { createFeatureHost } = require('./src/features');

const FEATURE_SYNC_MS = 5000;

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_IMAGE_CHARS = 3 * 1024 * 1024;
const MAX_HISTORY = 20;

const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

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
        reject(new HttpError(413, '请求体太大（上限 ' + Math.round(limit / 1024) + 'KB）'));
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
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new HttpError(400, '请求体不是合法 JSON：' + err.message);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象');
  }
  return value;
}

/** 只接受 { sessionId, message, image }，system 角色永远不给客户端 */
function pickChatInput(body) {
  const sessionId = safeSessionId(body.sessionId);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const image = typeof body.image === 'string' ? body.image.trim() : '';

  if (message === '' && image === '') throw new HttpError(400, '消息是空的');
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new HttpError(400, '消息太长（上限 ' + MAX_MESSAGE_CHARS + ' 字）');
  }
  if (image !== '') {
    if (!IMAGE_DATA_URL.test(image)) {
      throw new HttpError(400, '图片格式不对，需要 data:image/(png|jpeg|webp|gif);base64,... 形式的 data URL');
    }
    if (image.length > MAX_IMAGE_CHARS) {
      throw new HttpError(413, '图片太大（上限约 ' + Math.round(MAX_IMAGE_CHARS / 1024 / 1024) + 'MB base64）');
    }
  }
  return { sessionId: sessionId, message: message, image: image };
}

function withImage(messages, image, text) {
  const copy = messages.map(function (item) {
    return { role: item.role, content: item.content };
  });
  const last = copy[copy.length - 1];
  last.content = [
    { type: 'text', text: text === '' ? '（我发了一张图）' : text },
    { type: 'image_url', image_url: { url: image } },
  ];
  return copy;
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

function buildLlmText(provider, timeoutMs) {
  return async function (request) {
    let text = '';
    const stream = streamChat({
      provider: provider,
      messages: request.messages,
      temperature: request.temperature,
      timeoutMs: timeoutMs,
    });
    for await (const chunk of stream) text += chunk;
    return text;
  };
}

/** 回复发完之后才跑：摘要压缩 + 事实抽取，失败只记日志 */
function scheduleMemoryWork(options) {
  const memory = options.memory;
  const run = async function () {
    const llm = options.llm;
    try {
      if (memory.shouldSummarize()) {
        const turns = memory.turnsToSummarize();
        const previous = memory.export().summary;
        const summary = await summarizeTurns(llm, turns, previous);
        if (summary) memory.applySummary(summary, turns.length);
        options.logger.log('[memory] 已压缩 ' + turns.length + ' 条旧对话');
      }

      const recent = memory.recentTurns(2);
      const facts = await extractFacts(llm, recent);
      for (let i = 0; i < facts.length; i += 1) memory.addFact(facts[i], 'auto');
      if (facts.length > 0) options.logger.log('[memory] 记住：' + facts.join(' / '));
    } catch (err) {
      options.logger.warn('[memory] 后台整理失败：' + (err && err.message ? err.message : err));
    }
  };

  const runner = options.runner || setImmediate;
  runner(function () {
    run();
  });
}

function createServer(config, deps) {
  const options = deps || {};
  const root = options.root || config.root || __dirname;
  const dataRoot = options.dataRoot || root;
  const publicDir = options.publicDir || path.join(root, 'public');
  const chatStream = options.streamChat || streamChat;
  const agentRunner = options.runAgent || runAgent;
  const eventsStream = options.streamChatEvents;
  const logger = options.logger || console;
  const configLoader = options.loadConfig || loadConfig;
  const personaLoader = options.loadPersona || loadPersona;
  const envLoader = options.loadEnvFile || loadEnvFile;
  const disableBackground = options.disableBackground === true;

  // 热加载开关本身只在启动时读一次：关掉之后配置就不会再变，改了得重启
  const hotReload = config.hotReload !== false;
  let cached = null;
  // 先声明再赋值：能力模块 init 里可能回调 getConfig -> resolveLive -> sync
  let featureHost = null;

  function resolveLive() {
    if (!hotReload && cached) return cached;

    const env = withProcessEnv(envLoader(root));
    const liveConfig = configLoader({ root: root, env: env });
    const resolved = {
      config: liveConfig,
      env: env,
      provider: resolveProvider(liveConfig, liveConfig.active),
      persona: personaLoader(liveConfig.personaPath),
    };
    if (!hotReload) cached = resolved;
    // 开关跟随热加载：每轮对齐一次启停状态，没变化就什么都不做
    if (featureHost) featureHost.sync(liveConfig);
    return resolved;
  }

  const bus = options.bus || createBus({ logger: logger });

  const featureContext = {
    root: root,
    dataRoot: dataRoot,
    publicDir: publicDir,
    logger: logger,
    bus: bus,
    sendJson: sendJson,
    sendText: sendText,
    serveStatic: function (req, res, pathname) {
      serveStatic(req, res, pathname, publicDir);
    },
    readJson: async function (req, limit) {
      return parseJsonBody(await readBody(req, limit || MAX_BODY_BYTES));
    },
    getConfig: function () { return resolveLive().config; },
    // 能力模块里凡是要读 .env（比如 B站 cookie）都走这里，别直接摸 process.env
    getEnv: function () { return resolveLive().env || {}; },
    makeLlm: function () {
      const live = resolveLive();
      return buildLlmText(live.provider, live.config.requestTimeoutMs);
    },
  };

  featureHost = options.features || createFeatureHost({
    logger: logger,
    context: featureContext,
    modules: options.featureModules,
  });
  featureHost.sync(config);

  /** 开关紧跟配置：路由匹配前对一次，另有 5s 定时兜底（没有请求时也能停掉被关闭的能力） */
  function syncFeaturesNow() {
    if (!featureHost) return;
    try {
      resolveLive();
    } catch (err) {
      logger.warn('[features] 同步开关状态失败：' + (err && err.message ? err.message : String(err)));
    }
  }

  const featureSyncTimer = disableBackground ? null : setInterval(syncFeaturesNow, FEATURE_SYNC_MS);
  if (featureSyncTimer && typeof featureSyncTimer.unref === 'function') featureSyncTimer.unref();

  async function handleChat(req, res) {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' });
      res.end('Method Not Allowed');
      return;
    }

    const input = pickChatInput(parseJsonBody(await readBody(req, MAX_BODY_BYTES)));

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
    let memory = null;
    let liveProvider = null;
    let liveTimeout = config.requestTimeoutMs;

    try {
      const live = resolveLive();
      const liveConfig = live.config;
      const persona = live.persona;
      liveProvider = live.provider;
      liveTimeout = liveConfig.requestTimeoutMs;

      memory = openMemory({
        root: dataRoot,
        sessionId: input.sessionId,
        settings: liveConfig.memory,
        onWarn: function (msg) {
          logger.warn('[memory] ' + msg);
        },
      });

      const history = memory.recentTurns(MAX_HISTORY);
      const factsCount = memory.factsForPrompt().length;
      const hasSummary = memory.export().summary !== '';

      let vision = null;
      if (input.image) vision = resolveVisionProvider(liveConfig);
      const responder = vision || liveProvider;

      send({
        type: 'meta',
        persona: persona.name,
        provider: responder.name,
        model: vision ? vision.visionModel : liveProvider.chatModel,
        maxBubbles: persona.reply.maxBubbles,
        sessionId: input.sessionId,
        memory: { facts: factsCount, summary: hasSummary },
      });

      // 先落用户这条，模型出错也不会丢
      memory.appendTurn('user', input.message === '' ? '（发了一张图片）' : input.message);

      const messages = buildMessages(
        persona,
        history.concat([{ role: 'user', content: input.message === '' ? '（看这张图）' : input.message }]),
        { maxHistory: MAX_HISTORY, memoryText: memory.memoryBlock(), extraText: featureHost.promptText() }
      );

      if (vision) {
        const visionProvider = Object.assign({}, vision, { chatModel: vision.visionModel });
        const visionMessages = withImage(messages, input.image, input.message);
        const stream = chatStream({
          provider: visionProvider,
          messages: visionMessages,
          temperature: 0.8,
          timeoutMs: liveTimeout,
          signal: controller.signal,
        });
        for await (const chunk of stream) {
          text += chunk;
          send({ type: 'delta', text: chunk });
        }
      } else {
        const tools = createTools({
          memory: memory,
          searchApiKey: liveConfig.search.apiKey,
          searchEndpoint: liveConfig.search.endpoint,
          searchMaxResults: liveConfig.search.maxResults,
        });
        const stream = agentRunner({
          provider: liveProvider,
          messages: messages,
          tools: tools,
          maxRounds: liveConfig.agent.maxRounds,
          timeoutMs: liveTimeout,
          signal: controller.signal,
          streamChatEvents: eventsStream,
        });
        for await (const event of stream) {
          if (event.type === 'text') {
            text += event.text;
            send({ type: 'delta', text: event.text });
          } else if (event.type === 'tool') {
            send({ type: 'tool', name: event.name, ok: event.ok, args: event.args });
          }
        }
      }

      memory.appendTurn('assistant', text);
      send({ type: 'done', ok: true, text: text, ms: Date.now() - startedAt });
      logger.log(
        '[chat] ' + responder.name + '/' + (vision ? vision.visionModel : liveProvider.chatModel) +
          ' 会话=' + input.sessionId + ' → 出 ' + text.length + ' 字 / ' + (Date.now() - startedAt) + 'ms'
      );

      if (!disableBackground) {
        scheduleMemoryWork({
          memory: memory,
          llm: buildLlmText(liveProvider, liveTimeout),
          logger: logger,
          runner: options.backgroundRunner,
        });
        // 能力模块的回复后处理（目前是心情判定）同样只进日志，绝不影响这条回复
        featureHost.afterReply({
          sessionId: input.sessionId,
          personaName: persona.name,
          userText: input.message,
          replyText: text,
          ms: Date.now() - startedAt,
        }).catch(function (err) {
          logger.warn('[features] 回复后处理失败：' + (err && err.message ? err.message : err));
        });
      }
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

  async function handlePersona(req, res) {
    const file = config.personaPath;

    if (req.method === 'GET') {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        throw new HttpError(500, '读人设失败：' + (err.message || err));
      }
      sendJson(res, 200, { ok: true, path: file, hotReload: hotReload, persona: raw });
      return;
    }

    if (req.method === 'PUT') {
      const body = parseJsonBody(await readBody(req, 1024 * 200));
      const raw = body.persona && typeof body.persona === 'object' ? body.persona : body;
      try {
        validatePersona(raw, '请求体');
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
      sendJson(res, 200, { ok: true, path: file, hotReload: hotReload });
      return;
    }

    res.writeHead(405, { allow: 'GET, PUT' });
    res.end('Method Not Allowed');
  }

  function handleMemory(req, res, url) {
    const sessionId = safeSessionId(url.searchParams.get('sessionId'));

    if (req.method === 'GET') {
      const memory = openMemory({ root: dataRoot, sessionId: sessionId, settings: config.memory });
      sendJson(res, 200, { ok: true, memory: memory.export() });
      return;
    }

    if (req.method === 'DELETE') {
      const memory = openMemory({ root: dataRoot, sessionId: sessionId, settings: config.memory });
      memory.clear();
      sendJson(res, 200, { ok: true, sessionId: sessionId, cleared: true });
      return;
    }

    res.writeHead(405, { allow: 'GET, DELETE' });
    res.end('Method Not Allowed');
  }

  /**
   * 全局广播通道（SSE）：网页挂件、主动推送都从这里收。
   * 只发不收，客户端断线即回收监听。
   */
  function handleEvents(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { allow: 'GET' });
      res.end('Method Not Allowed');
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': connected\n\n');

    const send = function (payload) {
      if (res.writableEnded || res.destroyed) return;
      res.write('data: ' + JSON.stringify(payload) + '\n\n');
    };

    const offs = [
      bus.on('mood', function (moodState) { send({ type: 'mood', mood: moodState }); }),
      bus.on('push', function (msg) {
        const payload = msg && typeof msg === 'object' ? msg : {};
        send({ type: 'push', target: payload.target, text: payload.text, source: payload.source });
      }),
    ];

    let closed = false;
    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      for (let i = 0; i < offs.length; i += 1) offs[i]();
    }

    // 定期发注释帧：免得中间层掐连接，也顺手回收已经断掉的连接
    const ping = setInterval(function () {
      if (res.writableEnded || res.destroyed) cleanup();
      else res.write(': ping\n\n');
    }, 25000);
    if (typeof ping.unref === 'function') ping.unref();

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  async function handle(req, res) {
    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://localhost');
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
        personaName: live.persona ? live.persona.name : '',
        hotReload: hotReload,
        tools: ['web_search', 'fetch_url', 'remember'],
        features: featureHost.state(),
      });
      return;
    }

    if (pathname === '/api/chat') {
      await handleChat(req, res);
      return;
    }

    if (pathname === '/api/persona') {
      await handlePersona(req, res);
      return;
    }

    if (pathname === '/api/memory') {
      handleMemory(req, res, url);
      return;
    }

    if (pathname === '/api/events') {
      handleEvents(req, res);
      return;
    }

    // 先把开关状态对齐到最新配置，再匹配能力路由：否则关闭后旧路由仍会被命中
    if (pathname.indexOf('/api/') === 0) syncFeaturesNow();
    const featureRoute = featureHost.matchRoute(req.method, pathname);
    if (featureRoute) {
      await featureRoute.handler(req, res, url);
      return;
    }

    if (pathname === '/persona') {
      serveStatic(req, res, '/persona.html', publicDir);
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

  // 测试和 main() 都需要拿到能力宿主（看状态、关停）
  server.features = featureHost;
  server.bus = bus;

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
    // 名字只认人设文件，改 whale.json 的 name 这里跟着变
    let personaName = '';
    try {
      personaName = loadPersona(config.personaPath).name;
    } catch (err) {
      console.warn('  警告：读人设拿不到名字（' + err.message + '）');
    }
    console.log((personaName || '服务') + ' 已启动 → http://' + config.host + ':' + config.port);
    console.log('  配置：' + config.source + ' · ' + describeProvider(provider));
    const envCount = Object.keys(fileEnv || {}).length;
    console.log('  .env：' + (envCount > 0 ? '已加载 ' + envCount + ' 项（进程环境优先）' : '没找到，只用 config.json'));
    console.log('  搜索：' + (config.search.apiKey ? 'Tavily 已配置' : '未配 key（web_search 会给出提示）'));
    console.log('  热加载：' + (config.hotReload
      ? '开（改 .env / config.json / 人设，下一句就生效）'
      : '关（改完需要重启）'));
    if (!provider.apiKey) {
      console.warn('  警告：' + provider.name + ' 还没填 API key，发消息会直接报错（改 .env 后不必重启）');
    }
    if (config.host === '0.0.0.0' || config.host === '::') {
      console.warn('  警告：已绑定 ' + config.host + '，公网可访问前必须先加登录鉴权');
    }
    console.log('  Ctrl+C 停止');
  });

  const shutdown = function () {
    console.log('\n正在关闭…');
    clearInterval(featureSyncTimer);
    try {
      server.features.stopAll();
    } catch (err) {
      console.error('关闭能力时出错：' + (err && err.message ? err.message : err));
    }
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
