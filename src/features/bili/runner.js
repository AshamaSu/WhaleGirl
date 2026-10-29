'use strict';

const { buildDuty } = require('./duty');
const { runAgent: defaultRunAgent } = require('../../agent');

const DEFAULT_MAX_ROUNDS = 8;
const MAX_ANNOUNCE_CHARS = 2000;

const PICK_LINE = /^###\s*(BV[0-9A-Za-z]{10})\s*$/gm;

/** 报告里顶格的 ### BV 行就是这一轮的入选清单（也是额度对账依据） */
function parsePicked(report) {
  const text = String(report == null ? '' : report);
  const found = [];
  let match;
  PICK_LINE.lastIndex = 0;
  while ((match = PICK_LINE.exec(text)) !== null) {
    if (found.indexOf(match[1]) === -1) found.push(match[1]);
  }
  return found;
}

const ITEM_HEAD = /^###\s*(BV[0-9A-Za-z]{10})\s*$/;

/** 把报告里的每个 ### BV 块拆成 {bvid,title,up,link}，供浏览历史与对话引用 */
function parsePickedItems(report) {
  const lines = String(report == null ? '' : report).split('\n');
  const items = [];
  let current = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const head = ITEM_HEAD.exec(line);
    if (head) {
      current = { bvid: head[1], title: '', up: '', link: '' };
      items.push(current);
      continue;
    }
    if (!current) continue;
    if (line.indexOf('标题：') === 0) current.title = line.slice(3).trim();
    else if (line.indexOf('UP：') === 0) current.up = line.slice(3).trim();
    else if (line.indexOf('链接：') === 0) current.link = line.slice(3).trim();
  }
  for (let i = 0; i < items.length; i += 1) {
    if (!items[i].link) items[i].link = 'https://www.bilibili.com/video/' + items[i].bvid;
  }
  return items;
}

function triggerText(trigger) {
  return trigger === 'auto' ? '自动' : '手动';
}

function buildUserMessage(options) {
  const opts = options || {};
  const at = opts.at instanceof Date ? opts.at : new Date();
  const time = at.getFullYear() + '-' + String(at.getMonth() + 1).padStart(2, '0') + '-' + String(at.getDate()).padStart(2, '0') +
    ' ' + String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
  return [
    '到点了，去刷一轮 B站。现在是 ' + time + '。',
    '按章程做事：先看判重清单，再挑，最后按格式交报告。最多挑 ' + (Number(opts.itemsPerRound) > 0 ? Number(opts.itemsPerRound) : 1) + ' 条。',
  ].join('\n');
}

function sectionReport(header, body) {
  return header + '\n' + String(body == null ? '' : body).trim() + '\n';
}

/**
 * 跑一轮子代理。
 * 关键约定：无论成功失败都落一行报告（失败也要花钱，白烧没人知道才是最糟的）；
 * 任何异常都不外抛，调用方只看到一个 { ok, error }。
 */
async function runBiliRound(options) {
  const opts = options || {};
  const store = opts.store;
  const section = opts.section || {};
  const logger = opts.logger || console;
  const clock = typeof opts.now === 'function' ? opts.now : function () { return new Date(); };
  const agent = typeof opts.runAgent === 'function' ? opts.runAgent : defaultRunAgent;
  const at = clock();
  const trigger = opts.trigger === 'auto' ? 'auto' : 'manual';
  const header = '## ' + store.stamp(at) + ' · ' + triggerText(trigger);
  const maxRounds = Number(section.maxRounds) > 0 ? Number(section.maxRounds) : DEFAULT_MAX_ROUNDS;

  let report = '';
  let picked = [];
  let toolCalls = 0;

  try {
    const duty = buildDuty({
      root: opts.root,
      file: section.dutyFile,
      section: section,
      seen: store.seenLines(40),
    });

    const messages = [
      { role: 'system', content: duty.text },
      { role: 'user', content: buildUserMessage({ at: at, itemsPerRound: section.itemsPerRound }) },
    ];

    let finalText = '';
    const stream = agent({
      provider: opts.provider,
      messages: messages,
      tools: opts.tools,
      maxRounds: maxRounds,
      temperature: 0.6,
      timeoutMs: opts.timeoutMs,
    });

    for await (const event of stream) {
      if (event.type === 'tool') toolCalls += 1;
      if (event.type === 'final') finalText = event.text || finalText;
    }

    const body = String(finalText || '').trim();
    if (body === '') throw new Error('子代理没有产出报告（可能模型直接空回复）');
    // 工具轮次用尽后，DeepSeek 有时会以 DSML 文本形式再要一次工具；这段不能当报告落盘
    if (/｜｜DSML｜｜/.test(body)) {
      throw new Error('模型把工具调用写成了文本（DSML），本轮作废；通常是工具轮次用尽后仍想继续调用');
    }

    report = sectionReport(header, body);
    picked = parsePicked(body);

    store.appendReport(report, at);
    store.appendDigest(report, at);
    if (picked.length > 0) store.markSeen(picked, 'picked');
    store.recordRun({ auto: trigger === 'auto', ok: true, picked: picked.length, error: '' });

    if (logger && typeof logger.log === 'function') {
      logger.log('[bili] ' + triggerText(trigger) + '一轮完成：挑中 ' + picked.length + ' 条，工具调用 ' + toolCalls + ' 次');
    }
    return { ok: true, at: at, trigger: trigger, report: report, picked: picked, items: parsePickedItems(report), toolCalls: toolCalls, error: '' };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    report = sectionReport(header, '本轮失败：' + message);
    store.appendReport(report, at);
    store.recordRun({ auto: trigger === 'auto', ok: false, picked: 0, error: message });

    if (logger && typeof logger.warn === 'function') logger.warn('[bili] ' + triggerText(trigger) + '一轮失败：' + message);
    return { ok: false, at: at, trigger: trigger, report: report, picked: [], items: [], toolCalls: toolCalls, error: message };
  }
}

/**
 * 播报指令：报告是客观素材，人设由主娘的 system prompt 负责，
 * 所以这里只交代"用你自己的口吻讲 2~3 条，别复述报告"。
 */
function buildAnnounceMessages(personaMessages, report) {
  const instruction = [
    '（你刚自己去 B站 刷了一圈，下面是你的阅稿人整理的素材。用你自己的口吻挑 2~3 条讲给他听：',
    '像在跟他分享刚看到的好东西，不要罗列原文、不要提"报告""子代理""阅稿人"，不要念标题列表；',
    '每条后面附上素材里对应的 B站 链接，方便他点开。）',
    '',
    String(report == null ? '' : report).slice(0, MAX_ANNOUNCE_CHARS),
  ].join('\n');

  const base = Array.isArray(personaMessages) ? personaMessages.slice() : [];
  base.push({ role: 'user', content: instruction });
  return base;
}

/**
 * 模型爱一段一段写，空行分块是对的；但一整条链接单独一行会很丑，
 * 所以自己按行收，遇到"只有链接"的行就并回上一句——链接永远跟着它描述的那条视频。
 */
function splitBubbles(text, max) {
  const limit = Number(max) > 0 ? Number(max) : 3;
  const lines = String(text == null ? '' : text)
    .replace(/\r/g, '')
    .split('\n')
    .map(function (line) { return line.replace(/^\s*(?:[-*·]|\d+[.、)])\s*/, '').trim(); })
    .filter(function (line) { return line !== ''; });

  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const last = blocks[blocks.length - 1];
    if (last !== undefined && /^https?:\/\/\S+$/.test(line)) blocks[blocks.length - 1] = last + ' ' + line;
    else blocks.push(line);
  }

  if (blocks.length === 0) return [];
  if (blocks.length <= limit) return blocks;

  const head = blocks.slice(0, limit - 1);
  head.push(blocks.slice(limit - 1).join(' '));
  return head;
}

module.exports = {
  runBiliRound: runBiliRound,
  parsePicked: parsePicked,
  parsePickedItems: parsePickedItems,
  buildUserMessage: buildUserMessage,
  buildAnnounceMessages: buildAnnounceMessages,
  splitBubbles: splitBubbles,
  DEFAULT_MAX_ROUNDS: DEFAULT_MAX_ROUNDS,
};
