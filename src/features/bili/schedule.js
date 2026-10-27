'use strict';

const DAY_MINUTES = 24 * 60;

/** "09:30" -> 570；写错了返回 null，不让一个笔误把整天的调度搞乱 */
function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text == null ? '' : text).trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59) return null;
  if (hour === 24 && minute !== 0) return null;
  return (hour % 24) * 60 + minute;
}

/** "18:00-09:00" 这种跨天区间要单独标记，否则判断会反过来 */
function parseWindow(text) {
  const parts = String(text == null ? '' : text).split('-');
  if (parts.length !== 2) return null;
  const start = parseClock(parts[0]);
  const end = parseClock(parts[1]);
  if (start === null || end === null) return null;
  return { start: start, end: end, wrap: start > end };
}

function inWindow(minutes, win) {
  if (!win) return false;
  if (win.wrap) return minutes >= win.start || minutes < win.end;
  return minutes >= win.start && minutes < win.end;
}

/**
 * 活跃时段判断。windows 为空 = 全天可跑；周末默认全天（周末不该被工作日的错峰表限制）。
 * 有任一区间写错就忽略它，不因为配置笔误把功能整个停掉。
 */
function inActiveWindows(date, windows, weekendAllDay) {
  const list = Array.isArray(windows) ? windows : [];
  const parsed = list.map(parseWindow).filter(Boolean);
  if (parsed.length === 0) return true;

  const day = date.getDay();
  const weekend = day === 0 || day === 6;
  if (weekend && weekendAllDay !== false) return true;

  const minutes = date.getHours() * 60 + date.getMinutes();
  for (let i = 0; i < parsed.length; i += 1) {
    if (inWindow(minutes, parsed[i])) return true;
  }
  return false;
}

function dayKeyOf(date) {
  const pad = function (num) { return (num < 10 ? '0' : '') + num; };
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
}

/**
 * 定时器每一跳都问一次"现在该不该自动跑"。
 * 顺序就是原始项目的检查顺序：仅手动 -> 额度 -> 活跃时段 -> 间隔。
 * 返回 reason 是为了日志里能说清"为什么没跑"。
 */
function shouldAutoRun(options) {
  const opts = options || {};
  const section = opts.section || {};
  const state = opts.state || {};
  const now = opts.now instanceof Date ? opts.now : new Date();

  const quota = Number(section.dailyQuota);
  if (!Number.isFinite(quota) || quota <= 0) return { run: false, reason: 'dailyQuota=0，仅手动' };

  const today = dayKeyOf(now);
  const rounds = state.dayKey === today ? Number(state.dayRounds) || 0 : 0;
  if (rounds >= quota) return { run: false, reason: '今日额度已用完（' + rounds + '/' + quota + '）' };

  if (!inActiveWindows(now, section.activeWindows, section.weekendAllDay)) {
    return { run: false, reason: '不在活跃时段' };
  }

  const interval = Number(section.intervalMinutes);
  if (Number.isFinite(interval) && interval > 0 && state.lastRunAt) {
    const last = new Date(state.lastRunAt).getTime();
    if (Number.isFinite(last)) {
      const gap = now.getTime() - last;
      if (gap < interval * 60000) {
        const left = Math.ceil((interval * 60000 - gap) / 60000);
        return { run: false, reason: '距上轮不到 ' + interval + ' 分钟（还差 ' + left + ' 分钟）' };
      }
    }
  }

  return { run: true, reason: '到点了' };
}

module.exports = {
  parseClock: parseClock,
  parseWindow: parseWindow,
  inWindow: inWindow,
  inActiveWindows: inActiveWindows,
  shouldAutoRun: shouldAutoRun,
  dayKeyOf: dayKeyOf,
  DAY_MINUTES: DAY_MINUTES,
};
