'use strict';

const { keyFromUrl, mixinKey, signParams } = require('./wbi');

const API_HOST = 'https://api.bilibili.com';
const NAV_PATH = '/x/web-interface/nav';
const BUVID_PATH = '/x/frontend/finger/spi';

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_INTERVAL_MS = 2000;
const NAV_TTL_MS = 6 * 3600 * 1000;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 接口返回码 -> 人话。模型看不懂 -352 是什么意思，这里统一翻译 */
const CODE_HINTS = {
  '-101': '账号未登录（需要 cookie）',
  '-352': '被风控拦了（缺 buvid3 或请求太快）',
  '-400': '请求参数不对',
  '-404': '啥都没找到',
  '-412': '请求被拦截（风控）',
  '-509': '请求超出限制，等一会儿再来',
  '-799': '请求过于频繁',
};

class BiliError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BiliError';
    this.code = typeof code === 'number' ? code : 0;
  }
}

function codeText(code, message) {
  const hint = CODE_HINTS[String(code)];
  const detail = message ? '：' + message : '';
  if (hint) return 'B站接口 ' + code + ' ' + hint + detail;
  return 'B站接口 ' + code + (message ? ' ' + message : '');
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * B站接口客户端：限速、cookie、wbi 签名、错误翻译都收在这一个文件里。
 * 风控参数一变只改这里，上层（api/tools）不需要知道签名细节。
 */
function createBiliClient(options) {
  const opts = options || {};
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_INTERVAL_MS;
  const clock = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  const logger = opts.logger || console;
  // 不传就退回 process.env：单测和脚本直接 new 也能读到 WG_BILI_*
  const env = opts.env || process.env || {};

  const auth = {
    sessdata: String(opts.sessdata || env.WG_BILI_SESSDATA || '').trim(),
    biliJct: String(opts.biliJct || env.WG_BILI_BILI_JCT || '').trim(),
    dedeUserId: String(opts.dedeUserId || env.WG_BILI_DEDE_USER_ID || '').trim(),
    // 主人的 B站账号 mid：只从 .env 读，不写进 config.json
    mid: String(opts.mid || env.WG_BILI_MID || '').trim(),
  };

  let buvid3 = String(opts.buvid3 || env.WG_BILI_BUVID3 || '').trim();
  // 浏览器同款设备指纹：有历史记录的指纹能明显降低评论进审核的概率
  const extraFingerprint = [
    ['WG_BILI_BUVID4', 'buvid4'],
    ['WG_BILI_B_NUT', 'b_nut'],
    ['WG_BILI_UUID', '_uuid'],
  ].map(function (pair) {
    const value = String(env[pair[0]] || '').trim();
    return value !== '' ? pair[1] + '=' + value : '';
  }).filter(Boolean);
  // 自由扩展位：.env 里 WG_BILI_EXTRA_COOKIES="k=v; k2=v2"，浏览器里其余 cookie（buvid_fp 等）原样带上
  const extraCookies = String(env.WG_BILI_EXTRA_COOKIES || '').trim();
  let navCache = { key: '', at: 0 };
  let nextAt = 0;
  let queue = Promise.resolve();

  function cookieHeader() {
    const parts = [];
    if (buvid3) parts.push('buvid3=' + buvid3);
    for (let i = 0; i < extraFingerprint.length; i += 1) parts.push(extraFingerprint[i]);
    if (extraCookies !== '') parts.push(extraCookies);
    if (auth.sessdata) parts.push('SESSDATA=' + auth.sessdata);
    if (auth.biliJct) parts.push('bili_jct=' + auth.biliJct);
    if (auth.dedeUserId) parts.push('DedeUserID=' + auth.dedeUserId);
    return parts.join('; ');
  }

  function headers(extra) {
    const out = {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      accept: 'application/json, text/plain, */*',
    };
    const cookie = cookieHeader();
    if (cookie) out.cookie = cookie;
    if (extra) Object.keys(extra).forEach(function (key) { out[key] = extra[key]; });
    return out;
  }

  /** 全局限速：请求排一条队，相邻两次至少隔 intervalMs，避开风控的"请求太快" */
  function acquire() {
    const turn = queue.then(async function () {
      const wait = nextAt - clock().getTime();
      if (wait > 0) await sleep(wait);
      nextAt = clock().getTime() + intervalMs;
    });
    queue = turn.then(function () {}, function () {});
    return turn;
  }

  async function requestUrl(url, options) {
    const o = options || {};
    await acquire();

    const method = String(o.method || 'GET').toUpperCase();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    let res;
    try {
      res = await fetchImpl(url, {
        method: method,
        headers: headers(o.headers),
        body: o.body || undefined,
        signal: controller ? controller.signal : undefined,
      });
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? '超过 ' + timeoutMs + 'ms 没响应' : (err && err.message) || String(err);
      throw new BiliError('连不上 B站接口（' + reason + '）', -1);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) throw new BiliError('B站接口 HTTP ' + res.status + '（' + url.replace(/\?.*$/, '') + '）', res.status);

    let json;
    try {
      json = await res.json();
    } catch (err) {
      throw new BiliError('B站接口返回的不是 JSON（' + url.replace(/\?.*$/, '') + '）', -2);
    }

    const accepted = Array.isArray(o.acceptCodes) ? o.acceptCodes : [];
    const code = Number(json && json.code);
    // 字幕 CDN 之类的外部 JSON 没有 B站的 code 字段，跳过校验
    if (!o.skipCodeCheck && code !== 0 && accepted.indexOf(code) === -1) {
      throw new BiliError(codeText(code, json && json.message), code);
    }
    return { code: code, data: (json && json.data) || null, json: json };
  }

  function urlOf(pathname, query) {
    return API_HOST + pathname + (query ? '?' + query : '');
  }

  function buildQuery(params) {
    const source = params && typeof params === 'object' ? params : {};
    return Object.keys(source)
      .filter(function (name) { return source[name] !== undefined && source[name] !== null && source[name] !== ''; })
      .map(function (name) { return encodeURIComponent(name) + '=' + encodeURIComponent(String(source[name])); })
      .join('&');
  }

  /** 不带签名的公开接口 */
  async function get(pathname, params) {
    // 热门/评论这类接口没有 buvid3 会被 -352，第一次请求前先备好
    await ensureBuvid3();
    const result = await requestUrl(urlOf(pathname, buildQuery(params)), {});
    return result.data;
  }

  /**
   * 必须带 buvid3 才有意义：没有就现场申请一个（/x/frontend/finger/spi 是公开的，
   * 不需要用户去浏览器 F12 里抄）。
   */
  async function ensureBuvid3() {
    if (buvid3) return buvid3;
    try {
      const result = await requestUrl(urlOf(BUVID_PATH, ''), {});
      const value = result.data && (result.data.b_3 || result.data.buvid3);
      if (typeof value === 'string' && value !== '') {
        buvid3 = value;
        if (logger && typeof logger.log === 'function') logger.log('[bili] 已自动取得 buvid3');
      }
    } catch (err) {
      if (logger && typeof logger.warn === 'function') logger.warn('[bili] 取 buvid3 失败：' + err.message);
    }
    return buvid3;
  }

  let selfMid = String(auth.dedeUserId || '').trim();

  /** nav 里的 wbi key 六小时内不变，缓存起来省一次请求；-101（未登录）也带 key，所以接受它 */
  async function ensureNav() {
    const nowMs = clock().getTime();
    if (navCache.key && nowMs - navCache.at < NAV_TTL_MS) return navCache.key;

    const result = await requestUrl(urlOf(NAV_PATH, ''), { acceptCodes: [-101] });
    const wbi = result.data && result.data.wbi_img;
    if (!wbi || !wbi.img_url || !wbi.sub_url) throw new BiliError('拿不到 wbi key（nav 里没有 wbi_img）', -3);
    // nav 顺带告诉我们登录的是谁；cookie 里的 DedeUserID 只是兜底
    if (result.data && Number(result.data.mid) > 0) selfMid = String(result.data.mid);

    navCache = { key: mixinKey(keyFromUrl(wbi.img_url), keyFromUrl(wbi.sub_url)), at: nowMs };
    return navCache.key;
  }

  /**
   * 写操作（点赞/投币/评论…）统一走这里：POST 表单 + csrf。
   * 没登录直接拒绝——写接口没 csrf 一定被 -101 拒，提前说人话。
   */
  async function post(pathname, params) {
    if (!auth.sessdata || !auth.biliJct) throw new BiliError('B站账号没登录（缺 SESSDATA/bili_jct），写操作做不了', -101);
    await ensureBuvid3();
    const source = params && typeof params === 'object' ? Object.assign({}, params) : {};
    source.csrf = auth.biliJct;
    const body = buildQuery(source);
    const result = await requestUrl(urlOf(pathname, ''), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', origin: 'https://www.bilibili.com', referer: 'https://www.bilibili.com/' },
      body: body,
    });
    return result.data;
  }

  /** 需要 wbi 签名的接口（搜索、部分 player 接口） */
  async function getSigned(pathname, params) {
    await ensureBuvid3();
    const key = await ensureNav();
    const wts = Math.floor(clock().getTime() / 1000);
    const signed = signParams(params, key, wts);
    const result = await requestUrl(urlOf(pathname, signed.query + '&w_rid=' + signed.w_rid), {});
    return result.data;
  }

  /** 外部 JSON（字幕 CDN）：照样走限速和请求头，但不校验 B站的 code */
  async function fetchJson(url) {
    const result = await requestUrl(url, { headers: { referer: 'https://www.bilibili.com/' }, skipCodeCheck: true });
    return result.json;
  }

  return {
    get: get,
    getSigned: getSigned,
    post: post,
    fetchJson: fetchJson,
    ensureBuvid3: ensureBuvid3,
    ensureNav: ensureNav,
    hasLogin: function () { return !!auth.sessdata; },
    mid: function () { return auth.mid; },
    /** 登录账号自己的 mid（收藏夹等"以自己名义"的接口用），nav 之后最准 */
    selfMid: function () { return selfMid; },
    buvid3: function () { return buvid3; },
  };
}

module.exports = {
  createBiliClient: createBiliClient,
  BiliError: BiliError,
  codeText: codeText,
  API_HOST: API_HOST,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
};
