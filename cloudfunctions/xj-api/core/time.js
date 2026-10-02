/**
 * 时间工具：时间标准化、时间范围解析、相对时间展示、时间衰减相关度。
 * 对应方案 6.1 时间字段标准化 与 8.1 时间相关度。
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * 演示数据锚定的时区：北京时间（UTC+8）。
 *
 * ⚠ 真实踩过的坑：云函数运行环境的时区**不一定是 UTC+8**。
 *   如果直接 new Date().setHours(18, 42) 生成"今天 18:42"，
 *   在 UTC 环境里得到的是 18:42 UTC —— 小程序端（UTC+8）显示成次日 02:42，
 *   整个演示数据的时间会偏移 8 小时，界面日期看起来完全不对。
 *
 *   而且时间相关度还会因此失真：原本"丢失窗口结束后 22 分钟被捡到"，
 *   偏移后变成"提前 7.5 小时被捡到"，语义上也不合理。
 *
 * 所以演示数据的时间统一按北京时间构造，与运行环境时区无关。
 */
const CN_OFFSET_MINUTES = 8 * 60;

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 按北京时间构造「锚点日 + 时:分」的时间戳。
 *
 * @param {number} hour 北京时间的时（0-23）
 * @param {number} minute 北京时间的分
 * @param {number} dayOffset 相对锚点日的天数偏移（-1 表示昨天）
 * @param {number} anchorTs 锚点时间戳（默认当前时刻）
 * @returns {number} 时间戳（绝对时刻，与运行环境时区无关）
 */
function cnTime(hour, minute, dayOffset, anchorTs) {
  const anchor = new Date(anchorTs === undefined || anchorTs === null ? Date.now() : anchorTs);
  // 把锚点时刻换算成北京时间的"墙上时间"
  const cnNow = new Date(anchor.getTime() + CN_OFFSET_MINUTES * MIN);
  const y = cnNow.getUTCFullYear();
  const mo = cnNow.getUTCMonth();
  const d = cnNow.getUTCDate() + (dayOffset || 0);
  // 用 UTC 构造器避免本机时区再次介入，最后减去偏移还原成绝对时刻
  const wall = Date.UTC(y, mo, d, hour, minute || 0, 0, 0);
  return wall - CN_OFFSET_MINUTES * MIN;
}

/** Date | number | 'YYYY-MM-DD HH:mm' -> 时间戳 */
function toTs(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim().replace(/\./g, '-').replace(/\//g, '-');
  const m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (m) {
    return new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0)
    ).getTime();
  }
  const ts = new Date(text).getTime();
  return Number.isNaN(ts) ? 0 : ts;
}

/** 时间戳 -> 'YYYY-MM-DD HH:mm' */
function format(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 时间戳 -> 'MM-DD HH:mm' */
function formatShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 时间戳 -> 'HH:mm' */
function formatClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 时间戳 -> 'YYYY-MM-DDTHH:mm'（picker mode=date / time 需要） */
function toDateInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function toTimeInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 'YYYY-MM-DD' + 'HH:mm' -> 时间戳 */
function fromPicker(dateStr, timeStr) {
  if (!dateStr) return 0;
  return toTs(dateStr + ' ' + (timeStr || '00:00'));
}

/** 相对时间：“3 分钟前”“昨天 14:20”“3 天前” */
function fromNow(ts, nowTs) {
  if (!ts) return '';
  const now = nowTs || Date.now();
  const diff = now - ts;
  if (diff < 0) return format(ts);
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return Math.floor(diff / MIN) + ' 分钟前';
  if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前';
  if (diff < 2 * DAY) return '昨天 ' + formatClock(ts);
  if (diff < 7 * DAY) return Math.floor(diff / DAY) + ' 天前';
  return formatShort(ts);
}

/** 时长描述：分钟 -> “32 min” / “2 h 5 min” */
function durationText(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '未知';
  const abs = Math.abs(ms);
  if (abs < MIN) return '不到 1 分钟';
  const totalMin = Math.round(abs / MIN);
  if (totalMin < 60) return totalMin + ' 分钟';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? d + ' 天 ' + rh + ' 小时' : d + ' 天';
}

/**
 * 从自然语言时间描述中解析时间范围。
 * 支持：“今天下午3点”“昨天 18:10 左右”“17:30-18:20”“前天晚上”
 * @returns {{start:number, end:number, text:string, precise:boolean}|null}
 */
function parseTimeRange(raw, nowTs) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const now = new Date(nowTs || Date.now());

  let base = new Date(now.getTime());
  let precise = false;

  if (text.indexOf('前天') >= 0) base.setDate(base.getDate() - 2);
  else if (text.indexOf('昨天') >= 0) base.setDate(base.getDate() - 1);
  else if (text.indexOf('今天') >= 0) { /* 今天 */ }

  // 时段词
  let periodHour = null;
  if (text.indexOf('凌晨') >= 0) periodHour = 5;
  else if (text.indexOf('早上') >= 0 || text.indexOf('上午') >= 0) periodHour = 9;
  else if (text.indexOf('中午') >= 0) periodHour = 12;
  else if (text.indexOf('下午') >= 0) periodHour = 15;
  else if (text.indexOf('傍晚') >= 0 || text.indexOf('晚上') >= 0) periodHour = 19;

  // 17:30-18:20 / 17:30~18:20
  const range = text.match(/(\d{1,2})[:：](\d{1,2})\s*[-~到至]\s*(\d{1,2})[:：](\d{1,2})/);
  if (range) {
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(range[1]), Number(range[2]));
    const e = new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(range[3]), Number(range[4]));
    return { start: s.getTime(), end: e.getTime(), text: format(s.getTime()) + ' — ' + formatClock(e.getTime()), precise: true };
  }

  // 3点 / 15:30 / 下午3点半
  const single = text.match(/(\d{1,2})\s*(?:[:：]|点)\s*(\d{1,2})?\s*(半)?/);
  if (single) {
    let hh = Number(single[1]);
    let mm = single[2] !== undefined && single[2] !== '' ? Number(single[2]) : (single[3] ? 30 : 0);
    // 下午/晚上等时段词：12 小时制补 12
    if (periodHour !== null && periodHour >= 12 && hh < 12) hh += 12;
    if (hh > 23) hh = hh % 24;
    const t = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm);
    const win = 30 * MIN;
    return {
      start: t.getTime() - win,
      end: t.getTime() + win,
      text: '约 ' + formatClock(t.getTime()),
      precise: true
    };
  }

  if (periodHour !== null) {
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), periodHour - 2, 0);
    const e = new Date(base.getFullYear(), base.getMonth(), base.getDate(), periodHour + 3, 0);
    return { start: s.getTime(), end: e.getTime(), text: format(s.getTime()) + ' — ' + formatClock(e.getTime()), precise: false };
  }

  if (text.indexOf('今天') >= 0 || text.indexOf('昨天') >= 0 || text.indexOf('前天') >= 0) {
    const s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0);
    const e = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59);
    return { start: s.getTime(), end: e.getTime(), text: format(s.getTime()) + ' — ' + formatClock(e.getTime()), precise: false };
  }

  return null;
}

function rangeText(range) {
  if (!range) return '时间待确认';
  if (range.start && range.end) {
    const sameDay = toDateInput(range.start) === toDateInput(range.end);
    if (sameDay) {
      return formatShort(range.start) + ' — ' + formatClock(range.end);
    }
    return formatShort(range.start) + ' — ' + formatShort(range.end);
  }
  return format(range.start || range.end);
}

/** 时间范围中心点 */
function rangeCenter(range) {
  if (!range) return 0;
  if (range.start && range.end) return (range.start + range.end) / 2;
  return range.start || range.end || 0;
}

module.exports = {
  MIN,
  HOUR,
  DAY,
  CN_OFFSET_MINUTES,
  cnTime,
  toTs,
  format,
  formatShort,
  formatClock,
  toDateInput,
  toTimeInput,
  fromPicker,
  fromNow,
  durationText,
  parseTimeRange,
  rangeText,
  rangeCenter
};
