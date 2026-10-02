/**
 * 匹配流程中的纯函数部分（不依赖任何存储）
 * ---------------------------------------------------------------
 * 这些函数在小程序端与云函数端被共用，保证「本地演示」与「云端运行」
 * 的核验问题、语义核验、解释文案完全一致。
 */

const categorical = require('./categories');
const colorUtil = require('./color');
const matcher = require('./matcher');

/* ===================== 认领核验：问题生成 ===================== */

function toQuestion(feature) {
  const f = String(feature);
  if (f.indexOf('划痕') >= 0 || f.indexOf('磨损') >= 0 || f.indexOf('破损') >= 0 || f.indexOf('污渍') >= 0 || f.indexOf('磕碰') >= 0) {
    return '这件物品上有什么明显的使用痕迹？大概在什么位置？';
  }
  if (f.indexOf('贴纸') >= 0 || f.indexOf('贴画') >= 0 || f.indexOf('胶带') >= 0)
    return '物品上是否有贴纸或胶带？图案和位置是怎样的？';
  if (f.indexOf('刻字') >= 0 || f.indexOf('姓名') >= 0 || f.indexOf('标签') >= 0 || f.indexOf('扉页') >= 0)
    return '物品上是否有刻字、姓名贴或标签？内容是什么？';
  if (f.indexOf('挂件') >= 0 || f.indexOf('挂饰') >= 0 || f.indexOf('钥匙扣') >= 0)
    return '物品上挂了什么挂件或装饰？形状、颜色如何？';
  if (f.indexOf('包内') >= 0 || f.indexOf('口袋') >= 0 || f.indexOf('里面') >= 0)
    return '里面当时装了哪些东西？请列举两三样。';
  if (f.indexOf('伞柄') >= 0)
    return '伞柄是什么材质、什么形状？有没有特殊纹路？';
  if (f.indexOf('伞套') >= 0 || f.indexOf('卡套') >= 0 || f.indexOf('保护壳') >= 0 || f.indexOf('镜盒') >= 0 || f.indexOf('杯套') >= 0)
    return '配套的套／壳还在吗？是什么样子的？';
  if (f.indexOf('序列号') >= 0 || f.indexOf('编号') >= 0 || f.indexOf('卡号') >= 0)
    return '如果记得，请提供编号或序列号的后几位（选填）';
  if (f.indexOf('几把') >= 0 || f.indexOf('钥匙') >= 0)
    return '一共有几把钥匙？分别是什么用途？';
  if (f.indexOf('颜色') >= 0 || f.indexOf('胶圈') >= 0)
    return '这个部位的颜色是什么？';
  if (f.indexOf('照片') >= 0)
    return '证件上的照片有什么特征（仅用于人工核对，不会公开）？';
  if (f.indexOf('杯盖') >= 0 || f.indexOf('内侧') >= 0)
    return '物品内侧或盖子内部有什么特征？';
  return '请描述「' + f + '」的具体情况';
}

/** 把拾物者记录的私有特征转成核验问题 */
function buildQuestions(foundItem) {
  const features = (foundItem && foundItem.privateFeatures) || [];
  const cate = categorical.get(((foundItem && foundItem.attributes) || {}).category);
  const questions = features.map((f, idx) => ({
    id: 'q' + (idx + 1),
    feature: f,
    question: toQuestion(f),
    hint: '请描述具体特征，越具体越好（系统仅用于核验，不会公开展示）'
  }));
  if (!questions.length) {
    cate.privateFeatures.slice(0, 2).forEach((f, idx) => {
      questions.push({
        id: 'q' + (idx + 1),
        feature: f,
        question: toQuestion(f),
        hint: '由类别常识生成的问题，供拾物者参考核对'
      });
    });
  }
  return questions.slice(0, 3);
}

/* ===================== 认领核验：语义比对 ===================== */

const VERIFY_KEYWORDS = [
  '划痕', '贴纸', '刻字', '姓名', '挂件', '钥匙扣', '破损', '掉漆', '污渍', '序列号', '贴画',
  '标签', '图案', '颜色', '杯底', '内侧', '包内', '保护壳', '伞柄', '伞套', '胶带', '裂纹', '磕碰'
];

/**
 * 语义核验：把认领者的回答与拾物者记录的私有特征做语义比对。
 * 真实系统可用 LLM/embedding 做语义打分；此处用词汇重叠 + 特征关键词命中给出辅助分。
 * 返回值恒为 0~1，且明确标注「仅作辅助」。
 */
function verifyAnswer(answer, feature) {
  const a = String(answer || '').trim();
  if (!a) return { score: 0, reason: '未作答', keywords: [] };
  if (a.length < 2) return { score: 0.1, reason: '回答过短，无法判断', keywords: [] };

  const ts = colorUtil.textSimilarity(a, String(feature));
  const hitFeatureKw = VERIFY_KEYWORDS.filter((k) => String(feature).indexOf(k) >= 0 && a.indexOf(k) >= 0);

  let score = ts.score * 0.75 + Math.min(0.25, hitFeatureKw.length * 0.12);
  // 回答太笼统（如「就是有划痕」）不给高分
  if (a.length < 6) score *= 0.7;
  score = matcher.clamp01(score);

  let reason;
  if (score >= 0.6) reason = '回答与记录的私有特征语义高度一致';
  else if (score >= 0.32) reason = '回答与私有特征部分吻合，需要人工确认';
  else reason = '回答与私有特征匹配度低';
  return { score, reason, keywords: hitFeatureKw };
}

/** 批量核验：返回逐题结果与平均分 */
function verifyAll(questions, answers) {
  const list = (questions || []).map((q, idx) => {
    const answer = (answers && answers[idx]) || '';
    const result = verifyAnswer(answer, q.feature);
    return {
      questionId: q.id,
      question: q.question,
      feature: q.feature,
      answer,
      score: result.score,
      reason: result.reason,
      keywords: result.keywords || []
    };
  });
  const valid = list.filter((x) => x.answer);
  const avg = valid.length ? valid.reduce((s, x) => s + x.score, 0) / valid.length : 0;
  return { list, score: Number(avg.toFixed(4)) };
}

/* ===================== 权重与属性差异文案 ===================== */

const WEIGHT_NAMES = { image: '图像α', attr: '属性β', text: '文字γ', geo: '地点δ', time: '时间ε' };

function weightText(detail) {
  if (!detail || !detail.weights) return '';
  return Object.keys(WEIGHT_NAMES)
    .filter((k) => (detail.weights[k] || 0) > 0.001)
    .map((k) => WEIGHT_NAMES[k] + '=' + detail.weights[k].toFixed(2))
    .join('  ');
}

/** 属性逐项对比行（对比页表格） */
function buildAttrRows(attrItems) {
  return (attrItems || []).map((it) => {
    let judgement = '近似';
    let cls = 'warn';
    if (it.score >= 0.9) { judgement = '一致'; cls = 'success'; }
    else if (it.score <= 0.4) { judgement = '不一致'; cls = 'danger'; }
    if (it.a === '未提供' || it.b === '未提供') { judgement = '信息不全'; cls = 'gray'; }
    return {
      field: it.field,
      label: it.label,
      a: it.a,
      b: it.b,
      score: it.score,
      percent: Math.round(it.score * 100),
      note: it.note,
      judgement,
      cls
    };
  });
}

module.exports = {
  toQuestion,
  buildQuestions,
  verifyAnswer,
  verifyAll,
  weightText,
  buildAttrRows,
  WEIGHT_NAMES
};
