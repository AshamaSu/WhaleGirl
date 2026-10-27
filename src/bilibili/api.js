'use strict';

const { BiliError } = require('./client');

const MAX_DESC_CHARS = 1500;
const MAX_SUBTITLE_CHARS = 6000;
const MAX_COMMENT_CHARS = 100;
const POPULAR_MAX = 50;

const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/;

function stripTags(text) {
  return String(text == null ? '' : text)
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function trimText(text, limit) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit) + '…';
}

/** 秒数 -> 秒（search 接口给的是 "12:34"，popular 给的是秒数） */
function toSeconds(duration) {
  if (typeof duration === 'number' && Number.isFinite(duration)) return Math.round(duration);
  const text = String(duration == null ? '' : duration).trim();
  if (text === '') return 0;
  const parts = text.split(':').map(function (item) { return Number(item); });
  if (parts.some(function (item) { return !Number.isFinite(item); })) return 0;
  let seconds = 0;
  for (let i = 0; i < parts.length; i += 1) seconds = seconds * 60 + parts[i];
  return Math.round(seconds);
}

function daysAgo(pubdate, nowMs) {
  const seconds = Number(pubdate);
  if (!Number.isFinite(seconds) || seconds <= 0) return -1;
  return Math.max(0, Math.floor((nowMs - seconds * 1000) / 86400000));
}

function normalizeItem(raw, nowMs) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const owner = item.owner && typeof item.owner === 'object' ? item.owner.name : '';
  const stat = item.stat && typeof item.stat === 'object' ? item.stat : {};
  return {
    bvid: String(item.bvid || ''),
    aid: Number(item.aid) || 0,
    title: stripTags(item.title),
    author: String(item.author || owner || ''),
    play: Number(item.play !== undefined ? item.play : stat.view) || 0,
    pubdate: Number(item.pubdate || item.senddate) || 0,
    days: daysAgo(item.pubdate || item.senddate, nowMs),
    seconds: toSeconds(item.duration),
    desc: trimText(item.desc || item.description, MAX_DESC_CHARS),
    typename: String(item.tname || item.typename || ''),
  };
}

function assertBvid(value) {
  const bvid = String(value == null ? '' : value).trim();
  if (!BV_PATTERN.test(bvid)) throw new BiliError('bvid 不合法：' + (value === undefined ? '(空)' : value), 0);
  return bvid;
}

/**
 * B站只读接口的归一化层：调用方（工具/子代理）只看到干净的字段，
 * 不用关心 retry、cookie、字段名在哪个接口里叫什么。
 */
function createBiliApi(client, options) {
  const opts = options || {};
  const clock = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  const videoCache = new Map();

  async function popular(params) {
    const p = params || {};
    const ps = Math.min(POPULAR_MAX, Math.max(1, Number(p.ps) || 20));
    const data = await client.get('/x/web-interface/popular', { ps: ps, pn: Math.max(1, Number(p.pn) || 1) });
    const list = (data && Array.isArray(data.list) ? data.list : []).map(function (item) {
      return normalizeItem(item, clock().getTime());
    });
    return list;
  }

  async function search(params) {
    const p = params || {};
    const keyword = String(p.keyword == null ? '' : p.keyword).trim();
    if (keyword === '') throw new BiliError('搜索需要 keyword', 0);

    const data = await client.getSigned('/x/web-interface/wbi/search/type', {
      search_type: 'video',
      keyword: keyword,
      page: Math.max(1, Number(p.page) || 1),
      page_size: Math.min(30, Math.max(1, Number(p.ps) || 20)),
      order: String(p.order || 'pubdate'),
    });

    const raw = data && Array.isArray(data.result) ? data.result : [];
    return raw
      .filter(function (item) { return item && item.type === 'video' && item.bvid; })
      .map(function (item) { return normalizeItem(item, clock().getTime()); });
  }

  async function video(params) {
    const bvid = assertBvid(params && params.bvid);
    const cached = videoCache.get(bvid);
    if (cached && clock().getTime() - cached.at < 10 * 60 * 1000) return cached.value;

    const data = await client.get('/x/web-interface/view', { bvid: bvid });
    if (!data) throw new BiliError('查不到这条视频：' + bvid, -404);

    const value = {
      bvid: bvid,
      aid: Number(data.aid) || 0,
      cid: Number(data.cid) || 0,
      title: stripTags(data.title),
      author: String((data.owner && data.owner.name) || ''),
      desc: String(data.desc == null ? '' : data.desc).slice(0, MAX_DESC_CHARS),
      play: Number((data.stat && data.stat.view) || 0),
      like: Number((data.stat && data.stat.like) || 0),
      pubdate: Number(data.pubdate) || 0,
      days: daysAgo(data.pubdate, clock().getTime()),
      seconds: toSeconds(data.duration),
      typename: String(data.tname || ''),
    };
    videoCache.set(bvid, { at: clock().getTime(), value: value });
    return value;
  }

  /** 字幕：CC 字幕公开可读，AI 字幕要登录。取不到就是"没有字幕"，不是故障 */
  async function subtitle(params) {
    const p = params || {};
    const bvid = assertBvid(p.bvid);
    const cid = Number(p.cid) > 0 ? Number(p.cid) : (await video({ bvid: bvid })).cid;
    if (!cid) return { empty: true, reason: '拿不到 cid', text: '', count: 0 };

    const player = await client.get('/x/player/v2', { bvid: bvid, cid: cid });
    const tracks = (player && player.subtitle && player.subtitle.subtitles) || [];
    const usable = tracks.filter(function (track) { return track && track.subtitle_url; });
    if (usable.length === 0) {
      return { empty: true, reason: client.hasLogin() ? '这条视频没上传字幕' : '没有公开字幕（AI 字幕要登录）', text: '', count: 0 };
    }

    const track = usable[0];
    const url = /^https?:/i.test(track.subtitle_url) ? track.subtitle_url : 'https:' + track.subtitle_url;
    let body;
    try {
      body = await client.fetchJson(url);
    } catch (err) {
      return { empty: true, reason: '字幕文件下载失败：' + err.message, text: '', count: 0 };
    }

    const lines = (body && Array.isArray(body.body) ? body.body : [])
      .map(function (line) { return String((line && line.content) || '').trim(); })
      .filter(function (line) { return line !== ''; });
    const text = lines.join('\n').slice(0, MAX_SUBTITLE_CHARS);
    if (text === '') return { empty: true, reason: '字幕是空的', text: '', count: 0 };
    return { empty: false, reason: '', text: text, count: lines.length, lan: String(track.lan_doc || track.lan || '') };
  }

  async function comments(params) {
    const p = params || {};
    const bvid = assertBvid(p.bvid);
    const ps = Math.min(20, Math.max(1, Number(p.ps) || 8));
    const aid = Number(p.aid) > 0 ? Number(p.aid) : (await video({ bvid: bvid })).aid;
    if (!aid) return [];

    const data = await client.get('/x/v2/reply/main', { oid: aid, type: 1, mode: 3, ps: ps });
    const list = data && Array.isArray(data.replies) ? data.replies : [];
    return list.map(function (item) {
      const member = (item && item.member) || {};
      const content = (item && item.content) || {};
      return {
        author: String(member.uname || ''),
        content: trimText(content.message, MAX_COMMENT_CHARS),
        like: Number(item.like) || 0,
      };
    });
  }

  return {
    popular: popular,
    search: search,
    video: video,
    subtitle: subtitle,
    comments: comments,
  };
}

module.exports = {
  createBiliApi: createBiliApi,
  stripTags: stripTags,
  toSeconds: toSeconds,
  daysAgo: daysAgo,
  assertBvid: assertBvid,
  normalizeItem: normalizeItem,
  BV_PATTERN: BV_PATTERN,
  MAX_DESC_CHARS: MAX_DESC_CHARS,
  MAX_SUBTITLE_CHARS: MAX_SUBTITLE_CHARS,
};
