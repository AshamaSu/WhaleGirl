'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createBus } = require('../src/events');

const QUIET = { log: function () {}, warn: function () {}, error: function () {} };

test('on / emit 把事件送到每个监听者', function () {
  const bus = createBus({ logger: QUIET });
  const got = [];

  bus.on('push', function (payload) { got.push('a:' + payload.text); });
  bus.on('push', function (payload) { got.push('b:' + payload.text); });

  assert.strictEqual(bus.count('push'), 2);
  assert.strictEqual(bus.emit('push', { text: 'hi' }), 2);
  assert.deepStrictEqual(got, ['a:hi', 'b:hi']);
});

test('没有监听者时不报错，返回 0', function () {
  const bus = createBus({ logger: QUIET });
  assert.strictEqual(bus.emit('nobody', {}), 0);
});

test('一个监听者抛错不影响其他监听者，也不把异常抛回去', function () {
  const bus = createBus({ logger: QUIET });
  const got = [];

  bus.on('push', function () { throw new Error('boom'); });
  bus.on('push', function () { got.push('ok'); });

  assert.doesNotThrow(function () { bus.emit('push', {}); });
  assert.deepStrictEqual(got, ['ok']);
});

test('off 是幂等的，也不会误删同名事件的别的监听', function () {
  const bus = createBus({ logger: QUIET });
  const got = [];
  const first = function () { got.push('first'); };
  const second = function () { got.push('second'); };

  const offFirst = bus.on('push', first);
  bus.on('push', second);
  offFirst();
  offFirst();

  bus.emit('push', {});
  assert.deepStrictEqual(got, ['second']);
});

test('监听者可以在处理里注销自己', function () {
  const bus = createBus({ logger: QUIET });
  let hits = 0;

  const off = bus.on('push', function () {
    hits += 1;
    off();
  });

  bus.emit('push', {});
  bus.emit('push', {});
  assert.strictEqual(hits, 1);
  assert.strictEqual(bus.count('push'), 0);
});

test('非法参数不会建出空监听', function () {
  const bus = createBus({ logger: QUIET });
  bus.on('', function () {});
  bus.on('push', null);
  assert.strictEqual(bus.count('push'), 0);
});
