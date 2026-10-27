'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { runAgent, normalizeTools, safeParseArgs, truncate } = require('../src/agent');

const PROVIDER = { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', chatModel: 'deepseek-chat', temperature: 1.1 };
const HISTORY = [{ role: 'user', content: '今天有什么新闻' }];

function text(t) { return { type: 'text', text: t }; }
function finish(reason) { return { type: 'finish', reason: reason || 'stop' }; }
function toolCall(id, name, args) {
  return { type: 'tool_calls', calls: [{ id: id, type: 'function', function: { name: name, arguments: args } }] };
}

/** 按顺序回放预设事件，并记录每次调用时模型收到的 messages/tools */
function scripted(responses) {
  const calls = [];
  function streamer(options) {
    calls.push({
      messages: JSON.parse(JSON.stringify(options.messages)),
      tools: options.tools,
    });
    const events = responses[Math.min(calls.length - 1, responses.length - 1)] || [];
    return (async function* () {
      for (let i = 0; i < events.length; i += 1) yield events[i];
    })();
  }
  streamer.calls = calls;
  return streamer;
}

async function run(options) {
  const events = [];
  const iterator = runAgent(Object.assign({ provider: PROVIDER, messages: HISTORY, streamChatEvents: options.streamer, tools: options.tools || [] }, options.extra || {}));
  for await (const event of iterator) events.push(event);
  return events;
}

test('没有工具调用时直接出最终回复', async function () {
  const streamer = scripted([[text('在'), text('呢'), finish('stop')]]);
  const events = await run({ streamer: streamer });

  assert.strictEqual(events.filter(function (e) { return e.type === 'final'; })[0].text, '在呢');
  assert.strictEqual(streamer.calls.length, 1);
  assert.strictEqual(streamer.calls[0].tools.length, 0);
});

test('工具调用 -> 执行 -> 结果回填 -> 第二轮出答案', async function () {
  const tool = {
    name: 'web_search',
    description: '搜索',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    execute: async function (args) { return '三条结果：' + args.query; },
  };
  const streamer = scripted([
    [text('我查查'), toolCall('c1', 'web_search', '{"query":"鲸鱼"}'), finish('tool_calls')],
    [text('查到三条'), finish('stop')],
  ]);

  const events = await run({ streamer: streamer, tools: [tool] });

  const toolEvent = events.filter(function (e) { return e.type === 'tool'; })[0];
  assert.strictEqual(toolEvent.name, 'web_search');
  assert.strictEqual(toolEvent.ok, true);
  assert.match(toolEvent.result, /三条结果：鲸鱼/);

  assert.strictEqual(streamer.calls.length, 2);
  const second = streamer.calls[1].messages;
  const assistant = second[second.length - 2];
  const toolMsg = second[second.length - 1];
  assert.strictEqual(assistant.role, 'assistant');
  assert.strictEqual(assistant.tool_calls[0].id, 'c1');
  assert.strictEqual(toolMsg.role, 'tool');
  assert.strictEqual(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /三条结果：鲸鱼/);

  const finalEvent = events.filter(function (e) { return e.type === 'final'; })[0];
  assert.strictEqual(finalEvent.text, '查到三条');
  assert.strictEqual(finalEvent.rounds, 2);
});

test('同一轮多个工具都会执行，顺序按 index', async function () {
  const calls = [
    { id: 'a', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } },
    { id: 'b', type: 'function', function: { name: 'fetch_url', arguments: '{"url":"https://x.test"}' } },
  ];
  const executed = [];
  const tools = [
    { name: 'web_search', execute: async function () { executed.push('search'); return 'S'; } },
    { name: 'fetch_url', execute: async function () { executed.push('fetch'); return 'F'; } },
  ];
  const streamer = scripted([
    [{ type: 'tool_calls', calls: calls }, finish('tool_calls')],
    [text('好'), finish('stop')],
  ]);

  await run({ streamer: streamer, tools: tools });

  assert.deepStrictEqual(executed, ['search', 'fetch']);
});

test('工具抛错时把错误文本喂回模型，不中断循环', async function () {
  const tool = {
    name: 'fetch_url',
    execute: async function () { throw new Error('连不上 example.com'); },
  };
  const streamer = scripted([
    [toolCall('c1', 'fetch_url', '{"url":"https://x.test"}'), finish('tool_calls')],
    [text('那个页面我打不开'), finish('stop')],
  ]);

  const events = await run({ streamer: streamer, tools: [tool] });

  const toolEvent = events.filter(function (e) { return e.type === 'tool'; })[0];
  assert.strictEqual(toolEvent.ok, false);
  assert.match(toolEvent.result, /工具执行失败：连不上 example.com/);
  assert.match(streamer.calls[1].messages.pop().content, /工具执行失败/);
  assert.strictEqual(events.filter(function (e) { return e.type === 'final'; })[0].text, '那个页面我打不开');
});

test('模型瞎编工具名时给出可用列表', async function () {
  const streamer = scripted([
    [toolCall('c1', 'get_weather', '{}'), finish('tool_calls')],
    [text('那我看不了天气'), finish('stop')],
  ]);

  const events = await run({ streamer: streamer, tools: [{ name: 'web_search', execute: async function () { return 'x'; } }] });
  const toolEvent = events.filter(function (e) { return e.type === 'tool'; })[0];

  assert.strictEqual(toolEvent.ok, false);
  assert.match(toolEvent.result, /没有名为 "get_weather" 的工具/);
  assert.match(toolEvent.result, /web_search/);
});

test('参数不是合法 JSON 时不崩，提示回模型', async function () {
  const streamer = scripted([
    [toolCall('c1', 'web_search', '{query: oops'), finish('tool_calls')],
    [text('我重说一遍'), finish('stop')],
  ]);

  const events = await run({ streamer: streamer, tools: [{ name: 'web_search', execute: async function () { return 'x'; } }] });
  const toolEvent = events.filter(function (e) { return e.type === 'tool'; })[0];

  assert.strictEqual(toolEvent.ok, false);
  assert.match(toolEvent.result, /参数不是合法的 JSON/);
  assert.strictEqual(toolEvent.args, null);
});

test('轮数用尽后禁用工具，逼出一次最终回答', async function () {
  const tool = { name: 'web_search', execute: async function () { return '永远还要搜'; } };
  const loop = [toolCall('c1', 'web_search', '{"query":"x"}'), finish('tool_calls')];
  const streamer = scripted([loop, loop, loop, loop, loop]);
  const events = await run({ streamer: streamer, tools: [tool], extra: { maxRounds: 2 } });

  assert.strictEqual(streamer.calls.length, 3);
  assert.strictEqual(streamer.calls[0].tools.length, 1);
  assert.strictEqual(streamer.calls[1].tools.length, 1);
  assert.strictEqual(streamer.calls[2].tools, undefined);
  assert.strictEqual(events[events.length - 1].rounds, 3);
});

test('normalizeTools 过滤掉没有 execute 或没名字的', function () {
  const tools = normalizeTools([
    { name: 'a', execute: async function () {} },
    { name: '', execute: async function () {} },
    { name: 'c' },
    null,
  ]);

  assert.strictEqual(tools.length, 1);
  assert.strictEqual(tools[0].name, 'a');
  assert.deepStrictEqual(tools[0].parameters, { type: 'object', properties: {} });
});

test('safeParseArgs 处理空值与数组', function () {
  assert.deepStrictEqual(safeParseArgs(''), {});
  assert.deepStrictEqual(safeParseArgs('{"a":1}'), { a: 1 });
  assert.strictEqual(safeParseArgs('[1,2]'), null);
  assert.strictEqual(safeParseArgs('nope'), null);
});

test('truncate 超长结果加提示', function () {
  const out = truncate('x'.repeat(30), 10);
  assert.match(out, /^xxxxxxxxxx\n…（结果过长已截断，共 30 字）/);
  assert.strictEqual(truncate('short', 10), 'short');
});

