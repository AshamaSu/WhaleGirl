'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { streamChat, streamChatEvents, LlmError, extractData } = require('../src/llm');

const PROVIDER = {
  name: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1/',
  apiKey: 'sk-test-1234',
  chatModel: 'deepseek-chat',
  visionModel: '',
  temperature: 1.1,
};

const MESSAGES = [{ role: 'user', content: '你好' }];

function sseBody(pieces) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    getReader: function () {
      return {
        read: async function () {
          if (index >= pieces.length) return { done: true, value: undefined };
          const value = encoder.encode(pieces[index]);
          index += 1;
          return { done: false, value: value };
        },
        cancel: async function () {
          return undefined;
        },
      };
    },
  };
}

function sseResponse(pieces, contentType) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: function (name) {
        return name === 'content-type' ? contentType || 'text/event-stream' : null;
      },
    },
    body: sseBody(pieces),
  };
}

function delta(text) {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';
}

const DONE = 'data: [DONE]\n\n';

async function collect(gen) {
  let out = '';
  for await (const chunk of gen) out += chunk;
  return out;
}

test('按顺序拿到增量并在 [DONE] 结束', async function () {
  const result = await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse([delta('唔…'), delta('你好呀'), DONE]);
    },
  }));

  assert.strictEqual(result, '唔…你好呀');
});

test('一个 SSE 事件被拆到两个 chunk 也能拼回来', async function () {
  const frame = delta('小鲸');
  const cut = Math.floor(frame.length / 2);

  const result = await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse([frame.slice(0, cut), frame.slice(cut), DONE]);
    },
  }));

  assert.strictEqual(result, '小鲸');
});

test('[DONE] 之后的数据被忽略', async function () {
  const result = await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse([delta('a'), DONE, delta('不该出现')]);
    },
  }));

  assert.strictEqual(result, 'a');
});

test('CRLF 换行的 SSE 也能解析', async function () {
  const frame = delta('呀').replace(/\n/g, '\r\n');

  const result = await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse([frame, 'data: [DONE]\r\n\r\n']);
    },
  }));

  assert.strictEqual(result, '呀');
});

test('忽略 : ping 注释行', async function () {
  const result = await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse([': ping\n\n', delta('在'), DONE]);
    },
  }));

  assert.strictEqual(result, '在');
});

test('provider 忽略 stream 参数直接回 JSON 时走兜底', async function () {
  const result = await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return {
        ok: true,
        status: 200,
        headers: { get: function () { return 'application/json'; } },
        text: async function () {
          return JSON.stringify({ choices: [{ message: { content: '完整回复' } }] });
        },
      };
    },
  }));

  assert.strictEqual(result, '完整回复');
});

test('401 报出可读的中文提示', async function () {
  await assert.rejects(collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return {
        ok: false,
        status: 401,
        headers: { get: function () { return 'application/json'; } },
        text: async function () {
          return JSON.stringify({ error: { message: 'Invalid API key' } });
        },
      };
    },
  })), function (err) {
    assert.ok(err instanceof LlmError);
    assert.strictEqual(err.status, 401);
    assert.match(err.message, /401/);
    assert.match(err.message, /apiKey/);
    assert.match(err.message, /Invalid API key/);
    return true;
  });
});

test('没配 API key 时在发请求前就报错', async function () {
  let called = false;

  await assert.rejects(collect(streamChat({
    provider: Object.assign({}, PROVIDER, { apiKey: '' }),
    messages: MESSAGES,
    fetchImpl: async function () {
      called = true;
      return sseResponse([DONE]);
    },
  })), /还没配置 API key/);

  assert.strictEqual(called, false);
});

test('ECONNREFUSED 映射成中文提示', async function () {
  await assert.rejects(collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    },
  })), /拒绝连接/);
});

test('超时由内部 AbortController 触发', async function () {
  await assert.rejects(collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    timeoutMs: 20,
    fetchImpl: function (url, init) {
      return new Promise(function (resolve, reject) {
        if (init.signal.aborted) {
          reject(init.signal.reason);
          return;
        }
        init.signal.addEventListener('abort', function () {
          reject(init.signal.reason);
        });
      });
    },
  })), /没有响应/);
});

test('外层 signal 取消时报已取消', async function () {
  const controller = new AbortController();
  const task = collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    signal: controller.signal,
    fetchImpl: function (url, init) {
      return new Promise(function (resolve, reject) {
        if (init.signal.aborted) {
          reject(init.signal.reason);
          return;
        }
        init.signal.addEventListener('abort', function () {
          reject(init.signal.reason);
        });
      });
    },
  }));

  await new Promise(function (resolve) { setTimeout(resolve, 10); });
  controller.abort();

  await assert.rejects(task, /已取消/);
});

test('流里夹带 error 对象时抛出', async function () {
  await assert.rejects(collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse(['data: {"error":{"message":"quota exceeded"}}\n\n']);
    },
  })), /quota exceeded/);
});

test('一个字节都没有时给出空回复提示', async function () {
  await assert.rejects(collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse([DONE]);
    },
  })), /一个字都没返回/);
});

test('无法解析的数据段报错', async function () {
  await assert.rejects(collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse(['data: {oops\n\n']);
    },
  })), /无法解析的数据段/);
});

test('messages 为空时直接报错', async function () {
  await assert.rejects(collect(streamChat({
    provider: PROVIDER,
    messages: [],
    fetchImpl: async function () {
      return sseResponse([DONE]);
    },
  })), /messages 为空/);
});

test('请求体带上模型、温度、鉴权头，baseUrl 末尾斜杠被处理', async function () {
  let captured = null;

  await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function (url, init) {
      captured = { url: url, init: init };
      return sseResponse([delta('x'), DONE]);
    },
  }));

  assert.strictEqual(captured.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.strictEqual(captured.init.method, 'POST');
  assert.strictEqual(captured.init.headers.authorization, 'Bearer sk-test-1234');
  assert.strictEqual(captured.init.headers.accept, 'text/event-stream');

  const body = JSON.parse(captured.init.body);
  assert.strictEqual(body.model, 'deepseek-chat');
  assert.strictEqual(body.stream, true);
  assert.strictEqual(body.temperature, 1.1);
  assert.deepStrictEqual(body.messages, MESSAGES);
});

test('显式传入的 temperature 覆盖 provider 默认值', async function () {
  let body = null;

  await collect(streamChat({
    provider: PROVIDER,
    messages: MESSAGES,
    temperature: 0.3,
    fetchImpl: async function (url, init) {
      body = JSON.parse(init.body);
      return sseResponse([delta('x'), DONE]);
    },
  }));

  assert.strictEqual(body.temperature, 0.3);
});

test('extractData 只取 data: 行并支持多行拼接', function () {
  assert.strictEqual(extractData('event: message\nid: 1\ndata: {"a":1}'), '{"a":1}');
  assert.strictEqual(extractData('data: a\ndata: b'), 'a\nb');
  assert.strictEqual(extractData(': ping'), null);
});


function frame(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

async function collectEvents(options) {
  const events = [];
  for await (const event of streamChatEvents(options)) events.push(event);
  return events;
}

test('流式 tool_calls 分片按 index 归并成完整调用', async function () {
  const pieces = [
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"鲸鱼 新闻"}' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    DONE,
  ];

  const events = await collectEvents({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () { return sseResponse(pieces); },
  });

  const callEvent = events.filter(function (e) { return e.type === 'tool_calls'; })[0];
  assert.ok(callEvent);
  assert.strictEqual(callEvent.calls.length, 1);
  assert.strictEqual(callEvent.calls[0].id, 'call_1');
  assert.strictEqual(callEvent.calls[0].type, 'function');
  assert.strictEqual(callEvent.calls[0].function.name, 'web_search');
  assert.deepStrictEqual(JSON.parse(callEvent.calls[0].function.arguments), { query: '鲸鱼 新闻' });
  assert.strictEqual(events[events.length - 1].type, 'finish');
  assert.strictEqual(events[events.length - 1].reason, 'tool_calls');
});

test('多个 tool_calls 各自归并，缺 id 时补一个', async function () {
  const pieces = [
    frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'web_search', arguments: '{}' } }, { index: 1, function: { name: 'fetch_url', arguments: '{"url":' } }] } }] }),
    frame({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"https://x.test"}' } }] } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
    DONE,
  ];

  const events = await collectEvents({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () { return sseResponse(pieces); },
  });

  const calls = events.filter(function (e) { return e.type === 'tool_calls'; })[0].calls;
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].function.name, 'web_search');
  assert.strictEqual(calls[1].function.name, 'fetch_url');
  assert.strictEqual(calls[1].id, 'call_1');
  assert.deepStrictEqual(JSON.parse(calls[1].function.arguments), { url: 'https://x.test' });
});

test('只有 tool_calls 没有文本时不算空回复', async function () {
  const events = await collectEvents({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return sseResponse([
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'remember', arguments: '{"fact":"他叫阿龙"}' } }] } }] }),
        DONE,
      ]);
    },
  });

  assert.strictEqual(events.filter(function (e) { return e.type === 'text'; }).length, 0);
  assert.strictEqual(events.filter(function (e) { return e.type === 'tool_calls'; })[0].calls[0].function.name, 'remember');
});

test('非 SSE 的 JSON 响应也支持 tool_calls', async function () {
  const events = await collectEvents({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function () {
      return {
        ok: true,
        status: 200,
        headers: { get: function () { return 'application/json'; } },
        text: async function () {
          return JSON.stringify({
            choices: [{
              message: {
                content: '',
                tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"query":"x"}' } }],
              },
              finish_reason: 'tool_calls',
            }],
          });
        },
      };
    },
  });

  const callEvent = events.filter(function (e) { return e.type === 'tool_calls'; })[0];
  assert.strictEqual(callEvent.calls[0].function.name, 'web_search');
  assert.strictEqual(events[events.length - 1].reason, 'tool_calls');
});

test('传了 tools 才带 tools 字段，且 tool_choice 默认 auto', async function () {
  let body = null;
  const schema = [{ type: 'function', function: { name: 'web_search', description: 'x', parameters: { type: 'object', properties: {} } } }];

  await collectEvents({
    provider: PROVIDER,
    messages: MESSAGES,
    tools: schema,
    fetchImpl: async function (url, init) {
      body = JSON.parse(init.body);
      return sseResponse([delta('ok'), DONE]);
    },
  });
  assert.deepStrictEqual(body.tools, schema);
  assert.strictEqual(body.tool_choice, 'auto');

  await collectEvents({
    provider: PROVIDER,
    messages: MESSAGES,
    fetchImpl: async function (url, init) {
      body = JSON.parse(init.body);
      return sseResponse([delta('ok'), DONE]);
    },
  });
  assert.strictEqual(body.tools, undefined);
});
