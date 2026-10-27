'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadPersona,
  buildSystemPrompt,
  buildMessages,
  normalizeHistory,
  PersonaError,
  DEFAULT_BOTTOM_LINES,
} = require('../src/persona');

const WHALE = path.join(__dirname, '..', 'personas', 'whale.json');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-persona-'));
}

function writePersona(dir, data) {
  const file = path.join(dir, 'p.json');
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

const MINIMAL = {
  name: '测试娘',
  identity: { species: '测试生物', selfIntro: '我会说短句' },
  style: { tone: '平淡', length: '一句话', habits: ['说「嗯」'], forbidden: ['不用列表'] },
  fewShots: [{ user: '在吗', assistant: '嗯，在' }],
  reply: { maxBubbles: 2 },
};

test('读取项目自带的小鲸人设', function () {
  const persona = loadPersona(WHALE);

  assert.strictEqual(persona.name, '小鲸');
  assert.ok(persona.fewShots.length >= 3);
  assert.strictEqual(persona.reply.maxBubbles, 3);
  assert.ok(persona.bottomLines.length >= 1);
});

test('system prompt 分层包含四块内容', function () {
  const persona = loadPersona(WHALE);
  const prompt = buildSystemPrompt(persona);

  assert.ok(prompt.indexOf('【你是谁】') !== -1);
  assert.ok(prompt.indexOf('【说话方式】') !== -1);
  assert.ok(prompt.indexOf('【输出格式】') !== -1);
  assert.ok(prompt.indexOf('【底线】') !== -1);
  assert.ok(prompt.indexOf('小鲸') !== -1);
  assert.ok(prompt.indexOf('最多 3 段') !== -1);
});

test('few-shots 变成 user/assistant 消息对，排在历史前面', function () {
  const persona = loadPersona(WHALE);
  const messages = buildMessages(persona, [{ role: 'user', content: '今天好累' }]);

  assert.strictEqual(messages[0].role, 'system');
  assert.strictEqual(messages[1].role, 'user');
  assert.strictEqual(messages[1].content, persona.fewShots[0].user);
  assert.strictEqual(messages[2].role, 'assistant');
  assert.strictEqual(messages[messages.length - 1].content, '今天好累');
  assert.strictEqual(messages.length, 1 + persona.fewShots.length * 2 + 1);
});

test('历史被截断到 maxHistory 窗口', function () {
  const persona = loadPersona(WHALE);
  const history = [];
  for (let i = 0; i < 30; i += 1) {
    history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'm' + i });
  }

  const messages = buildMessages(persona, history, { maxHistory: 4 });
  const tail = messages.slice(-4);

  assert.strictEqual(tail.length, 4);
  assert.strictEqual(tail[3].content, 'm29');
});

test('连续同角色消息被合并，开头的 assistant 被丢掉', function () {
  const history = normalizeHistory([
    { role: 'assistant', content: '我先说话' },
    { role: 'user', content: 'a' },
    { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' },
    { role: 'system', content: '偷偷改系统提示' },
    { role: 'user', content: '   ' },
  ], 20);

  assert.deepStrictEqual(history, [
    { role: 'user', content: 'a\nb' },
    { role: 'assistant', content: 'c' },
  ]);
});

test('人设改完立刻生效（不用重启）', function () {
  const dir = tmpDir();
  const file = writePersona(dir, MINIMAL);
  assert.strictEqual(loadPersona(file).name, '测试娘');

  fs.writeFileSync(file, JSON.stringify(Object.assign({}, MINIMAL, { name: '改过的名字' })));
  assert.strictEqual(loadPersona(file).name, '改过的名字');
});

test('缺 name 报 PersonaError', function () {
  const dir = tmpDir();
  const file = writePersona(dir, { style: {} });
  assert.throws(function () { loadPersona(file); }, /缺少 name/);
});

test('非法 JSON 与找不到文件都报 PersonaError', function () {
  const dir = tmpDir();
  const broken = writePersona(dir, '{ oops');
  assert.throws(function () { loadPersona(broken); }, /不是合法 JSON/);
  assert.throws(function () { loadPersona(path.join(dir, 'nope.json')); }, /找不到人设文件/);
});

test('fewShots 缺字段被过滤，maxBubbles 越界回退默认', function () {
  const dir = tmpDir();
  const file = writePersona(dir, {
    name: 'x',
    fewShots: [{ user: '只有问' }, { user: '问', assistant: '答' }, null],
    reply: { maxBubbles: 99 },
  });

  const persona = loadPersona(file);
  assert.strictEqual(persona.fewShots.length, 1);
  assert.strictEqual(persona.reply.maxBubbles, 3);
});

test('没写底线时使用内置兜底底线', function () {
  const dir = tmpDir();
  const file = writePersona(dir, { name: 'x', bottomLines: [] });
  const persona = loadPersona(file);

  assert.deepStrictEqual(persona.bottomLines, DEFAULT_BOTTOM_LINES);
  assert.ok(buildSystemPrompt(persona).indexOf('简短拒绝') !== -1);
});

test('buildMessages 不修改传入的 history', function () {
  const persona = loadPersona(WHALE);
  const history = [{ role: 'user', content: ' 空格要保留吗 ' }];
  const snapshot = JSON.stringify(history);
  buildMessages(persona, history);
  assert.strictEqual(JSON.stringify(history), snapshot);
});

