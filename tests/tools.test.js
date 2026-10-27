'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createWebSearchTool } = require('../src/tools/web_search');
const { createFetchUrlTool, htmlToText, assertPublicUrl } = require('../src/tools/fetch_url');
const { createRememberTool } = require('../src/tools/remember');
const { createTools, toolNames } = require('../src/tools');

function htmlResponse(body, type) {
  return {
    ok: true,
    status: 200,
    headers: { get: function () { return type || 'text/html; charset=utf-8'; } },
    text: async function () { return body; },
  };
}

test('web_search 没配 key 时给出可执行的提示', async function () {
  const tool = createWebSearchTool({ apiKey: '' });
  await assert.rejects(tool.execute({ query: '鲸鱼' }), /WG_TAVILY_API_KEY/);
});

test('web_search 请求参数与结果格式', async function () {
  let captured = null;
  const tool = createWebSearchTool({
    apiKey: 'tvly-test',
    fetchImpl: async function (url, init) {
      captured = { url: url, init: init };
      return {
        ok: true,
        status: 200,
        json: async function () {
          return {
            results: [
              { title: '鲸鱼新闻', url: 'https://news.test/a', content: '今天  有  一头鲸鱼\n出现在港口' },
              { title: '第二条', url: 'https://news.test/b', content: '内容' },
            ],
          };
        },
      };
    },
  });

  const out = await tool.execute({ query: ' 鲸鱼 新闻 ', count: 99 });

  assert.strictEqual(captured.url, 'https://api.tavily.com/search');
  assert.strictEqual(captured.init.method, 'POST');
  assert.strictEqual(captured.init.headers.authorization, 'Bearer tvly-test');

  const body = JSON.parse(captured.init.body);
  assert.strictEqual(body.query, '鲸鱼 新闻');
  assert.strictEqual(body.max_results, 8);
  assert.strictEqual(body.stream, undefined);

  assert.match(out, /1\. 鲸鱼新闻/);
  assert.match(out, /https:\/\/news\.test\/a/);
  assert.match(out, /今天 有 一头鲸鱼 出现在港口/);
});

test('web_search 没有结果时给友好提示', async function () {
  const tool = createWebSearchTool({
    apiKey: 'k',
    fetchImpl: async function () { return { ok: true, status: 200, json: async function () { return { results: [] }; } }; },
  });

  assert.match(await tool.execute({ query: 'x' }), /没有搜到结果/);
});

test('web_search 非 2xx 时报出状态码与服务端信息', async function () {
  const tool = createWebSearchTool({
    apiKey: 'k',
    fetchImpl: async function () {
      return { ok: false, status: 401, text: async function () { return '{"detail":"invalid api key"}'; } };
    },
  });

  await assert.rejects(tool.execute({ query: 'x' }), /HTTP 401.*invalid api key/);
});

test('web_search 空搜索词直接拒绝', async function () {
  const tool = createWebSearchTool({ apiKey: 'k' });
  await assert.rejects(tool.execute({ query: '   ' }), /搜索词是空的/);
});

test('htmlToText 去掉脚本样式并解码实体', function () {
  const html = '<html><head><style>.a{color:red}</style><script>var x = 1;</script></head>' +
    '<body><h1>标题</h1><p>第一段 &amp; 第二段</p><p>&#20320;好 &hellip;</p><br/><div>末行</div></body></html>';

  const text = htmlToText(html);
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /var x/);
  assert.match(text, /标题/);
  assert.match(text, /第一段 & 第二段/);
  assert.match(text, /你好 …/);
  assert.match(text, /末行/);
});

test('fetch_url 抓取正文并截断超长页面', async function () {
  const long = '<p>' + '鲸'.repeat(7000) + '</p>';
  let captured = null;
  const tool = createFetchUrlTool({
    fetchImpl: async function (url, init) {
      captured = { url: url, init: init };
      return htmlResponse(long);
    },
  });

  const out = await tool.execute({ url: 'https://example.com/post' });

  assert.strictEqual(captured.url, 'https://example.com/post');
  assert.match(captured.init.headers['user-agent'], /Mozilla/);
  assert.match(out, /正文过长已截断/);
  assert.ok(out.length < 7000);
});

test('fetch_url 挡住内网地址', function () {
  assert.throws(function () { assertPublicUrl('http://127.0.0.1:8787/api/health'); }, /内网/);
  assert.throws(function () { assertPublicUrl('http://localhost:3000'); }, /内网/);
  assert.throws(function () { assertPublicUrl('http://169.254.169.254/latest/meta-data'); }, /内网/);
  assert.throws(function () { assertPublicUrl('http://192.168.1.1'); }, /内网/);
  assert.throws(function () { assertPublicUrl('file:///etc/passwd'); }, /只支持 http\/https/);
  assert.throws(function () { assertPublicUrl('不是链接'); }, /URL 不合法/);
  assert.ok(assertPublicUrl('https://example.com/a?b=1'));
});

test('fetch_url 遇到非网页与错误状态都报清楚', async function () {
  const image = createFetchUrlTool({
    fetchImpl: async function () { return htmlResponse('binary', 'image/png'); },
  });
  await assert.rejects(image.execute({ url: 'https://example.com/a.png' }), /不是网页/);

  const missing = createFetchUrlTool({
    fetchImpl: async function () { return { ok: false, status: 404, headers: { get: function () { return 'text/html'; } } }; },
  });
  await assert.rejects(missing.execute({ url: 'https://example.com/none' }), /HTTP 404/);
});

test('fetch_url 遇到只有脚本的页面给友好说明', async function () {
  const tool = createFetchUrlTool({
    fetchImpl: async function () { return htmlResponse('<html><body><script>app()</script></body></html>'); },
  });

  assert.match(await tool.execute({ url: 'https://example.com/spa' }), /没有可读的文字/);
});

test('remember 交给 memory 并确认', async function () {
  const facts = [];
  const tool = createRememberTool({ addFact: function (fact) { facts.push(fact); } });

  assert.match(await tool.execute({ fact: ' 他叫阿龙 ' }), /已经记住了：他叫阿龙/);
  assert.deepStrictEqual(facts, ['他叫阿龙']);

  await assert.rejects(tool.execute({ fact: '  ' }), /是空的/);
  await assert.rejects(tool.execute({ fact: 'x'.repeat(201) }), /太长/);
});

test('createTools 按可用条件装配', function () {
  const withMemory = createTools({ memory: { addFact: function () {} }, searchApiKey: 'k' });
  assert.deepStrictEqual(toolNames(withMemory), ['remember', 'fetch_url', 'web_search']);

  const withoutMemory = createTools({});
  assert.deepStrictEqual(toolNames(withoutMemory), ['fetch_url', 'web_search']);
});

