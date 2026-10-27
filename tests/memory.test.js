'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  openMemory,
  safeSessionId,
  parseFacts,
  extractFacts,
  summarizeTurns,
  normalizeFact,
} = require('../src/memory');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wg-mem-'));
}

test('appendTurn 与 recentTurns 只给最近几条', function () {
  const mem = openMemory({ root: tmpRoot(), sessionId: 's1' });

  mem.appendTurn('user', '一');
  mem.appendTurn('assistant', '二');
  mem.appendTurn('user', '三');

  assert.deepStrictEqual(mem.recentTurns(2), [
    { role: 'assistant', content: '二' },
    { role: 'user', content: '三' },
  ]);
  assert.deepStrictEqual(mem.recentTurns(99).length, 3);
});

test('空内容不写入', function () {
  const mem = openMemory({ root: tmpRoot() });
  assert.strictEqual(mem.appendTurn('user', '   '), null);
  assert.strictEqual(mem.recentTurns(10).length, 0);
});

test('同一条事实重复写入只保留一条，并刷回强度', function () {
  const mem = openMemory({ root: tmpRoot(), settings: { factDecay: 0.5 } });

  mem.addFact('他叫阿龙。');
  mem.appendTurn('user', 'x');
  const afterDecay = mem.facts()[0].strength;
  assert.ok(afterDecay < 1);

  mem.addFact(' 他叫阿龙 ');
  assert.strictEqual(mem.facts().length, 1);
  assert.strictEqual(mem.facts()[0].strength, 1);
  assert.strictEqual(mem.facts()[0].text, '他叫阿龙');
});

test('事实超过上限时丢掉最弱的', function () {
  const mem = openMemory({ root: tmpRoot(), settings: { maxFacts: 2 } });
  mem.addFact('a');
  mem.addFact('b');
  mem.addFact('c');

  assert.strictEqual(mem.facts().length, 2);
});

test('每轮衰减，低于阈值就忘掉', function () {
  const mem = openMemory({ root: tmpRoot(), settings: { factDecay: 0.5, minStrength: 0.15 } });
  mem.addFact('他住在杭州');

  mem.appendTurn('user', '1');
  mem.appendTurn('user', '2');
  assert.strictEqual(mem.facts().length, 1);

  mem.appendTurn('user', '3');
  mem.appendTurn('user', '4');
  assert.strictEqual(mem.facts().length, 0);
  assert.strictEqual(mem.memoryBlock(), '');
});

test('memoryBlock 含摘要与带日期的事实', function () {
  const mem = openMemory({ root: tmpRoot(), settings: { maxTurns: 2, keepRecentTurns: 1 } });
  mem.addFact('他叫阿龙');
  mem.appendTurn('user', 'a');
  mem.appendTurn('user', 'b');
  mem.appendTurn('user', 'c');
  mem.applySummary('他最近在忙搬家', mem.turnsToSummarize().length);

  const block = mem.memoryBlock();
  assert.match(block, /【你还记得的往事】/);
  assert.match(block, /他最近在忙搬家/);
  assert.match(block, /【你记得关于对方的事】/);
  assert.match(block, new RegExp('- \\d{4}-\\d{2}-\\d{2}：他叫阿龙'));
  assert.match(block, /不用刻意强调/);
});

test('摘要触发条件与压缩后保留最近几条', function () {
  const mem = openMemory({ root: tmpRoot(), settings: { maxTurns: 4, keepRecentTurns: 2 } });
  for (let i = 0; i < 6; i += 1) mem.appendTurn('user', 'm' + i);

  assert.strictEqual(mem.shouldSummarize(), true);
  const toSummarize = mem.turnsToSummarize();
  assert.strictEqual(toSummarize.length, 4);
  assert.strictEqual(toSummarize[0].content, 'm0');

  mem.applySummary('旧事摘要', toSummarize.length);
  assert.strictEqual(mem.shouldSummarize(), false);
  assert.deepStrictEqual(mem.recentTurns(10).map(function (t) { return t.content; }), ['m4', 'm5']);
});

test('记忆写盘后重新打开还在，文件权限 600', function () {
  const root = tmpRoot();
  const first = openMemory({ root: root, sessionId: 'abc' });
  first.addFact('她养了一只猫');
  first.appendTurn('user', '你好');

  const second = openMemory({ root: root, sessionId: 'abc' });
  assert.strictEqual(second.facts().length, 1);
  assert.strictEqual(second.facts()[0].text, '她养了一只猫');
  assert.strictEqual(second.recentTurns(10).length, 1);

  const mode = fs.statSync(second.file).mode & 0o777;
  assert.strictEqual(mode, 0o600);
});

test('clear 清空内容但保留文件', function () {
  const mem = openMemory({ root: tmpRoot(), sessionId: 'c1' });
  mem.addFact('x');
  mem.appendTurn('user', 'y');

  mem.clear();
  assert.strictEqual(mem.facts().length, 0);
  assert.strictEqual(mem.recentTurns(10).length, 0);
  assert.strictEqual(fs.existsSync(mem.file), true);
});

test('export 返回深拷贝', function () {
  const mem = openMemory({ root: tmpRoot() });
  mem.addFact('a');
  const dumped = mem.export();
  dumped.facts[0].text = '改过了';

  assert.strictEqual(mem.facts()[0].text, 'a');
  assert.strictEqual(dumped.sessionId, 'default');
});

test('sessionId 会被清洗，挡掉路径穿越', function () {
  assert.strictEqual(safeSessionId('../../etc/passwd'), '______etc_passwd');
  assert.strictEqual(safeSessionId(''), 'default');

  const root = tmpRoot();
  const mem = openMemory({ root: root, sessionId: '../evil' });
  assert.strictEqual(path.dirname(mem.file), path.join(root, 'data', 'memory'));
});

test('记忆文件损坏时备份并从空开始', function () {
  const root = tmpRoot();
  const dir = path.join(root, 'data', 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{ 这不是 json');

  const warnings = [];
  const mem = openMemory({ root: root, sessionId: 'bad', onWarn: function (msg) { warnings.push(msg); } });

  assert.strictEqual(mem.facts().length, 0);
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /记忆文件损坏/);
  assert.ok(fs.readdirSync(dir).some(function (f) { return f.indexOf('bad.json.corrupt-') === 0; }));
});

test('parseFacts 过滤 NONE、去编号、去重、丢弃超长', function () {
  const facts = parseFacts([
    '他叫阿龙',
    '- 她养了一只猫',
    '1. 他叫阿龙。',
    'NONE',
    '',
    '无',
    'x'.repeat(130),
  ].join('\n'));

  assert.deepStrictEqual(facts, ['他叫阿龙', '她养了一只猫']);
});

test('extractFacts 与 summarizeTurns 走注入的 llm', async function () {
  const seen = [];
  const llm = async function (options) {
    seen.push(options);
    if (options.temperature === 0.2) return '他叫阿龙\n- 她讨厌香菜\nNONE';
    return '  他最近在搬家，情绪不错。  ';
  };

  const facts = await extractFacts(llm, [{ role: 'user', content: '我叫阿龙，讨厌香菜' }]);
  assert.deepStrictEqual(facts, ['他叫阿龙', '她讨厌香菜']);

  const summary = await summarizeTurns(llm, [{ role: 'user', content: '最近在搬家' }], '旧摘要');
  assert.strictEqual(summary, '他最近在搬家，情绪不错。');
  assert.match(seen[1].messages[1].content, /旧摘要/);
});

test('normalizeFact 去掉句尾标点与多余空格', function () {
  assert.strictEqual(normalizeFact('  他 叫 阿龙。 '), '他 叫 阿龙');
  assert.strictEqual(normalizeFact('x!!'), 'x');
});

