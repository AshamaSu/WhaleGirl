'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createServer } = require('../server');
const { openMemory, listSessions, exportAll, importAll, safeSessionId } = require('../src/memory');
const { loadConfig } = require('../src/config');

const ROOT = path.join(__dirname, '..');
const PERSONA = path.join(ROOT, 'personas', 'whale.json');
const QUIET = { log: function () {}, warn: function () {}, error: function () {} };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mt-'));
}

function baseConfig(features) {
  return {
    root: ROOT,
    source: 'config.json',
    host: '127.0.0.1',
    port: 0,
    active: 'deepseek',
    personaPath: PERSONA,
    hotReload: true,
    features: features || {},
    memory: {},
    agent: { maxRounds: 4 },
    search: { endpoint: 'https://api.tavily.com/search', apiKey: '', maxResults: 4 },
    vision: { provider: '' },
    requestTimeoutMs: 5000,
    providers: {
      deepseek: {
        name: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-test',
        chatModel: 'deepseek-chat',
        visionModel: '',
        temperature: 1.1,
      },
    },
    warnings: [],
  };
}

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

async function start(config, deps) {
  const dataRoot = tmpDir();
  const options = Object.assign({
    root: ROOT,
    dataRoot: dataRoot,
    logger: QUIET,
    disableBackground: true,
    loadConfig: function () { return config; },
  }, deps || {});

  const server = createServer(config, options);
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });

  return {
    base: 'http://127.0.0.1:' + server.address().port,
    server: server,
    dataRoot: dataRoot,
    close: function () {
      return new Promise(function (resolve) { server.close(resolve); });
    },
  };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
  }
  return false;
}

// —— memory.js 新接口 ——

test('置顶的事实不再衰减，也不会被上限挤掉', function () {
  const root = tmpDir();
  const mem = openMemory({ root: root, sessionId: 's1', settings: { factDecay: 0.5, maxFacts: 2 } });
  const kept = mem.addFact('他叫阿龙');
  mem.addFact('她讨厌香菜');

  assert.strictEqual(mem.setPinned(kept.id, true).pinned, true);

  mem.appendTurn('user', '随便聊聊');
  const afterDecay = mem.facts().find(function (f) { return f.id === kept.id; });
  assert.strictEqual(afterDecay.strength, 1, '置顶就是永久记住，强度不衰减');

  mem.addFact('他住在上海');
  assert.ok(mem.facts().some(function (f) { return f.id === kept.id; }), '被挤掉的不该是置顶那条');
});

test('删除事实：删掉返回 true，重复删返回 false', function () {
  const mem = openMemory({ root: tmpDir(), sessionId: 's1' });
  const fact = mem.addFact('他喜欢下雨天');

  assert.strictEqual(mem.removeFact(fact.id), true);
  assert.strictEqual(mem.facts().length, 0);
  assert.strictEqual(mem.removeFact(fact.id), false);
  assert.strictEqual(mem.setPinned('不存在的 id', true), null);
});

test('会话列表按更新时间排序，坏文件跳过', function () {
  const root = tmpDir();
  const a = openMemory({ root: root, sessionId: 'old' });
  a.appendTurn('user', '旧');
  const b = openMemory({ root: root, sessionId: 'new' });
  b.appendTurn('user', '新');
  fs.writeFileSync(path.join(root, 'data', 'memory', 'broken.json'), '{ 不是 json');

  const sessions = listSessions({ root: root });
  assert.deepStrictEqual(sessions.map(function (s) { return s.sessionId; }).sort(), ['new', 'old']);
  assert.strictEqual(listSessions({ root: path.join(root, 'none') }).length, 0);
});

test('导出再导入能还原，同名会话先备份', function () {
  const from = tmpDir();
  const to = tmpDir();
  const mem = openMemory({ root: from, sessionId: 's1' });
  mem.appendTurn('user', '你好');
  const fact = mem.addFact('他叫阿龙');
  mem.setPinned(fact.id, true);

  const bundle = exportAll({ root: from });
  assert.strictEqual(bundle.version, 1);
  assert.strictEqual(bundle.sessions.length, 1);

  // 目标目录先放一份旧数据，验证 .bak
  const existing = openMemory({ root: to, sessionId: 's1' });
  existing.appendTurn('user', '旧数据');

  const result = importAll({ root: to, bundle: bundle, stamp: 'T1' });
  assert.deepStrictEqual({ imported: result.imported, skipped: result.skipped }, { imported: 1, skipped: 0 });

  const restored = openMemory({ root: to, sessionId: 's1' });
  assert.strictEqual(restored.facts().length, 1);
  assert.strictEqual(restored.facts()[0].pinned, true);
  assert.ok(fs.existsSync(path.join(to, 'data', 'memory', 's1.json.bak-T1')));
});

test('恢复时结构不对的会话被跳过而不是整包失败', function () {
  const result = importAll({ root: tmpDir(), bundle: { sessions: [{ sessionId: 'x' }, { sessionId: 'y', memory: { turns: [], facts: [] } }] } });
  assert.strictEqual(result.imported, 1);
  assert.strictEqual(result.skipped, 1);
  assert.strictEqual(result.errors.length, 1);

  assert.strictEqual(importAll({ root: tmpDir(), bundle: {} }).errors[0], '备份文件里没有 sessions 数组');
});

// —— HTTP 层 ——

test('能力关着时 /memory 与时间线接口都不存在，health 里如实汇报', async function () {
  const app = await start(baseConfig({}));
  try {
    const page = await fetch(app.base + '/memory');
    assert.strictEqual(page.status, 404);

    const timeline = await fetch(app.base + '/api/memory/timeline?sessionId=s1');
    assert.strictEqual(timeline.status, 404);

    const health = await (await fetch(app.base + '/api/health')).json();
    assert.deepStrictEqual(health.features, {
      mood: { core: true, enabled: false, error: '' },
      memory: { core: true, enabled: false, error: '' },
      bili: { core: false, enabled: false, error: '' },
    });
  } finally {
    await app.close();
  }
});

test('打开 memory 能力后：页面可访问、时间线能看到事实、置顶与删除生效', async function () {
  const app = await start(baseConfig({ memory: { enabled: true } }));
  try {
    const page = await fetch(app.base + '/memory');
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);

    const mem = openMemory({ root: app.dataRoot, sessionId: 's1' });
    const fact = mem.addFact('他叫阿龙');
    mem.appendTurn('user', '你好');

    const health = await (await fetch(app.base + '/api/health')).json();
    assert.strictEqual(health.features.memory.enabled, true);

    const sessions = await (await fetch(app.base + '/api/memory/sessions')).json();
    assert.strictEqual(sessions.sessions.length, 1);
    assert.strictEqual(sessions.sessions[0].sessionId, 's1');

    const timeline = await (await fetch(app.base + '/api/memory/timeline?sessionId=s1')).json();
    assert.strictEqual(timeline.facts.length, 1);
    assert.strictEqual(timeline.facts[0].text, '他叫阿龙');
    assert.strictEqual(timeline.facts[0].pinned, false);
    assert.strictEqual(timeline.turns, 1);

    // 置顶
    const pinned = await (await fetch(app.base + '/api/memory/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: fact.id, pinned: true }),
    })).json();
    assert.strictEqual(pinned.ok, true);
    assert.strictEqual(openMemory({ root: app.dataRoot, sessionId: 's1' }).facts()[0].pinned, true);

    // 删不存在的事实给 404，而不是 500
    const missing = await fetch(app.base + '/api/memory/pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: 'f_nope', pinned: true }),
    });
    assert.strictEqual(missing.status, 404);

    // 忘记这条
    const forgot = await (await fetch(app.base + '/api/memory/forget', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', id: fact.id }),
    })).json();
    assert.strictEqual(forgot.ok, true);
    assert.strictEqual(openMemory({ root: app.dataRoot, sessionId: 's1' }).facts().length, 0);
  } finally {
    await app.close();
  }
});

test('备份可以下载，也能原样恢复', async function () {
  const app = await start(baseConfig({ memory: { enabled: true } }));
  try {
    const mem = openMemory({ root: app.dataRoot, sessionId: 's1' });
    mem.addFact('他叫阿龙');
    mem.appendTurn('user', '你好');

    const backup = await fetch(app.base + '/api/memory/backup');
    assert.strictEqual(backup.status, 200);
    assert.match(backup.headers.get('content-disposition'), /attachment/);
    const bundle = await backup.json();
    assert.strictEqual(bundle.sessions.length, 1);

    // 清空后再恢复
    mem.clear();
    assert.strictEqual(openMemory({ root: app.dataRoot, sessionId: 's1' }).facts().length, 0);

    const restored = await (await fetch(app.base + '/api/memory/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bundle),
    })).json();
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(restored.imported, 1);
    assert.strictEqual(openMemory({ root: app.dataRoot, sessionId: 's1' }).facts().length, 1);
  } finally {
    await app.close();
  }
});

test('打开 mood 能力后：心情会织进 system prompt，/api/mood 可读', async function () {
  const streamer = fakeEvents(['唔…']);
  const app = await start(baseConfig({ mood: { enabled: true } }), { streamChatEvents: streamer });
  try {
    await (await fetch(app.base + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', message: '在吗' }),
    })).text();

    const system = streamer.captured[0].messages[0].content;
    assert.match(system, /【你现在的心情】/);
    assert.match(system, /平静/);

    const mood = await (await fetch(app.base + '/api/mood')).json();
    assert.strictEqual(mood.ok, true);
    assert.strictEqual(mood.mood.value, 60);
  } finally {
    await app.close();
  }
});

test('/api/events 把 mood 事件推给网页', async function () {
  const app = await start(baseConfig({ mood: { enabled: true } }));
  let req = null;
  try {
    const chunks = [];
    req = http.get(app.base + '/api/events', function (res) {
      assert.match(res.headers['content-type'], /text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', function (chunk) { chunks.push(chunk); });
    });
    req.on('error', function () {});

    assert.ok(await waitFor(function () { return chunks.join('').indexOf('connected') !== -1; }), 'SSE 应该先发一个 connected 注释帧');

    app.server.bus.emit('mood', { value: 71, label: '心情不错', updatedAt: '', history: [] });
    const ok = await waitFor(function () { return chunks.join('').indexOf('"type":"mood"') !== -1; });
    assert.ok(ok, '应该收到 mood 事件');
    assert.match(chunks.join(''), /心情不错/);
  } finally {
    if (req) req.destroy();
    await app.close();
  }
});
