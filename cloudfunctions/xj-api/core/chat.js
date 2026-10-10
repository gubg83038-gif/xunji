/**
 * 核验期临时会话（纯函数，平台无关）
 * ---------------------------------------------------------------
 * 背景：认领单进入「待拾物者确认」后，双方还需要商量线下交接的时间与地点，
 * 但页面只给了「复制我的核验回答」这一个弱联系手段，失主和拾物者实际上
 * 没法对话。
 *
 * 设计原则（刻意做得很克制）：
 *   1. **只在一条认领单内部存在**：不是社交私信，没有联系人列表，
 *      认领单结束（归还 / 拒绝 / 关闭）即关闭会话；
 *   2. **只在核验期开放**：answering 阶段会话未开启（防止认领者先套话），
 *      归还完成后转只读；
 *   3. **不收集真实联系方式**：正文里出现手机号 / 微信号时在服务端脱敏，
 *      仅保留线下约定所需的时间地点信息；
 *   4. 纯函数，无存储依赖，小程序端与云函数端共用，保证两端行为一致。
 */

/** 会话状态：closed 未开启 / open 可对话 / readonly 只读（已归还或已拒绝） */
const SESSION_STATE = {
  closed: { key: 'closed', label: '会话未开启', desc: '提交核验回答后，会为双方开启一条临时会话' },
  open: { key: 'open', label: '临时会话中', desc: '仅本次认领的双方可见；归还完成后会话转为只读' },
  readonly: { key: 'readonly', label: '会话已只读', desc: '本次认领已结束，会话不再接受新消息' }
};

/** 认领状态 → 会话状态 */
const STATE_BY_CLAIM_STATUS = {
  answering: 'closed',
  submitted: 'open',
  verified: 'open',
  returned: 'readonly',
  rejected: 'readonly'
};

const MAX_LENGTH = 200;
const MAX_MESSAGES = 100;

/**
 * 手机号 / 社交账号的粗匹配。
 *
 * ⚠ 顺序有讲究：手机号与「微信/QQ + 账号」必须排在纯数字串之前。
 *   否则 `\d{5,12}` 会先把手机号的 11 位数字吃掉，手机号规则就永远命中不了。
 *   这里刻意**不**拦截纯数字串——学号、快递单号、座位号都是线下交接的有用信息。
 */
const CONTACT_PATTERNS = [
  { re: /1[3-9]\d{9}/g, replace: '[手机号已隐藏]' },
  { re: /(微信|weixin|wechat|vx|VX|v信|企鹅|QQ|qq)\s*(?:号|号是|：|:)?\s*[A-Za-z0-9_-]{5,}/g, replace: '[社交账号已隐藏]' }
];

/** 会话状态查询 */
function sessionState(claimStatus) {
  const key = STATE_BY_CLAIM_STATUS[claimStatus] || 'closed';
  return Object.assign({ key }, SESSION_STATE[key]);
}

/** 是否可以发消息 */
function canSend(claimStatus) {
  return sessionState(claimStatus).key === 'open';
}

/**
 * 脱敏：把联系方式替换掉，但保留时间地点这类交接必需信息。
 * @returns {{text:string, redacted:boolean}}
 */
function sanitize(text) {
  let out = String(text === undefined || text === null ? '' : text);
  let redacted = false;
  CONTACT_PATTERNS.forEach((p) => {
    if (p.re.test(out)) {
      redacted = true;
      out = out.replace(p.re, p.replace);
    }
    p.re.lastIndex = 0;
  });
  return { text: out, redacted };
}

/**
 * 创建一条会话消息。
 * @param {{claimId:string, senderId:string, senderRole:string, text:string, now?:number, id?:string, uid?:function}} input
 * @returns {{ok:boolean, message?:string, value?:object}}
 */
function createMessage(input) {
  const data = input || {};
  const raw = String(data.text || '').trim();
  if (!raw) return { ok: false, message: '消息不能为空' };
  if (raw.length > MAX_LENGTH) return { ok: false, message: '消息最多 ' + MAX_LENGTH + ' 字' };

  const cleaned = sanitize(raw);
  const now = data.now || Date.now();
  const id = data.id || (typeof data.uid === 'function' ? data.uid('msg') : 'msg_' + now);
  return {
    ok: true,
    value: {
      id,
      senderId: data.senderId || '',
      senderRole: data.senderRole === 'keeper' ? 'keeper' : 'claimant',
      text: cleaned.text,
      redacted: cleaned.redacted,
      createdAt: now
    }
  };
}

/**
 * 追加消息到列表（纯函数，返回新数组）。
 * 超出上限时保留最新的 MAX_MESSAGES 条，避免认领单文档无限膨胀。
 */
function appendMessage(list, message) {
  const base = Array.isArray(list) ? list.slice() : [];
  if (!message) return base;
  base.push(message);
  return base.length > MAX_MESSAGES ? base.slice(base.length - MAX_MESSAGES) : base;
}

/** 昵称脱敏：对方看到完整昵称；自己看到「我」 */
function displayName(nickName, isMine) {
  if (isMine) return '我';
  return nickName || '对方';
}

/**
 * 构造会话视图（页面直接用）。
 *
 * @param {object} claim   认领单实体
 * @param {object} options { userId, nameOf(userId), now }
 * @returns {object|null}
 */
function sessionView(claim, options) {
  if (!claim) return null;
  const opts = options || {};
  const userId = opts.userId || '';
  const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : () => '';
  const now = opts.now || Date.now();
  const st = sessionState(claim.status);
  const myRole = claim.keeperId === userId && claim.claimantId !== userId ? 'keeper' : 'claimant';

  const messages = (claim.messages || []).map((m) => {
    const mine = m.senderId === userId;
    return {
      id: m.id,
      text: m.text,
      redacted: !!m.redacted,
      mine,
      senderRole: m.senderRole || 'claimant',
      senderName: displayName(mine ? '' : nameOf(m.senderId), mine),
      createdAt: m.createdAt,
      timeText: formatClock(m.createdAt, now)
    };
  });

  return {
    state: st.key,
    stateLabel: st.label,
    stateDesc: st.desc,
    canSend: st.key === 'open',
    myRole,
    counterpartRole: myRole === 'keeper' ? 'claimant' : 'keeper',
    counterpartLabel: myRole === 'keeper' ? '失主' : '拾物者',
    myLabel: myRole === 'keeper' ? '拾物者（我）' : '失主（我）',
    count: messages.length,
    messages,
    hasMessages: messages.length > 0
  };
}

/** 相对时间：今天显示 HH:mm，昨天 / 更早显示月-日 HH:mm */
function formatClock(ts, now) {
  if (!ts) return '';
  const d = new Date(ts);
  const n = new Date(now || Date.now());
  const pad = (x) => (x < 10 ? '0' + x : String(x));
  const hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
  const sameDay = d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
}

module.exports = {
  SESSION_STATE,
  STATE_BY_CLAIM_STATUS,
  MAX_LENGTH,
  MAX_MESSAGES,
  sessionState,
  canSend,
  sanitize,
  createMessage,
  appendMessage,
  displayName,
  sessionView,
  formatClock
};
