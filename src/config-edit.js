'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * config.json（JSONC）的「保注释」局部写回工具。
 *
 * 设计：不做整文件重序列化（那会毁掉中文注释），而是——
 *   1. 定位 features.<name> 段（注释/字符串感知的花括号配对）；
 *   2. 在段内逐 key 替换值（保留缩进、逗号、行内/独立注释）；
 *   3. 段里没有的 key 追加到段尾；段本身缺失则在 features 里补一个最小段；
 *   4. 写回前先剥注释做 JSON.parse 校验，非法不落盘。
 *
 * 只服务于「参数管理面板」这类浅层补丁；深层结构调整请手工改配置。
 */

/** 找到 start 之后第一个 key: { 的对象体范围（含引号键），返回 { keyStart, open, close } 或 null */
function findObject(text, from, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*\\{', 'g');
  re.lastIndex = from;
  const hit = re.exec(text);
  if (!hit) return null;
  const open = hit.index + hit[0].length - 1;
  const close = matchBrace(text, open);
  if (close === -1) return null;
  return { keyStart: hit.index, open: open, close: close };
}

/** 字符串/注释感知的花括号配对：openIdx 指向 '{'，返回配对 '}' 的下标 */
function matchBrace(text, openIdx) {
  let depth = 0;
  let state = 'normal';
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'normal') {
      if (ch === '"') state = 'string';
      else if (ch === '/' && next === '/') state = 'line';
      else if (ch === '/' && next === '*') state = 'block';
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    } else if (state === 'string') {
      if (ch === '\\') i += 1;
      else if (ch === '"') state = 'normal';
    } else if (state === 'line') {
      if (ch === '\n') state = 'normal';
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'normal'; i += 1; }
    }
  }
  return -1;
}

/** 在 block（文本片段）内替换某 key 的值；返回新文本。没有该 key 时返回 null 由调用方追加 */
function setKeyInBlock(block, key, valueText) {
  const lines = block.split('\n');
  const re = new RegExp('^(\\s*"' + key + '"\\s*:\\s*)(.*?)(,)?(\\s*\\/\\/.*)?$');
  for (let i = 0; i < lines.length; i += 1) {
    const m = re.exec(lines[i]);
    if (m) {
      lines[i] = m[1] + valueText + (m[3] || '') + (m[4] || '');
      return lines.join('\n');
    }
  }
  return null;
}

/** 在 block 内追加 key（放在收尾大括号前一行），自动补前一行逗号与缩进 */
function appendKeyToBlock(block, key, valueText) {
  const lines = block.split('\n');
  // 收尾行是最后一个 '}' 所在行
  let closeIdx = lines.length - 1;
  while (closeIdx >= 0 && lines[closeIdx].indexOf('}') === -1) closeIdx -= 1;
  if (closeIdx < 0) return block;
  // 缩进取收尾行前最近一个属性行
  let propIdx = closeIdx - 1;
  while (propIdx >= 0 && lines[propIdx].trim() === '') propIdx -= 1;
  const indentMatch = propIdx >= 0 ? /^\s*/.exec(lines[propIdx]) : null;
  const indent = indentMatch ? indentMatch[0] : '  ';
  // 前一个属性行没有逗号就补上
  if (propIdx >= 0 && !/[,\{]\s*(\/\/.*)?$/.test(lines[propIdx])) {
    lines[propIdx] = lines[propIdx].replace(/\s*$/, ',');
  }
  lines.splice(closeIdx, 0, indent + '"' + key + '": ' + valueText + ',');
  return lines.join('\n');
}

/** 段内任何「属性行以逗号结尾、下一非空行是收尾大括号」的尾逗号都清掉（JSON 不允许） */
function stripTrailingCommas(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().indexOf('}') !== 0) continue;
    let j = i - 1;
    while (j >= 0 && lines[j].trim() === '') j -= 1;
    if (j >= 0) lines[j] = lines[j].replace(/,(\s*(?:\/\/.*)?)$/, '$1');
  }
  return lines.join('\n');
}

/**
 * 把 patch 应用到 features.<name> 段；text 为原始 JSONC，返回新文本。
 * patch 的值：原始类型 = 直接替换/追加；普通对象 = 递归进同名子对象块。
 * 数组 = 整体替换（紧凑单行）。
 */
/** 把嵌套补丁摊平成点路径（段缺失时构造最小段用） */
function subPatchFlat(value, prefix) {
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const dotted = prefix ? prefix + '.' + key : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) Object.assign(out, subPatchFlat(val, dotted));
    else out[dotted] = val;
  }
  return out;
}

function applyPatch(text, name, patch) {
  const feat = findObject(text, 0, 'features');
  if (!feat) throw new Error('config.json 里没有 features 段');

  const sec = findObject(text, feat.open, name);
  if (!sec) {
    // 段缺失：把新段插进 features 收尾大括号之前（字符级定位，不受换行风格影响）
    const flat = {};
    for (const [key, value] of Object.entries(patch)) {
      flat[key] = value && typeof value === 'object' && !Array.isArray(value) ? subPatchFlat(value) : value;
    }
    const sectionText = '{' + Object.entries(flat).map(function (entry) {
      return JSON.stringify(entry[0]) + ': ' + JSON.stringify(entry[1]);
    }).join(', ') + '}';
    const head = text.slice(0, feat.close).replace(/[ \t\r\n]+$/, '');
    const tail = text.slice(feat.close);
    const needsComma = !/[{,]$/.test(head);
    return head + (needsComma ? ',' : '') + '\n  "' + name + '": ' + sectionText + '\n' + tail;
  }

  const head = text.slice(0, sec.open);
  const tail = text.slice(sec.close + 1);
  let block = text.slice(sec.open, sec.close + 1);

  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // 子对象：定位子块，逐 key 递归
      const relKey = block.indexOf('"' + key + '"');
      const compact = JSON.stringify(value);
      if (relKey === -1) {
        block = appendKeyToBlock(block, key, compact);
        continue;
      }
      const subOpen = block.indexOf('{', relKey);
      const subClose = matchBrace(block, subOpen);
      if (subOpen === -1 || subClose === -1) continue;
      let sub = block.slice(subOpen, subClose + 1);
      if (sub.indexOf('\n') === -1) {
        // 紧凑单行子块（行级替换帮不上忙，也没注释可保）：解析后整体重写
        const merged = JSON.parse(stripComments(sub));
        for (const [subKey, subValue] of Object.entries(value)) merged[subKey] = subValue;
        block = block.slice(0, subOpen) + JSON.stringify(merged) + block.slice(subClose + 1);
        continue;
      }
      for (const [subKey, subValue] of Object.entries(value)) {
        const replaced = setKeyInBlock(sub, subKey, JSON.stringify(subValue));
        if (replaced !== null) sub = replaced;
        else sub = appendKeyToBlock(sub, subKey, JSON.stringify(subValue));
      }
      block = block.slice(0, subOpen) + sub + block.slice(subClose + 1);
    } else {
      const replaced = setKeyInBlock(block, key, JSON.stringify(value));
      if (replaced !== null) block = replaced;
      else block = appendKeyToBlock(block, key, JSON.stringify(value));
    }
  }

  // 追加的 key 可能在任何一层收尾大括号前留下尾逗号（JSON 不允许），统一清掉
  block = stripTrailingCommas(block);

  return head + block + tail;
}

/**
 * 把补丁写进 config.json 的 features.<name> 段（保注释）。
 * 返回 { ok, applied, config, error }；applied 为剥注释后的新 features 段。
 */
function patchFeatureSection(root, name, patch) {
  const file = path.join(root, 'config.json');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, error: '读不到 config.json：' + (err.code || err.message) };
  }
  let newText;
  try {
    newText = applyPatch(text, name, patch || {});
  } catch (err) {
    return { ok: false, error: '补丁计算失败：' + (err.message || err) };
  }
  // 写前校验：剥注释后必须能 parse
  try {
    JSON.parse(stripComments(newText));
  } catch (err) {
    return { ok: false, error: '写回后配置不是合法 JSON，已放弃写入：' + err.message };
  }
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, newText, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: '写 config.json 失败：' + (err.code || err.message) };
  }
  let applied = null;
  try {
    applied = JSON.parse(stripComments(fs.readFileSync(file, 'utf8'))).features[name] || null;
  } catch (err) { applied = null; }
  return { ok: true, applied: applied };
}

function stripComments(text) {
  let out = '';
  let state = 'normal';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'normal') {
      if (ch === '"') { state = 'string'; out += ch; }
      else if (ch === '/' && next === '/') { state = 'line'; i += 1; }
      else if (ch === '/' && next === '*') { state = 'block'; i += 1; }
      else out += ch;
    } else if (state === 'string') {
      if (ch === '\\') { out += ch + (next || ''); i += 1; }
      else if (ch === '"') state = 'normal';
      out += ch;
    } else if (state === 'line') {
      if (ch === '\n') { state = 'normal'; out += ch; }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'normal'; i += 1; }
    }
  }
  return out;
}

module.exports = {
  patchFeatureSection: patchFeatureSection,
  applyPatch: applyPatch,
  stripComments: stripComments,
  matchBrace: matchBrace,
};
