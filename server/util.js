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

module.exports = { nowTs, uid, logAudit };
