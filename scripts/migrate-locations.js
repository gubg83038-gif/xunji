/**
 * 一次性迁移脚本：把演示数据集里的旧演示地点 id 换成江南大学蠡湖校区的真实地点 id。
 *
 * 处理两个文件：
 *   core/seed-data.js   两端共享的数据定义
 *   mock/seed.js        本地模式的灌入实现（内含一份等价的数据定义）
 *
 * 用法：node scripts/migrate-locations.js
 */

const fs = require('fs');
const path = require('path');

const FILES = [
  path.join(__dirname, '..', 'core', 'seed-data.js'),
  path.join(__dirname, '..', 'mock', 'seed.js')
];

/** 旧演示 id → 真实校区地点 id（保持原地点的场景含义） */
const MAP = {
  'stadium': 'track_n',        // 操场 → 北区运动场
  'dorm_b': 'dorm_north',      // B 栋宿舍 → 北区宿舍园区
  'lib_north': 'lib',          // 图书馆北门 → 图书馆
  'lib_south': 'lib',          // 图书馆南门 → 图书馆
  'court': 'court_n',          // 篮球场 → 北区篮球场
  'road_main': 'road_central', // 主干道 → 中央大道
  'lab': 'mech'                // 实验楼 → 机械工程学院
};

function main() {
  let grandTotal = 0;

  FILES.forEach((file) => {
    if (!fs.existsSync(file)) {
      console.log('跳过（文件不存在）：' + path.relative(process.cwd(), file));
      return;
    }
    let src = fs.readFileSync(file, 'utf8');
    let total = 0;
    console.log('\n' + path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/'));

    Object.keys(MAP).forEach((from) => {
      const to = MAP[from];
      const needle = "locationId: '" + from + "'";
      const hits = src.split(needle).length - 1;
      if (hits) {
        src = src.split(needle).join("locationId: '" + to + "'");
        total += hits;
      }
      console.log('  ' + from.padEnd(12) + ' -> ' + to.padEnd(14) + '(' + hits + ' 处)');
    });

    fs.writeFileSync(file, src, 'utf8');
    console.log('  小计：' + total + ' 处');
    grandTotal += total;
  });

  console.log('\n共替换 ' + grandTotal + ' 处');
  console.log('注意：替换后请执行 node scripts/sync-core.js，并运行测试确认地点全部能解析。');
}

main();
