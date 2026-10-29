'use strict';

const { isEnabled } = require('./features/settings');
const { createMoodModule } = require('./features/mood');
const { createMemoryTimelineModule } = require('./features/memory-timeline');
const { createBiliModule } = require('./features/bili');

/** 注册表：加新能力只改这里一行 */
function defaultModules() {
  return [createMoodModule(), createMemoryTimelineModule(), createBiliModule()];
}

function message(err) {
  return err && err.message ? err.message : String(err);
}

/**
 * 能力宿主：按 config.features 装配 / 卸载能力模块。
 *
 * 三条硬约束：
 *   1. 未声明 = 关闭；
 *   2. 单个能力 init 或运行失败只记日志，不回传异常，聊天主链路不受影响；
 *   3. 能力注册的路由 / prompt 片段 / 回复后钩子都记在它名下，卸载时一起清掉。
 */
function createFeatureHost(options) {
  const opts = options || {};
  const logger = opts.logger || console;
  const context = opts.context || {};
  const modules = Array.isArray(opts.modules) && opts.modules.length > 0 ? opts.modules : defaultModules();

  const running = new Map();      // name -> { module, handle }
  const states = new Map();       // name -> { enabled, error }
  const routes = new Map();       // name -> [{ method, pathname, handler }]
  const tools = new Map();        // name -> [toolDef]
  const channels = new Map();     // name -> { channel, send }
  const promptBlocks = new Map(); // name -> [fn]
  const afterReplyHooks = new Map(); // name -> [fn]

  let syncing = false;
  let lastSummary = '';

  function warn(text) {
    if (logger && typeof logger.warn === 'function') logger.warn(text);
  }

  function info(text) {
    if (logger && typeof logger.log === 'function') logger.log(text);
  }

  /** 每个能力拿到的是自己的门面：注册的东西记在它名下 */
  function scoped(name) {
    const facade = Object.create(context);
    facade.route = function (method, pathname, handler) {
      if (typeof pathname !== 'string' || pathname === '' || typeof handler !== 'function') return;
      const list = routes.get(name) || [];
      list.push({ method: String(method || 'GET').toUpperCase(), pathname: pathname, handler: handler });
      routes.set(name, list);
    };
    facade.addPromptBlock = function (fn) {
      if (typeof fn !== 'function') return;
      const list = promptBlocks.get(name) || [];
      list.push(fn);
      promptBlocks.set(name, list);
    };
    facade.addAfterReply = function (fn) {
      if (typeof fn !== 'function') return;
      const list = afterReplyHooks.get(name) || [];
      list.push(fn);
      afterReplyHooks.set(name, list);
    };
    // 插件注册给主对话的工具：必须带命名空间 plugin_<name>_，防撞名
    facade.addTool = function (def) {
      if (!def || typeof def !== 'object' || typeof def.name !== 'string') return;
      if (def.name.indexOf('plugin_' + name + '_') !== 0) {
        warn('[features] ' + name + ' 的工具名必须以 plugin_' + name + '_ 开头：' + def.name);
        return;
      }
      const list = tools.get(name) || [];
      if (list.some(function (item) { return item.name === def.name; })) {
        warn('[features] ' + name + ' 重复注册工具：' + def.name);
        return;
      }
      list.push(def);
      tools.set(name, list);
    };
    // 渠道插件注册发送函数：name 必须等于消息里的 source
    facade.registerChannel = function (channelName, send) {
      if (typeof channelName !== 'string' || channelName === '' || typeof send !== 'function') return;
      channels.set(name, { channel: channelName, send: send });
    };
    return facade;
  }

  function drop(name) {
    routes.delete(name);
    promptBlocks.delete(name);
    afterReplyHooks.delete(name);
    tools.delete(name);
    channels.delete(name);
  }

  /** 已启用插件注册的工具（按运行顺序拼平） */
  function allTools() {
    const out = [];
    running.forEach(function (entry, name) {
      const list = tools.get(name) || [];
      for (let i = 0; i < list.length; i += 1) out.push(list[i]);
    });
    return out;
  }

  /** 按渠道名取发送函数（name 必须等于 source） */
  function channelSend(channel) {
    let found = null;
    running.forEach(function (entry, name) {
      const item = channels.get(name);
      if (item && item.channel === channel) found = item.send;
    });
    return found;
  }

  function start(name, module, config) {
    try {
      const handle = typeof module.init === 'function' ? module.init(scoped(name), { config: config }) : null;
      running.set(name, { module: module, handle: handle || null });
      states.set(name, { enabled: true, error: '' });
      info('[features] 已启用：' + name);
    } catch (err) {
      // 半路失败：把已经注册进去的路由 / 钩子清掉，免得半死不活的能力继续接请求
      drop(name);
      running.delete(name);
      states.set(name, { enabled: false, error: message(err) });
      warn('[features] ' + name + ' 启动失败，已跳过：' + message(err));
    }
  }

  function stop(name) {
    const entry = running.get(name);
    running.delete(name);
    drop(name);
    states.set(name, { enabled: false, error: '' });
    if (!entry) return;
    try {
      if (entry.handle && typeof entry.handle.stop === 'function') entry.handle.stop();
    } catch (err) {
      warn('[features] ' + name + ' 停止时报错：' + message(err));
    }
    info('[features] 已关闭：' + name);
  }

  function enabledFor(module, config) {
    if (typeof module.enabled === 'function') return module.enabled(config) === true;
    return isEnabled(config, module.name);
  }

  function summary() {
    const out = {};
    for (let i = 0; i < modules.length; i += 1) {
      const name = modules[i] && modules[i].name;
      if (typeof name !== 'string' || name === '') continue;
      const state = states.get(name);
      out[name] = { enabled: !!(state && state.enabled), error: (state && state.error) || '' };
    }
    return out;
  }

  /** 启停清单只在变化时打印，避免每个请求刷一遍日志 */
  function logSummary() {
    const state = summary();
    const on = [];
    const off = [];
    const broken = [];
    const names = Object.keys(state);
    for (let i = 0; i < names.length; i += 1) {
      if (state[names[i]].error) broken.push(names[i]);
      else if (state[names[i]].enabled) on.push(names[i]);
      else off.push(names[i]);
    }
    const line = '已启用：' + (on.join('、') || '无') +
      ' ／ 已关闭：' + (off.join('、') || '无') +
      (broken.length > 0 ? ' ／ 出错：' + broken.join('、') : '');
    if (line === lastSummary) return;
    lastSummary = line;
    info('[features] ' + line);
  }

  /** 按当前配置对齐启停状态；重复调用只会处理差异 */
  function sync(config) {
    if (syncing) return summary();
    syncing = true;
    try {
      for (let i = 0; i < modules.length; i += 1) {
        const module = modules[i];
        const name = module && module.name;
        if (typeof name !== 'string' || name === '') continue;
        const want = enabledFor(module, config);
        const has = running.has(name);
        if (want && !has) start(name, module, config);
        else if (!want && has) stop(name);
        else if (!want && !states.has(name)) states.set(name, { enabled: false, error: '' });
      }
      logSummary();
      return summary();
    } finally {
      syncing = false;
    }
  }

  /** 只匹配正在运行的能力注册的路由 */
  function matchRoute(method, pathname) {
    const wanted = String(method || 'GET').toUpperCase();
    const names = Array.from(running.keys());
    for (let i = 0; i < names.length; i += 1) {
      const list = routes.get(names[i]) || [];
      for (let j = 0; j < list.length; j += 1) {
        if (list[j].pathname === pathname && list[j].method === wanted) return list[j];
      }
    }
    return null;
  }

  /** 拼所有能力的 prompt 片段；单个片段出错只丢它自己 */
  function promptText() {
    const parts = [];
    const names = Array.from(running.keys());
    for (let i = 0; i < names.length; i += 1) {
      const list = promptBlocks.get(names[i]) || [];
      for (let j = 0; j < list.length; j += 1) {
        try {
          const text = list[j]();
          if (typeof text === 'string' && text.trim() !== '') parts.push(text.trim());
        } catch (err) {
          warn('[features] ' + names[i] + ' 的 prompt 片段出错：' + message(err));
        }
      }
    }
    return parts.join('\n\n');
  }

  /** 回复已发给用户之后才跑，任何失败都只进日志 */
  async function afterReply(payload) {
    const jobs = [];
    const names = Array.from(running.keys());
    for (let i = 0; i < names.length; i += 1) {
      const list = afterReplyHooks.get(names[i]) || [];
      for (let j = 0; j < list.length; j += 1) {
        const name = names[i];
        try {
          jobs.push(Promise.resolve(list[j](payload)).catch(function (err) {
            warn('[features] ' + name + ' 回复后处理失败：' + message(err));
          }));
        } catch (err) {
          warn('[features] ' + name + ' 回复后处理失败：' + message(err));
        }
      }
    }
    if (jobs.length > 0) await Promise.all(jobs);
  }

  function stopAll() {
    const names = Array.from(running.keys());
    for (let i = 0; i < names.length; i += 1) stop(names[i]);
  }

  function runningNames() {
    return Array.from(running.keys());
  }

  return {
    sync: sync,
    state: summary,
    matchRoute: matchRoute,
    promptText: promptText,
    afterReply: afterReply,
    running: runningNames,
    tools: allTools,
    channelSend: channelSend,
    stopAll: stopAll,
  };
}

module.exports = {
  createFeatureHost: createFeatureHost,
  defaultModules: defaultModules,
};
