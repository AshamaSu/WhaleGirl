'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createMoodModule,
  createMoodStore,
  moodLabel,
  clampDelta,
  clampValue,
  buildPromptBlock,
  parseMoodReply,
  judgeMood,
  DEFAULT_VALUE,
  MOOD_DIR,
  MOOD_FILE,
} = require('../src/features/mood');
const { createBus } = require('../src/events');

const QUIET = { log: function () {}, warn: function () {}, error: function () {} };

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mood-'));
}

function fixedClock(startIso) {
  let t = new Date(startIso).getTime();
  const clock = function () { return new Date(t); };
  clock.advance = function (minutes) { t += minutes * 60 * 1000; };
  return clock;
}

test('心情分档：边界值归到本档', function () {
  assert.strictEqual(moodLabel(0), '低落');
  assert.strictEqual(moodLabel(20), '低落');
  assert.strictEqual(moodLabel(21), '有点丧');
  assert.strictEqual(moodLabel(40), '有点丧');
  assert.strictEqual(moodLabel(60), '平静');
  assert.strictEqual(moodLabel(61), '心情不错');
  assert.strictEqual(moodLabel(100), '特别开心');
  assert.strictEqual(moodLabel('不是数字'), '平静');
});

test('delta 与数值都夹在合法区间', function () {
  assert.strictEqual(clampDelta(99), 8);
  assert.strictEqual(clampDelta(-99), -8);
  assert.strictEqual(clampDelta('3'), 3);
  assert.strictEqual(clampDelta('x'), 0);
  assert.strictEqual(clampValue(-10), 0);
  assert.strictEqual(clampValue(999), 100);
  assert.strictEqual(clampValue(undefined), DEFAULT_VALUE);
});

test('仓库：默认平静 60，apply 累加并落盘', function () {
  const root = tmpRoot();
  const clock = fixedClock('2026-10-27T10:00:00Z');
  const store = createMoodStore({ root: root, now: clock });

  assert.strictEqual(store.snapshot(24).value, DEFAULT_VALUE);
  assert.strictEqual(store.snapshot(24).label, '平静');

  const entry = store.apply(5, '被夸了');
  assert.deepStrictEqual({ delta: entry.delta, value: entry.value }, { delta: 5, value: 65 });
  assert.strictEqual(store.snapshot(24).label, '心情不错');

  // 重新打开读的是同一份文件
  const reopened = createMoodStore({ root: root, now: clock });
  assert.strictEqual(reopened.snapshot(24).value, 65);
  assert.strictEqual(reopened.read().history.length, 1);

  const file = path.join(root, MOOD_DIR, MOOD_FILE);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).value, 65);
});

test('仓库：数值夹在 0~100，历史只留 24 小时内的', function () {
  const root = tmpRoot();
  const clock = fixedClock('2026-10-27T10:00:00Z');
  const store = createMoodStore({ root: root, now: clock });

  for (let i = 0; i < 10; i += 1) store.apply(5, '一直很开心');
  assert.strictEqual(store.snapshot(24).value, 100, '不能超过 100');

  for (let i = 0; i < 12; i += 1) store.apply(-5, '一直不开心');
  assert.strictEqual(store.snapshot(24).value, 40, '不能低于 0（10*5 涨满后跌 12 次）');

  clock.advance(60 * 25);
  const after = store.snapshot(24);
  assert.strictEqual(after.history.length, 1, '25 小时前的记录不算进 24h，但回落会追加一条');
  assert.strictEqual(after.value, 60, '低于基线时每小时 +1，收敛到 60 就停');
  assert.strictEqual(store.snapshot(48).history.length, 23);
});

test('仓库：文件坏了就备份并从平静重来', function () {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, MOOD_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, MOOD_DIR, MOOD_FILE), '{ 坏掉的 json');

  const warnings = [];
  const store = createMoodStore({ root: root, onWarn: function (msg) { warnings.push(msg); } });

  assert.strictEqual(store.snapshot(24).value, DEFAULT_VALUE);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /心情文件损坏/);
  const backups = fs.readdirSync(path.join(root, MOOD_DIR)).filter(function (name) {
    return name.indexOf('mood.json.corrupt-') === 0;
  });
  assert.strictEqual(backups.length, 1);
});

test('解析判定结果：容忍代码块围栏与前后解释', function () {
  assert.deepStrictEqual(parseMoodReply('{"delta": 3, "reason": "被夸了"}'), { delta: 3, reason: '被夸了' });
  assert.deepStrictEqual(
    parseMoodReply('好的，结果如下：\n{ "delta": -2, "reason": "被凶了" } 完毕'),
    { delta: -2, reason: '被凶了' }
  );
  assert.deepStrictEqual(parseMoodReply('{"delta": "4", "reason": "聊得开心"}'), { delta: 4, reason: '聊得开心' });
  assert.strictEqual(parseMoodReply('{"delta": 99}').delta, 8, '超出范围要夹回去');
  assert.strictEqual(parseMoodReply('我觉得她挺开心的'), null);
  assert.strictEqual(parseMoodReply('{"reason": "没给 delta"}'), null);
  assert.strictEqual(parseMoodReply(''), null);
});

test('judgeMood 用 temperature 0，并把对话内容带上', async function () {
  const seen = [];
  const llm = async function (request) {
    seen.push(request);
    return '{"delta": 2, "reason": "被夸了"}';
  };

  const verdict = await judgeMood(llm, {
    currentLabel: '平静',
    currentValue: 60,
    userText: '你今天好可爱',
    replyText: '唔…谢谢',
  });

  assert.deepStrictEqual(verdict, { delta: 2, reason: '被夸了' });
  assert.strictEqual(seen[0].temperature, 0);
  assert.match(seen[0].messages[1].content, /你今天好可爱/);
  assert.match(seen[0].messages[1].content, /60/);
});

test('prompt 片段写清档位、数值与最近变化，且不许报数值', function () {
  const block = buildPromptBlock({
    value: 72,
    label: '心情不错',
    history: [
      { at: '2026-10-27T10:00:00Z', delta: 5, value: 70, reason: '被夸了' },
      { at: '2026-10-27T10:05:00Z', delta: -3, value: 67, reason: '被冷落' },
    ],
  });

  assert.match(block, /心情不错/);
  assert.match(block, /72\/100/);
  assert.match(block, /\+5（被夸了）/);
  assert.match(block, /-3（被冷落）/);
  assert.match(block, /不要报数值/);
  assert.strictEqual(buildPromptBlock(null), '');
});

test('能力模块：注册 /api/mood、注入 prompt、回复后更新并发事件', async function () {
  const root = tmpRoot();
  const routes = {};
  const blocks = [];
  const hooks = [];
  const bus = createBus({ logger: QUIET });
  const emitted = [];
  bus.on('mood', function (state) { emitted.push(state); });

  const ctx = {
    logger: QUIET,
    bus: bus,
    dataRoot: root,
    route: function (method, pathname, handler) { routes[method + ' ' + pathname] = handler; },
    addPromptBlock: function (fn) { blocks.push(fn); },
    addAfterReply: function (fn) { hooks.push(fn); },
    sendJson: function (res, status, data) { res.sent = { status: status, data: data }; },
    makeLlm: function () { return null; },
  };

  const module = createMoodModule({
    llm: function () { return async function () { return '{"delta": 4, "reason": "被夸了"}'; }; },
  });

  const handle = module.init(ctx);
  assert.ok(routes['GET /api/mood']);
  assert.strictEqual(hooks.length, 1);

  // 路由能读到当前心情
  routes['GET /api/mood']({ method: 'GET' }, {});
  assert.strictEqual(handle.store.snapshot(24).value, DEFAULT_VALUE);

  // prompt 片段拿的是实时值
  assert.match(blocks[0](), /平静/);

  await hooks[0]({ userText: '你好可爱', replyText: '谢谢' });

  assert.strictEqual(handle.store.snapshot(24).value, 64);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].value, 64);
  assert.match(blocks[0](), /心情不错|平静/);
});
