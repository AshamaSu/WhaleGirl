'use strict';

const DEFAULT_TIMEOUT_MS = 60000;

class LlmError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = 'LlmError';
    const info = extra || {};
    this.status = info.status;
    this.code = info.code;
  }
}

const HTTP_HINTS = {
  400: '请求被拒绝，通常是模型名、参数或工具定义不对',
  401: 'API key 无效或已过期',
  402: '账户余额不足',
  403: '没有访问该模型的权限',
  404: '接口路径不存在',
  422: '参数不合法',
  429: '请求太频繁或额度用完了',
};

function trimBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return String(url);
  }
}

function messageOf(body) {
  const text = String(body == null ? '' : body);
  try {
    const data = JSON.parse(text);
    const err = data && data.error;
    const msg = (err && (err.message || err.code)) || (data && (data.message || data.msg));
    if (msg) return String(msg).slice(0, 300);
  } catch (err) {
    // 不是 JSON 就走纯文本兜底
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat ? flat.slice(0, 300) : '';
}

function mapHttpError(status, body, provider) {
  let hint = HTTP_HINTS[status];
  if (!hint) hint = status >= 500 ? '对方服务端出错，稍后再试' : '请求失败';
  let advice = '';
  if (status === 401 || status === 403) advice = '，检查 providers.' + provider.name + '.apiKey';
  if (status === 404) advice = '，检查 baseUrl 是否少了 /v1（当前 ' + provider.baseUrl + '）';
  if (status === 429) advice = '，等一会儿再试，或检查余额/限流';
  const detail = messageOf(body);
  return new LlmError(
    provider.name + ' 返回 HTTP ' + status + '（' + hint + '）' + advice + (detail ? '：' + detail : ''),
    { status: status, code: 'http_' + status }
  );
}

function mapFetchError(err, provider, timeoutMs) {
  if (err instanceof LlmError) return err;
  const code = (err && err.code) || (err && err.cause && err.cause.code) || '';
  const host = hostOf(provider.baseUrl);
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;

  if (code === 'TIMEOUT') {
    return new LlmError(provider.name + ' 请求超过 ' + timeout + 'ms 没有响应，先看网络，再考虑调大 requestTimeoutMs', { code: 'timeout' });
  }
  if (code === 'ABORT_ERR' || (err && err.name === 'AbortError')) {
    return new LlmError(provider.name + ' 的请求已取消', { code: 'aborted' });
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new LlmError('连不上 ' + provider.name + '：域名解析失败（' + host + '），检查网络或 baseUrl', { code: 'dns' });
  }
  if (code === 'ECONNREFUSED') {
    return new LlmError('连不上 ' + provider.name + '：' + host + ' 拒绝连接。连本地服务的话，先确认它已经启动', { code: 'refused' });
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return new LlmError('和 ' + provider.name + ' 的连接被重置，稍后重试', { code: 'reset' });
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return new LlmError('连 ' + provider.name + ' 时证书校验失败（' + code + '），常见于公司代理或中转站', { code: 'tls' });
  }
  const detail = err && err.message ? err.message : String(err);
  return new LlmError(provider.name + ' 请求失败：' + detail, { code: 'network' });
}

async function readText(res) {
  try {
    return await res.text();
  } catch (err) {
    return '';
  }
}

/** 从单个 SSE 事件块里取出 data: 行（可能是多行 data） */
function extractData(block) {
  const lines = String(block).split('\n');
  const parts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.indexOf('data:') !== 0) continue; // 忽略 : ping 注释和 event:/id: 行
    let value = line.slice(5);
    if (value.charAt(0) === ' ') value = value.slice(1);
    parts.push(value);
  }
  if (parts.length === 0) return null;
  return parts.join('\n');
}

/** 单个 SSE 事件 -> { content, toolCalls, finishReason } */
function parseChunk(data, provider) {
  let json;
  try {
    json = JSON.parse(data);
  } catch (err) {
    throw new LlmError(provider.name + ' 返回了无法解析的数据段：' + String(data).slice(0, 200), { code: 'bad_chunk' });
  }
  if (json && json.error) {
    const msg = (json.error && json.error.message) || JSON.stringify(json.error).slice(0, 200);
    throw new LlmError(provider.name + ' 在流式响应里报错：' + msg, { code: 'stream_error' });
  }
  const choice = json && json.choices && json.choices[0];
  const holder = choice && (choice.delta || choice.message);
  return {
    content: holder && typeof holder.content === 'string' ? holder.content : '',
    toolCalls: holder && Array.isArray(holder.tool_calls) ? holder.tool_calls : null,
    finishReason: (choice && choice.finish_reason) || null,
  };
}

/**
 * 流式返回的 tool_calls 是碎片：同一个 index 分多帧，id/name 只在第一帧，
 * arguments 是一段段字符串拼起来的。这里按 index 归并。
 */
function mergeToolCalls(acc, calls) {
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i] || {};
    const index = typeof call.index === 'number' ? call.index : i;
    const slot = acc.get(index) || { id: '', name: '', arguments: '' };
    if (call.id) slot.id = call.id;
    const fn = call.function || {};
    if (fn.name) slot.name = fn.name;
    if (typeof fn.arguments === 'string') slot.arguments += fn.arguments;
    else if (fn.arguments && typeof fn.arguments === 'object') slot.arguments += JSON.stringify(fn.arguments);
    acc.set(index, slot);
  }
}

function finalizeToolCalls(acc) {
  const out = [];
  const entries = Array.from(acc.entries()).sort(function (a, b) { return a[0] - b[0]; });
  for (let i = 0; i < entries.length; i += 1) {
    const slot = entries[i][1];
    if (!slot.name) continue;
    out.push({
      id: slot.id || 'call_' + entries[i][0],
      type: 'function',
      function: { name: slot.name, arguments: slot.arguments || '{}' },
    });
  }
  return out;
}

function parseWholeBody(text, provider) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const flat = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new LlmError(provider.name + ' 返回的内容既不是 SSE 也不是合法 JSON：' + flat, { code: 'bad_body' });
  }
  if (json && json.error) {
    const msg = (json.error && json.error.message) || JSON.stringify(json.error).slice(0, 200);
    throw new LlmError(provider.name + ' 返回错误：' + msg, { code: 'stream_error' });
  }
  const choice = json && json.choices && json.choices[0];
  const message = (choice && choice.message) || {};
  const content = typeof message.content === 'string' ? message.content : '';
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const calls = [];
  for (let i = 0; i < rawCalls.length; i += 1) {
    const call = rawCalls[i] || {};
    const fn = call.function || {};
    if (!fn.name) continue;
    calls.push({
      id: call.id || 'call_' + i,
      type: 'function',
      function: {
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
      },
    });
  }
  return { content: content, toolCalls: calls, finishReason: (choice && choice.finish_reason) || null };
}

/**
 * 流式对话（结构化事件版）。
 * yield: { type: 'text', text } / { type: 'tool_calls', calls } / { type: 'finish', reason }
 * 所有失败都抛 LlmError，message 是给人看的中文。
 */
async function* streamChatEvents(options) {
  const opts = options || {};
  const provider = opts.provider;
  const messages = opts.messages || [];
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const outerSignal = opts.signal;
  const tools = opts.tools;

  if (!provider) throw new LlmError('没有可用的 provider 配置', { code: 'no_provider' });
  if (!provider.apiKey) {
    throw new LlmError(
      provider.name + ' 还没配置 API key：请编辑 .env 的 WG_' + String(provider.name).toUpperCase() +
        '_API_KEY，或 config.json 的 providers.' + provider.name + '.apiKey',
      { code: 'no_api_key' }
    );
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new LlmError('messages 为空，没有内容可以发给模型', { code: 'empty_messages' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new LlmError('当前运行时没有全局 fetch，需要 Node 18 及以上', { code: 'no_fetch' });
  }

  const url = trimBaseUrl(provider.baseUrl) + '/chat/completions';
  const payload = { model: provider.chatModel, messages: messages, stream: true };
  const temperature = opts.temperature === undefined ? provider.temperature : opts.temperature;
  if (typeof temperature === 'number' && Number.isFinite(temperature)) payload.temperature = temperature;
  if (Array.isArray(tools) && tools.length > 0) {
    payload.tools = tools;
    payload.tool_choice = opts.toolChoice || 'auto';
  }

  const controller = new AbortController();
  const abortWith = function (err) {
    if (!controller.signal.aborted) controller.abort(err);
  };

  const timer = setTimeout(function () {
    const timeoutError = new Error('timeout ' + timeoutMs + 'ms');
    timeoutError.code = 'TIMEOUT';
    abortWith(timeoutError);
  }, timeoutMs);

  const onOuterAbort = function () {
    const abortError = new Error('aborted by caller');
    abortError.code = 'ABORT_ERR';
    abortWith(abortError);
  };
  if (outerSignal) {
    if (outerSignal.aborted) onOuterAbort();
    else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const cleanup = function () {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
  };

  let reader = null;
  try {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: 'Bearer ' + provider.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      throw mapFetchError(err, provider, timeoutMs);
    }

    if (!res.ok) throw mapHttpError(res.status, await readText(res), provider);

    const contentType = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
    if (contentType.indexOf('text/event-stream') === -1) {
      // 有的中转站 / 本地服务会忽略 stream:true，直接回一份完整 JSON
      const parsed = parseWholeBody(await readText(res), provider);
      if (parsed.content) yield { type: 'text', text: parsed.content };
      if (parsed.toolCalls.length > 0) yield { type: 'tool_calls', calls: parsed.toolCalls };
      yield { type: 'finish', reason: parsed.finishReason || (parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop') };
      return;
    }

    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new LlmError(provider.name + ' 返回了 SSE 头但没有可读的响应体', { code: 'empty_body' });
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let produced = false;
    let finishReason = null;
    let sawDone = false;
    const toolAcc = new Map();

    readLoop:
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer = (buffer + decoder.decode(step.value, { stream: true })).replace(/\r\n/g, '\n');

      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const data = extractData(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);

        if (data !== null) {
          if (data === '[DONE]') {
            sawDone = true;
            break readLoop;
          }
          const chunk = parseChunk(data, provider);
          if (chunk.finishReason) finishReason = chunk.finishReason;
          if (chunk.toolCalls) mergeToolCalls(toolAcc, chunk.toolCalls);
          if (chunk.content) {
            produced = true;
            yield { type: 'text', text: chunk.content };
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }

    // 收尾：最后一段可能没有以空行结束
    if (!sawDone && buffer.trim() !== '') {
      const tail = extractData(buffer);
      if (tail !== null && tail !== '[DONE]') {
        const chunk = parseChunk(tail, provider);
        if (chunk.finishReason) finishReason = chunk.finishReason;
        if (chunk.toolCalls) mergeToolCalls(toolAcc, chunk.toolCalls);
        if (chunk.content) {
          produced = true;
          yield { type: 'text', text: chunk.content };
        }
      }
    }

    const calls = finalizeToolCalls(toolAcc);
    if (!produced && calls.length === 0) {
      throw new LlmError(provider.name + ' 连上了但一个字都没返回，检查模型名和账户额度', { code: 'empty_reply' });
    }
    if (calls.length > 0) yield { type: 'tool_calls', calls: calls };
    yield { type: 'finish', reason: finishReason || (calls.length > 0 ? 'tool_calls' : 'stop') };
  } catch (err) {
    throw mapFetchError(err, provider, timeoutMs);
  } finally {
    cleanup();
    if (reader) {
      try {
        await reader.cancel();
      } catch (err) {
        // 已经关了，忽略
      }
    }
  }
}

/** 只要纯文本的便捷版本（P0 的调用方与测试用这个） */
async function* streamChat(options) {
  const events = streamChatEvents(options);
  for await (const event of events) {
    if (event.type === 'text') yield event.text;
  }
}

module.exports = {
  LlmError: LlmError,
  streamChat: streamChat,
  streamChatEvents: streamChatEvents,
  extractData: extractData,
  parseChunk: parseChunk,
  mergeToolCalls: mergeToolCalls,
  finalizeToolCalls: finalizeToolCalls,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
};
