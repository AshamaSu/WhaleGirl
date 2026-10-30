'use strict';

const { createBiliClient } = require('./vendor/client');
const { createBiliApi } = require('./vendor/api');
const { createBiliTools } = require('./vendor/tools');
const { createBiliStore } = require('./store');
const { runBiliRound, runReplyCheckRound } = require('./runner');
const { shouldAutoRun, shouldCheckReplies, parseWindow } = require('./schedule');
const configEdit = require('../../config-edit');
const { buildAnnounceMessages, splitBubbles } = require('./runner');
const { createBiliHttp } = require('./http');

/** 能力配置段：与宿主「未声明=关闭」语义一致，但不再依赖宿主 settings */
function featureSection(config) {
  const features = config && config.features;
  const section = features && features.bili;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : null;
}

/** 参数面板的参数定义（插件自己提供，面板按它渲染与校验） */
const PARAM_SPECS = [
  { key: 'owner', type: 'string', label: '对主人的称呼', default: '主人' },
  { key: 'intervalMinutes', type: 'number', label: '自动轮间隔（分钟）', min: 30, max: 1440, default: 180, desc: '两次自动浏览的最小间隔；手动触发不受限' },
  { key: 'dailyQuota', type: 'number', label: '每日自动轮数上限', min: 0, max: 20, default: 4, desc: '手动轮不计入；0 = 只手动' },
  { key: 'activeWindows', type: 'strings', label: '活跃时段', default: ['12:00-14:00', '18:00-09:00'], desc: '每行一个 HH:MM-HH:MM，可跨夜；留空 = 全天' },
  { key: 'weekendAllDay', type: 'boolean', label: '周末全天可跑', default: true, desc: '周末不受活跃时段限制' },
  { key: 'keywords', type: 'strings', label: '兴趣关键词', default: [], desc: '留空 = 按大众口味挑' },
  { key: 'itemsPerRound', type: 'number', label: '每轮挑几条', min: 1, max: 10, default: 3, desc: '' },
  { key: 'minPlays', type: 'number', label: '候选最低播放量', min: 0, max: 100000000, default: 5000, desc: '' },
  { key: 'maxDaysOld', type: 'number', label: '只看几天内发布', min: 0, max: 365, default: 14, desc: '' },
  { key: 'maxRounds', type: 'number', label: '子代理工具轮次上限', min: 1, max: 16, default: 8, desc: '防跑飞烧 token' },
  { key: 'announce', type: 'boolean', label: '推出口吻播报', default: true, desc: 'false 只落报告' },
  { key: 'replyCheckIntervalMinutes', type: 'number', label: '查回复间隔（分钟）', min: 5, max: 1440, default: 30, desc: '' },
  { key: 'interact.enabled', type: 'boolean', label: '允许互动（写操作）', default: false, desc: '点赞/投币/收藏/评论的总开关' },
  { key: 'interact.maxLikes', type: 'number', label: '每日点赞上限', min: 0, max: 50, default: 10, desc: '' },
  { key: 'interact.maxCoins', type: 'number', label: '每日投币上限（枚）', min: 0, max: 10, default: 2, desc: '' },
  { key: 'interact.maxFavorites', type: 'number', label: '每日收藏上限', min: 0, max: 20, default: 3, desc: '' },
  { key: 'interact.maxReplies', type: 'number', label: '每日评论/回复上限', min: 0, max: 50, default: 5, desc: '' },
  { key: 'interact.maxDynamics', type: 'number', label: '每日发动态上限', min: 0, max: 10, default: 2, desc: '成长记录/碎碎念' },
  { key: 'interact.maxFollows', type: 'number', label: '每日关注/取关上限', min: 0, max: 20, default: 5, desc: '网页端朋友管理也计入；0 = 禁用' },
];

const SPEC_MAP = {};
for (const spec of PARAM_SPECS) SPEC_MAP[spec.key] = spec;

/** 单个参数值校验；返回错误文案或 null */
function validateSpec(spec, value) {
  if (spec.type === 'boolean') return typeof value === 'boolean' ? null : '必须是 true/false';
  if (spec.type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) return '必须是数字';
    if (spec.min !== undefined && num < spec.min) return '不能小于 ' + spec.min;
    if (spec.max !== undefined && num > spec.max) return '不能大于 ' + spec.max;
    return null;
  }
  if (spec.type === 'string') return typeof value === 'string' && value.trim() !== '' ? null : '必须是非空字符串';
  if (spec.type === 'strings') {
    if (!Array.isArray(value)) return '必须是字符串数组';
    for (const item of value) {
      if (typeof item !== 'string' || item.trim() === '') return '数组里每项都必须是非空字符串';
    }
    return null;
  }
  return '未知类型';
}

/**
 * 参数面板写入口：校验 patch → 合并到当前段 → 保注释写回 config.json。
 * 返回 { ok, applied } 或 { ok: false, errors: [...] }。
 */
function applyBiliParams(root, currentRaw, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['请求体必须是对象'] };
  // 契约兼容：面板可能发嵌套对象（{interact:{maxLikes:3}}）也可能发点路径（{'interact.maxLikes':3}），统一摊平成点路径
  const flat = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value)) flat[key + '.' + subKey] = subValue;
    } else flat[key] = value;
  }
  const errors = [];
  const clean = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key === 'enabled') {
      if (typeof value !== 'boolean') { errors.push('enabled 必须是 true/false'); continue; }
      clean.enabled = value;
      continue;
    }
    const spec = SPEC_MAP[key];
    if (!spec) { errors.push('未知参数：' + key); continue; }
    const err = validateSpec(spec, value);
    if (err) { errors.push(spec.label + '：' + err); continue; }
    if (key === 'activeWindows') {
      const bad = value.filter(function (item) { return parseWindow(item) === null; });
      if (bad.length > 0) { errors.push('时段格式应为 HH:MM-HH:MM：' + bad.join('、')); continue; }
    }
    clean[key] = spec.type === 'number' ? Number(value) : value;
  }
  if (errors.length > 0) return { ok: false, errors: errors };
  const writePatch = Object.assign({}, currentRaw);
  for (const [key, value] of Object.entries(clean)) {
    if (key === 'enabled') { writePatch.enabled = value; continue; }
    const parts = key.split('.');
    if (parts.length === 1) writePatch[key] = value;
    else {
      const sub = Object.assign({}, writePatch[parts[0]] || {});
      sub[parts[1]] = value;
      writePatch[parts[0]] = sub;
    }
  }
  const result = configEdit.patchFeatureSection(root, 'bili', writePatch);
  if (!result.ok) return { ok: false, errors: [result.error] };
  return { ok: true, applied: result.applied };
}

const TICK_MS = 60 * 1000;
const DEFAULT_INTERVAL_MINUTES = 180;
const DEFAULT_QUOTA = 4;
const DEFAULT_ITEMS = 3;
const DEFAULT_MIN_PLAYS = 5000;
const DEFAULT_MAX_DAYS = 14;
const DEFAULT_WINDOWS = ['12:00-14:00', '18:00-09:00'];
const MAX_ANNOUNCE_BUBBLES = 3;

function num(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** 配置只覆盖显式写了的键，其余走默认值；写错的时段留给 schedule 忽略 */
function normalizeSection(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const windows = Array.isArray(src.activeWindows)
    ? src.activeWindows.filter(function (item) { return typeof item === 'string' && item.trim() !== ''; })
    : DEFAULT_WINDOWS.slice();
  const keywords = Array.isArray(src.keywords)
    ? src.keywords.map(function (item) { return String(item || '').trim(); }).filter(Boolean)
    : [];

  return {
    owner: String(src.owner || '主人').trim() || '主人',
    intervalMinutes: src.intervalMinutes === undefined ? DEFAULT_INTERVAL_MINUTES : num(src.intervalMinutes, DEFAULT_INTERVAL_MINUTES),
    dailyQuota: src.dailyQuota === undefined ? DEFAULT_QUOTA : Math.max(0, num(src.dailyQuota, DEFAULT_QUOTA)),
    activeWindows: windows,
    weekendAllDay: src.weekendAllDay !== false,
    keywords: keywords,
    itemsPerRound: src.itemsPerRound === undefined ? DEFAULT_ITEMS : Math.max(1, num(src.itemsPerRound, DEFAULT_ITEMS)),
    minPlays: src.minPlays === undefined ? DEFAULT_MIN_PLAYS : Math.max(0, num(src.minPlays, DEFAULT_MIN_PLAYS)),
    maxDaysOld: src.maxDaysOld === undefined ? DEFAULT_MAX_DAYS : Math.max(0, num(src.maxDaysOld, DEFAULT_MAX_DAYS)),
    maxRounds: src.maxRounds === undefined ? 8 : Math.max(1, num(src.maxRounds, 8)),
    announce: src.announce !== false,
    dutyFile: String(src.dutyFile || '').trim(),
    requestIntervalMs: num(src.requestIntervalMs, 2000),
    timeoutMs: num(src.timeoutMs, 0),
    replyCheckIntervalMinutes: num(src.replyCheckIntervalMinutes, 30),
    interact: normalizeInteract(src.interact),
  };
}

/** 互动段（#3）：enabled 默认关——写操作必须显式打开，防手滑 */
function normalizeInteract(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled === true,
    maxLikes: Math.max(0, num(src.maxLikes, 10)),
    maxCoins: Math.max(0, num(src.maxCoins, 2)),
    maxFavorites: Math.max(0, num(src.maxFavorites, 3)),
    maxReplies: Math.max(0, num(src.maxReplies, 5)),
    maxDynamics: Math.max(0, num(src.maxDynamics, 2)),
    maxFollows: Math.max(0, num(src.maxFollows, 5)),
  };
}

/**
 * A4：对话查询她的B站动态。聚合本地留存（浏览历史/关注名单/互动日志），
 * 只读、纯本地文件，不发起网络请求；输出压到 ~800 字内供主对话直接引用。
 */
const RECALL_MAX_CHARS = 800;

function recallReport(store, args) {
  const topic = String((args && args.topic) || 'summary');
  const keyword = String((args && args.keyword) || '').trim();
  const days = Number(args && args.days) > 0 ? Math.min(90, Number(args.days)) : 7;
  const match = function (text) { return keyword === '' || String(text == null ? '' : text).indexOf(keyword) !== -1; };
  const sections = [];

  if (topic === 'browse' || topic === 'summary') {
    let items = [];
    try { items = store.recentHistory(50, days) || []; } catch (err) { items = []; }
    items = items.filter(function (item) { return match(item.title) || match(item.up); });
    if (items.length === 0) {
      sections.push('浏览：最近 ' + days + ' 天没有看过' + (keyword ? '含「' + keyword + '」的' : '') + '视频');
    } else {
      const lines = items.slice(0, 10).map(function (item) {
        const day = String(item.date || '').slice(5);
        return '- ' + (day ? day + ' ' : '') + '《' + (item.title || item.bvid) + '》' + (item.up ? '（UP：' + item.up + '）' : '');
      });
      sections.push('浏览（最近 ' + days + ' 天共 ' + items.length + ' 条' + (items.length > 10 ? '，取最近 10 条' : '') + '）：\n' + lines.join('\n'));
    }
  }

  if (topic === 'follows' || topic === 'summary') {
    let list = [];
    try { list = store.getFollows() || []; } catch (err) { list = []; }
    list = list.filter(function (item) { return match(item.uname) || match(item.remark); });
    if (list.length === 0) {
      sections.push('关注：名单是空的');
    } else {
      const lines = list.map(function (item) {
        return '- ' + (item.uname || item.mid) + (item.remark ? '（备注：' + item.remark + '）' : '') + (item.special ? '［特别关注］' : '');
      });
      sections.push('关注的朋友：\n' + lines.join('\n'));
    }
  }

  if (topic === 'replies' || topic === 'summary') {
    let log = [];
    try { log = store.interactLog(50) || []; } catch (err) { log = []; }
    const typeNames = { replies: '评论', dynamics: '动态', follows: '关注' };
    const mine = log.filter(function (entry) {
      return (entry.type === 'replies' || entry.type === 'dynamics' || entry.type === 'follows') && match(entry.detail);
    });
    if (mine.length === 0) {
      sections.push('互动：最近没发过评论/回复/动态');
    } else {
      const lines = mine.slice(0, 10).map(function (entry) {
        return '- ' + String(entry.at || '').slice(5, 10) + ' [' + (typeNames[entry.type] || entry.type) + '] ' + (entry.detail || '');
      });
      sections.push('互动记录（取最近 ' + lines.length + ' 条）：\n' + lines.join('\n'));
    }
  }

  if (sections.length === 0) sections.push('没查到相关记录');
  return sections.join('\n\n').slice(0, RECALL_MAX_CHARS);
}

const HISTORY_PROMPT_LIMIT = 5;
const HISTORY_PROMPT_DAYS = 7;

/** 拼给主对话的「最近看过」片段；没有历史就返回空串（feature 宿主会跳过空片段） */
function historyPrompt(store) {
  if (!store || typeof store.recentHistory !== 'function') return '';
  let items = [];
  try {
    items = store.recentHistory(HISTORY_PROMPT_LIMIT, HISTORY_PROMPT_DAYS);
  } catch (err) {
    return '';
  }
  if (!items || items.length === 0) return '';
  const lines = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] || {};
    const day = String(item.date || '').slice(5);
    const up = item.up ? '（UP：' + item.up + '）' : '';
    lines.push('- ' + (day ? day + ' ' : '') + '《' + (item.title || item.bvid) + '》' + up + ' ' + (item.link || ''));
  }
  return [
    '【你最近在 B 站看过的东西（主人问起时照这个说，没看过的不许编）】',
  ].concat(lines).join('\n');
}

/**
 * 能力模块：B站 子代理（config.features.bili）。
 *
 * 三段链路互相独立，任一段挂掉都不影响聊天：
 *   定时器 -> 子代理（只产出客观报告）-> 小鲸播报（事件总线推送）
 */
function createBiliModule(options) {
  const opts = options || {};

  return {
    name: 'bili',
    enabled: function (config) {
      const section = featureSection(config);
      return !!(section && section.enabled === true);
    },

    init: function (ctx) {
      const config = ctx.getConfig();
      const section = normalizeSection(featureSection(config));
      const logger = ctx.logger || console;
      const clock = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };

      const store = opts.store || createBiliStore({
        root: ctx.dataRoot,
        now: clock,
        onWarn: function (msg) { logger.warn('[bili] ' + msg); },
      });

      const client = opts.client || createBiliClient({
        // .env 里的 B站 cookie 要经 ctx.getEnv 拿：server 不会把它们写进 process.env
        env: typeof ctx.getEnv === 'function' ? ctx.getEnv() : process.env,
        logger: logger,
        intervalMs: section.requestIntervalMs,
        timeoutMs: section.timeoutMs > 0 ? section.timeoutMs : undefined,
        now: clock,
      });
      const api = opts.api || createBiliApi(client, { now: clock });
      // 互动额度（#3）：包一层，模型侧只问"还剩几次"
      const budget = {
        remaining: function (type) {
          const snapshot = store.interactBudget(section.interact);
          return snapshot[type] ? snapshot[type].left : 0;
        },
        record: function (type, cost, info) {
          for (let i = 0; i < Math.max(1, cost); i += 1) store.recordInteract(type, info);
        },
      };

      const tools = opts.tools || createBiliTools(api, {
        minPlays: section.minPlays,
        maxDaysOld: section.maxDaysOld,
        filterSeen: store.hasSeen,
        interact: section.interact,
        budget: budget,
        masterMid: typeof client.mid === 'function' ? client.mid() : '',
        isNewNotified: store.hasNotified,
      });

      let timer = null;
      let replyTimer = null;
      let running = false;
      let lastResult = null;

      function llmText() {
        try {
          return ctx.makeLlm();
        } catch (err) {
          logger.warn('[bili] 拿不到模型：' + (err && err.message ? err.message : err));
          return null;
        }
      }

      /** 子代理循环由宿主提供，插件不接触 provider */
      function buildAgent() {
        if (typeof ctx.makeAgent !== 'function') throw new Error('宿主没有 makeAgent');
        const run = ctx.makeAgent({ tools: tools });
        return function (options) {
          return run(options.messages, {
            maxRounds: options.maxRounds,
            temperature: options.temperature,
            timeoutMs: options.timeoutMs,
          });
        };
      }

      /** 播报：报告进主娘的眼睛，出来的是她自己的话；失败只丢这一环 */
      async function announce(result) {
        if (section.announce === false) return [];
        const picked = Array.isArray(result.picked) ? result.picked.length : 0;
        if (picked === 0) return [];

        const llm = llmText();
        if (typeof llm !== 'function') return [];

        try {
          if (!ctx.persona || typeof ctx.persona.compose !== 'function') {
            throw new Error('宿主没有 persona.compose');
          }
          const composed = ctx.persona.compose('', { history: false, memory: false, features: false });
          const bubbles = splitBubbles(
            await llm({
              messages: buildAnnounceMessages(composed.messages, result.report),
              temperature: 0.9,
            }),
            Math.min(MAX_ANNOUNCE_BUBBLES, (composed.reply && composed.reply.maxBubbles) || MAX_ANNOUNCE_BUBBLES)
          );
          const roundId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          for (let i = 0; i < bubbles.length; i += 1) {
            ctx.pushText(bubbles[i], { kind: 'broadcast', source: 'bili', roundId: roundId });
          }
          logger.log('[bili] 已播报 ' + bubbles.length + ' 条');
          return bubbles;
        } catch (err) {
          logger.warn('[bili] 播报失败：' + (err && err.message ? err.message : err));
          return [];
        }
      }

      /** 参数热生效：每轮/每次取用前按最新 config 重归一（对象原位更新，闭包引用不失效） */
      function syncSection() {
        const fresh = normalizeSection(featureSection(ctx.getConfig()));
        for (const key of Object.keys(fresh)) {
          if (key === 'interact') Object.assign(section.interact, fresh.interact);
          else section[key] = fresh[key];
        }
      }

      async function runOnce(trigger) {
        if (running) return { ok: false, error: '上一轮还在跑', skipped: true };
        running = true;
        syncSection();
        try {
          const live = ctx.getConfig();
          const runAgent = typeof opts.runAgent === 'function' ? opts.runAgent : buildAgent();
          // 主人的 B站 昵称：浏览轮里想@主人时用；拿不到就传提示语，章程里自己绕开
          const masterMid = typeof client.mid === 'function' ? client.mid() : '';
          let ownerBiliName = '';
          if (masterMid !== '' && typeof api.masterNickname === 'function') {
            ownerBiliName = await api.masterNickname({ vmid: masterMid }).catch(function () { return ''; });
          }
          const result = await runBiliRound({
            root: ctx.root,
            store: store,
            section: section,
            tools: tools,
            trigger: trigger === 'auto' ? 'auto' : 'manual',
            logger: logger,
            now: clock,
            runAgent: runAgent,
            ownerBiliName: ownerBiliName,
            fetchSpecialVideos: fetchSpecialVideosText,
            timeoutMs: live.requestTimeoutMs,
          });
          lastResult = result;
          if (result.ok && Array.isArray(result.items) && result.items.length > 0) {
            store.appendHistory(result.items, { at: result.at, trigger: result.trigger });
            // A3：概念总结进宿主记忆事实层（source=bili，随标准 factDecay 衰减遗忘）。
            // 每轮最多 1 条，轮数受 dailyQuota 限制，天然不会刷爆事实容量。
            if (typeof ctx.addMemoryFact === 'function') {
              try {
                const titles = result.items.slice(0, 3).map(function (item) { return '《' + (item.title || item.bvid) + '》'; }).join('');
                ctx.addMemoryFact('今天在B站看了' + titles + (result.items.length > 3 ? ' 等 ' + result.items.length + ' 条' : ''), 'bili');
              } catch (err) {
                logger.warn('[bili] 概念总结落记忆失败：' + (err && err.message ? err.message : err));
              }
            }
          }
          if (result.ok) {
            result.bubbles = await announce(result);
          }
          return result;
        } catch (err) {
          // runBiliRound 自己不抛；这里防的是装配层意外（比如 provider 没配）
          const message = err && err.message ? err.message : String(err);
          logger.warn('[bili] 这一轮没能跑起来：' + message);
          lastResult = { ok: false, error: message, picked: [] };
          return lastResult;
        } finally {
          running = false;
        }
      }

      function tick() {
        syncSection();
        if (running) return;
        const gate = shouldAutoRun({ state: store.state(), section: section, now: clock() });
        if (!gate.run) return;
        logger.log('[bili] 自动触发：' + gate.reason);
        runOnce('auto').catch(function (err) {
          logger.warn('[bili] 自动一轮失败：' + (err && err.message ? err.message : err));
        });
      }

      /** 轻量查回复（#4）：不占浏览轮额度；没登录就不白跑 */
      let replyChecking = false;
      function tickReplies() {
        syncSection();
        if (running || replyChecking) return;
        if (client.hasLogin && !client.hasLogin()) return;
        const gate = shouldCheckReplies({ state: store.state(), section: section, now: clock() });
        if (!gate.run) return;
        logger.log('[bili] ' + gate.reason);
        replyChecking = true;
        const runAgent = typeof opts.runAgent === 'function' ? opts.runAgent : buildAgent();
        runReplyCheckRound({
          store: store,
          section: section,
          api: api,
          tools: tools,
          runAgent: runAgent,
          masterMid: typeof client.mid === 'function' ? client.mid() : '',
          logger: logger,
          now: clock,
          timeoutMs: ctx.getConfig().requestTimeoutMs,
        }).catch(function (err) {
          logger.warn('[bili] 查回复一轮失败：' + (err && err.message ? err.message : err));
        }).then(function () {
          replyChecking = false;
        });
      }

      /**
       * A2：特别关注 UP 的最新视频 → 章程优先候选文本。
       * 名单里没有特别关注就返回空串；单个 UP 失败只跳过该 UP。
       */
      async function fetchSpecialVideosText() {
        let list = [];
        try { list = store.getFollows().filter(function (item) { return item.special === true; }); } catch (err) { list = []; }
        if (list.length === 0) return '';
        const lines = [];
        const ups = list.slice(0, 10);
        for (let i = 0; i < ups.length; i += 1) {
          try {
            const videos = await api.spaceVideos({ mid: ups[i].mid, ps: 2 });
            videos.slice(0, 2).forEach(function (video) {
              lines.push('- 《' + video.title + '》 UP：' + (video.up || ups[i].uname || ups[i].mid) + ' ' + video.link + (video.play > 0 ? '（播放 ' + video.play + '）' : ''));
            });
          } catch (err) {
            logger.warn('[bili] 特别关注 UP ' + ups[i].mid + ' 最新视频抓取失败，跳过：' + (err && err.message ? err.message : err));
          }
        }
        return lines.join('\n');
      }

      // 扫「登录账号自己」的关注列表找目标 mid（最多 4 页 × 50 条）；没有 → null
      async function scanFollowings(mid) {
        // selfMid 来自 cookie 的 dedeUserId，最准；nav 没拉过时退化到配置的 WG_BILI_MID
        if (typeof client.ensureNav === 'function') {
          try { await client.ensureNav(); } catch (err) { /* 拉不到就用现有值 */ }
        }
        const vmid = Number((typeof client.selfMid === 'function' && client.selfMid()) || client.mid() || 0) || 0;
        if (!vmid) return null;
        for (let pn = 1; pn <= 4; pn += 1) {
          const list = await api.followings({ vmid: vmid, ps: 50, pn: pn });
          const hit = list.find(function (item) { return Number(item.mid) === Number(mid); });
          if (hit) return hit;
          if (list.length < 50) return null;
        }
        return null;
      }

      // 功能面（svc）：接口层（http.js）只认这个门面，摸不到内部状态
      const svc = {
        running: function () { return running; },
        rawSection: function () {
          syncSection();
          return featureSection(ctx.getConfig()) || {};
        },
        specs: function () { return PARAM_SPECS; },
        applyParams: function (patch) {
          const result = applyBiliParams(ctx.root, featureSection(ctx.getConfig()) || {}, patch);
          if (result.ok) syncSection();
          return result;
        },
        replying: function () { return replyChecking; },
        lastResult: function () {
          return lastResult ? { ok: lastResult.ok, trigger: lastResult.trigger, picked: lastResult.picked, error: lastResult.error, at: lastResult.at } : null;
        },
        section: function () { return section; },
        state: function () { return store.state(); },
        seenCount: function () { return store.seenLines(200).length; },
        interact: function () {
          return {
            section: section.interact,
            budget: store.interactBudget(section.interact),
            log: store.interactLog(20),
          };
        },
        login: function () { return client.hasLogin ? client.hasLogin() : false; },
        mid: function () { return typeof client.mid === 'function' ? client.mid() : ''; },
        replyCheckAt: function () { return store.state().lastReplyCheckAt || ''; },
        // —— 朋友管理（A1）：网页端提交即执行；特别关注组账号禁止取关 ——
        followsList: function () { return store.getFollows(); },
        follow: async function (mid, remark) {
          const id = Number(mid) || 0;
          if (id <= 0) return { ok: false, error: 'mid 不合法' };
          const budget = store.interactBudget(section.interact).follows;
          if (budget.left <= 0) {
            return { ok: false, error: '今天的关注额度用完了（' + budget.used + '/' + budget.limit + '），明天再来' };
          }
          const existing = await scanFollowings(id);
          if (existing) {
            store.addFollow({ mid: id, uname: existing.uname, remark: remark, special: existing.special });
            return { ok: false, error: '已经关注了「' + (existing.uname || id) + '」' };
          }
          await api.relationModify(id, 1);
          let entry = null;
          try { entry = await scanFollowings(id); } catch (err) { entry = null; }
          const record = store.addFollow({ mid: id, uname: entry ? entry.uname : '', remark: remark, special: entry ? entry.special : false });
          store.recordInteract('follows', { detail: '关注 ' + (record.uname || id) + (record.remark ? '（' + record.remark + '）' : '') });
          logger.log('[bili] 关注成功：' + id + (record.uname ? '（' + record.uname + '）' : ''));
          return { ok: true, follow: record };
        },
        unfollow: async function (mid) {
          const id = Number(mid) || 0;
          if (id <= 0) return { ok: false, error: 'mid 不合法' };
          const existing = await scanFollowings(id);
          if (!existing) {
            const removed = store.removeFollow(id);
            return { ok: removed ? true : false, error: removed ? 'B站那边本来就没关注了，名单已对账' : '本来就没有关注 ' + id, removed: removed };
          }
          if (existing.special) {
            return { ok: false, error: '「' + (existing.uname || id) + '」是特别关注，要去B站 App 里取消，这里不动' };
          }
          await api.relationModify(id, 2);
          const removed = store.removeFollow(id);
          store.recordInteract('follows', { detail: '取关 ' + (existing.uname || id) });
          logger.log('[bili] 取关成功：' + id + (existing.uname ? '（' + existing.uname + '）' : ''));
          return { ok: true, removed: removed };
        },
        startBrowse: function (trigger) {
          runOnce(trigger === 'auto' ? 'auto' : 'manual').catch(function (err) {
            logger.warn('[bili] 手动一轮失败：' + (err && err.message ? err.message : err));
          });
        },
        startReplyCheck: function () {
          replyChecking = true;
          try {
            const runAgent = typeof opts.runAgent === 'function' ? opts.runAgent : buildAgent();
            runReplyCheckRound({
              store: store,
              section: section,
              api: api,
              tools: tools,
              runAgent: runAgent,
              masterMid: typeof client.mid === 'function' ? client.mid() : '',
              logger: logger,
              now: clock,
              timeoutMs: ctx.getConfig().requestTimeoutMs,
            }).catch(function (err) {
              logger.warn('[bili] 手动查回复失败：' + (err && err.message ? err.message : err));
            }).then(function () {
              replyChecking = false;
            });
            return { ok: true };
          } catch (err) {
            replyChecking = false;
            return { ok: false, error: err && err.message ? err.message : String(err) };
          }
        },
      };

      // 接口层：契约与 HTTP 翻译都在 http.js，这里只负责注册
      const httpRoutes = createBiliHttp(svc, ctx);
      for (let i = 0; i < httpRoutes.length; i += 1) {
        ctx.route(httpRoutes[i].method, httpRoutes[i].pathname, httpRoutes[i].handler);
      }

      if (typeof ctx.addPromptBlock === 'function') {
        ctx.addPromptBlock(function () { return historyPrompt(store); });
      }

      // A4：主人明确问起她在B站的动态时，主对话调这个只读工具查本地记录（体现本性：不问不查）
      if (typeof ctx.addTool === 'function') {
        ctx.addTool({
          name: 'plugin_bili_browse_recall',
          description:
            '查询小鲸自己在B站的活动记录：浏览过什么视频、关注了谁、发过什么评论/动态。' +
            '仅当主人明确问起「你在B站看了什么/关注了谁/回复了什么」这类问题时才调用；闲聊或聊别的事情不要调用。' +
            '回答以查到的记录为准，查不到就直说，不要编造。',
          parameters: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
                enum: ['browse', 'follows', 'replies', 'summary'],
                description: 'browse=浏览记录；follows=关注名单；replies=自己发过的评论/动态；summary=概要（全都要）',
              },
              keyword: { type: 'string', description: '可选：按标题/UP/备注过滤关键词' },
              days: { type: 'number', description: '可选：浏览记录只看最近几天（默认 7）' },
            },
            required: ['topic'],
          },
          execute: async function (args) {
            return recallReport(store, args || {});
          },
        });
      }

      timer = setInterval(tick, TICK_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
      replyTimer = setInterval(tickReplies, TICK_MS);
      if (replyTimer && typeof replyTimer.unref === 'function') replyTimer.unref();

      return {
        stop: function () {
          if (timer) clearInterval(timer);
          timer = null;
          if (replyTimer) clearInterval(replyTimer);
          replyTimer = null;
        },
        runOnce: runOnce,
        applyParams: function (patch) {
          const result = applyBiliParams(ctx.root, featureSection(ctx.getConfig()) || {}, patch);
          if (result.ok) syncSection();
          return result;
        },
        specs: function () { return PARAM_SPECS; },
        state: store.state,
        store: store,
        section: section,
        follow: svc.follow,
        unfollow: svc.unfollow,
        followsList: svc.followsList,
      };
    },
  };
}

module.exports = {
  createBiliModule: createBiliModule,
  recallReport: recallReport,
  normalizeSection: normalizeSection,
  normalizeInteract: normalizeInteract,
  historyPrompt: historyPrompt,
  TICK_MS: TICK_MS,
};
