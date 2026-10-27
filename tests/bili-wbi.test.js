'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { keyFromUrl, mixinKey, signParams, encodeValue } = require('../src/bilibili/wbi');

// 2026-10 实测 nav 拿到的真实 key 对（未登录也返回），用来锁住 mixin 算法的输出
const IMG = '7cd084941338484aae1ad9425b84077c';
const SUB = '4932caff0ff746eab6f01bf08b70ac45';
const KEY = 'ea1db124af3c7062474693fa704f4ff8';

test('keyFromUrl 从图片地址里抠出 key', function () {
  assert.equal(keyFromUrl('https://i0.hdslb.com/bfs/wbi/' + IMG + '.png'), IMG);
  assert.equal(keyFromUrl(IMG + '.png'), IMG);
  assert.equal(keyFromUrl(''), '');
});

test('mixinKey 按移位表重排并截到 32 位', function () {
  assert.equal(mixinKey(IMG, SUB), KEY);
  assert.equal(mixinKey(IMG, SUB).length, 32);
});

test('mixinKey 在 key 不完整时明确报错', function () {
  assert.throws(function () { mixinKey('abc', 'def'); }, /wbi key 长度不够/);
});

test('encodeValue 去掉官方要求剔除的字符', function () {
  assert.equal(encodeValue("a b!'()*~"), 'a%20b~');
});

test('signParams 排序、加 wts、拼 md5', function () {
  const signed = signParams({ b: 2, a: 'x y', empty: '' }, KEY, 1700000000);

  // 空值被丢掉，key 按字典序，值 urlencode
  assert.equal(signed.query, 'a=x%20y&b=2&wts=1700000000');
  assert.equal(
    signed.w_rid,
    crypto.createHash('md5').update(signed.query + KEY).digest('hex')
  );
  assert.equal(signed.w_rid.length, 32);
});

test('signParams 同样的输入永远得到同样的签名', function () {
  const first = signParams({ keyword: '鲸鱼', page: 1 }, KEY, 1700000000);
  const second = signParams({ page: 1, keyword: '鲸鱼' }, KEY, 1700000000);
  assert.deepEqual(first, second);
});

test('signParams 拒绝非法 mixinKey', function () {
  assert.throws(function () { signParams({ a: 1 }, 'short', 1); }, /mixinKey 不合法/);
});
