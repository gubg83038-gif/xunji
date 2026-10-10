const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
const latest = source.split('## 未发布')[1];
if (!latest) throw new Error('缺少未发布日志');
const entry = latest.split(/\n### /)[1];
if (!entry || !/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(entry)) throw new Error('最新日志标题格式错误');
['用户诉求', '改动文件', '方案', '影响范围', '测试结果', '遗留 / 待办'].forEach((key) => {
  if (!entry.includes('**' + key + '**')) throw new Error('日志缺少字段：' + key);
});
console.log('✓ 最新变更日志格式和必填字段完整');
