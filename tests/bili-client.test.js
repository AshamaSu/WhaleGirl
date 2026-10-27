'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createBiliClient, BiliError } = require('../src/bilibili/client');

const IMG = '7cd084941338484aae1ad9425b84077c';
const SUB = '4932caff0ff746eab6f01bf08b70ac45';

/** 极简 fetch 替身：按路径返回预设 JSON，并记下每次调用的 url 与请求头 */
function makeFetch(table) {
  const calls = [];
  const impl = async function (url, init) {
    calls.push({ url: String(url), headers: (init && init.headers) || {}, at: Date.now() });
    const hit = table(String(url));
    if (!hit) return { ok: false, status: 404, json: async function () { return {}; } };
    return { ok: true, status: 200, json: async function () { return hit; } };
  };
  impl.calls = calls;
  return impl;
}

function navPayload() {
  return {
    code: -101,
    message: '账号未登录',
    data: {
      isLogin: false,
      wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/' + IMG + '.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/' + SUB + '.png',
      },
    },
  };
}

test('自动取 buvid3 并带进后续请求的 cookie', async function () {
  const fetchImpl = makeFetch(function (url) {
    if (url.indexOf('/x/frontend/finger/spi') !== -1) return { code: 0, data: { b_3: 'ABC-123-infoc' } };
    if (url.indexOf('/x/web-interface/popular') !== -1) return { code: 0, data: { list: [] } };
    return null;
  });
  const client = createBiliClient({ fetchImpl: fetchImpl, intervalMs: 1 });

  await client.get('/x/web-interface/popular', { ps: 1 });
  assert.equal(client.buvid3(), 'ABC-123-infoc');

  const last = fetchImpl.calls[fetchImpl.calls.length - 1];
  assert.match(last.headers.cookie, /buvid3=ABC-123-infoc/);
  assert.match(last.headers['user-agent'], /Mozilla/);
  assert.match(last.headers.referer, /bilibili/);
});

test('限速：相邻两次请求至少隔 intervalMs', async function () {
  const fetchImpl = makeFetch(function () { return { code: 0, data: null }; });
  const client = createBiliClient({ fetchImpl: fetchImpl, intervalMs: 40, buvid3: 'x' });

  await Promise.all([
    client.get('/a', {}),
    client.get('/b', {}),
    client.get('/c', {}),
  ]);

  const calls = fetchImpl.calls;
  assert.equal(calls.length, 3);
  for (let i = 1; i < calls.length; i += 1) {
    assert.ok(calls[i].at - calls[i - 1].at >= 35, '间隔太短：' + (calls[i].at - calls[i - 1].at) + 'ms');
  }
});

test('wbi key 六小时内复用，不重复打 nav', async function () {
  const fetchImpl = makeFetch(function (url) {
    if (url.indexOf('/x/web-interface/nav') !== -1) return navPayload();
    return { code: 0, data: { result: [] } };
  });
  const client = createBiliClient({ fetchImpl: fetchImpl, intervalMs: 1, buvid3: 'x' });

  await client.getSigned('/x/web-interface/wbi/search/type', { keyword: 'a' });
  await client.getSigned('/x/web-interface/wbi/search/type', { keyword: 'b' });

  const navCalls = fetchImpl.calls.filter(function (call) { return call.url.indexOf('/nav') !== -1; });
  assert.equal(navCalls.length, 1);

  const signed = fetchImpl.calls.filter(function (call) { return call.url.indexOf('w_rid=') !== -1; });
  assert.equal(signed.length, 2);
  assert.match(signed[0].url, /keyword=a/);
});

test('业务错误码翻译成人话并带上 code', async function () {
  const fetchImpl = makeFetch(function () { return { code: -352, message: '风控校验失败' }; });
  const client = createBiliClient({ fetchImpl: fetchImpl, intervalMs: 1, buvid3: 'x' });

  await assert.rejects(
    function () { return client.get('/x/web-interface/popular', {}); },
    function (err) {
      assert.ok(err instanceof BiliError);
      assert.equal(err.code, -352);
      assert.match(err.message, /风控/);
      return true;
    }
  );
});

test('HTTP 非 200 与超时都给可读错误', async function () {
  const notFound = createBiliClient({
    fetchImpl: async function () { return { ok: false, status: 502, json: async function () { return {}; } }; },
    intervalMs: 1,
    buvid3: 'x',
  });
  await assert.rejects(function () { return notFound.get('/x', {}); }, /HTTP 502/);

  const slow = createBiliClient({
    fetchImpl: function (url, init) {
      return new Promise(function (resolve, reject) {
        init.signal.addEventListener('abort', function () {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    },
    timeoutMs: 20,
    intervalMs: 1,
    buvid3: 'x',
  });
  await assert.rejects(function () { return slow.get('/x', {}); }, /超过 20ms 没响应/);
});

test('登录 cookie 从环境变量读，hasLogin 正确', function () {
  const client = createBiliClient({
    fetchImpl: async function () { return { ok: true, status: 200, json: async function () { return { code: 0, data: null }; } }; },
    intervalMs: 1,
    env: { WG_BILI_SESSDATA: 'sess', WG_BILI_BILI_JCT: 'jct', WG_BILI_DEDE_USER_ID: '42' },
  });
  assert.equal(client.hasLogin(), true);
});

test('不传 env 时退回 process.env：脚本里直接 new 也能读到 cookie', function () {
  const backup = process.env.WG_BILI_SESSDATA;
  process.env.WG_BILI_SESSDATA = 'from-process-env';
  try {
    const client = createBiliClient({ fetchImpl: async function () { return { ok: true, status: 200, json: async function () { return { code: 0, data: null }; } }; }, intervalMs: 1 });
    assert.equal(client.hasLogin(), true);
  } finally {
    if (backup === undefined) delete process.env.WG_BILI_SESSDATA;
    else process.env.WG_BILI_SESSDATA = backup;
  }
});
