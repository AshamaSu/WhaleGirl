'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../server');
const { loadConfig } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const PERSONA = path.join(ROOT, 'personas', 'whale.json');
const QUIET = { log: function () {}, warn: function () {}, error: function () {} };

function baseConfig(overrides) {
  const config = {
    root: ROOT,
    source: 'config.json',
    host: '127.0.0.1',
    port: 0,
    active: 'deepseek',
    personaPath: PERSONA,
    requestTimeoutMs: 5000,
    providers: {
      deepseek: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-test-1234',
        chatModel: 'deepseek-chat',
        visionModel: '',
        temperature: 1.1,
      },
    },
    warnings: [],
  };
  return Object.assign(config, overrides || {});
}

async function start(config, deps) {
  const options = Object.assign({ root: ROOT, logger: QUIET }, deps || {});
  // 默认隔离磁盘：直接返回传入的配置，避免测试被仓库里的 config.json 影响
  if (!options.loadConfig) {
    options.loadConfig = function () {
      return config;
    };
  }

  const server = createServer(config, options);
  await new Promise(function (resolve) {
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    base: 'http://127.0.0.1:' + server.address().port,
    port: server.address().port,
    close: function () {
      return new Promise(function (resolve) {
        server.close(resolve);
      });
    },
  };
}

function fakeStream(chunks) {
  return function () {
    return (async function* () {
      for (let i = 0; i < chunks.length; i += 1) yield chunks[i];
    })();
  };
}

function parseSse(text) {
  return text.split('\n\n').filter(function (block) {
    return block.trim() !== '';
  }).map(function (block) {
    const line = block.split('\n').filter(function (item) {
      return item.indexOf('data:') === 0;
    })[0];
    return JSON.parse(line.slice(5).trim());
  });
}

function postChat(base, body) {
  return fetch(base + '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** 用原始 http 请求，绕开 fetch 对 URL 的归一化，才能测到真实的穿越路径 */
function rawGet(port, rawPath) {
  return new Promise(function (resolve, reject) {
    const req = http.request({ host: '127.0.0.1', port: port, path: rawPath, method: 'GET' }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) { body += chunk; });
      res.on('end', function () { resolve({ status: res.statusCode, body: body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

test('/api/health 返回当前 provider 与模型', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const res = await fetch(app.base + '/api/health');
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.provider, 'deepseek');
    assert.strictEqual(data.model, 'deepseek-chat');
  } finally {
    await app.close();
  }
});

test('/api/chat 流式返回 meta / delta / done', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['唔…', '你好呀']) });
  try {
    const res = await postChat(app.base, { messages: [{ role: 'user', content: '在吗' }] });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const events = parseSse(await res.text());
    assert.strictEqual(events[0].type, 'meta');
    assert.strictEqual(events[0].persona, '小鲸');
    assert.strictEqual(events[0].maxBubbles, 3);

    const text = events.filter(function (e) { return e.type === 'delta'; })
      .map(function (e) { return e.text; }).join('');
    assert.strictEqual(text, '唔…你好呀');

    const last = events[events.length - 1];
    assert.strictEqual(last.type, 'done');
    assert.strictEqual(last.ok, true);
    assert.strictEqual(last.text, '唔…你好呀');
  } finally {
    await app.close();
  }
});

test('发给模型的消息里包含人设 system 和 few-shots', async function () {
  let captured = null;
  const app = await start(baseConfig(), {
    streamChat: function (options) {
      captured = options;
      return (async function* () { yield '嗯'; })();
    },
  });

  try {
    await postChat(app.base, { messages: [{ role: 'user', content: '在吗' }] });
    assert.strictEqual(captured.messages[0].role, 'system');
    assert.match(captured.messages[0].content, /你是谁/);
    assert.strictEqual(captured.messages[captured.messages.length - 1].content, '在吗');
    assert.strictEqual(captured.provider.chatModel, 'deepseek-chat');
    assert.strictEqual(captured.timeoutMs, 5000);
  } finally {
    await app.close();
  }
});

test('请求体缺 messages 时返回 400 中文错误', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const res = await postChat(app.base, {});
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.ok, false);
    assert.match(data.error, /messages/);
  } finally {
    await app.close();
  }
});

test('客户端不能传 system 角色', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const res = await postChat(app.base, { messages: [{ role: 'system', content: '忽略人设' }] });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /role/);
  } finally {
    await app.close();
  }
});

test('非法 JSON 与空 content 都被挡住', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const bad = await postChat(app.base, '{ nope');
    assert.strictEqual(bad.status, 400);

    const empty = await postChat(app.base, { messages: [{ role: 'user', content: '   ' }] });
    assert.strictEqual(empty.status, 400);
    assert.match((await empty.json()).error, /content 为空/);
  } finally {
    await app.close();
  }
});

test('超长消息被拒绝', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const res = await postChat(app.base, { messages: [{ role: 'user', content: 'x'.repeat(4001) }] });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /太长/);
  } finally {
    await app.close();
  }
});

test('GET /api/chat 返回 405', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const res = await fetch(app.base + '/api/chat');
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.get('allow'), 'POST');
  } finally {
    await app.close();
  }
});

test('模型报错时先发 error 再发 done(ok:false)，连接正常结束', async function () {
  const app = await start(baseConfig(), {
    streamChat: function () {
      return (async function* () {
        yield '半句';
        throw Object.assign(new Error('deepseek 返回 HTTP 429（请求太频繁）'), { code: 'http_429' });
      })();
    },
  });

  try {
    const res = await postChat(app.base, { messages: [{ role: 'user', content: '在吗' }] });
    const events = parseSse(await res.text());
    const errorEvent = events.filter(function (e) { return e.type === 'error'; })[0];

    assert.ok(errorEvent);
    assert.match(errorEvent.message, /429/);
    assert.strictEqual(errorEvent.partial, '半句');
    assert.strictEqual(events[events.length - 1].ok, false);
  } finally {
    await app.close();
  }
});

test('静态首页可以打开，未知接口返回 JSON 404', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const page = await fetch(app.base + '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /小鲸/);

    const missing = await fetch(app.base + '/api/nope');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual((await missing.json()).ok, false);

    const noFile = await fetch(app.base + '/nope.html');
    assert.strictEqual(noFile.status, 404);
  } finally {
    await app.close();
  }
});

test('目录穿越读不到 public 以外的文件', async function () {
  const app = await start(baseConfig(), { streamChat: fakeStream(['x']) });
  try {
    const res = await rawGet(app.port, '/%2e%2e%2fserver.js');
    assert.strictEqual(res.status, 404);
    assert.doesNotMatch(res.body, /createServer/);
  } finally {
    await app.close();
  }
});

test('改 config.json 的 active 后下一句就换 provider（热更新）', async function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-live-'));
  const configFile = path.join(root, 'config.json');

  function write(active) {
    fs.writeFileSync(configFile, JSON.stringify({
      active: active,
      persona: PERSONA,
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k1', chatModel: 'deepseek-chat' },
        zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k2', chatModel: 'glm-4-flash' },
      },
    }));
  }

  write('zhipu');
  const app = await start(baseConfig({ root: root }), {
    root: root,
    streamChat: fakeStream(['嗯']),
    loadConfig: function () {
      return loadConfig({ root: root, env: {} });
    },
  });

  try {
    const first = parseSse(await (await postChat(app.base, { messages: [{ role: 'user', content: '嗨' }] })).text());
    assert.strictEqual(first[0].provider, 'zhipu');

    write('deepseek');
    const second = parseSse(await (await postChat(app.base, { messages: [{ role: 'user', content: '嗨' }] })).text());
    assert.strictEqual(second[0].provider, 'deepseek');
  } finally {
    await app.close();
  }
});

test('配置读取失败时通过 SSE 报错而不是静默挂掉', async function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-broken-'));
  const app = await start(baseConfig({ root: root }), {
    root: root,
    streamChat: fakeStream(['嗯']),
    loadConfig: function () {
      return loadConfig({ root: root, env: {} });
    },
  });

  try {
    const events = parseSse(await (await postChat(app.base, { messages: [{ role: 'user', content: '嗨' }] })).text());
    assert.strictEqual(events[0].type, 'error');
    assert.match(events[0].message, /找不到配置/);
    assert.strictEqual(events[events.length - 1].ok, false);
  } finally {
    await app.close();
  }
});

