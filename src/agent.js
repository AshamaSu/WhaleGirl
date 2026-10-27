'use strict';

const { streamChatEvents } = require('./llm');

const DEFAULT_MAX_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 4000;

/**
 * 工具调用循环：
 *   模型 -> 要不要调工具？-> 调 -> 结果写回历史 -> 再问模型 -> ... -> 出最终回复
 * 工具出错不抛异常，而是把错误文本喂回模型，让它自己决定怎么补救。
 */
function normalizeTools(tools) {
  const list = [];
  const source = Array.isArray(tools) ? tools : [];
  for (let i = 0; i < source.length; i += 1) {
    const tool = source[i];
    if (!tool || typeof tool.name !== 'string' || tool.name === '') continue;
    if (typeof tool.execute !== 'function') continue;
    list.push({
      name: tool.name,
      description: String(tool.description || ''),
      parameters: tool.parameters || { type: 'object', properties: {} },
      execute: tool.execute,
    });
  }
  return list;
}

/** 转成 OpenAI 的 tools 定义（不含 execute） */
function toolSchemas(tools) {
  return tools.map(function (tool) {
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    };
  });
}

function safeParseArgs(raw) {
  if (raw === undefined || raw === null || raw === '') return {};
  try {
    const value = JSON.parse(String(raw));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (err) {
    return null;
  }
}

function truncate(text, limit) {
  const value = String(text == null ? '' : text);
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '\n…（结果过长已截断，共 ' + value.length + ' 字）';
}

/**
 * 跑一轮完整对话（可能包含多次工具往返）。
 * yield:
 *   { type: 'text', text }                       文本增量
 *   { type: 'tool', id, name, args, ok, result } 工具调用与结果（给前端做提示）
 *   { type: 'final', text, rounds }              最终回复汇总
 */
async function* runAgent(options) {
  const opts = options || {};
  const provider = opts.provider;
  const tools = normalizeTools(opts.tools);
  const schemas = toolSchemas(tools);
  const maxRounds = Number.isInteger(opts.maxRounds) && opts.maxRounds > 0 ? opts.maxRounds : DEFAULT_MAX_ROUNDS;
  const streamer = opts.streamChatEvents || streamChatEvents;
  const toolLimit = opts.maxToolResultChars || MAX_TOOL_RESULT_CHARS;
  const messages = (opts.messages || []).slice();

  function findTool(name) {
    for (let i = 0; i < tools.length; i += 1) {
      if (tools[i].name === name) return tools[i];
    }
    return null;
  }

  for (let round = 0; round < maxRounds; round += 1) {
    let text = '';
    let calls = null;

    const stream = streamer({
      provider: provider,
      messages: messages,
      tools: schemas,
      temperature: opts.temperature,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });

    for await (const event of stream) {
      if (event.type === 'text') {
        text += event.text;
        yield { type: 'text', text: event.text };
      } else if (event.type === 'tool_calls') {
        calls = event.calls;
      }
    }

    if (!calls || calls.length === 0) {
      yield { type: 'final', text: text, rounds: round + 1 };
      return;
    }

    // 把这一轮的工具调用写回历史，再逐个执行
    messages.push({ role: 'assistant', content: text === '' ? null : text, tool_calls: calls });

    for (let i = 0; i < calls.length; i += 1) {
      const call = calls[i];
      const name = call.function && call.function.name;
      const rawArgs = call.function && call.function.arguments;
      const args = safeParseArgs(rawArgs);

      let ok = true;
      let result;

      if (!findTool(name)) {
        ok = false;
        result = '没有名为 "' + name + '" 的工具，可用的有：' + tools.map(function (t) { return t.name; }).join(', ');
      } else if (args === null) {
        ok = false;
        result = '参数不是合法的 JSON 对象：' + String(rawArgs).slice(0, 200);
      } else {
        try {
          result = await findTool(name).execute(args, {
            provider: provider,
            signal: opts.signal,
            messages: messages,
          });
        } catch (err) {
          ok = false;
          result = '工具执行失败：' + (err && err.message ? err.message : String(err));
        }
      }

      const content = truncate(result, toolLimit);
      yield { type: 'tool', id: call.id, name: name, args: args, ok: ok, result: content };
      messages.push({ role: 'tool', tool_call_id: call.id, content: content });
    }

    if (opts.onRound) opts.onRound(round + 1, messages);
  }

  // 轮数用尽还在要工具：不再给工具，逼它用自己的话回答
  let text = '';
  const finalStream = streamer({
    provider: provider,
    messages: messages,
    temperature: opts.temperature,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  for await (const event of finalStream) {
    if (event.type === 'text') {
      text += event.text;
      yield { type: 'text', text: event.text };
    }
  }
  yield { type: 'final', text: text, rounds: maxRounds + 1 };
}

module.exports = {
  runAgent: runAgent,
  normalizeTools: normalizeTools,
  toolSchemas: toolSchemas,
  safeParseArgs: safeParseArgs,
  truncate: truncate,
  DEFAULT_MAX_ROUNDS: DEFAULT_MAX_ROUNDS,
};
