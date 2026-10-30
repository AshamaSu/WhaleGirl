'use strict';

const { isEnabled } = require('./settings');
const configEdit = require('../config-edit');
const {
  openMemory,
  memorySettings,
  safeSessionId,
  listSessions,
  exportAll,
  importAll,
} = require('../memory');

const RESTORE_LIMIT = 8 * 1024 * 1024;

/** 参数面板的参数定义（与 bili 的 PARAM_SPECS 同一形状；落 features.memory.params） */
const PARAM_SPECS = [
  { key: 'params.factDecay', type: 'number', label: '每轮衰减系数', min: 0.8, max: 0.995, default: 0.97, desc: '每轮对话后事实强度 × 此值；越接近 1 忘得越慢' },
  { key: 'params.minStrength', type: 'number', label: '遗忘阈值', min: 0.01, max: 0.5, default: 0.15, desc: '强度低于此值的事实被淘汰；置顶的永不衰减' },
  { key: 'params.maxFacts', type: 'number', label: '事实容量上限', min: 10, max: 200, default: 40, desc: '超量按 置顶 > 强度 > 最近 提到裁剪' },
  { key: 'params.maxPromptFacts', type: 'number', label: '进提示词的事实条数', min: 1, max: 30, default: 12, desc: '每轮最多注入几条相关事实' },
  { key: 'params.maxTurns', type: 'number', label: '原文窗口（条）', min: 10, max: 200, default: 40, desc: '超过后把更早的原文压缩成摘要' },
  { key: 'params.keepRecentTurns', type: 'number', label: '压缩后保留原文（条）', min: 2, max: 60, default: 12, desc: '' },
  { key: 'params.maxPromptChars', type: 'number', label: '记忆块最大长度（字符）', min: 200, max: 4000, default: 1200, desc: '' },
];

const SPEC_MAP = {};
for (const spec of PARAM_SPECS) SPEC_MAP[spec.key] = spec;

/** 单个参数值校验；返回错误文案或 null（形状与 bili 的 validateSpec 一致） */
function validateSpec(spec, value) {
  if (spec.type === 'boolean') return typeof value === 'boolean' ? null : '必须是 true/false';
  if (spec.type === 'number') {
    const num = Number(value);
    if (!Number.isFinite(num)) return '必须是数字';
    if (spec.min !== undefined && num < spec.min) return '不能小于 ' + spec.min;
    if (spec.max !== undefined && num > spec.max) return '不能大于 ' + spec.max;
    return null;
  }
  if (spec.type === 'string') return typeof value === 'string' && value.trim() !== '' ? null : '必须是非空字符串';
  return '未知类型';
}

/**
 * 参数面板写入口：校验 patch（点路径 params.*，兼容嵌套 {params:{...}}）→ 保注释写回 config.json。
 * 返回 { ok, applied } 或 { ok: false, errors: [...] }。
 */
function applyMemoryParams(root, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, errors: ['请求体必须是对象'] };
  // 摊平嵌套对象成点路径（与 bili 同款兼容）
  const flat = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [sub, subValue] of Object.entries(value)) flat[key + '.' + sub] = subValue;
    } else {
      flat[key] = value;
    }
  }
  const errors = [];
  const writePatch = {};
  for (const [key, value] of Object.entries(flat)) {
    const spec = SPEC_MAP[key];
    if (!spec) { errors.push('不认识的参数：' + key); continue; }
    const error = validateSpec(spec, value);
    if (error) { errors.push(spec.label + '(' + key + ')' + error); continue; }
    const [parent, leaf] = key.split('.');
    if (!writePatch[parent]) writePatch[parent] = {};
    writePatch[parent][leaf] = value;
  }
  if (errors.length > 0) return { ok: false, errors: errors };
  const result = configEdit.patchFeatureSection(root, 'memory', writePatch);
  if (!result.ok) return { ok: false, errors: [result.error || '写回 config.json 失败'] };
  const applied = result.applied || {};
  return { ok: true, applied: applied.params || {} };
}

/** 能力模块：记忆时间线（config.features.memory）—— 只加页面与备份，不改记忆主逻辑 */
function createMemoryTimelineModule() {
  return {
    name: 'memory',
    core: true, // 宿主核心能力：常驻不可卸载，面板不给开关
    enabled: function (config) { return isEnabled(config, 'memory'); },
    init: function (ctx) {
      function settings() {
        return memorySettings(ctx.getConfig());
      }

      function open(sessionId) {
        return openMemory({
          root: ctx.dataRoot,
          sessionId: sessionId,
          settings: settings(),
          onWarn: function (msg) { ctx.logger.warn('[memory] ' + msg); },
        });
      }

      ctx.route('GET', '/memory', function (req, res) {
        ctx.serveStatic(req, res, '/memory.html');
      });

      ctx.route('GET', '/api/memory/sessions', function (req, res) {
        ctx.sendJson(res, 200, { ok: true, sessions: listSessions({ root: ctx.dataRoot }) });
      });

      // —— 参数面板契约（与 bili 的 /api/features/<name>/params 同一形状）——
      ctx.route('GET', '/api/features/memory/params', function (req, res) {
        const config = ctx.getConfig();
        const section = (config.features && config.features.memory) || {};
        ctx.sendJson(res, 200, {
          ok: true,
          enabled: true,
          core: true,
          section: section,
          params: PARAM_SPECS,
        });
      });

      ctx.route('POST', '/api/features/memory/params', async function (req, res) {
        const body = await ctx.readJson(req, 64 * 1024).catch(function () { return null; });
        const result = applyMemoryParams(ctx.root, body || {});
        if (!result.ok) {
          ctx.sendJson(res, 400, { ok: false, errors: result.errors || ['参数不合法'] });
          return;
        }
        ctx.sendJson(res, 200, { ok: true, applied: result.applied });
      });

      ctx.route('GET', '/api/memory/timeline', function (req, res, url) {
        const sessionId = safeSessionId(url.searchParams.get('sessionId'));
        const data = open(sessionId).export();
        const limits = settings();
        const minStrength = Number(limits.minStrength) || 0.15;
        const facts = data.facts.map(function (fact) {
          const strength = Number(fact.strength) || 0;
          return {
            id: fact.id,
            text: fact.text,
            at: fact.at,
            lastSeen: fact.lastSeen,
            source: fact.source,
            pinned: fact.pinned === true,
            strength: Math.round(strength * 1000) / 1000,
            fading: strength < minStrength,
          };
        });
        facts.sort(function (a, b) {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.strength - a.strength;
        });

        ctx.sendJson(res, 200, {
          ok: true,
          sessionId: sessionId,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          summary: data.summary,
          summaryAt: data.summaryAt,
          turns: data.turns.length,
          stats: data.stats,
          minStrength: minStrength,
          factDecay: Number(limits.factDecay) || 0.97,
          facts: facts,
        });
      });

      ctx.route('POST', '/api/memory/pin', async function (req, res) {
        const body = await ctx.readJson(req, 16 * 1024);
        const id = typeof body.id === 'string' ? body.id : '';
        if (id === '') {
          ctx.sendJson(res, 400, { ok: false, error: '要置顶哪条？请求体少了 id' });
          return;
        }
        const fact = open(body.sessionId).setPinned(id, body.pinned === true);
        if (!fact) {
          ctx.sendJson(res, 404, { ok: false, error: '没有这条事实（可能已经淡忘了）：' + id });
          return;
        }
        ctx.sendJson(res, 200, { ok: true, fact: fact });
      });

      ctx.route('POST', '/api/memory/forget', async function (req, res) {
        const body = await ctx.readJson(req, 16 * 1024);
        const id = typeof body.id === 'string' ? body.id : '';
        if (id === '') {
          ctx.sendJson(res, 400, { ok: false, error: '要删哪条？请求体少了 id' });
          return;
        }
        const removed = open(body.sessionId).removeFact(id);
        if (!removed) {
          ctx.sendJson(res, 404, { ok: false, error: '没有这条事实（可能已经淡忘了）：' + id });
          return;
        }
        ctx.sendJson(res, 200, { ok: true, removed: id });
      });

      ctx.route('GET', '/api/memory/backup', function (req, res) {
        const body = JSON.stringify(exportAll({ root: ctx.dataRoot }), null, 2);
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'content-disposition': 'attachment; filename="whale-memory-' + stamp + '.json"',
          'cache-control': 'no-store',
        });
        res.end(body);
      });

      ctx.route('POST', '/api/memory/restore', async function (req, res) {
        const bundle = await ctx.readJson(req, RESTORE_LIMIT);
        const result = importAll({ root: ctx.dataRoot, bundle: bundle });
        ctx.logger.log('[memory] 恢复备份：导入 ' + result.imported + ' 个会话，跳过 ' + result.skipped + ' 个');
        ctx.sendJson(res, 200, {
          ok: result.imported > 0,
          imported: result.imported,
          skipped: result.skipped,
          errors: result.errors.slice(0, 10),
        });
      });
    },
  };
}

module.exports = {
  createMemoryTimelineModule: createMemoryTimelineModule,
};
