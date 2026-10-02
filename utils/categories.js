/**
 * 兼容转发层：真正的实现在 core/categories.js
 * ---------------------------------------------------------------
 * 项目重构后算法层统一收敛到 core/（小程序端与云函数端共享同一份实现），
 * 这里保留 utils/ 的旧引用路径，避免历史代码与文档中的路径失效。
 *
 * 新代码请直接：require('../../core/categories.js')
 */

module.exports = require('../core/categories.js');
