'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isEnabled } = require('./settings');

const MOOD_DIR = 'data';
const MOOD_FILE = 'mood.json';

const DEFAULT_VALUE = 60;
const MIN_VALUE = 0;
const MAX_VALUE = 100;
const MAX_DELTA = 5;
const MAX_HISTORY = 500;

/** 数值分档。边界值归到这一档（20 → 低落，60 → 平静） */
const LEVELS = [
  { max: 20, label: '低落' },
  { max: 40, label: '有点丧' },
  { max: 60, label: '平静' },
  { max: 80, label: '心情不错' },
  { max: MAX_VALUE, label: '特别开心' },
];

function moodLabel(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '平静';
  for (let i = 0; i < LEVELS.length; i += 1) {
    if (num <= LEVELS[i].max) return LEVELS[i].label;
  }
  return LEVELS[LEVELS.length - 1].label;
}

function clampValue(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_VALUE;
  return Math.min(MAX_VALUE, Math.max(MIN_VALUE, Math.round(num)));
}

/** 心情增量只允许 -5 ~ +5，NaN 按 0 处理 */
function clampDelta(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(MAX_DELTA, Math.max(-MAX_DELTA, Math.round(num)));
}

function nowIso(clock) {
  return (clock ? clock() : new Date()).toISOString();
}

function emptyState(clock) {
  const at = nowIso(clock);
  return { value: DEFAULT_VALUE, label: moodLabel(DEFAULT_VALUE), createdAt: at, updatedAt: at, history: [] };
}

function normalizeEntry(raw) {
  return {
    at: typeof raw.at === 'string' ? raw.at : '',
    delta: clampDelta(raw.delta),
    value: clampValue(raw.value),
    reason: String(raw.reason == null ? '' : raw.reason).slice(0, 120),
  };
}

function normalizeState(raw, clock) {
  const value = clampValue(raw.value);
  const history = Array.isArray(raw.history) ? raw.history.map(normalizeEntry) : [];
  return {
    value: value,
    label: moodLabel(value),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(clock),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(clock),
    history: history.slice(-MAX_HISTORY),
  };
}

/**
 * 心情状态仓库。只有一份文件（全局心情，不分会话），
 * 写盘用 tmp + rename；坏文件先备份，再从「平静」重新开始。
 */
function createMoodStore(options) {
  const opts = options || {};
  const root = opts.root || process.cwd();
  const clock = typeof opts.now === 'function' ? opts.now : null;
  const warn = typeof opts.onWarn === 'function' ? opts.onWarn : function () {};

  const dir = path.join(root, MOOD_DIR);
  const file = path.join(dir, MOOD_FILE);
  let state = load();

  function load() {
    if (!fs.existsSync(file)) return emptyState(clock);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('结构不对');
      if (!Number.isFinite(Number(parsed.value))) throw new Error('value 不是数字');
      return normalizeState(parsed, clock);
    } catch (err) {
      const bad = file + '.corrupt-' + Date.now();
      try {
        fs.renameSync(file, bad);
      } catch (e) {
        // 挪不动就算了，下面会覆盖
      }
      warn('心情文件损坏，已备份到 ' + bad + '（' + err.message + '）');
      return emptyState(clock);
    }
  }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      warn('写心情文件失败：' + (err.code || err.message));
    }
  }

  /** hours 决定时间线回溯多久（默认 24 小时） */
  function snapshot(hours) {
    const span = Number(hours) > 0 ? Number(hours) : 24;
    const since = (clock ? clock() : new Date()).getTime() - span * 3600 * 1000;
    const history = state.history.filter(function (entry) {
      const at = new Date(entry.at).getTime();
      return Number.isFinite(at) && at >= since;
    });
    return { value: state.value, label: state.label, updatedAt: state.updatedAt, history: history };
  }

  function apply(delta, reason) {
    const step = clampDelta(delta);
    const value = clampValue(state.value + step);
    const at = nowIso(clock);
    const entry = { at: at, delta: step, value: value, reason: String(reason == null ? '' : reason).slice(0, 120) };

    state.value = value;
    state.label = moodLabel(value);
    state.updatedAt = at;
    state.history.push(entry);
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
    save();
    return entry;
  }

  function reset() {
    state = emptyState(clock);
    save();
    return snapshot(24);
  }

  return {
    file: file,
    read: function () { return JSON.parse(JSON.stringify(state)); },
    snapshot: snapshot,
    apply: apply,
    reset: reset,
  };
}

const PROMPT_TAIL = '（心情会自然渗进语气里，但不要报数值、不要说“我现在心情值多少”）';

/** 进 prompt 的心情段：当前档位 + 数值 + 最近几次变化 */
function buildPromptBlock(snapshot) {
  if (!snapshot || !Number.isFinite(Number(snapshot.value))) return '';
  const lines = ['【你现在的心情】', '心情：' + snapshot.label + '（约 ' + snapshot.value + '/100）'];
  const recent = Array.isArray(snapshot.history) ? snapshot.history.slice(-3) : [];
  if (recent.length > 0) {
    lines.push('最近的变化：' + recent.map(function (entry) {
      const sign = entry.delta > 0 ? '+' : '';
      return sign + entry.delta + (entry.reason ? '（' + entry.reason + '）' : '');
    }).join('、'));
  }
  lines.push(PROMPT_TAIL);
  return lines.join('\n');
}

const JUDGE_SYSTEM = [
  '你是情绪判定器。读一段对话，判断「她」在回复完之后心情变化了多少。',
  '只输出一个 JSON 对象，不要解释、不要 Markdown 代码块：{"delta": 整数, "reason": "不超过 20 字的原因"}',
  'delta 范围 -5 到 +5：被夸、聊得投机会升；被凶、被敷衍、被追问隐私会降；平常闲聊给 0 或 ±1。',
  'reason 用第三人称，写清楚是什么引起的。',
].join('\n');

function buildJudgeInput(info) {
  const current = info || {};
  return [
    '她当前的心情：' + (current.currentLabel || '平静') + '（' + (Number(current.currentValue) || DEFAULT_VALUE) + '/100）',
    '对方说：' + String(current.userText == null ? '' : current.userText),
    '她回：' + String(current.replyText == null ? '' : current.replyText),
  ].join('\n\n');
}

/** 容错解析：允许前后有解释文字或代码块围栏；解析不出就返回 null（本轮跳过） */
function parseMoodReply(text) {
  const raw = String(text == null ? '' : text);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const delta = Number(parsed.delta);
  if (!Number.isFinite(delta)) return null;
  return { delta: clampDelta(delta), reason: String(parsed.reason == null ? '' : parsed.reason).trim().slice(0, 60) };
}

/** llm: async ({ messages, temperature }) => string */
async function judgeMood(llm, info) {
  const text = await llm({
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: buildJudgeInput(info) },
    ],
    temperature: 0,
  });
  return parseMoodReply(text);
}

/** 能力模块：心情（config.features.mood） */
function createMoodModule(options) {
  const opts = options || {};
  return {
    name: 'mood',
    enabled: function (config) { return isEnabled(config, 'mood'); },
    init: function (ctx) {
      const store = opts.store || createMoodStore({
        root: ctx.dataRoot,
        now: opts.now,
        onWarn: function (msg) { ctx.logger.warn('[mood] ' + msg); },
      });
      const llmFor = typeof opts.llm === 'function' ? opts.llm : function () { return ctx.makeLlm(); };

      ctx.addPromptBlock(function () {
        return buildPromptBlock(store.snapshot(24));
      });

      ctx.route('GET', '/api/mood', function (req, res) {
        ctx.sendJson(res, 200, { ok: true, mood: store.snapshot(24) });
      });

      ctx.addAfterReply(async function (info) {
        const llm = llmFor();
        if (typeof llm !== 'function') return;
        const current = store.snapshot(1);
        const verdict = await judgeMood(llm, {
          currentLabel: current.label,
          currentValue: current.value,
          userText: info && info.userText,
          replyText: info && info.replyText,
        });
        if (!verdict) {
          ctx.logger.warn('[mood] 判定解析不出来，本轮跳过');
          return;
        }
        const entry = store.apply(verdict.delta, verdict.reason);
        ctx.logger.log('[mood] ' + (entry.delta > 0 ? '+' : '') + entry.delta + ' → ' + entry.value + '（' + verdict.reason + '）');
        ctx.bus.emit('mood', store.snapshot(24));
      });

      return { store: store };
    },
  };
}

module.exports = {
  createMoodModule: createMoodModule,
  createMoodStore: createMoodStore,
  moodLabel: moodLabel,
  clampDelta: clampDelta,
  clampValue: clampValue,
  buildPromptBlock: buildPromptBlock,
  buildJudgeInput: buildJudgeInput,
  parseMoodReply: parseMoodReply,
  judgeMood: judgeMood,
  DEFAULT_VALUE: DEFAULT_VALUE,
  MIN_VALUE: MIN_VALUE,
  MAX_VALUE: MAX_VALUE,
  MAX_DELTA: MAX_DELTA,
  MOOD_DIR: MOOD_DIR,
  MOOD_FILE: MOOD_FILE,
};
