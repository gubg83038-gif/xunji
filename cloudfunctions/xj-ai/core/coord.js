/**
 * WGS-84 → GCJ-02 坐标偏移工具
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   OpenStreetMap / GPS 用的是 WGS-84，
 *   微信 map 组件、wx.getLocation、腾讯/高德地图用的是 GCJ-02（火星坐标系）。
 *   两者在无锡一带相差约 500 米，直接混用会导致「地点整体偏到隔壁街区」，
 *   对依赖 exp(-d/σ) 的时空重排是致命的。
 *
 * 算法：国测局公开的 GCJ-02 偏移量拟合公式（业内通用的标准实现）。
 * 说明：这是对官方加密算法的近似还原，民用场景下误差通常在米级；
 *      若需要严格合规的坐标服务，应使用腾讯位置服务的坐标转换 API。
 */

const PI = Math.PI;
const A = 6378245.0;              // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方

const OUT_OF_CHINA = (lng, lat) => !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/**
 * WGS-84 → GCJ-02
 * @returns {{lng:number, lat:number}}
 */
function wgs84ToGcj02(lng, lat) {
  if (OUT_OF_CHINA(lng, lat)) return { lng, lat };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return {
    lng: Number((lng + dLng).toFixed(6)),
    lat: Number((lat + dLat).toFixed(6))
  };
}

/** GCJ-02 → WGS-84（迭代反解，用于把已有坐标导回标准坐标系） */
function gcj02ToWgs84(lng, lat) {
  if (OUT_OF_CHINA(lng, lat)) return { lng, lat };
  let wgsLng = lng;
  let wgsLat = lat;
  for (let i = 0; i < 5; i += 1) {
    const gcj = wgs84ToGcj02(wgsLng, wgsLat);
    wgsLng += lng - gcj.lng;
    wgsLat += lat - gcj.lat;
  }
  return { lng: Number(wgsLng.toFixed(6)), lat: Number(wgsLat.toFixed(6)) };
}

module.exports = {
  wgs84ToGcj02,
  gcj02ToWgs84,
  isOutOfChina: OUT_OF_CHINA
};
