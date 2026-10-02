/**
 * 演示图片库（小程序端包装）
 * ---------------------------------------------------------------
 * 真正的规格定义在 core/image-spec.js（小程序端与云函数端共享），
 * 这里只做一层转发，保证旧的引用路径（utils/image）继续可用。
 *
 * 为什么规格要放在 core：
 *   云函数灌入演示数据时也需要同一份图片标识与线索，
 *   两端共用一份定义可以避免「本地有图、云端没图」的不一致。
 */

const spec = require('../core/image-spec');

module.exports = {
  PREFIX: spec.PREFIX,
  LIBRARY: spec.LIBRARY,
  list: spec.list,
  get: spec.get,
  isDemo: spec.isDemo,
  toImageId: spec.toImageId,
  titleOf: spec.titleOf,
  /** 兼容旧接口：把键名解析成完整图片标识 */
  resolve: (keyOrSpec) => {
    if (!keyOrSpec) return null;
    if (typeof keyOrSpec === 'object') return keyOrSpec;
    return spec.get(keyOrSpec);
  }
};
