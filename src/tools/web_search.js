'use strict';

const DEFAULT_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_MAX_RESULTS = 4;
const DEFAULT_TIMEOUT_MS = 15000;

function clean(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * 搜索工具的接口层：目前只接 Tavily，换别家只改这个文件。
 * 没有 key 时不抛"配置错误"给前端，而是抛给 agent —— 模型会看到原因并如实告诉用户。
 */
function createWebSearchTool(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const apiKey = opts.apiKey || '';
  const endpoint = opts.endpoint || DEFAULT_ENDPOINT;
  const defaultCount = opts.maxResults || DEFAULT_MAX_RESULTS;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return {
    name: 'web_search',
    description:
      '联网搜索最新的公开信息。需要新闻、实时价格、天气、某个具体事件或你不确定的事实时用它。返回标题、链接和摘要，回答时请带上链接。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，具体一些，别只写一个词' },
        count: { type: 'integer', description: '返回条数 1~8，默认 ' + defaultCount },
      },
      required: ['query'],
    },
    execute: async function (args) {
      const input = args || {};
      const query = clean(input.query);
      if (query === '') throw new Error('搜索词是空的');
      if (apiKey === '') throw new Error('还没配置搜索 key：在 .env 里填 WG_TAVILY_API_KEY 后重试');

      let count = Number(input.count);
      if (!Number.isFinite(count)) count = defaultCount;
      count = Math.max(1, Math.min(8, Math.floor(count)));

      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ' + apiKey,
        },
        body: JSON.stringify({ query: query, max_results: count, search_depth: 'basic', include_answer: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const detail = await res.text().catch(function () { return ''; });
        throw new Error('搜索服务返回 HTTP ' + res.status + (detail ? '：' + clean(detail).slice(0, 200) : ''));
      }

      const data = await res.json();
      const results = Array.isArray(data.results) ? data.results : [];
      if (results.length === 0) return '没有搜到结果，换个说法或更宽的关键词再试一次';

      const lines = [];
      for (let i = 0; i < results.length; i += 1) {
        const item = results[i] || {};
        lines.push(
          (i + 1) + '. ' + clean(item.title || '(无标题)') + '\n' +
          '   链接：' + clean(item.url) + '\n' +
          '   摘要：' + clean(item.content).slice(0, 300)
        );
      }
      return lines.join('\n\n');
    },
  };
}

module.exports = { createWebSearchTool: createWebSearchTool, DEFAULT_ENDPOINT: DEFAULT_ENDPOINT };
