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

/**
 * 多语言轨优先中文：zh-CN（人工） > ai-zh（自动）> 其他语言。
 * 只取第一条会在外语视频里拿到看不懂的轨道。
 */
function pickTrack(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  function rank(track) {
    const lan = String((track && track.lan) || '').toLowerCase();
    if (/^zh/.test(lan)) return 0;
    if (/zh/.test(lan)) return 1;
    return 2;
  }
  let best = null;
  for (let i = 0; i < list.length; i += 1) {
    if (!best || rank(list[i]) < rank(best)) best = list[i];
  }
  return best;
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

    const track = pickTrack(usable);
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


  // ===== 主人的公开数据源（#2：跟着主人的兴趣浏览）=====

  /** 主人关注的 UP 列表（对方没关隐私才有；拉不到就是结果，不是故障） */
  async function followings(params) {
    const p = params || {};
    const vmid = Number(p.vmid) > 0 ? Number(p.vmid) : 0;
    if (!vmid) throw new BiliError('followings 需要 vmid（主人的 mid）', 0);
    const ps = Math.min(50, Math.max(1, Number(p.ps) || 20));
    const pn = Math.max(1, Number(p.pn) || 1);
    const data = await client.get('/x/relation/followings', { vmid: vmid, ps: ps, pn: pn, order: 'attention' });
    const list = data && Array.isArray(data.list) ? data.list : [];
    return list.map(function (item) {
      return {
        mid: Number(item.mid) || 0,
        uname: String((item.uname || (item.space && item.space.name)) || ''),
        sign: trimText(item.sign, 60),
        official: String((item.official_verify && item.official_verify.desc) || ''),
        // 特别关注判定：special 位为 1，或挂在系统「特别关注」标签（tag 含 -10）下
        special: item.special === 1 || (Array.isArray(item.tag) && item.tag.indexOf(-10) !== -1),
        attribute: Number(item.attribute) || 0,
      };
    });
  }

  /**
   * 指定 UP 的最新投稿（wbi 签名接口，实测可用：is_risk=false）。
   * 返回 [{ bvid, title, up, play, created(秒), link }]，供特别关注优先选题用。
   */
  async function spaceVideos(params) {
    const p = params || {};
    const mid = Number(p.mid) || 0;
    if (mid <= 0) throw new BiliError('spaceVideos 需要 mid', 0);
    const ps = Math.min(10, Math.max(1, Number(p.ps) || 2));
    const data = await client.getSigned('/x/space/wbi/arc/search', { mid: mid, ps: ps, pn: 1, order: 'pubdate' });
    const vlist = (data && data.list && Array.isArray(data.list.vlist)) ? data.list.vlist : [];
    return vlist.map(function (item) {
      const bvid = String(item.bvid || '');
      return {
        bvid: bvid,
        title: stripTags(item.title),
        up: String(item.author || ''),
        play: Number(item.play) || 0,
        created: Number(item.created) || 0,
        link: bvid ? 'https://www.bilibili.com/video/' + bvid : '',
      };
    });
  }

  /**
   * 关注/取关（act: 1=关注 2=取关）。写操作走 client.post（自动带 csrf + 限速队列）。
   * 调用方负责前置校验（是否已关注、特别关注保护）与记录。
   */
  async function relationModify(fid, act) {
    const id = Number(fid) || 0;
    if (id <= 0) throw new BiliError('fid 不合法：' + fid, 0);
    const action = Number(act) === 2 ? 2 : 1;
    await client.post('/x/relation/modify', { fid: id, act: action });
    return true;
  }

  /**
   * 主人的公开动态里的视频（转发/投稿/收藏的都可能出现在这）。
   * 动态结构很深且常变，全用兜底解析：拿不到就跳过这条，不让一条坏数据炸掉整页。
   */
  async function masterDynamics(params) {
    const p = params || {};
    const vmid = Number(p.vmid) > 0 ? Number(p.vmid) : 0;
    if (!vmid) throw new BiliError('masterDynamics 需要 vmid（主人的 mid）', 0);

    // 该接口 2026-10 起要求 wbi 签名，匿名 get 会 404
    const data = await client.getSigned('/x/polymer/web-dynamic/v1/feed', { host_mid: vmid });
    const items = data && data.items && Array.isArray(data.items) ? data.items : [];
    const out = [];
    for (let i = 0; i < items.length && out.length < 20; i += 1) {
      const entry = items[i] || {};
      const modules = entry.modules || {};
      const dynamic = modules.module_dynamic || {};
      const major = dynamic.major || {};
      const archive = major.archive || {};
      const bvid = String(archive.bvid || '');
      if (bvid === '') continue;
      const author = modules.module_author || {};
      const stat = archive.stat || {};
      out.push({
        bvid: bvid,
        aid: Number(archive.aid) || 0,
        title: stripTags(archive.title),
        author: String((author.name || archive.upname) || ''),
        play: Number(stat.play) || 0,
        like: Number(stat.like) || 0,
        seconds: toSeconds(archive.duration_text),
        pubtext: String(author.pub_time || ''),
        desc: trimText(dynamic.desc ? dynamic.desc.text : '', MAX_DESC_CHARS),
      });
    }
    return out;
  }

  // ===== 通知（#4：谁回复了我们）=====

  /**
   * 「回复我的」消息列表（2026-10 实测结构）：
   *   item.subject_id = 评论区 oid（视频是 aid，文章是 cv 号）
   *   item.business_id = 评论区类型（1=视频，12=文章）
   *   item.root_id = 我们被回复的那条评论（楼中楼根）
   *   item.source_id = 对方那条评论的 rpid（点赞它用这个）
   *   item.source_content = 对方说的话；item.root_reply_content = 我们原评论
   * 字段缺失就兜底，单条坏数据不炸整页。
   */
  async function msgfeedReplies(params) {
    const p = params || {};
    const ps = Math.min(20, Math.max(1, Number(p.ps) || 10));
    const data = await client.get('/x/msgfeed/reply', { build: 0, mimetype: 'web', ps: ps, type: 'all' });
    const items = data && data.items && Array.isArray(data.items) ? data.items : [];
    return items.map(function (entry) {
      const e = entry || {};
      const user = e.user || {};
      const item = e.item || {};
      const oid = Number(item.subject_id) || 0;
      return {
        id: String(e.id || ''),
        fromMid: Number(user.mid) || 0,
        fromName: String(user.nickname || user.uname || ''),
        text: trimText(item.source_content, 200),
        oid: oid,
        subjectType: [1, 11, 12].indexOf(Number(item.business_id)) !== -1 ? Number(item.business_id) : 1,
        bvid: '',
        subjectTitle: stripTags(item.title || ''),
        rootRpid: Number(item.root_id) || 0,
        rootText: trimText(item.root_reply_content, 100),
        replyRpid: Number(item.source_id) || 0,
        timeAt: String(item.reply_time || ''),
      };
    }).filter(function (item) { return item.id !== '' && item.oid > 0; });
  }

  /** 主人的 B站 昵称（@ 他用）。card 接口公开，六小时缓存 */
  let masterNameCache = { name: '', at: 0 };
  async function masterNickname(params) {
    const vmid = Number(params && params.vmid) || 0;
    if (!vmid) throw new BiliError('masterNickname 需要 vmid', 0);
    const nowMs = clock().getTime();
    if (masterNameCache.name && nowMs - masterNameCache.at < 6 * 3600 * 1000) return masterNameCache.name;
    const data = await client.get('/x/web-interface/card', { mid: vmid });
    const name = String((data && data.card && data.card.name) || (data && data.name) || '').trim();
    if (name !== '') masterNameCache = { name: name, at: nowMs };
    return name;
  }

  // ===== 写操作（#3：互动）。都要求登录，csrf 由 client.post 统一带 =====

  /** 给视频点赞（like=1）。已经点过赞的接口会报错，调用方把错误翻译给人话 */
  async function likeVideo(params) {
    const bvid = assertBvid(params && params.bvid);
    return client.post('/x/web-interface/archive/like', { bvid: bvid, like: 1 });
  }

  /** 投币：multiply 是 1 或 2 枚，select_like=0 表示顺手点赞由点赞接口单独管 */
  async function coin(params) {
    const bvid = assertBvid(params && params.bvid);
    const multiply = Number(params && params.multiply) === 2 ? 2 : 1;
    return client.post('/x/web-interface/coin/add', { bvid: bvid, multiply: multiply, select_like: 0 });
  }

  /** 一键三连：点赞 + 投币 + 收藏一把梭；硬币不够时 B站会部分成功，结果原样返回 */
  async function triple(params) {
    const bvid = assertBvid(params && params.bvid);
    return client.post('/x/web-interface/archive/like/triple', { bvid: bvid });
  }

  /** 收藏进默认收藏夹：没有收藏夹就先建一个，之后一直用同一个 */
  let favFolderCache = null;
  async function ensureFavFolder() {
    if (favFolderCache) return favFolderCache;
    const mid = Number(typeof client.selfMid === 'function' ? client.selfMid() : 0) || 0;
    if (!mid) throw new BiliError('不知道自己的 mid，建不了收藏夹（先跑一轮带登录的请求）', 0);

    const list = await client.get('/x/v3/fav/folder/created/list-all', { up_mid: mid });
    const folders = list && Array.isArray(list.list) ? list.list : [];
    if (folders.length > 0 && Number(folders[0].id) > 0) {
      favFolderCache = { id: Number(folders[0].id), title: String(folders[0].title || '') };
      return favFolderCache;
    }
    await client.post('/x/v3/fav/folder/add', { title: '小鲸觉得好', intro: '小鲸自己收藏的', privacy: 0 });
    const again = await client.get('/x/v3/fav/folder/created/list-all', { up_mid: mid });
    const made = again && Array.isArray(again.list) ? again.list : [];
    if (made.length === 0 || !Number(made[0].id)) throw new BiliError('收藏夹建了但查不到', 0);
    favFolderCache = { id: Number(made[0].id), title: String(made[0].title || '') };
    return favFolderCache;
  }

  async function favorite(params) {
    const bvid = assertBvid(params && params.bvid);
    const info = await video({ bvid: bvid });
    if (!info.aid) throw new BiliError('拿不到 aid，没法收藏：' + bvid, -404);
    const folder = await ensureFavFolder();
    return client.post('/x/v3/fav/resource/deal', {
      rid: info.aid,
      type: 2,
      add_media_ids: folder.id,
      del_media_ids: '',
    });
  }

  /**
   * 发评论：root>0 时是楼中楼回复某人，parent 用对方 rpid。
   * type：1=视频（bvid/aid），11=动态/图文（oid=动态评论id），12=文章（oid=cv号）。
   */
  const REPLY_TYPES = [1, 11, 12, 17];
  async function reply(params) {
    const p = params || {};
    const message = String(p.message == null ? '' : p.message).trim();
    if (message === '') throw new BiliError('评论内容不能为空', 0);
    if (message.length > 300) throw new BiliError('评论太长（' + message.length + ' 字），压到 300 字以内', 0);
    const type = REPLY_TYPES.indexOf(Number(p.type)) !== -1 ? Number(p.type) : 1;
    let oid = Number(p.oid) || Number(p.aid) || 0;
    if (!oid) {
      if (type !== 1) throw new BiliError('动态/文章评论需要 oid', 0);
      const bvid = assertBvid(p.bvid);
      const info = await video({ bvid: bvid });
      if (!info.aid) throw new BiliError('拿不到 aid，没法评论：' + bvid, -404);
      oid = info.aid;
    }
    const body = { oid: oid, type: type, message: message };
    const root = Number(p.rootRpid) || 0;
    if (root > 0) {
      body.root = root;
      // parent 指向被回复的那条评论（楼中楼里 @ 的对象）；不传就是回复楼层根
      body.parent = Number(p.parentRpid) || root;
    }
    const data = await client.post('/x/v2/reply/add', body);
    return data && Number(data.rpid) > 0 ? { rpid: Number(data.rpid) } : { rpid: 0 };
  }

  /**
   * 发文字动态（成长记录/碎碎念）。老版 dynamic_svr 端点最稳：
   * type=4 纯文字，rid=0。发布成功返回动态 id。
   */
  async function createTextDynamic(params) {
    const content = String(params && params.content == null ? '' : params.content).trim();
    if (content === '') throw new BiliError('动态内容不能为空', 0);
    if (content.length > 1000) throw new BiliError('动态太长（' + content.length + ' 字），压到 1000 字以内', 0);
    const data = await client.post('https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create', {
      type: 4,
      rid: 0,
      content: content,
    });
    // 大整数会丢精度，*_str 才是准的
    const dynId = String((data && (data.dynamic_id_str || data.dyn_id_str || data.dynamic_id || data.dyn_id)) || '');
    return { dynId: dynId };
  }

  /** 给评论点赞（action=1）；用来给主人的留言捧场。文章评论传 type=12 */
  async function likeComment(params) {
    const p = params || {};
    const oid = Number(p.oid) || 0;
    const rpid = Number(p.rpid) || 0;
    if (!oid || !rpid) throw new BiliError('likeComment 需要 oid 和 rpid', 0);
    const type = [1, 11, 12, 17].indexOf(Number(p.type)) !== -1 ? Number(p.type) : 1;
    return client.post('/x/v2/reply/action', { oid: oid, type: type, rpid: rpid, action: 1 });
  }

  return {
    popular: popular,
    search: search,
    video: video,
    subtitle: subtitle,
    comments: comments,
    followings: followings,
    relationModify: relationModify,
    masterDynamics: masterDynamics,
    masterNickname: masterNickname,
    msgfeedReplies: msgfeedReplies,
    likeVideo: likeVideo,
    coin: coin,
    triple: triple,
    favorite: favorite,
    reply: reply,
    createTextDynamic: createTextDynamic,
    likeComment: likeComment,
  };
}

module.exports = {
  createBiliApi: createBiliApi,
  pickTrack: pickTrack,
  stripTags: stripTags,
  toSeconds: toSeconds,
  daysAgo: daysAgo,
  assertBvid: assertBvid,
  normalizeItem: normalizeItem,
  BV_PATTERN: BV_PATTERN,
  MAX_DESC_CHARS: MAX_DESC_CHARS,
  MAX_SUBTITLE_CHARS: MAX_SUBTITLE_CHARS,
};
