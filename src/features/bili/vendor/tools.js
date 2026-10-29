'use strict';

const { assertBvid } = require('./api');

const MAX_LIST = 20;

function formatCount(value) {
  const num = Number(value) || 0;
  if (num >= 100000000) return (num / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (num >= 10000) return (num / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(num);
}

function daysText(days) {
  const num = Number(days);
  if (!Number.isFinite(num) || num < 0) return '时间未知';
  if (num === 0) return '今天';
  return num + ' 天前';
}

function oneLine(index, item) {
  return (index + 1) + '. ' + item.bvid + ' | ' + item.title +
    ' | UP：' + (item.author || '未知') +
    ' | ' + formatCount(item.play) + '播放' +
    ' | ' + daysText(item.days);
}

/** 列表类结果的公共收尾：硬过滤 + 截断 + 空结果也要说人话 */
function renderList(items, limit, filter) {
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (filter && !filter(items[i])) {
      dropped += 1;
      continue;
    }
    kept.push(items[i]);
  }
  const sliced = kept.slice(0, Math.min(MAX_LIST, Math.max(1, Number(limit) || MAX_LIST)));
  if (sliced.length === 0) {
    return '没有符合条件的视频' + (dropped > 0 ? '（过滤掉 ' + dropped + ' 条：播放量太低或发布太早）' : '') + '。';
  }
  const lines = sliced.map(function (item, index) { return oneLine(index, item); });
  if (dropped > 0) lines.push('（已过滤 ' + dropped + ' 条不符合硬条件的）');
  return lines.join('\n');
}

/**
 * 子代理专用的 5 个只读工具。
 * filterSeen 把"已经推荐过的"提前剔掉，避免每轮重复花 token 读同一条。
 */
function createBiliTools(api, options) {
  const opts = options || {};
  const defaults = {
    minPlays: Number(opts.minPlays) > 0 ? Number(opts.minPlays) : 0,
    maxDaysOld: Number(opts.maxDaysOld) > 0 ? Number(opts.maxDaysOld) : 0,
  };
  const filterSeen = typeof opts.filterSeen === 'function' ? opts.filterSeen : null;
  const isNewNotified = typeof opts.isNewNotified === 'function' ? opts.isNewNotified : null;

  function accept(item, args) {
    const minPlays = Number(args && args.minPlays) > 0 ? Number(args.minPlays) : defaults.minPlays;
    const maxDays = Number(args && args.maxDaysOld) > 0 ? Number(args.maxDaysOld) : defaults.maxDaysOld;
    if (filterSeen && filterSeen(item.bvid)) return false;
    if (minPlays > 0 && item.play < minPlays) return false;
    if (maxDays > 0 && item.days >= 0 && item.days > maxDays) return false;
    return true;
  }

  // ===== 主人数据源与互动工具（#2/#3/#4）=====

  const interact = opts.interact && typeof opts.interact === 'object' ? opts.interact : {};
  const interactEnabled = interact.enabled === true;
  const budget = typeof opts.budget === 'object' && opts.budget ? opts.budget : null;
  const masterMid = String(opts.masterMid || '').trim();

  function masterTag(mid) {
    const value = String(mid || '');
    return masterMid !== '' && value === masterMid ? '（主人）' : '';
  }

  const TYPE_NAMES = {
    likes: '点赞',
    coins: '投币',
    favorites: '收藏',
    replies: '回复',
  };

  /** 写工具的统一闸门：额度不够就给人话，绝不让模型白试一次接口 */
  async function runWrite(type, cost, info, action) {
    if (!interactEnabled) return '互动功能没开（features.bili.interact.enabled=false），跳过。';
    if (!budget) return '额度服务没接上，跳过这次互动。';
    if (budget.remaining(type) < cost) return '今天' + TYPE_NAMES[type] + '的额度用完了，这次没做。';
    let result;
    try {
      result = await action();
    } catch (err) {
      return '没做成（' + (err && err.message ? err.message : err) + '）。别重试，换下一条。';
    }
    budget.record(type, cost, info);
    return typeof result === 'string' ? result : '成了';
  }

  return [
    {
      name: 'bili_popular',
      description: '拉 B站 当前热门视频列表（标题/BV/UP/播放量/发布天数）。适合"没想好搜什么"的时候先看一眼大盘。',
      parameters: {
        type: 'object',
        properties: {
          ps: { type: 'number', description: '要几条，默认 20，最多 20' },
          minPlays: { type: 'number', description: '可选的播放量下限，低于它的直接丢掉' },
        },
      },
      execute: async function (args) {
        const list = await api.popular({ ps: Math.min(MAX_LIST, Number(args.ps) || 20) });
        return renderList(list, MAX_LIST, function (item) { return accept(item, args); });
      },
    },
    {
      name: 'bili_search',
      description: '按关键词搜索 B站 视频，默认按发布时间倒序。适合按主人的兴趣定向找。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词，2~10 个字效果最好' },
          ps: { type: 'number', description: '要几条，默认 20，最多 20' },
          order: { type: 'string', description: '排序：pubdate（最新，默认）/ totalrank（综合）/ dm（弹幕多）' },
          maxDaysOld: { type: 'number', description: '可选的发布天数上限' },
        },
        required: ['keyword'],
      },
      execute: async function (args) {
        const list = await api.search({
          keyword: String(args.keyword || '').trim(),
          ps: Math.min(MAX_LIST, Number(args.ps) || 20),
          order: String(args.order || 'pubdate'),
        });
        return renderList(list, MAX_LIST, function (item) { return accept(item, args); });
      },
    },
    {
      name: 'bili_video',
      description: '看一条视频的详情和简介全文（标题、UP、播放、点赞、发布天数、简介）。挑中之前用它补背景。',
      parameters: {
        type: 'object',
        properties: { bvid: { type: 'string', description: 'BV 号，例如 BV1xx411c7mD' } },
        required: ['bvid'],
      },
      execute: async function (args) {
        const bvid = assertBvid(args.bvid);
        const info = await api.video({ bvid: bvid });
        const lines = [
          info.bvid + ' | ' + info.title,
          'UP：' + (info.author || '未知') + ' ｜ 分区：' + (info.typename || '未知'),
          '播放：' + formatCount(info.play) + ' ｜ 点赞：' + formatCount(info.like) + ' ｜ 发布：' + daysText(info.days),
          '链接：https://www.bilibili.com/video/' + info.bvid,
          '简介：' + (info.desc || '（没有简介）'),
        ];
        return lines.join('\n');
      },
    },
    {
      name: 'bili_subtitle',
      description: '拉一条视频的字幕全文。没有字幕（无语音/UP 没传/AI 字幕要登录）会明确说"没有字幕"，这就是结果，别重试。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          cid: { type: 'number', description: '可选的分 P cid，不填会自动查' },
        },
        required: ['bvid'],
      },
      execute: async function (args) {
        const bvid = assertBvid(args.bvid);
        const result = await api.subtitle({ bvid: bvid, cid: args.cid });
        if (result.empty) return bvid + ' 没有字幕：' + result.reason + '（按跳过处理，换下一条）';
        return '【' + bvid + ' 字幕（' + (result.lan || '未知语言') + '，' + result.count + ' 行）】\n' + result.text;
      },
    },
    {
      name: 'bili_comments',
      description: '拉一条视频的热门评论前几条，用来看观众反应（不是拿来做创作素材）。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          ps: { type: 'number', description: '要几条，默认 8，最多 20' },
        },
        required: ['bvid'],
      },
      execute: async function (args) {
        const bvid = assertBvid(args.bvid);
        const list = await api.comments({ bvid: bvid, ps: Number(args.ps) || 8 });
        if (list.length === 0) return '这条视频还没有评论。';
        return list.map(function (item, index) {
          return (index + 1) + '. ' + (item.author || '匿名') + '（' + formatCount(item.like) + ' 赞）：' + item.content;
        }).join('\n');
      },
    },

    // ---- 主人的兴趣（#2）----

    {
      name: 'bili_master_follows',
      description: '看主人（' + (masterMid || '主人') + '）关注的 UP 列表。想顺着主人的口味找内容时先看这个。',
      parameters: {
        type: 'object',
        properties: {
          ps: { type: 'number', description: '要几条，默认 20，最多 50' },
        },
      },
      execute: async function (args) {
        const list = await api.followings({ vmid: masterMid, ps: Math.min(50, Number(args.ps) || 20) });
        if (list.length === 0) return '看不到主人的关注列表（可能设了隐私，或还没关注任何人）。';
        return list.map(function (item, index) {
          return (index + 1) + '. ' + (item.uname || '未知') + masterTag(item.mid) + (item.sign ? '：' + item.sign : '');
        }).join('\n');
      },
    },
    {
      name: 'bili_master_feed',
      description: '看主人最近的公开动态里出现的视频（他转发/投过/提过的）。这是了解主人最近在看什么的最直接窗口。',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async function () {
        const list = await api.masterDynamics({ vmid: masterMid });
        if (list.length === 0) return '主人最近的动态里没有可见的视频（可能设了隐私）。';
        return list.map(function (item, index) {
          return (index + 1) + '. ' + item.bvid + ' | ' + item.title +
            ' | UP：' + (item.author || '未知') +
            ' | ' + (item.pubtext || '') + (item.desc ? '\n   动态说：' + item.desc : '');
        }).join('\n');
      },
    },

    // ---- 通知（#4）----

    {
      name: 'bili_check_replies',
      description: '查「回复我的」通知：谁回复了我们的评论。主人的留言会标出来。这轮里新出现的要处理。',
      parameters: {
        type: 'object',
        properties: {},
      },
      execute: async function () {
        const list = await api.msgfeedReplies({ ps: 10 });
        if (list.length === 0) return '还没有人回复过我们的评论。';
        return list.map(function (item, index) {
          const isNew = isNewNotified && isNewNotified(item.id) ? '【新】' : '';
          const root = item.rootRpid > 0 ? '（回复我们：' + item.rootText + '）' : '';
          const where = item.subjectType === 12 ? ' ｜ 文章oid=' + item.oid + ' type=12' : ' ｜ 视频：' + (item.subjectTitle || '') + ' ｜ oid=' + item.oid;
          return (index + 1) + '. ' + isNew + item.fromName + masterTag(item.fromMid) + '：' + item.text +
            where +
            (item.rootRpid > 0 ? ' ｜ root_rpid=' + item.rootRpid : '') +
            (item.replyRpid > 0 ? ' ｜ reply_rpid=' + item.replyRpid : '') + root;
        }).join('\n');
      },
    },

    // ---- 互动写操作（#3）----

    {
      name: 'bili_like',
      description: '给视频点赞。真看完了觉得好才点，一轮最多点几条由额度管着。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          reason: { type: 'string', description: '一句话：为什么值得点' },
        },
        required: ['bvid', 'reason'],
      },
      execute: async function (args) {
        const bvid = assertBvid(args.bvid);
        return runWrite('likes', 1, { bvid: bvid, detail: '点赞：' + args.reason }, async function () {
          await api.likeVideo({ bvid: bvid });
          return bvid + ' 点赞成功';
        });
      },
    },
    {
      name: 'bili_coin',
      description: '给视频投币。掷色子决定投 1 枚还是 2 枚（默认 1）；一天最多投 2 枚，省着用。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          multiply: { type: 'number', description: '1 或 2 枚，掷色子定' },
          reason: { type: 'string', description: '一句话：为什么值得投' },
        },
        required: ['bvid', 'reason'],
      },
      execute: async function (args) {
        const bvid = assertBvid(args.bvid);
        const multiply = Number(args.multiply) === 2 ? 2 : 1;
        if (!interactEnabled) return '互动功能没开，跳过。';
        if (!budget) return '额度服务没接上，跳过这次互动。';
        if (budget.remaining('coins') < multiply) return '今天硬币额度不够了（剩 ' + budget.remaining('coins') + ' 枚），这次没投。';
        try {
          await api.coin({ bvid: bvid, multiply: multiply });
          budget.record('coins', multiply, { bvid: bvid, detail: '投币' + multiply + '枚：' + args.reason });
          return bvid + ' 投币 ' + multiply + ' 枚成功';
        } catch (err) {
          return '没投出去（' + (err && err.message ? err.message : err) + '）。别重试。';
        }
      },
    },
    {
      name: 'bili_fav',
      description: '收藏视频进默认收藏夹。值得回头再看才收。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          reason: { type: 'string', description: '一句话：为什么值得收藏' },
        },
        required: ['bvid', 'reason'],
      },
      execute: async function (args) {
        const bvid = assertBvid(args.bvid);
        return runWrite('favorites', 1, { bvid: bvid, detail: '收藏：' + args.reason }, async function () {
          await api.favorite({ bvid: bvid });
          return bvid + ' 收藏成功';
        });
      },
    },
    {
      name: 'bili_triple',
      description: '一键三连（点赞+投币+收藏）。只在真心强烈推荐时用，会一次用掉三种额度和 2 枚硬币。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号' },
          reason: { type: 'string', description: '一句话：为什么值得三连' },
        },
        required: ['bvid', 'reason'],
      },
      execute: async function (args) {
        const bvid = assertBvid(args.bvid);
        if (!interactEnabled) return '互动功能没开，跳过。';
        if (!budget) return '额度服务没接上，跳过这次互动。';
        if (budget.remaining('likes') < 1 || budget.remaining('favorites') < 1 || budget.remaining('coins') < 2) {
          return '三连额度不够（点赞剩 ' + budget.remaining('likes') + '、硬币剩 ' + budget.remaining('coins') + '、收藏剩 ' + budget.remaining('favorites') + '），退而求其次单独点赞就行。';
        }
        try {
          await api.triple({ bvid: bvid });
          budget.record('likes', 1, { bvid: bvid, detail: '三连·点赞：' + args.reason });
          budget.record('coins', 2, { bvid: bvid, detail: '三连·投币：' + args.reason });
          budget.record('favorites', 1, { bvid: bvid, detail: '三连·收藏：' + args.reason });
          return bvid + ' 三连成功（点赞+投币+收藏）';
        } catch (err) {
          return '没三连成（' + (err && err.message ? err.message : err) + '）。可以退而求其次只点赞。';
        }
      },
    },
    {
      name: 'bili_comment',
      description: '在视频下面发评论（用小鲸的口吻，短句），或楼中楼回复某条评论。给 UP 留言、回应网友、跟主人打招呼都用它。',
      parameters: {
        type: 'object',
        properties: {
          bvid: { type: 'string', description: 'BV 号（视频评论时填这个）' },
          aid: { type: 'number', description: '视频的 aid；只有通知里给 oid 没有 bvid 时用它' },
          oid: { type: 'number', description: '文章评论时填这个（通知里 type=12 的 oid，即 cv 号）' },
          type: { type: 'number', description: '评论区类型：1=视频（默认），12=专栏文章（通知里 type=12 时必须传 12）' },
          message: { type: 'string', description: '评论内容，小鲸的口吻，一两句话' },
          rootRpid: { type: 'number', description: '楼中楼时填楼层的根 rpid（通知行里的 root_rpid），直接评论就别填' },
          parentRpid: { type: 'number', description: '楼中楼里回复某条具体评论时填对方的 rpid（通知行里的 reply_rpid）；不填=回复楼层根' },
          atName: { type: 'string', description: '楼中楼回复某人时填对方昵称（通知行里的名字，回谁写谁），工具会自动加「回复 @昵称 : 」前缀让对方收到通知' },
        },
        required: ['message'],
      },
      execute: async function (args) {
        let message = String(args.message || '').trim();
        if (message === '') return '评论内容是空的，没发。';
        // B站楼中楼格式：回复谁就带谁的前缀，对方才收得到通知。名字来自通知数据，回谁写谁
        const atName = String(args.atName || '').trim();
        if (Number(args.parentRpid) > 0 && atName !== '' && message.indexOf('回复 @') !== 0) {
          message = '回复 @' + atName + ' : ' + message;
        }
        const hasBvid = /^BV[0-9A-Za-z]{10}$/.test(String(args.bvid || '').trim());
        const type = Number(args.type) === 12 ? 12 : 1;
        const oid = Number(args.oid) || 0;
        const aid = Number(args.aid) || 0;
        if (!hasBvid && !aid && !oid) return 'bvid/aid/oid 都没有，发不出去。';
        const key = hasBvid ? String(args.bvid).trim() : (type === 12 ? 'cv:' + oid : 'aid:' + aid);
        return runWrite('replies', 1, { bvid: key, detail: '评论：' + message }, async function () {
          const replyArgs = { message: message, rootRpid: Number(args.rootRpid) || 0, parentRpid: Number(args.parentRpid) || 0 };
          let result;
          if (hasBvid) result = await api.reply(Object.assign({ bvid: String(args.bvid).trim() }, replyArgs));
          else if (type === 12) result = await api.reply(Object.assign({ oid: oid, type: 12 }, replyArgs));
          else result = await api.reply(Object.assign({ aid: aid }, replyArgs));
          return (Number(args.rootRpid) > 0 ? '楼中楼回复' : '评论') + '发送成功（rpid=' + result.rpid + '）：' + message;
        });
      },
    },
    {
      name: 'bili_like_comment',
      description: '给一条评论点赞（比如主人的留言）。需要 oid 和 rpid。',
      parameters: {
        type: 'object',
        properties: {
          oid: { type: 'number', description: '评论区 oid（视频是 aid，文章是 cv 号）' },
          rpid: { type: 'number', description: '评论的 rpid' },
          type: { type: 'number', description: '1=视频（默认），12=专栏文章' },
        },
        required: ['oid', 'rpid'],
      },
      execute: async function (args) {
        const oid = Number(args.oid) || 0;
        const rpid = Number(args.rpid) || 0;
        if (!oid || !rpid) return 'oid/rpid 不对，没点。';
        return runWrite('likes', 1, { bvid: String(rpid), detail: '给评论点赞 oid=' + oid }, async function () {
          await api.likeComment({ oid: oid, rpid: rpid, type: Number(args.type) === 12 ? 12 : 1 });
          return '评论点赞成功（rpid=' + rpid + '）';
        });
      },
    },
  ];
}

module.exports = {
  createBiliTools: createBiliTools,
  formatCount: formatCount,
  daysText: daysText,
  renderList: renderList,
};
