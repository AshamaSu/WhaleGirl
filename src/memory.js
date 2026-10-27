'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = path.join('data', 'memory');

const DEFAULTS = {
  maxTurns: 40,          // 超过这么多条原文就压缩
  keepRecentTurns: 12,   // 压缩后保留最近多少条原文
  factDecay: 0.97,       // 每轮事实强度衰减
  minStrength: 0.15,     // 低于这个值就忘掉
  maxFacts: 40,          // 最多存多少条事实
  maxPromptFacts: 12,    // 进 prompt 的最多几条
  maxPromptChars: 1200,  // 记忆块最大长度
};

class MemoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryError';
  }
}

function safeSessionId(raw) {
  const id = String(raw == null ? '' : raw).trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return id === '' ? 'default' : id;
}

function nowIso() {
  return new Date().toISOString();
}

function emptyMemory(sessionId) {
  return {
    sessionId: sessionId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    turns: [],
    facts: [],
    summary: '',
    summaryAt: null,
    stats: { turns: 0, summarized: 0 },
  };
}

function normalizeFact(text) {
  return String(text == null ? '' : text)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[。．.!！?？]+$/, '');
}

/**
 * 打开（或新建）一个会话的记忆。
 * 每次调用都从磁盘读，服务端不持有跨请求状态 —— 热加载关掉时由 server 缓存这个对象。
 */
function openMemory(options) {
  const opts = options || {};
  const root = opts.root || process.cwd();
  const sessionId = safeSessionId(opts.sessionId);
  const settings = Object.assign({}, DEFAULTS, opts.settings || {});
  const warn = typeof opts.onWarn === 'function' ? opts.onWarn : function () {};

  const dir = path.join(root, DATA_DIR);
  const file = path.join(dir, sessionId + '.json');

  let data = null;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.turns) && Array.isArray(parsed.facts)) {
        data = parsed;
      } else {
        throw new Error('结构不对');
      }
    } catch (err) {
      const bad = file + '.corrupt-' + Date.now();
      try {
        fs.renameSync(file, bad);
      } catch (e) {
        // 挪不动就覆盖
      }
      warn('记忆文件损坏，已备份到 ' + bad + '（' + err.message + '）');
      data = null;
    }
  }
  if (!data) data = emptyMemory(sessionId);

  function save() {
    data.updatedAt = nowIso();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      warn('写记忆文件失败：' + (err.code || err.message));
    }
  }

  function decayFacts() {
    const kept = [];
    for (let i = 0; i < data.facts.length; i += 1) {
      const fact = data.facts[i];
      // 置顶的事实等于「永久记住」：不衰减，也不会被淘汰
      if (fact.pinned === true) {
        fact.strength = 1;
        kept.push(fact);
        continue;
      }
      fact.strength = Number(fact.strength || 1) * settings.factDecay;
      if (fact.strength >= settings.minStrength) kept.push(fact);
    }
    data.facts = kept;
  }

  function trimFacts() {
    if (data.facts.length <= settings.maxFacts) return;
    data.facts.sort(function (a, b) {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      if (b.strength !== a.strength) return b.strength - a.strength;
      return String(a.lastSeen) < String(b.lastSeen) ? 1 : -1;
    });
    data.facts = data.facts.slice(0, settings.maxFacts);
  }

  const api = {
    sessionId: sessionId,
    file: file,
    settings: settings,

    appendTurn(role, content) {
      const text = String(content == null ? '' : content).trim();
      if (text === '') return null;
      const turn = { role: role === 'assistant' ? 'assistant' : 'user', content: text, at: nowIso() };
      data.turns.push(turn);
      data.stats.turns += 1;
      decayFacts();
      save();
      return turn;
    },

    recentTurns(limit) {
      const count = limit || settings.keepRecentTurns;
      return data.turns.slice(Math.max(0, data.turns.length - count)).map(function (turn) {
        return { role: turn.role, content: turn.content };
      });
    },

    addFact(text, source) {
      const factText = normalizeFact(text);
      if (factText === '') return null;

      for (let i = 0; i < data.facts.length; i += 1) {
        if (normalizeFact(data.facts[i].text) === factText) {
          data.facts[i].text = factText;
          data.facts[i].lastSeen = nowIso();
          data.facts[i].strength = 1;
          save();
          return data.facts[i];
        }
      }

      const fact = {
        id: 'f_' + crypto.randomBytes(4).toString('hex'),
        text: factText,
        at: nowIso(),
        lastSeen: nowIso(),
        strength: 1,
        pinned: false,
        source: source === 'tool' ? 'tool' : 'auto',
      };
      data.facts.push(fact);
      trimFacts();
      save();
      return fact;
    },

    facts() {
      return data.facts.slice();
    },

    /** 置顶 = 永久记住：强度拉回 1，之后不再衰减 */
    setPinned(id, pinned) {
      const fact = data.facts.find(function (item) { return item.id === id; });
      if (!fact) return null;
      fact.pinned = pinned === true;
      if (fact.pinned) fact.strength = 1;
      save();
      return fact;
    },

    removeFact(id) {
      const before = data.facts.length;
      data.facts = data.facts.filter(function (item) { return item.id !== id; });
      if (data.facts.length === before) return false;
      save();
      return true;
    },

    factsForPrompt() {
      const alive = data.facts.filter(function (fact) {
        return Number(fact.strength || 0) >= settings.minStrength;
      });
      alive.sort(function (a, b) {
        if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
        if (b.strength !== a.strength) return b.strength - a.strength;
        return String(a.lastSeen) < String(b.lastSeen) ? 1 : -1;
      });
      return alive.slice(0, settings.maxPromptFacts);
    },

    /** 记忆层进 prompt 的文本：摘要 + 事实（带日期） */
    memoryBlock() {
      const parts = [];
      if (data.summary) parts.push('【你还记得的往事】\n' + data.summary);

      const facts = api.factsForPrompt();
      if (facts.length > 0) {
        parts.push('【你记得关于对方的事】\n' + facts.map(function (fact) {
          return '- ' + String(fact.at).slice(0, 10) + '：' + fact.text;
        }).join('\n'));
      }
      if (parts.length === 0) return '';

      let block = parts.join('\n\n') + '\n\n（这些是以前的记忆，合适的时候自然用上，不用刻意强调“我记得”）';
      if (block.length > settings.maxPromptChars) block = block.slice(0, settings.maxPromptChars) + '\n…';
      return block;
    },

    shouldSummarize() {
      return data.turns.length > settings.maxTurns;
    },

    turnsToSummarize() {
      const cut = data.turns.length - settings.keepRecentTurns;
      return cut > 0 ? data.turns.slice(0, cut) : [];
    },

    applySummary(summaryText, dropCount) {
      data.summary = String(summaryText == null ? '' : summaryText).trim();
      data.summaryAt = nowIso();
      const count = Math.max(0, Math.min(dropCount, data.turns.length));
      data.turns = data.turns.slice(count);
      data.stats.summarized += count;
      save();
    },

    /** 导出：给页面看和备份用 */
    export() {
      return JSON.parse(JSON.stringify(data));
    },

    clear() {
      data = emptyMemory(sessionId);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
      } catch (err) {
        warn('清空记忆失败：' + (err.code || err.message));
      }
      return data;
    },

    save: save,
  };

  return api;
}

function memoryDir(root) {
  return path.join(root, DATA_DIR);
}

function readSessionFile(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.turns) || !Array.isArray(parsed.facts)) {
    throw new Error('结构不对');
  }
  return parsed;
}

/** 会话列表：给时间线页面用。坏文件跳过，不让一个坏文件把整页拖崩 */
function listSessions(options) {
  const opts = options || {};
  const dir = memoryDir(opts.root || process.cwd());
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const out = [];
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = readSessionFile(path.join(dir, name));
    } catch (err) {
      continue;
    }
    const pinned = parsed.facts.filter(function (fact) { return fact.pinned === true; }).length;
    out.push({
      sessionId: safeSessionId(parsed.sessionId || name.replace(/\.json$/, '')),
      createdAt: String(parsed.createdAt || ''),
      updatedAt: String(parsed.updatedAt || ''),
      turns: parsed.turns.length,
      facts: parsed.facts.length,
      pinned: pinned,
      summarized: Number(parsed.stats && parsed.stats.summarized) || 0,
      summary: String(parsed.summary || '').slice(0, 80),
    });
  }
  out.sort(function (a, b) {
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
  return out;
}

const BACKUP_VERSION = 1;

/** 整包导出（JSON）：备份/恢复用，不引第三方压缩库 */
function exportAll(options) {
  const opts = options || {};
  const dir = memoryDir(opts.root || process.cwd());
  const bundle = { version: BACKUP_VERSION, exportedAt: nowIso(), sessions: [] };

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return bundle;
    throw err;
  }

  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (!name.endsWith('.json')) continue;
    let parsed;
    try {
      parsed = readSessionFile(path.join(dir, name));
    } catch (err) {
      continue;
    }
    bundle.sessions.push({
      sessionId: safeSessionId(parsed.sessionId || name.replace(/\.json$/, '')),
      memory: parsed,
    });
  }
  return bundle;
}

/**
 * 整包恢复：同名会话先备份成 .bak-时间戳，再原子覆盖。
 * 返回明细而不抛错——一个会话坏了不该让整包恢复失败。
 */
function importAll(options) {
  const opts = options || {};
  const root = opts.root || process.cwd();
  const dir = memoryDir(root);
  const stamp = String(opts.stamp || Date.now());
  const bundle = opts.bundle || {};
  const result = { imported: 0, skipped: 0, errors: [] };

  const sessions = Array.isArray(bundle.sessions) ? bundle.sessions : null;
  if (!sessions) {
    result.errors.push('备份文件里没有 sessions 数组');
    return result;
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    result.errors.push('建不了记忆目录：' + (err.code || err.message));
    return result;
  }

  for (let i = 0; i < sessions.length; i += 1) {
    const item = sessions[i];
    const memory = item && item.memory;
    if (!memory || typeof memory !== 'object' || !Array.isArray(memory.turns) || !Array.isArray(memory.facts)) {
      result.skipped += 1;
      result.errors.push('第 ' + (i + 1) + ' 个会话结构不对，已跳过');
      continue;
    }

    const sessionId = safeSessionId(item.sessionId || memory.sessionId);
    const file = path.join(dir, sessionId + '.json');
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, file + '.bak-' + stamp);
      } catch (err) {
        // 备份失败不挡恢复，但记一笔让人知道
        result.errors.push(sessionId + ' 的旧文件备份失败：' + (err.code || err.message));
      }
    }

    const restored = Object.assign({}, memory, { sessionId: sessionId, restoredAt: nowIso() });
    try {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(restored, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
      result.imported += 1;
    } catch (err) {
      result.skipped += 1;
      result.errors.push(sessionId + ' 写入失败：' + (err.code || err.message));
    }
  }
  return result;
}

const EXTRACT_SYSTEM = [
  '你是记忆整理员。从对话里抽取关于「对方」的长期事实。',
  '只抽取三类：身份信息（名字、称呼、住处、职业、家人宠物）、稳定的偏好与忌讳、明确约定过的事。',
  '不要抽取：一次性的情绪、临时安排、闲聊、你自己的话、以及任何需要猜测才能得出的结论。',
  '每条一句话，第三人称，不超过 40 字，像「他叫阿龙」「她讨厌香菜」这样。',
  '每行一条，不加编号和标点装饰；没有任何值得记的就只输出 NONE。',
].join('\n');

function transcript(turns) {
  return turns.map(function (turn) {
    return (turn.role === 'user' ? '对方：' : '她：') + turn.content;
  }).join('\n');
}

function parseFacts(text) {
  const seen = {};
  const facts = [];
  const lines = String(text == null ? '' : text).split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i].trim();
    line = line.replace(/^[-*·•\d.、)\s]+/, '').replace(/^["“「]|["”」]$/g, '').trim();
    if (line === '' || line.length > 120) continue;
    if (/^(NONE|none|无|没有)$/.test(line)) continue;
    const key = normalizeFact(line);
    if (seen[key]) continue;
    seen[key] = true;
    facts.push(line);
  }
  return facts;
}

const SUMMARY_SYSTEM = [
  '你是记忆整理员。把下面这段旧对话压缩成一段摘要，给以后的自己看。',
  '保留：对方透露的事实、双方的情绪变化、没聊完的话题、约定过的事。',
  '丢掉：寒暄、重复内容、你的具体措辞。',
  '用第三人称陈述，200 字以内，只输出摘要正文。',
].join('\n');

/** llm: async ({messages, temperature}) => string */
async function extractFacts(llm, turns) {
  if (!turns || turns.length === 0) return [];
  const text = await llm({
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: transcript(turns) },
    ],
    temperature: 0.2,
  });
  return parseFacts(text);
}

async function summarizeTurns(llm, turns, previousSummary) {
  if (!turns || turns.length === 0) return '';
  const content = (previousSummary ? '之前的摘要：\n' + previousSummary + '\n\n' : '') + '要压缩的对话：\n' + transcript(turns);
  return (await llm({
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: content },
    ],
    temperature: 0.3,
  })).trim();
}

module.exports = {
  MemoryError: MemoryError,
  openMemory: openMemory,
  safeSessionId: safeSessionId,
  normalizeFact: normalizeFact,
  parseFacts: parseFacts,
  extractFacts: extractFacts,
  summarizeTurns: summarizeTurns,
  transcript: transcript,
  listSessions: listSessions,
  exportAll: exportAll,
  importAll: importAll,
  DEFAULTS: DEFAULTS,
  DATA_DIR: DATA_DIR,
  BACKUP_VERSION: BACKUP_VERSION,
};
