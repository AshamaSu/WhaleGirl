'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SEEN = 500;
const MAX_HISTORY_LINES = 2000;
const MAX_HISTORY_BYTES = 512 * 1024;

function pad(num) {
  return (num < 10 ? '0' : '') + num;
}

function dayKeyOf(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

function monthKeyOf(date) {
  return date.getFullYear() + '-' + pad(date.getMonth() + 1);
}

function stamp(date) {
  return dayKeyOf(date) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function emptyState() {
  return { dayKey: '', dayRounds: 0, lastRunAt: '', lastResult: null, interact: emptyInteract(), interactLog: [] };
}

const INTERACT_TYPES = ['likes', 'coins', 'favorites', 'replies', 'dynamics'];

function emptyInteract() {
  return { dayKey: '', likes: 0, coins: 0, favorites: 0, replies: 0, dynamics: 0 };
}

/** 互动日志最多留 50 条，够最近几天的提示与排查用 */
const MAX_INTERACT_LOG = 50;

/**
 * B站子代理的落盘层：状态、判重表、报告、月度归档。
 * 路径统一在 data/bili/ 下，坏文件备份后重来（跟心情模块一个套路）。
 */
function createBiliStore(options) {
  const opts = options || {};
  const root = opts.root || process.cwd();
  const clock = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  const warn = typeof opts.onWarn === 'function' ? opts.onWarn : function () {};

  const base = path.join(root, 'data', 'bili');
  const outDir = path.join(base, 'out');
  const digestDir = path.join(base, 'digest');
  const historyPath = path.join(base, 'history.jsonl');
  const stateFile = path.join(base, 'state.json');
  const seenFile = path.join(base, 'seen.json');

  function ensureDirs() {
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.mkdirSync(digestDir, { recursive: true });
    } catch (err) {
      warn('创建 bili 数据目录失败：' + (err.code || err.message));
    }
  }

  function readJson(file, fallback, validate) {
    if (!fs.existsSync(file)) return fallback;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('结构不对');
      if (validate && !validate(parsed)) throw new Error('字段不对');
      return parsed;
    } catch (err) {
      const bad = file + '.corrupt-' + Date.now();
      try { fs.renameSync(file, bad); } catch (e) { /* 挪不动就覆盖 */ }
      warn('bili 状态文件损坏，已备份到 ' + bad + '（' + err.message + '）');
      return fallback;
    }
  }

  function writeJson(file, value) {
    ensureDirs();
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      warn('写 ' + path.basename(file) + ' 失败：' + (err.code || err.message));
      return false;
    }
  }

  function appendFile(file, text) {
    ensureDirs();
    try {
      fs.appendFileSync(file, String(text) + '\n');
      return true;
    } catch (err) {
      warn('写 ' + path.basename(file) + ' 失败：' + (err.code || err.message));
      return false;
    }
  }

  let state = normalizeState(readJson(stateFile, emptyState(), function (raw) { return typeof raw === 'object'; }));
  let seen = readJson(seenFile, {}, function () { return true; });

  function normalizeState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const interactSrc = source.interact && typeof source.interact === 'object' ? source.interact : {};
    const interact = emptyInteract();
    interact.dayKey = typeof interactSrc.dayKey === 'string' ? interactSrc.dayKey : '';
    for (let i = 0; i < INTERACT_TYPES.length; i += 1) {
      const key = INTERACT_TYPES[i];
      interact[key] = Number.isFinite(Number(interactSrc[key])) ? Math.max(0, Math.round(Number(interactSrc[key]))) : 0;
    }
    return {
      dayKey: typeof source.dayKey === 'string' ? source.dayKey : '',
      dayRounds: Number.isFinite(Number(source.dayRounds)) ? Math.max(0, Math.round(Number(source.dayRounds))) : 0,
      lastRunAt: typeof source.lastRunAt === 'string' ? source.lastRunAt : '',
      lastResult: source.lastResult && typeof source.lastResult === 'object' ? source.lastResult : null,
      interact: interact,
      interactLog: Array.isArray(source.interactLog) ? source.interactLog.slice(-MAX_INTERACT_LOG) : [],
      lastReplyCheckAt: typeof source.lastReplyCheckAt === 'string' ? source.lastReplyCheckAt : '',
    };
  }

  /** 换天就把当日轮数归零——顺手在读取时修，免得定时器还要单独判断 */
  function stateNow() {
    const today = dayKeyOf(clock());
    if (state.dayKey !== today) {
      state.dayKey = today;
      state.dayRounds = 0;
      state.interact = emptyInteract();
      writeJson(stateFile, state);
    }
    if (state.interact.dayKey !== today) {
      state.interact = emptyInteract();
      writeJson(stateFile, state);
    }
    return JSON.parse(JSON.stringify(state));
  }

  function saveState() {
    writeJson(stateFile, state);
  }

  /**
   * 记一轮。auto=false（手动）不扣当日额度；lastRunAt 两种都更新，
   * 免得手动刚跑完定时器又立刻跑一轮。
   */
  function recordRun(info) {
    const data = info || {};
    const at = clock();
    state.dayKey = dayKeyOf(at);
    state.lastRunAt = at.toISOString();
    if (data.auto === true && data.ok === true) state.dayRounds += 1;
    state.lastResult = {
      at: state.lastRunAt,
      auto: data.auto === true,
      ok: data.ok === true,
      picked: Number(data.picked) || 0,
      error: String(data.error || '').slice(0, 200),
    };
    saveState();
    return stateNow();
  }

  function hasSeen(bvid) {
    return Object.prototype.hasOwnProperty.call(seen, String(bvid || ''));
  }

  function markSeen(bvids, verdict) {
    const at = clock();
    const list = Array.isArray(bvids) ? bvids : [];
    for (let i = 0; i < list.length; i += 1) {
      const bvid = String(list[i] || '');
      if (bvid === '') continue;
      seen[bvid] = { at: at.toISOString(), date: dayKeyOf(at), verdict: String(verdict || 'picked') };
    }

    const keys = Object.keys(seen);
    if (keys.length > MAX_SEEN) {
      keys.sort(function (a, b) { return String(seen[a].at).localeCompare(String(seen[b].at)); });
      const drop = keys.slice(0, keys.length - MAX_SEEN);
      for (let i = 0; i < drop.length; i += 1) delete seen[drop[i]];
    }
    writeJson(seenFile, seen);
  }

  /** 给子代理 prompt 的"已经推过"清单，越新越靠前 */
  function seenLines(limit) {
    const cap = Number(limit) > 0 ? Number(limit) : 40;
    return Object.keys(seen)
      .map(function (bvid) { return { bvid: bvid, date: String(seen[bvid].date || '') }; })
      .sort(function (a, b) { return b.date.localeCompare(a.date); })
      .slice(0, cap)
      .map(function (item) { return item.bvid + '（' + (item.date || '日期未知') + '）'; });
  }

  function reportPath(date) {
    return path.join(outDir, dayKeyOf(date || clock()) + '.md');
  }

  function appendReport(text, date) {
    return appendFile(reportPath(date), text);
  }

  function appendDigest(text, date) {
    return appendFile(path.join(digestDir, monthKeyOf(date || clock()) + '.md'), text);
  }

  /** 浏览历史：一行一条 JSON，只记「她自己看过的」，供对话里被引用 */
  function appendHistory(items, meta) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return 0;
    const when = meta && meta.at instanceof Date ? meta.at : clock();
    const trigger = meta && meta.trigger === 'auto' ? 'auto' : 'manual';
    const lines = [];
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i] || {};
      if (!item.bvid) continue;
      lines.push(JSON.stringify({
        at: when.toISOString(),
        date: dayKeyOf(when),
        trigger: trigger,
        bvid: String(item.bvid),
        title: String(item.title || ''),
        up: String(item.up || ''),
        link: String(item.link || ('https://www.bilibili.com/video/' + item.bvid)),
      }));
    }
    if (lines.length === 0) return 0;
    ensureDirs();
    try {
      fs.appendFileSync(historyPath, lines.join('\n') + '\n', 'utf8');
    } catch (err) {
      warn('写浏览历史失败：' + (err.code || err.message));
      return 0;
    }
    trimHistory();
    return lines.length;
  }

  function trimHistory() {
    try {
      const stat = fs.statSync(historyPath);
      if (stat.size < MAX_HISTORY_BYTES) return;
      const kept = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean).slice(-MAX_HISTORY_LINES);
      const tmp = historyPath + '.tmp';
      fs.writeFileSync(tmp, kept.join('\n') + '\n', 'utf8');
      fs.renameSync(tmp, historyPath);
    } catch (err) {
      warn('整理浏览历史失败：' + (err.code || err.message));
    }
  }

  /** 倒序取最近 N 条；days > 0 时只看最近这些天 */
  function recentHistory(limit, days) {
    const max = Number(limit) > 0 ? Math.floor(Number(limit)) : 5;
    const span = Number(days) > 0 ? Math.floor(Number(days)) : 0;
    let rows = [];
    try {
      if (!fs.existsSync(historyPath)) return [];
      rows = fs.readFileSync(historyPath, 'utf8').split('\n');
    } catch (err) {
      warn('读浏览历史失败：' + (err.code || err.message));
      return [];
    }
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < max; i -= 1) {
      const line = rows[i].trim();
      if (line === '') continue;
      let row;
      try { row = JSON.parse(line); } catch (e) { continue; }
      if (!row || !row.bvid) continue;
      if (span > 0) {
        const t = Date.parse(row.at);
        if (Number.isFinite(t) && clock().getTime() - t > span * 86400000) continue;
      }
      out.push(row);
    }
    return out;
  }

  // ===== 互动预算（#3：写操作的每日闸门）=====

  /**
   * 剩余额度。section.interact 的上限是配置，当日用量是状态；
   * 单类上限为 0 表示这类禁用。recordInteract 里也会复查，防止并发轮把额度打穿。
   */
  function interactBudget(limits) {
    const src = limits && typeof limits === 'object' ? limits : {};
    const current = stateNow().interact;
    const out = {};
    const limitKeys = { likes: 'maxLikes', coins: 'maxCoins', favorites: 'maxFavorites', replies: 'maxReplies', dynamics: 'maxDynamics' };
    for (let i = 0; i < INTERACT_TYPES.length; i += 1) {
      const key = INTERACT_TYPES[i];
      const limit = Math.max(0, Math.round(Number(src[limitKeys[key]]) || 0));
      out[key] = { used: current[key], limit: limit, left: Math.max(0, limit - current[key]) };
    }
    return out;
  }

  function recordInteract(type, info) {
    const key = String(type || '');
    if (INTERACT_TYPES.indexOf(key) === -1) return null;
    const at = clock();
    const today = dayKeyOf(at);
    if (state.dayKey !== today) {
      state.dayKey = today;
      state.dayRounds = 0;
    }
    if (state.interact.dayKey !== today) state.interact = emptyInteract();
    state.interact.dayKey = today;
    state.interact[key] += 1;
    const entry = {
      at: at.toISOString(),
      type: key,
      bvid: String((info && info.bvid) || ''),
      detail: String((info && info.detail) || '').slice(0, 120),
    };
    state.interactLog.push(entry);
    if (state.interactLog.length > MAX_INTERACT_LOG) state.interactLog = state.interactLog.slice(-MAX_INTERACT_LOG);
    writeJson(stateFile, state);
    return entry;
  }

  /** 通知去重：查过的消息 id 记下来，轻量轮只处理新到的 */
  const notifiedFile = path.join(base, 'notified.json');
  let notified = readJson(notifiedFile, {}, function () { return true; });

  function hasNotified(id) {
    return Object.prototype.hasOwnProperty.call(notified, String(id || ''));
  }

  function markNotified(ids) {
    const list = Array.isArray(ids) ? ids : [];
    let changed = false;
    for (let i = 0; i < list.length; i += 1) {
      const id = String(list[i] || '');
      if (id === '' || hasNotified(id)) continue;
      notified[id] = { at: clock().toISOString() };
      changed = true;
    }
    const keys = Object.keys(notified);
    if (keys.length > MAX_SEEN) {
      keys.sort(function (a, b) { return String(notified[a].at).localeCompare(String(notified[b].at)); });
      const drop = keys.slice(0, keys.length - MAX_SEEN);
      for (let i = 0; i < drop.length; i += 1) delete notified[drop[i]];
      changed = true;
    }
    if (changed) writeJson(notifiedFile, notified);
    return changed;
  }

  function markReplyCheck(at) {
    const when = at instanceof Date ? at : clock();
    state.lastReplyCheckAt = when.toISOString();
    writeJson(stateFile, state);
  }

  return {
    base: base,
    outDir: outDir,
    digestDir: digestDir,
    historyPath: historyPath,
    state: stateNow,
    interactBudget: interactBudget,
    recordInteract: recordInteract,
    interactLog: function (limit) {
      const list = state.interactLog || [];
      const cap = Number(limit) > 0 ? Number(limit) : 20;
      return list.slice(-cap).reverse();
    },
    hasNotified: hasNotified,
    markNotified: markNotified,
    markReplyCheck: markReplyCheck,
    recordRun: recordRun,
    hasSeen: hasSeen,
    markSeen: markSeen,
    seenLines: seenLines,
    appendReport: appendReport,
    appendDigest: appendDigest,
    appendHistory: appendHistory,
    recentHistory: recentHistory,
    reportPath: reportPath,
    stamp: function (date) { return stamp(date || clock()); },
    dayKey: function (date) { return dayKeyOf(date || clock()); },
    now: clock,
  };
}

module.exports = {
  createBiliStore: createBiliStore,
  dayKeyOf: dayKeyOf,
  monthKeyOf: monthKeyOf,
  stamp: stamp,
  MAX_SEEN: MAX_SEEN,
};
