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

  function accept(item, args) {
    const minPlays = Number(args && args.minPlays) > 0 ? Number(args.minPlays) : defaults.minPlays;
    const maxDays = Number(args && args.maxDaysOld) > 0 ? Number(args.maxDaysOld) : defaults.maxDaysOld;
    if (filterSeen && filterSeen(item.bvid)) return false;
    if (minPlays > 0 && item.play < minPlays) return false;
    if (maxDays > 0 && item.days >= 0 && item.days > maxDays) return false;
    return true;
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
  ];
}

module.exports = {
  createBiliTools: createBiliTools,
  formatCount: formatCount,
  daysText: daysText,
  renderList: renderList,
};
