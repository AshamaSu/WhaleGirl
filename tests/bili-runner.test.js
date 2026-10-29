'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runBiliRound, parsePicked, splitBubbles, buildAnnounceMessages } = require('../src/features/bili/runner');
const { createBiliStore } = require('../src/features/bili/store');

const ROOT = path.join(__dirname, '..');
const FIXED = new Date('2026-10-27T21:40:00');

const REPORT = [
  '### BV1gExu6GEjZ',
  '标题：鲸鱼观察日记',
  'UP：某UP主',
  '链接：https://www.bilibili.com/video/BV1gExu6GEjZ',
  '播放：12.3万',
  '为什么值得：拍得干净，讲得克制。',
  '',
  '### BV1aaaaaaaaa',
  '标题：第二条',
  '',
  '因无字幕跳过 2 条',
].join('\n');

/** 假 agent：按脚本吐事件，用来替掉真实模型 */
function fakeAgent(script) {
  return function () {
    return (async function* () {
      const steps = typeof script === 'function' ? script() : script;
      for (let i = 0; i < steps.length; i += 1) {
        if (steps[i].type === 'throw') throw new Error(steps[i].message);
        yield steps[i];
      }
    })();
  };
}

function setup(overrides) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bili-run-'));
  const store = createBiliStore({ root: root, now: function () { return FIXED; } });
  const logs = [];
  const options = Object.assign({
    root: ROOT,
    store: store,
    section: { owner: '主人', itemsPerRound: 2, minPlays: 1000, maxDaysOld: 30, keywords: ['鲸鱼'] },
    provider: { name: 'fake' },
    tools: [],
    logger: { log: function (m) { logs.push(m); }, warn: function (m) { logs.push(m); } },
    now: function () { return FIXED; },
  }, overrides || {});
  return { root: root, store: store, options: options, logs: logs };
}

test('模型把工具调用写成 DSML 文本时本轮判失败，不落脏报告', async function () {
  const env = setup({ runAgent: fakeAgent([
    { type: 'final', text: '<｜｜DSML｜｜ calls>' + String.fromCharCode(10) + '<｜｜DSML｜｜ invoke name="bili_subtitle">' },
  ]) });

  const result = await runBiliRound(env.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /DSML/);
  assert.deepEqual(result.picked, []);

  const text = fs.readFileSync(env.store.reportPath(FIXED), 'utf8');
  assert.match(text, /本轮失败/);
  assert.ok(text.indexOf('<｜｜DSML｜｜ invoke') === -1, '脏文本不能进报告');
});

test('parsePicked 只认顶格的 ### BV 行', function () {
  assert.deepEqual(parsePicked(REPORT), ['BV1gExu6GEjZ', 'BV1aaaaaaaaa']);
  assert.deepEqual(parsePicked('  ### BV1gExu6GEjZ'), []);
  assert.deepEqual(parsePicked('### BV1gExu6GEjZ 标题'), []);
  assert.deepEqual(parsePicked(''), []);
});

test('一轮成功：落盘报告、记判重、额度按触发方式记', async function () {
  const env = setup({ runAgent: fakeAgent([
    { type: 'tool', name: 'bili_search', ok: true, result: 'ok' },
    { type: 'final', text: REPORT },
  ]) });

  const result = await runBiliRound(env.options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.picked, ['BV1gExu6GEjZ', 'BV1aaaaaaaaa']);
  assert.equal(result.toolCalls, 1);

  const file = env.store.reportPath(FIXED);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /## 2026-10-27 21:40 · 手动/);
  assert.match(text, /### BV1gExu6GEjZ/);

  assert.equal(env.store.hasSeen('BV1gExu6GEjZ'), true);
  assert.equal(env.store.state().dayRounds, 0, '手动轮不扣额度');
});

test('自动轮成功才扣当日额度', async function () {
  const env = setup({
    runAgent: fakeAgent([{ type: 'final', text: REPORT }]),
  });
  await runBiliRound(Object.assign({}, env.options, { trigger: 'auto' }));
  assert.equal(env.store.state().dayRounds, 1);
});

test('子代理抛错：报告留失败一行，额度不扣', async function () {
  const env = setup({ runAgent: fakeAgent([{ type: 'throw', message: '接口全挂了' }]) });
  const result = await runBiliRound(Object.assign({}, env.options, { trigger: 'auto' }));

  assert.equal(result.ok, false);
  assert.match(result.error, /接口全挂了/);
  assert.match(fs.readFileSync(env.store.reportPath(FIXED), 'utf8'), /本轮失败：接口全挂了/);
  assert.equal(env.store.state().dayRounds, 0);
  assert.equal(env.store.state().lastResult.ok, false);
});

test('子代理交白卷也算失败', async function () {
  const env = setup({ runAgent: fakeAgent([{ type: 'final', text: '   ' }]) });
  const result = await runBiliRound(env.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /没有产出报告/);
});

test('章程文件缺失时给出可读错误，不炸进程', async function () {
  const env = setup({
    root: fs.mkdtempSync(path.join(os.tmpdir(), 'wg-bili-empty-')),
    runAgent: fakeAgent([{ type: 'final', text: REPORT }]),
  });
  const result = await runBiliRound(env.options);
  assert.equal(result.ok, false);
  assert.match(result.error, /读不到子代理章程/);
});

test('splitBubbles 按空行分块，块内句子和它的链接留在一起', function () {
  assert.deepEqual(splitBubbles('一句话\nhttps://x/1\n\n第二句\nhttps://x/2', 3), ['一句话 https://x/1', '第二句 https://x/2']);
  assert.deepEqual(splitBubbles('一\n二\n三\n四', 3), ['一', '二', '三 四']);
  assert.deepEqual(splitBubbles('- 一\n\n2. 二', 3), ['一', '二']);
  assert.deepEqual(splitBubbles('', 3), []);
});

test('播报指令把报告塞给主娘，并禁止她念报告', function () {
  const messages = buildAnnounceMessages([{ role: 'system', content: 'system' }], REPORT);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.match(messages[1].content, /不要提"报告"/);
  assert.match(messages[1].content, /BV1gExu6GEjZ/);
});
