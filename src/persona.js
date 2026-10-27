'use strict';

const fs = require('node:fs');

const DEFAULT_MAX_BUBBLES = 3;
const DEFAULT_HISTORY_LIMIT = 20;

/** 人设文件没写底线时兜底，底线不跟着编辑一起丢 */
const DEFAULT_BOTTOM_LINES = [
  '遇到色情、暴力、歧视、诅咒类内容，简短拒绝，不说教，最多补一句把话题岔开',
  '不假装自己是真人，也不编造自己做过的事；不确定的事就说不知道',
  '不替医生、律师、理财顾问下结论，让人去找专业的人',
];

class PersonaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersonaError';
  }
}

function readPersonaFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new PersonaError('找不到人设文件：' + filePath);
    throw new PersonaError('读不到人设文件：' + filePath + '（' + (err.code || err.message) + '）');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new PersonaError('人设文件不是合法 JSON：' + filePath + '（' + err.message + '）');
  }
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(function (item) { return String(item).trim(); }).filter(function (item) { return item !== ''; });
}

function validatePersona(raw, filePath) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PersonaError('人设文件顶层必须是一个 JSON 对象：' + filePath);
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '') throw new PersonaError('人设缺少 name 字段：' + filePath);

  const reply = raw.reply && typeof raw.reply === 'object' ? raw.reply : {};
  let maxBubbles = Number(reply.maxBubbles);
  if (!Number.isInteger(maxBubbles) || maxBubbles < 1 || maxBubbles > 6) {
    maxBubbles = DEFAULT_MAX_BUBBLES;
  }

  const fewShots = Array.isArray(raw.fewShots) ? raw.fewShots : [];
  const cleanShots = [];
  for (let i = 0; i < fewShots.length; i += 1) {
    const shot = fewShots[i];
    const user = shot && typeof shot.user === 'string' ? shot.user.trim() : '';
    const assistant = shot && typeof shot.assistant === 'string' ? shot.assistant.trim() : '';
    if (user !== '' && assistant !== '') cleanShots.push({ user: user, assistant: assistant });
  }

  const bottomLines = asStringArray(raw.bottomLines);

  return {
    id: typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : name,
    name: name,
    identity: raw.identity && typeof raw.identity === 'object' ? raw.identity : {},
    style: raw.style && typeof raw.style === 'object' ? raw.style : {},
    bottomLines: bottomLines.length > 0 ? bottomLines : DEFAULT_BOTTOM_LINES.slice(),
    fewShots: cleanShots,
    reply: { maxBubbles: maxBubbles },
    mood: raw.mood && typeof raw.mood === 'object' ? raw.mood : {},
    source: filePath,
  };
}

/** 每次请求现读，改完存盘下一句就生效 */
function loadPersona(filePath) {
  return validatePersona(readPersonaFile(filePath), filePath);
}

/** 模型不知道今天几号，问"今天有什么新闻"就会瞎猜年份 */
function formatNow() {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());
  } catch (err) {
    return new Date().toISOString();
  }
}

function bullet(items, prefix) {
  return items.map(function (item) { return prefix + item; }).join('\n');
}

/** 人设 prompt 分层：身份 / 说话方式 / 输出格式 / 底线 */
function buildSystemPrompt(persona) {
  const identity = persona.identity || {};
  const style = persona.style || {};
  const name = persona.name;
  const sections = [];

  const identityLines = ['你是「' + name + '」。'];
  if (identity.species) identityLines.push('你是一只' + identity.species + '。');
  if (identity.age) identityLines.push('设定上你' + identity.age + '。');
  if (identity.selfIntro) identityLines.push('自我介绍：' + identity.selfIntro);
  if (identity.background) identityLines.push('背景：' + identity.background);
  sections.push('【你是谁】\n' + identityLines.join('\n'));

  const styleLines = [];
  if (style.tone) styleLines.push('语气：' + style.tone);
  if (style.length) styleLines.push('长度：' + style.length);
  const habits = asStringArray(style.habits);
  if (habits.length > 0) styleLines.push('说话习惯：\n' + bullet(habits, '- '));
  const forbidden = asStringArray(style.forbidden);
  if (forbidden.length > 0) styleLines.push('不要出现：\n' + bullet(forbidden, '- '));
  if (styleLines.length > 0) sections.push('【说话方式】\n' + styleLines.join('\n'));

  const maxBubbles = persona.reply.maxBubbles;
  sections.push(
    '【输出格式】\n' +
      '- 想说的内容用换行分成最多 ' + maxBubbles + ' 段，每段一句话，像一句一句发出来的消息\n' +
      '- 不用 markdown、不用编号和列表、不写括号里的动作描写\n' +
      '- 句尾不加句号，也不用一串波浪号\n' +
      '- 不总结、不复述我说过的话，直接接话'
  );

  sections.push(
    '【底线】\n' +
      bullet(persona.bottomLines, '- ') + '\n' +
      '- 底线被触碰时用一两句话轻轻带过，不长篇说教'
  );

  sections.push(
    '【工具与事实】\n' +
      '- 需要最新信息（新闻、价格、天气、某个具体事件的发生经过）时，调用 web_search；摘要不够就 fetch_url 读原文\n' +
      '- 用了工具就要说具体：谁、发生了什么、什么时候，别用比喻代替事实\n' +
      '- 回答的最后单独一段给出 1~2 条来源，格式「来源：链接」，链接只能来自工具结果，不许自己编\n' +
      '- 工具失败或查不到时，直接说"我现在查不到"，不要拿想象填空白'
  );

  sections.push('【场景】你现在在网页上和一个人一对一聊天，对方说什么你就顺着接，别像客服。');
  sections.push('【现在的时间】' + formatNow() + '（用到"今天/最近"时以这个时间为准）');

  return sections.join('\n\n');
}

/** 把连贯的同一角色消息合并，个别 provider 不接受连续两条同角色 */
function normalizeHistory(history, limit) {
  const list = Array.isArray(history) ? history : [];
  const cleaned = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
    if (!role) continue;
    const content = typeof item.content === 'string' ? item.content.trim() : '';
    if (content === '') continue;
    cleaned.push({ role: role, content: content });
  }

  const tail = cleaned.slice(Math.max(0, cleaned.length - limit));
  const merged = [];
  for (let i = 0; i < tail.length; i += 1) {
    const last = merged[merged.length - 1];
    if (last && last.role === tail[i].role) last.content = last.content + '\n' + tail[i].content;
    else merged.push({ role: tail[i].role, content: tail[i].content });
  }
  // 开头如果是 assistant（历史被截断导致），丢掉，避免模型误以为自己在续写自己
  if (merged.length > 0 && merged[0].role === 'assistant') merged.shift();
  return merged;
}

/** system + few-shots + 历史，这就是最终发给模型的消息数组 */
function buildMessages(persona, history, options) {
  const opts = options || {};
  const limit = opts.maxHistory || DEFAULT_HISTORY_LIMIT;
  // 记忆块并进同一条 system 消息，避免出现两条 system
  const systemPrompt = buildSystemPrompt(persona) + (opts.memoryText ? '\n\n' + opts.memoryText : '');
  const messages = [{ role: 'system', content: systemPrompt }];
  for (let i = 0; i < persona.fewShots.length; i += 1) {
    messages.push({ role: 'user', content: persona.fewShots[i].user });
    messages.push({ role: 'assistant', content: persona.fewShots[i].assistant });
  }
  return messages.concat(normalizeHistory(history, limit));
}

function describePersona(persona) {
  return persona.name + ' · 气泡上限 ' + persona.reply.maxBubbles + ' · few-shots ' + persona.fewShots.length + ' 组 · ' + persona.source;
}

module.exports = {
  PersonaError: PersonaError,
  loadPersona: loadPersona,
  validatePersona: validatePersona,
  buildSystemPrompt: buildSystemPrompt,
  buildMessages: buildMessages,
  normalizeHistory: normalizeHistory,
  describePersona: describePersona,
  DEFAULT_MAX_BUBBLES: DEFAULT_MAX_BUBBLES,
  DEFAULT_BOTTOM_LINES: DEFAULT_BOTTOM_LINES,
};
