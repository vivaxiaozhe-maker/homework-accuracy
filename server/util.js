/* 通用工具：时间戳、id、审计日志写入（M3.6 会在此扩展为统一打点入口） */
const db = require('./db');

// 本地时间 YYYY-MM-DD HH:mm:ss（与前端 mock 的 ts 格式一致）
function nowTs(){
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function uid(prefix){
  return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* 写审计日志（服务端权威记录，不信前端打点） */
function logAudit(user, action, targetType, targetDesc, detail, ownerId){
  db.prepare(`INSERT INTO audit_logs (id, ts, user_id, user_name, role, action, target_type, target_desc, detail, owner_id)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(uid('log_'), nowTs(),
      user ? user.id : null, user ? user.name : null, user ? user.role : null,
      action, targetType || null, targetDesc || '', detail || '',
      ownerId || (user ? user.id : null));
}

/* 归属写权限：教务全部可写；助教仅自己名下；销售恒不可写 */
function canWrite(user, ownerId){
  if(!user || user.role === 'sales') return false;
  if(user.role === 'admin') return true;
  return user.id === ownerId;
}

/* ---- 行 → 前端 camelCase JSON（JSON 文本字段反序列化） ---- */
function parseJson(s, fallback){
  if(!s) return fallback;
  try{ return JSON.parse(s); }catch(e){ return fallback; }
}
function stuToJson(s){
  return { id: s.id, ownerId: s.owner_id, name: s.name, school: s.school || '', gradYear: s.grad_year || '',
    archived: !!s.archived, sample: !!s.sample,
    subjects: parseJson(s.subjects, []),
    subjPlans: parseJson(s.subj_plans, {}), subjPlanSetAt: parseJson(s.subj_plan_set_at, {}),
    subjComments: parseJson(s.subj_comments, {}), subjAdvice: parseJson(s.subj_advice, {}),
    mock: parseJson(s.mock, {}), createdAt: s.created_at };
}
function recToJson(r){
  return { id: r.id, studentId: r.student_id, ownerId: r.owner_id, date: r.date,
    total: r.total, correct: r.correct, wrongs: parseJson(r.wrongs, []),
    subject: r.subject || '', images: parseJson(r.images, []), pdfs: parseJson(r.pdfs, []), sample: !!r.sample };
}
function missToJson(m){
  return { id: m.id, studentId: m.student_id, ownerId: m.owner_id, date: m.date, subject: m.subject || '',
    resolved: !!m.resolved, resolution: m.resolution || null, resolvedAt: m.resolved_at || null, sample: !!m.sample };
}
function reqToJson(r){
  return { id: r.id, studentId: r.student_id, ownerId: r.owner_id, subject: r.subject,
    oldPlan: r.old_plan, newPlan: r.new_plan, reason: r.reason || '', status: r.status,
    requestedBy: r.requested_by, requestedAt: r.requested_at,
    reviewedBy: r.reviewed_by || null, reviewedAt: r.reviewed_at || null, sample: !!r.sample };
}

module.exports = { nowTs, uid, logAudit, canWrite, parseJson, stuToJson, recToJson, missToJson, reqToJson };
