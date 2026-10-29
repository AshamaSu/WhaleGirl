'use strict';

const crypto = require('node:crypto');

/**
 * B站 wbi 签名的像素表：把 img_key + sub_key 拼起来后按这张表重排，取前 32 位当 mixinKey。
 * 移位表是公开常量，变动频率远低于接口本身，写死在这里即可。
 */
const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const MIXIN_LENGTH = 32;

/** 从 nav 里的 img_url / sub_url 里抠出 key（文件名去掉扩展名） */
function keyFromUrl(url) {
  const name = String(url == null ? '' : url).split('/').pop() || '';
  return name.split('.')[0];
}

/** imgKey + subKey -> 32 位 mixinKey */
function mixinKey(imgKey, subKey) {
  const raw = String(imgKey == null ? '' : imgKey) + String(subKey == null ? '' : subKey);
  if (raw.length < MIXIN_TAB.length) {
    throw new Error('wbi key 长度不够（' + raw.length + '），拿到的可能是空 key');
  }
  let out = '';
  for (let i = 0; i < MIXIN_LENGTH; i += 1) out += raw.charAt(MIXIN_TAB[i]);
  return out;
}

/** 官方要求：urlencode 之后再把 !'()* 去掉，否则 w_rid 对不上 */
function encodeValue(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, '');
}

/**
 * 签名：过滤空值 -> 加 wts -> 按 key 排序 -> urlencode -> md5(query + mixinKey)。
 * 返回的 query 已含 wts，拼上 &w_rid=... 就能直接请求。
 */
function signParams(params, key, wts) {
  if (typeof key !== 'string' || key.length < MIXIN_LENGTH) {
    throw new Error('mixinKey 不合法，签名前要先从 nav 取 key');
  }
  const all = {};
  const source = params && typeof params === 'object' ? params : {};
  const names = Object.keys(source);
  for (let i = 0; i < names.length; i += 1) {
    const value = source[names[i]];
    if (value === undefined || value === null || value === '') continue;
    all[names[i]] = value;
  }
  all.wts = wts;

  const query = Object.keys(all)
    .sort()
    .map(function (name) { return encodeURIComponent(name) + '=' + encodeValue(all[name]); })
    .join('&');

  const w_rid = crypto.createHash('md5').update(query + key).digest('hex');
  return { wts: wts, query: query, w_rid: w_rid };
}

module.exports = {
  MIXIN_TAB: MIXIN_TAB,
  MIXIN_LENGTH: MIXIN_LENGTH,
  keyFromUrl: keyFromUrl,
  mixinKey: mixinKey,
  signParams: signParams,
  encodeValue: encodeValue,
};
