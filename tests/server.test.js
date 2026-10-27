'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../server');
const { loadConfig } = require('../src/config');
const { loadPersona } = require('../src/persona');

const ROOT = path.join(__dirname, '..');
const PERSONA = path.join(ROOT, 'personas', 'whale.json');
const QUIET = { log: function () {}, warn: function () {}, error: function () {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-srv-'));
}

function baseConfig(overrides) {
  const config = {
    root: ROOT,
    source: 'config.json',
    host: '127.0.0.1',
    port: 0,
    active: 'deepseek',
    personaPath: PERSONA,
    hotReload: true,
    memory: {},
    agent: { maxRounds: 4 },
    search: { endpoint: 'https://api.tavily.com/search', apiKey: 'tvly-test', maxResults: 4 },
    vision: { provider: 'zhipu' },
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
      zhipu: {
        name: 'zhipu',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: 'zp-test',
        chatModel: 'glm-4-flash',
        visionModel: 'glm-4v-flash',
        temperature: 1,
      },
    },
    warnings: [],
  };
  return Object.assign(config, overrides || {});
}

/** 假的模型事件流：按预设脚本回放文本 */
function fakeEvents(chunks) {
  const captured = [];
  const streamer = function (options) {
    captured.push(options);
    return (async function* () {
      for (let i = 0; i < chunks.length; i += 1) yield { type: 'text', text: chunks[i] };
      yield { type: 'finish', reason: 'stop' };
    })();
  };
  streamer.captured = captured;
  return streamer;
}

/** 假的纯文本流（视觉通道走 streamChat） */
function fakeChatStream(chunks) {
  const captured = [];
  const streamer = function (options) {
    captured.push(options);
    return (async function* () {
      for (let i = 0; i < chunks.length; i += 1) yield chunks[i];
    })();
  };
  streamer.captured = captured;
  return streamer;
}

async function start(config, deps) {
  const options = Object.assign({
    root: ROOT,
    dataRoot: tmpDir(),
    logger: QUIET,
    disableBackground: true,
  }, deps || {});
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
    dataRoot: options.dataRoot,
    close: function () {
      return new Promise(function (resolve) {
        server.close(resolve);
      });
    },
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

test('/api/health 返回 provider、人设名与工具清单', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['x']) });
  try {
    const data = await (await fetch(app.base + '/api/health')).json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.provider, 'deepseek');
    assert.strictEqual(data.model, 'deepseek-chat');
    assert.strictEqual(data.personaName, loadPersona(PERSONA).name);
    assert.strictEqual(data.hotReload, true);
    assert.deepStrictEqual(data.tools, ['web_search', 'fetch_url', 'remember']);
  } finally {
    await app.close();
  }
});

test('/api/chat 流式返回 meta / delta / done，并带上会话与记忆状态', async function () {
  const streamer = fakeEvents(['唔…', '你好呀']);
  const app = await start(baseConfig(), { streamChatEvents: streamer });
  try {
    const res = await postChat(app.base, { sessionId: 's1', message: '在吗' });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const events = parseSse(await res.text());
    assert.strictEqual(events[0].type, 'meta');
    assert.strictEqual(events[0].persona, loadPersona(PERSONA).name);
    assert.strictEqual(events[0].sessionId, 's1');
    assert.deepStrictEqual(events[0].memory, { facts: 0, summary: false });

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

test('发出去的消息包含人设 system、few-shots 和本轮输入', async function () {
  const streamer = fakeEvents(['嗯']);
  const app = await start(baseConfig(), { streamChatEvents: streamer });
  try {
    await postChat(app.base, { message: '在吗' });
    const options = streamer.captured[0];

    assert.strictEqual(options.messages[0].role, 'system');
    assert.match(options.messages[0].content, /你是谁/);
    assert.strictEqual(options.messages[options.messages.length - 1].content, '在吗');
    assert.strictEqual(options.provider.chatModel, 'deepseek-chat');
    assert.strictEqual(options.tools.length, 3);
  } finally {
    await app.close();
  }
});

test('同一个 session 的上一轮会被带进下一轮（短期记忆）', async function () {
  const streamer = fakeEvents(['记住了']);
  const app = await start(baseConfig(), { streamChatEvents: streamer });
  try {
    await postChat(app.base, { sessionId: 'm1', message: '我叫阿龙' });
    await postChat(app.base, { sessionId: 'm1', message: '我叫什么' });

    const second = streamer.captured[1].messages;
    const contents = second.map(function (m) { return m.content; }).join('\n');
    assert.match(contents, /我叫阿龙/);
    assert.strictEqual(second[second.length - 1].content, '我叫什么');
  } finally {
    await app.close();
  }
});

test('两轮对话都写进会话记忆文件', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['嗯']) });
  try {
    await postChat(app.base, { sessionId: 'disk', message: '你好' });
    const file = path.join(app.dataRoot, 'data', 'memory', 'disk.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(saved.sessionId, 'disk');
    assert.strictEqual(saved.turns.length, 2);
    assert.strictEqual(saved.turns[0].role, 'user');
    assert.strictEqual(saved.turns[1].role, 'assistant');
  } finally {
    await app.close();
  }
});

test('/api/memory 可以导出与清空', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['嗯']) });
  try {
    await postChat(app.base, { sessionId: 'exp', message: '你好' });

    const exported = await (await fetch(app.base + '/api/memory?sessionId=exp')).json();
    assert.strictEqual(exported.ok, true);
    assert.strictEqual(exported.memory.turns.length, 2);

    const cleared = await (await fetch(app.base + '/api/memory?sessionId=exp', { method: 'DELETE' })).json();
    assert.strictEqual(cleared.cleared, true);

    const after = await (await fetch(app.base + '/api/memory?sessionId=exp')).json();
    assert.strictEqual(after.memory.turns.length, 0);
  } finally {
    await app.close();
  }
});

test('请求体缺 message 时返回 400 中文错误', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['x']) });
  try {
    const res = await postChat(app.base, {});
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /消息是空的/);
  } finally {
    await app.close();
  }
});

test('超长消息与坏图片格式都被挡住', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['x']) });
  try {
    const long = await postChat(app.base, { message: 'x'.repeat(4001) });
    assert.strictEqual(long.status, 400);
    assert.match((await long.json()).error, /太长/);

    const badImage = await postChat(app.base, { message: '看图', image: 'https://example.com/a.png' });
    assert.strictEqual(badImage.status, 400);
    assert.match((await badImage.json()).error, /data URL/);
  } finally {
    await app.close();
  }
});

test('图片走视觉模型，消息内容变成多段结构', async function () {
  const chatStream = fakeChatStream(['一条', '蓝鲸']);
  const app = await start(baseConfig(), { streamChat: chatStream, streamChatEvents: fakeEvents(['x']) });
  const image = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');

  try {
    const events = parseSse(await (await postChat(app.base, { message: '这是什么', image: image })).text());
    assert.strictEqual(events[0].model, 'glm-4v-flash');
    assert.strictEqual(events[0].provider, 'zhipu');

    const options = chatStream.captured[0];
    assert.strictEqual(options.provider.chatModel, 'glm-4v-flash');
    const last = options.messages[options.messages.length - 1];
    assert.ok(Array.isArray(last.content));
    assert.strictEqual(last.content[0].text, '这是什么');
    assert.strictEqual(last.content[1].type, 'image_url');
    assert.match(last.content[1].image_url.url, /^data:image\/png;base64,/);
  } finally {
    await app.close();
  }
});

test('GET /api/chat 返回 405', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['x']) });
  try {
    const res = await fetch(app.base + '/api/chat');
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.get('allow'), 'POST');
  } finally {
    await app.close();
  }
});

test('模型报错时先发 error 再发 done(ok:false)', async function () {
  const app = await start(baseConfig(), {
    streamChatEvents: function () {
      return (async function* () {
        yield { type: 'text', text: '半句' };
        throw Object.assign(new Error('deepseek 返回 HTTP 429（请求太频繁）'), { code: 'http_429' });
      })();
    },
  });

  try {
    const events = parseSse(await (await postChat(app.base, { message: '在吗' })).text());
    const errorEvent = events.filter(function (e) { return e.type === 'error'; })[0];

    assert.ok(errorEvent);
    assert.match(errorEvent.message, /429/);
    assert.strictEqual(errorEvent.partial, '半句');
    assert.strictEqual(events[events.length - 1].ok, false);
  } finally {
    await app.close();
  }
});

test('静态首页可以打开，/persona 指向调参页，未知接口 404', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['x']) });
  try {
    const page = await fetch(app.base + '/');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /id="chat"/);

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
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['x']) });
  try {
    const res = await rawGet(app.port, '/%2e%2e%2fserver.js');
    assert.strictEqual(res.status, 404);
    assert.doesNotMatch(res.body, /createServer/);
  } finally {
    await app.close();
  }
});

test('GET /api/persona 返回原始 JSON，PUT 保存后下一句生效', async function () {
  const dir = tmpDir();
  const personaFile = path.join(dir, 'p.json');
  fs.copyFileSync(PERSONA, personaFile);

  const streamer = fakeEvents(['嗯']);
  const app = await start(baseConfig({ personaPath: personaFile }), { streamChatEvents: streamer });
  try {
    const got = await (await fetch(app.base + '/api/persona')).json();
    assert.strictEqual(got.ok, true);
    assert.ok(got.persona.name);

    const edited = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
    edited.name = '测试改名';
    edited.style.length = '每次只说一句';

    const put = await fetch(app.base + '/api/persona', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edited),
    });
    assert.strictEqual(put.status, 200);

    const saved = JSON.parse(fs.readFileSync(personaFile, 'utf8'));
    assert.strictEqual(saved.name, '测试改名');

    const events = parseSse(await (await postChat(app.base, { message: '嗨' })).text());
    assert.strictEqual(events[0].persona, '测试改名');
  } finally {
    await app.close();
  }
});

test('PUT /api/persona 会拒绝缺 name 的人设', async function () {
  const app = await start(baseConfig(), { streamChatEvents: fakeEvents(['x']) });
  try {
    const res = await fetch(app.base + '/api/persona', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ style: {} }),
    });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /name/);
  } finally {
    await app.close();
  }
});

test('改 config.json 的 active 后下一句就换 provider（热更新）', async function () {
  const root = tmpDir();
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
    streamChatEvents: fakeEvents(['嗯']),
    loadConfig: function () {
      return loadConfig({ root: root, env: {} });
    },
  });

  try {
    const first = parseSse(await (await postChat(app.base, { message: '嗨' })).text());
    assert.strictEqual(first[0].provider, 'zhipu');

    write('deepseek');
    const second = parseSse(await (await postChat(app.base, { message: '嗨' })).text());
    assert.strictEqual(second[0].provider, 'deepseek');
  } finally {
    await app.close();
  }
});

test('hotReload 关掉后改 config.json 不再生效', async function () {
  const root = tmpDir();
  const configFile = path.join(root, 'config.json');

  function write(active) {
    fs.writeFileSync(configFile, JSON.stringify({
      active: active,
      hotReload: false,
      persona: PERSONA,
      providers: {
        deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k1', chatModel: 'deepseek-chat' },
        zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'k2', chatModel: 'glm-4-flash' },
      },
    }));
  }

  write('zhipu');
  const app = await start(baseConfig({ root: root, hotReload: false }), {
    root: root,
    streamChatEvents: fakeEvents(['嗯']),
    loadConfig: function () {
      return loadConfig({ root: root, env: {} });
    },
  });

  try {
    const first = parseSse(await (await postChat(app.base, { message: '嗨' })).text());
    assert.strictEqual(first[0].provider, 'zhipu');

    write('deepseek');
    const second = parseSse(await (await postChat(app.base, { message: '嗨' })).text());
    assert.strictEqual(second[0].provider, 'zhipu');
  } finally {
    await app.close();
  }
});

test('配置读取失败时通过 SSE 报错而不是静默挂掉', async function () {
  const root = tmpDir();
  const app = await start(baseConfig({ root: root }), {
    root: root,
    streamChatEvents: fakeEvents(['嗯']),
    loadConfig: function () {
      return loadConfig({ root: root, env: {} });
    },
  });

  try {
    const events = parseSse(await (await postChat(app.base, { message: '嗨' })).text());
    assert.strictEqual(events[0].type, 'error');
    assert.match(events[0].message, /找不到配置/);
    assert.strictEqual(events[events.length - 1].ok, false);
  } finally {
    await app.close();
  }
});

