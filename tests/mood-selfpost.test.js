'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMoodModule, createMoodStore } = require('../src/features/mood');
const { createBus } = require('../src/events');

const QUIET = { log: function () {}, warn: function () {}, error: function () {} };

test('selfPost：同 roundId 只加一次，不同轮各加一次', async function () {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mood-self-'));
  const bus = createBus({ logger: QUIET });
  const module = createMoodModule({
    root: root,
    now: function () { return new Date('2026-10-29T20:00:00'); },
    llm: function () { throw new Error('不该调用'); },
  });
  const handle = module.init({
    dataRoot: root,
    logger: QUIET,
    bus: bus,
    makeLlm: function () { throw new Error('不该调用'); },
    route: function () {},
    addPromptBlock: function () {},
    addAfterReply: function () {},
  });

  bus.emit('selfPost', { source: 'bili', roundId: 'r1', text: '分享A' });
  bus.emit('selfPost', { source: 'bili', roundId: 'r1', text: '分享A2' });
  assert.strictEqual(handle.store.snapshot(24).value, 62, '同轮只加一次');

  bus.emit('selfPost', { source: 'bili', roundId: 'r2', text: '分享B' });
  assert.strictEqual(handle.store.snapshot(24).value, 64, '新一轮再加');
});