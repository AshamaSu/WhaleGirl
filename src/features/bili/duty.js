'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DUTY_FILE = 'prompts/bili-duty.md';
const MAX_SEEN_LINES = 40;

const PLACEHOLDERS = ['owner', 'keywords', 'seen', 'minPlays', 'maxDaysOld', 'n'];

function readDuty(root, file) {
  const target = path.isAbsolute(String(file || '')) ? file : path.join(root, file || DEFAULT_DUTY_FILE);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    throw new Error('读不到子代理章程：' + target + '（' + (err.code || err.message) + '）');
  }
  if (text.trim() === '') throw new Error('子代理章程是空的：' + target);
  return { text: text, path: target };
}

/** 占位符只替换一次，避免注入进来的文本里带 {n} 被二次替换 */
function renderDuty(template, vars) {
  const values = vars || {};
  let out = String(template == null ? '' : template);
  for (let i = 0; i < PLACEHOLDERS.length; i += 1) {
    const key = PLACEHOLDERS[i];
    const value = values[key] === undefined || values[key] === null ? '' : String(values[key]);
    out = out.split('{' + key + '}').join(value);
  }
  return out;
}

function keywordsText(keywords) {
  const list = Array.isArray(keywords) ? keywords.map(function (item) { return String(item || '').trim(); }).filter(Boolean) : [];
  if (list.length === 0) return '（没有特别指定，按你自己的判断挑大众也会觉得有意思的）';
  return list.join('、');
}

function seenText(lines) {
  const list = Array.isArray(lines) ? lines.filter(Boolean).slice(0, MAX_SEEN_LINES) : [];
  if (list.length === 0) return '（还没有推荐过任何视频，这轮随便挑）';
  return list.map(function (line) { return '- ' + line; }).join('\n');
}

/**
 * 拼出这一轮的章程正文。
 * 章程文件放在 prompts/ 下，改语气/加规矩不用动代码，下一轮就生效。
 */
function buildDuty(options) {
  const opts = options || {};
  const loaded = readDuty(opts.root || process.cwd(), opts.file);
  const section = opts.section || {};
  const text = renderDuty(loaded.text, {
    owner: String(section.owner || '主人').trim() || '主人',
    keywords: keywordsText(section.keywords),
    seen: seenText(opts.seen),
    minPlays: Number(section.minPlays) > 0 ? Number(section.minPlays) : 0,
    maxDaysOld: Number(section.maxDaysOld) > 0 ? Number(section.maxDaysOld) : 0,
    n: Number(section.itemsPerRound) > 0 ? Number(section.itemsPerRound) : 1,
  });
  return { text: text, path: loaded.path };
}

module.exports = {
  buildDuty: buildDuty,
  readDuty: readDuty,
  renderDuty: renderDuty,
  keywordsText: keywordsText,
  seenText: seenText,
  DEFAULT_DUTY_FILE: DEFAULT_DUTY_FILE,
  MAX_SEEN_LINES: MAX_SEEN_LINES,
  PLACEHOLDERS: PLACEHOLDERS,
};
