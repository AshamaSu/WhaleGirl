'use strict';

const { createWebSearchTool } = require('./web_search');
const { createFetchUrlTool } = require('./fetch_url');
const { createRememberTool } = require('./remember');

/**
 * 按可用条件装配工具：没有 memory 就不给 remember，没有搜索 key 也给 web_search
 * （它会如实告诉模型"没配 key"，比直接消失更容易让模型给出可用的回答）。
 */
function createTools(options) {
  const opts = options || {};
  const tools = [];
  if (opts.memory) tools.push(createRememberTool(opts.memory));
  tools.push(createFetchUrlTool({ fetchImpl: opts.fetchImpl, timeoutMs: opts.fetchTimeoutMs }));
  tools.push(createWebSearchTool({
    fetchImpl: opts.fetchImpl,
    apiKey: opts.searchApiKey,
    endpoint: opts.searchEndpoint,
    maxResults: opts.searchMaxResults,
  }));
  return tools;
}

function toolNames(tools) {
  return (tools || []).map(function (tool) { return tool.name; });
}

module.exports = {
  createTools: createTools,
  toolNames: toolNames,
  createWebSearchTool: createWebSearchTool,
  createFetchUrlTool: createFetchUrlTool,
  createRememberTool: createRememberTool,
};
