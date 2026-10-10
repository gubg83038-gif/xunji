/**
 * 核验期临时会话（小程序端适配层）
 * ---------------------------------------------------------------
 * 与 utils/matcher.js、utils/time.js 同一模式：这里只是转发 core/chat.js，
 * 算法与规则**只写在 core/**，避免两端行为漂移（见 AGENTS.md 约定三）。
 */

module.exports = require('../core/chat.js');
