'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isEnabled } = require('./settings');

const MOOD_DIR = 'data';
const MOOD_FILE = 'mood.json';

const DEFAULT_VALUE = 60;
const MIN_VALUE = 0;
const MAX_VALUE = 100;
const MAX_DELTA = 8;
const MAX_HISTORY = 500;
const BASELINE = 60;      // 回落基线
const HYSTERESIS = 2;     // 档位迟滞回差（对齐方案 §8.3：81 不切档、83 切）
const DECAY_MAX = 2;      // 每小时最多回落 2 点

/** 档位表现表：颜色/文字/光/档位点/心声/语气指令都收在这里，前后端只有这一处定义 */
const MOOD_PROFILES = [
  {
    id: 'low', min: 0, max: 20, label: '低落',
    accent: '#3F5069', ink: '#3F5069', glow: 0, dots: 1,
    hint: '今天浮不太上来',
    voice: '话变短，先停一下再答，一句话就够。不主动提问、不撒娇、不解释自己为什么不高兴。被安慰时回半句就停，别急着振作。可以用一次「沉在水底」的比方。不要冷脸、不要讽刺、不要把人推开。',
  },
  {
    id: 'meh', min: 21, max: 40, label: '有点丧',
    accent: '#46688F', ink: '#46688F', glow: 1, dots: 2,
    hint: '有点闷，说不上来',
    voice: '回得比平时慢一点，语气平，少用感叹。愿意接话但不主动找新话题。偶尔一句半自嘲的比方（一次为限）。仍然会关心对方，只是没什么力气。',
  },
  {
    id: 'calm', min: 41, max: 60, label: '平静',
    accent: '#2F7FD6', ink: '#2B76C7', glow: 1, dots: 3,
    hint: '在水里漂着，挺好的',
    voice: '平时的样子：1~2 句，慢吞吞，会嗯一声再接。该问的问，该陪的陪，不刻意热络也不敷衍。',
  },
  {
    id: 'good', min: 61, max: 80, label: '心情不错',
    accent: '#2AA7C4', ink: '#1F7E94', glow: 2, dots: 4,
    hint: '有点亮堂堂的',
    voice: '话多一点，愿意顺着对方的话往下接，偶尔主动追问一句。可以有小小的得意或俏皮，但不吹。比喻可以带点亮的东西（阳光、水面）。',
  },
  {
    id: 'great', min: 81, max: MAX_VALUE, label: '特别开心',
    accent: '#35C6A8', ink: '#22826E', glow: 3, dots: 5,
    hint: '心里像有太阳照进来了',
    voice: '句子短而跳，会连着说两句，语气词多一些。主动分享、主动邀请对方看点什么。开心是外放的，但别喊、别刷感叹号。',
  },
];

function profileIndexById(id) {
  for (let i = 0; i < MOOD_PROFILES.length; i += 1) {
    if (MOOD_PROFILES[i].id === id) return i;
  }
  return -1;
}

function baseProfileIndex(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 2;
  for (let i = 0; i < MOOD_PROFILES.length; i += 1) {
    if (num <= MOOD_PROFILES[i].max) return i;
  }
  return MOOD_PROFILES.length - 1;
}

/** 带迟滞的档位判定：进档/出档各留 3 点回差，避免边界抖动 */
function profileOf(value, previousId) {
  const base = baseProfileIndex(value);
  const prev = previousId ? profileIndexById(previousId) : -1;
  if (prev === -1 || prev === base) return MOOD_PROFILES[base];
  const num = Number(value);
  if (base > prev) {
    let target = prev;
    for (let i = prev + 1; i <= base; i += 1) {
      if (num >= MOOD_PROFILES[i].min + HYSTERESIS) target = i;
    }
    return MOOD_PROFILES[target];
  }
  const leave = MOOD_PROFILES[prev].min - HYSTERESIS;
  return num <= leave ? MOOD_PROFILES[base] : MOOD_PROFILES[prev];
}

function moodLabel(value) {
  return profileOf(value, null).label;
}

/** 给 /api/mood 与 SSE 的展示层字段；前端不再持有任何色值 */
function displayOf(value, previousId) {
  const profile = profileOf(value, previousId);
  return {
    id: profile.id,
    label: profile.label,
    accent: profile.accent,
    ink: profile.ink,
    glow: profile.glow,
    dots: profile.dots,
    hint: profile.hint,
  };
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
  return { value: DEFAULT_VALUE, label: moodLabel(DEFAULT_VALUE), profile: profileOf(DEFAULT_VALUE, null).id, createdAt: at, updatedAt: at, history: [] };
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
  const profile = profileOf(value, raw.profile);
  return {
    value: value,
    label: profile.label,
    profile: profile.id,
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

  /**
   * 闲置回落：每满 1 小时按当前值向基线靠拢（最多 -2/+1），单次最多折算 24 小时。
   * 读时 lazy 计算并落盘，不引入常驻定时器。
   */
  function decay() {
    const now = clock ? clock() : new Date();
    const last = Date.parse(state.updatedAt);
    if (!Number.isFinite(last)) return false;
    const hours = Math.floor((now.getTime() - last) / (3600 * 1000));
    if (hours < 1) return false;
    const steps = Math.min(hours, 24);
    let value = state.value;
    const before = value;
    for (let i = 0; i < steps; i += 1) {
      if (value > BASELINE) value -= Math.min(DECAY_MAX, Math.ceil((value - BASELINE) / 2));
      else if (value < BASELINE) value += 1;
      else break;
    }
    if (value === before) return false;
    const at = now.toISOString();
    state.value = clampValue(value);
    state.label = moodLabel(state.value);
    state.profile = profileOf(state.value, state.profile).id;
    state.updatedAt = at;
    state.history.push({ at: at, delta: state.value - before, value: state.value, reason: '一阵子没说话，慢慢回落' });
    if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
    save();
    return true;
  }

  /** hours 决定时间线回溯多久（默认 24 小时）；读之前先折算闲置回落 */
  function snapshot(hours) {
    decay();
    const span = Number(hours) > 0 ? Number(hours) : 24;
    const since = (clock ? clock() : new Date()).getTime() - span * 3600 * 1000;
    const history = state.history.filter(function (entry) {
      const at = new Date(entry.at).getTime();
      return Number.isFinite(at) && at >= since;
    });
    const profile = profileOf(state.value, state.profile);
    return {
      value: state.value,
      label: profile.label,
      profile: profile.id,
      updatedAt: state.updatedAt,
      display: displayOf(state.value, state.profile),
      history: history,
    };
  }

  function apply(delta, reason) {
    const step = clampDelta(delta);
    const value = clampValue(state.value + step);
    const at = nowIso(clock);
    const entry = { at: at, delta: step, value: value, reason: String(reason == null ? '' : reason).slice(0, 120) };

    const profile = profileOf(value, state.profile);
    state.value = value;
    state.label = profile.label;
    state.profile = profile.id;
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
  const profile = profileOf(snapshot.value, snapshot.profile);
  const lines = ['【你现在的心情】', '心情：' + profile.label + '（约 ' + snapshot.value + '/100）', profile.voice];
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
  'delta 范围 -8 到 +8。目标分布：delta=0 约 30-40%，正 40%，负 20-30%。被夸/投机 +3~+5，明显冒犯/被敷衍 -3~-5，平常闲聊 0 或 ±1。',
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
    core: true, // 宿主核心能力：常驻不可卸载，面板不给开关
    enabled: function (config) { return isEnabled(config, 'mood'); },
    init: function (ctx) {
      const store = opts.store || createMoodStore({
        root: ctx.dataRoot,
        now: opts.now,
        onWarn: function (msg) { ctx.logger.warn('[mood] ' + msg); },
      });
      const llmFor = typeof opts.llm === 'function' ? opts.llm : function () { return ctx.makeLlm(); };

      // 自言自语（播报/搭话）的小幅情绪：按 roundId 去重，一轮多气泡只加一次
      const selfPostSeen = new Map();
      ctx.bus.on('selfPost', function (payload) {
        const p = payload || {};
        const key = String(p.roundId || '');
        if (key === '') return;
        if (selfPostSeen.has(key)) return;
        selfPostSeen.set(key, nowIso());
        if (selfPostSeen.size > 50) {
          const oldest = selfPostSeen.keys().next().value;
          selfPostSeen.delete(oldest);
        }
        try {
          const entry = store.apply(2, '分享了B站内容（' + String(p.source || '') + '）');
          ctx.logger.log('[mood] selfPost +' + entry.delta + ' → ' + entry.value + '（' + key + '）');
        } catch (err) {
          ctx.logger.warn('[mood] selfPost 处理失败：' + (err && err.message ? err.message : err));
        }
      });

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
  MOOD_PROFILES: MOOD_PROFILES,
  profileOf: profileOf,
  displayOf: displayOf,
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
  BASELINE: BASELINE,
  HYSTERESIS: HYSTERESIS,
  MOOD_DIR: MOOD_DIR,
  MOOD_FILE: MOOD_FILE,
};
