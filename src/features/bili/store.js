'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SEEN = 500;

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
  return { dayKey: '', dayRounds: 0, lastRunAt: '', lastResult: null };
}

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
    return {
      dayKey: typeof source.dayKey === 'string' ? source.dayKey : '',
      dayRounds: Number.isFinite(Number(source.dayRounds)) ? Math.max(0, Math.round(Number(source.dayRounds))) : 0,
      lastRunAt: typeof source.lastRunAt === 'string' ? source.lastRunAt : '',
      lastResult: source.lastResult && typeof source.lastResult === 'object' ? source.lastResult : null,
    };
  }

  /** 换天就把当日轮数归零——顺手在读取时修，免得定时器还要单独判断 */
  function stateNow() {
    const today = dayKeyOf(clock());
    if (state.dayKey !== today) {
      state.dayKey = today;
      state.dayRounds = 0;
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

  return {
    base: base,
    outDir: outDir,
    digestDir: digestDir,
    state: stateNow,
    recordRun: recordRun,
    hasSeen: hasSeen,
    markSeen: markSeen,
    seenLines: seenLines,
    appendReport: appendReport,
    appendDigest: appendDigest,
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
