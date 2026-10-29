'use strict';

const { isEnabled } = require('./settings');
const {
  openMemory,
  safeSessionId,
  listSessions,
  exportAll,
  importAll,
} = require('../memory');

const RESTORE_LIMIT = 8 * 1024 * 1024;

/** 能力模块：记忆时间线（config.features.memory）—— 只加页面与备份，不改记忆主逻辑 */
function createMemoryTimelineModule() {
  return {
    name: 'memory',
    core: true, // 宿主核心能力：常驻不可卸载，面板不给开关
    enabled: function (config) { return isEnabled(config, 'memory'); },
    init: function (ctx) {
      function settings() {
        return ctx.getConfig().memory || {};
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
