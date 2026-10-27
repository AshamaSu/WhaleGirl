'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseClock, parseWindow, inActiveWindows, shouldAutoRun } = require('../src/features/bili/schedule');

function local(text) {
  // 用本地时间构造，避免测试机时区影响判断
  const parts = text.split(/[-T:]/).map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], parts[3] || 0, parts[4] || 0);
}

test('parseClock 接受 0-24 点，写错返回 null', function () {
  assert.equal(parseClock('09:30'), 570);
  assert.equal(parseClock('24:00'), 0);
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('9:3'), null);
  assert.equal(parseClock(''), null);
});

test('parseWindow 认得出跨天区间', function () {
  assert.deepEqual(parseWindow('12:00-14:00'), { start: 720, end: 840, wrap: false });
  assert.deepEqual(parseWindow('18:00-09:00'), { start: 1080, end: 540, wrap: true });
  assert.equal(parseWindow('中午-下午'), null);
});

test('活跃时段：跨天区间在夜里也算活跃', function () {
  const windows = ['12:00-14:00', '18:00-09:00'];
  // 2026-10-27 是周二
  assert.equal(inActiveWindows(local('2026-10-27T13:00'), windows, false), true);
  assert.equal(inActiveWindows(local('2026-10-27T23:30'), windows, false), true);
  assert.equal(inActiveWindows(local('2026-10-27T03:00'), windows, false), true);
  assert.equal(inActiveWindows(local('2026-10-27T10:00'), windows, false), false);
});

test('周末默认全天可跑，关掉 weekendAllDay 后仍按时段', function () {
  // 2026-10-31 是周六
  assert.equal(inActiveWindows(local('2026-10-31T10:00'), ['12:00-14:00'], true), true);
  assert.equal(inActiveWindows(local('2026-10-31T10:00'), ['12:00-14:00'], false), false);
  assert.equal(inActiveWindows(local('2026-10-27T10:00'), [], false), true);
});

test('dailyQuota=0 时永不自动跑', function () {
  const gate = shouldAutoRun({
    section: { dailyQuota: 0 },
    state: { dayKey: '2026-10-27', dayRounds: 0, lastRunAt: '' },
    now: local('2026-10-27T13:00'),
  });
  assert.equal(gate.run, false);
  assert.match(gate.reason, /仅手动/);
});

test('额度用完、不在时段、间隔不够都拦住', function () {
  const section = { dailyQuota: 2, activeWindows: ['12:00-14:00'], weekendAllDay: false, intervalMinutes: 180 };

  assert.match(shouldAutoRun({
    section: section,
    state: { dayKey: '2026-10-27', dayRounds: 2, lastRunAt: '2026-10-27T10:00:00' },
    now: local('2026-10-27T13:00'),
  }).reason, /额度/);

  assert.match(shouldAutoRun({
    section: section,
    state: { dayKey: '2026-10-27', dayRounds: 0, lastRunAt: '' },
    now: local('2026-10-27T10:00'),
  }).reason, /不在活跃时段/);

  assert.match(shouldAutoRun({
    section: section,
    state: { dayKey: '2026-10-27', dayRounds: 0, lastRunAt: local('2026-10-27T12:30').toISOString() },
    now: local('2026-10-27T13:00'),
  }).reason, /不到 180 分钟/);
});

test('换天后额度重新算，条件都满足就放行', function () {
  const gate = shouldAutoRun({
    section: { dailyQuota: 1, activeWindows: ['12:00-14:00'], weekendAllDay: false, intervalMinutes: 60 },
    state: { dayKey: '2026-10-26', dayRounds: 5, lastRunAt: local('2026-10-26T23:00').toISOString() },
    now: local('2026-10-27T13:00'),
  });
  assert.equal(gate.run, true);
});
