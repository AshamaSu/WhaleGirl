'use strict';

/**
 * 能力开关的唯一判定入口。
 * 约定：config.features 里未声明 = 关闭；enabled 必须是 true（字符串 "true" 在 config 层已归一化）。
 */
function sectionOf(config, name) {
  const features = config && config.features;
  if (!features || typeof features !== 'object') return null;
  const section = features[name];
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  return section;
}

function isEnabled(config, name) {
  const section = sectionOf(config, name);
  return !!(section && section.enabled === true);
}

module.exports = {
  sectionOf: sectionOf,
  isEnabled: isEnabled,
};
