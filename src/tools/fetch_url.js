'use strict';

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BYTES = 400 * 1024;
const MAX_CHARS = 6000;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, function (m, hex) {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch (e) { return m; }
    })
    .replace(/&#(\d+);/g, function (m, dec) {
      try { return String.fromCodePoint(parseInt(dec, 10)); } catch (e) { return m; }
    })
    .replace(/&([a-z]+);/gi, function (m, name) {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : m;
    });
}

/** 零依赖的正文抽取：去掉脚本样式和标签，保留段落换行 */
function htmlToText(html) {
  let text = String(html == null ? '' : html);
  text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text.replace(/[ \t\r\f\v\u00a0]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** 挡住内网地址，避免模型被诱导去读本机服务或云上元数据 */
function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl).trim());
  } catch (err) {
    throw new Error('URL 不合法：' + rawUrl);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http/https 链接');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked =
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (blocked) throw new Error('不抓内网地址：' + host);
  return url;
}

function createFetchUrlTool(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxChars = opts.maxChars || MAX_CHARS;

  return {
    name: 'fetch_url',
    description: '打开一个网页并读取正文。搜索结果的摘要不够用时，用它读原文。会去掉导航广告，只保留文字。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的完整链接，http/https 开头' } },
      required: ['url'],
    },
    execute: async function (args) {
      const url = assertPublicUrl((args || {}).url);

      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) throw new Error('打开失败，HTTP ' + res.status);

      const type = (res.headers && res.headers.get ? res.headers.get('content-type') : '') || '';
      if (type && type.indexOf('text') === -1 && type.indexOf('json') === -1 && type.indexOf('xml') === -1) {
        throw new Error('这个链接不是网页（content-type: ' + type + '），读不了');
      }

      const raw = await res.text();
      if (raw.length > MAX_BYTES) throw new Error('页面太大（' + Math.round(raw.length / 1024) + 'KB），放弃了');

      const text = htmlToText(raw);
      if (text === '') return '这个页面没有可读的文字（可能需要登录或被脚本渲染）';
      if (text.length <= maxChars) return text;
      return text.slice(0, maxChars) + '\n…（正文过长已截断，共 ' + text.length + ' 字）';
    },
  };
}

module.exports = {
  createFetchUrlTool: createFetchUrlTool,
  htmlToText: htmlToText,
  decodeEntities: decodeEntities,
  assertPublicUrl: assertPublicUrl,
};
