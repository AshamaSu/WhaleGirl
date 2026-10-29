'use strict';

const { createBiliClient } = require('./vendor/client');
const { createBiliApi } = require('./vendor/api');
const { createBiliTools } = require('./vendor/tools');
const { createBiliStore } = require('./store');
const { runBiliRound, runReplyCheckRound } = require('./runner');
const { shouldAutoRun, shouldCheckReplies } = require('./schedule');
const { buildAnnounceMessages, splitBubbles } = require('./runner');

/** 能力配置段：与宿主「未声明=关闭」语义一致，但不再依赖宿主 settings */
function featureSection(config) {
  const features = config && config.features;
  const section = features && features.bili;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : null;
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
  };
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

      async function runOnce(trigger) {
        if (running) return { ok: false, error: '上一轮还在跑', skipped: true };
        running = true;
        try {
          const live = ctx.getConfig();
          const runAgent = typeof opts.runAgent === 'function' ? opts.runAgent : buildAgent();
          const result = await runBiliRound({
            root: ctx.root,
            store: store,
            section: section,
            tools: tools,
            trigger: trigger === 'auto' ? 'auto' : 'manual',
            logger: logger,
            now: clock,
            runAgent: opts.runAgent,
            timeoutMs: live.requestTimeoutMs,
          });
          lastResult = result;
          if (result.ok && Array.isArray(result.items) && result.items.length > 0) {
            store.appendHistory(result.items, { at: result.at, trigger: result.trigger });
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

      ctx.route('GET', '/api/features/bili/state', function (req, res) {
        ctx.sendJson(res, 200, {
          ok: true,
          running: running,
          section: section,
          state: store.state(),
          lastResult: lastResult ? { ok: lastResult.ok, trigger: lastResult.trigger, picked: lastResult.picked, error: lastResult.error, at: lastResult.at } : null,
          seen: store.seenLines(200).length,
          login: client.hasLogin ? client.hasLogin() : false,
          mid: typeof client.mid === 'function' ? client.mid() : '',
          interact: {
            section: section.interact,
            budget: store.interactBudget(section.interact),
            log: store.interactLog(20),
          },
          lastReplyCheckAt: store.state().lastReplyCheckAt || '',
        });
      });

      // 手动触发不等结果：一轮可能跑一两分钟，让浏览器干等容易超时；进度看 state 或推送
      ctx.route('POST', '/api/features/bili/run', async function (req, res) {
        if (running) {
          ctx.sendJson(res, 409, { ok: false, error: '上一轮还在跑，等它结束' });
          return;
        }
        runOnce('manual').catch(function (err) {
          logger.warn('[bili] 手动一轮失败：' + (err && err.message ? err.message : err));
        });
        ctx.sendJson(res, 202, { ok: true, started: true });
      });

      if (typeof ctx.addPromptBlock === 'function') {
        ctx.addPromptBlock(function () { return historyPrompt(store); });
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
        state: store.state,
        store: store,
        section: section,
      };
    },
  };
}

module.exports = {
  createBiliModule: createBiliModule,
  normalizeSection: normalizeSection,
  normalizeInteract: normalizeInteract,
  historyPrompt: historyPrompt,
  TICK_MS: TICK_MS,
};
