'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openMemory } = require('../src/memory');

test('appendSelfTurn：进短期记忆、不衰减事实、不进对话抽取', function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mem-self-'));
  const memory = openMemory({ root: root, sessionId: 'main' });
  memory.addFact('主人喜欢深海蓝', 'test');
  const strengthBefore = memory.export().facts[0].strength;

  memory.appendSelfTurn('我刚在 B 站分享了一条视频');
  const after = memory.export();

  assert.strictEqual(after.turns[after.turns.length - 1].self, true);
  assert.strictEqual(after.facts[0].strength, strengthBefore, '自言自语不衰减事实');

  const dialogue = memory.recentDialogueTurns(5);
  assert.strictEqual(dialogue.length, 0, 'self turn 不进事实抽取口径');
  assert.strictEqual(memory.recentTurns(5).length, 1, '但 recentTurns 仍能看到');
});

test('摘要触发只数真实对话，self turn 不撑窗口', function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mem-self2-'));
  const memory = openMemory({ root: root, sessionId: 'main' });

  for (let i = 0; i < 3; i += 1) memory.appendSelfTurn('分享 ' + i);
  assert.strictEqual(memory.shouldSummarize(), false, '全是播报也不触发压缩');

  for (let i = 0; i < 41; i += 1) memory.appendTurn('user', '消息 ' + i);
  assert.strictEqual(memory.shouldSummarize(), true);
  const toSummarize = memory.turnsToSummarize();
  assert.ok(toSummarize.every(function (t) { return t.self !== true; }), '要压缩的是真实对话');
});