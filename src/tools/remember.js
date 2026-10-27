'use strict';

/**
 * 长期记忆写入工具。memory 只需要提供 addFact(text)。
 * 让它自己判断"什么值得记"，比在代码里堆正则靠谱。
 */
function createRememberTool(memory) {
  return {
    name: 'remember',
    description:
      '把关于对方的长期事实写进记忆：名字、称呼、住处、职业、家人宠物、明确说过的喜好与忌讳、约定好的事。只记值得长期记住的，别记流水账和闲聊。',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: '一句话事实，第三人称，例如「他叫阿龙」「她养了一只叫豆豆的猫」' },
      },
      required: ['fact'],
    },
    execute: async function (args) {
      const fact = String((args || {}).fact == null ? '' : (args || {}).fact).trim();
      if (fact === '') throw new Error('要记的内容是空的');
      if (fact.length > 200) throw new Error('这条太长，压缩成一句话再记');
      memory.addFact(fact);
      return '已经记住了：' + fact;
    },
  };
}

module.exports = { createRememberTool: createRememberTool };
