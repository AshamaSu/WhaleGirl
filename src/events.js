'use strict';

/**
 * 极简事件总线。
 * 能力模块之间、能力与网页之间只通过事件说话：谁发出去的不关心有谁在听，
 * 也绝不因为某个监听者出错就把异常抛回 emit 的调用方（推送不能拖垮聊天）。
 */
function createBus(options) {
  const opts = options || {};
  const logger = opts.logger || console;
  const handlers = new Map();

  function warn(text) {
    if (logger && typeof logger.warn === 'function') logger.warn(text);
  }

  /** 返回一个幂等的 off：重复调用（close 与 stop 都触发）不会误删别人的监听 */
  function on(type, handler) {
    if (typeof type !== 'string' || type === '' || typeof handler !== 'function') {
      return function () {};
    }
    let set = handlers.get(type);
    if (!set) {
      set = new Set();
      handlers.set(type, set);
    }
    set.add(handler);

    let active = true;
    return function off() {
      if (!active) return;
      active = false;
      set.delete(handler);
      if (set.size === 0) handlers.delete(type);
    };
  }

  /** 返回成功送达的监听者数量，方便测试与日志 */
  function emit(type, payload) {
    const set = handlers.get(type);
    if (!set || set.size === 0) return 0;

    // 先快照：监听者在回调里 off 自己会改动这个 Set
    const list = Array.from(set);
    let delivered = 0;
    for (let i = 0; i < list.length; i += 1) {
      try {
        list[i](payload, type);
        delivered += 1;
      } catch (err) {
        warn('[events] ' + type + ' 的监听者出错：' + (err && err.message ? err.message : err));
      }
    }
    return delivered;
  }

  function count(type) {
    const set = handlers.get(type);
    return set ? set.size : 0;
  }

  function clear() {
    handlers.clear();
  }

  return {
    on: on,
    emit: emit,
    count: count,
    clear: clear,
  };
}

module.exports = {
  createBus: createBus,
};
