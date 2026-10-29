'use strict';

/**
 * B站插件 · HTTP 接口层（与功能分离）。
 *
 * 分层约定（后续对外插件都照此模式）：
 *   index.js  = 功能面：定时器、轮次编排、额度、播报，不碰 HTTP；
 *   http.js   = 接口面：只做「协议翻译」——解析请求、调功能面 svc、按契约回 JSON。
 *
 * 契约（contract）是机器可读的接口说明：request/response 里每个字段的类型与含义。
 * 改字段先改 contract，再改实现；state 接口会把全部契约原样吐出来，方便外部对表。
 *
 * svc 是功能面暴露给接口层的最小门面（由 index.js 装配），接口层不越界摸内部状态。
 */

function createBiliHttp(svc, ctx) {
  return [
    {
      method: 'GET',
      pathname: '/api/features/bili/state',
      summary: '查询插件运行状态与互动额度',
      contract: {
        request: '无参数',
        response: {
          ok: 'boolean，恒为 true',
          running: 'boolean，浏览轮是否进行中',
          section: 'object，当前生效配置（含 interact 段）',
          state: 'object，当日轮数/lastRunAt 等调度状态',
          lastResult: 'object|null，最近一轮 { ok, trigger, picked, error, at }',
          seen: 'number，已推荐过的视频数',
          login: 'boolean，B站 cookie 是否有效',
          mid: 'string，主人的 mid（未配置为空串）',
          interact: 'object，{ section, budget: {likes,coins,favorites,replies 的 used/limit/left}, log: 最近20条 }',
          lastReplyCheckAt: 'string，上次查回复时间（ISO，空串=从未）',
        },
      },
      handler: function (req, res) {
        ctx.sendJson(res, 200, {
          ok: true,
          running: svc.running(),
          section: svc.section(),
          state: svc.state(),
          lastResult: svc.lastResult(),
          seen: svc.seenCount(),
          login: svc.login(),
          mid: svc.mid(),
          interact: svc.interact(),
          lastReplyCheckAt: svc.replyCheckAt(),
        });
      },
    },
    {
      method: 'POST',
      pathname: '/api/features/bili/run',
      summary: '手动触发一轮浏览（异步，进度看 state 或推送）',
      contract: {
        request: '无参数（body 可为空）',
        response: {
          '202': '{ ok: true, started: true }，已开跑；一轮一到两分钟，别等在这条连接上',
          '409': '{ ok: false, error: "上一轮还在跑，等它结束" }',
        },
      },
      handler: function (req, res) {
        if (svc.running()) {
          ctx.sendJson(res, 409, { ok: false, error: '上一轮还在跑，等它结束' });
          return;
        }
        svc.startBrowse('manual');
        ctx.sendJson(res, 202, { ok: true, started: true });
      },
    },
    {
      method: 'POST',
      pathname: '/api/features/bili/check-replies',
      summary: '手动触发一次「回复我的」轻量处理（异步）',
      contract: {
        request: '无参数（body 可为空）',
        response: {
          '202': '{ ok: true, started: true }，已开跑；没新通知时不会花模型 token',
          '400': '{ ok: false, error: "B站账号没登录" }',
          '409': '{ ok: false, error: "上一轮还在跑" }（浏览轮或查回复轮任一在跑）',
        },
      },
      handler: function (req, res) {
        if (svc.running() || svc.replying()) {
          ctx.sendJson(res, 409, { ok: false, error: '上一轮还在跑' });
          return;
        }
        if (!svc.login()) {
          ctx.sendJson(res, 400, { ok: false, error: 'B站账号没登录' });
          return;
        }
        const result = svc.startReplyCheck();
        if (result && result.ok === false) {
          ctx.sendJson(res, 409, { ok: false, error: result.error || '启动失败' });
          return;
        }
        ctx.sendJson(res, 202, { ok: true, started: true });
      },
    },
  ];
}

module.exports = {
  createBiliHttp: createBiliHttp,
};
