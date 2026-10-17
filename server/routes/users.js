/* 账号管理路由（仅教务；全局 /api 守卫已完成登录校验） */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../auth');
const { uid, logAudit, nowTs } = require('../util');

const router = express.Router();
router.use(requireAdmin);

function toJson(u){
  // v1.8.1 ENG-02：初始密码只显示一次（创建/重置当次响应返回），列表永不返回 tempPassword
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    disabled: !!u.disabled, mustChangePwd: !!u.must_change_pwd, createdAt: u.created_at,
    stuCnt: u.stu_cnt !== undefined ? u.stu_cnt : undefined
  };
}

// GET /api/users：全部账号（不含 pass_hash / temp_password），附学生数统计；deletedUsers = tombstone 名单（用户名永久锁定展示用）
router.get('/', (req, res) => {
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM students s WHERE s.owner_id = u.id) AS stu_cnt
                            FROM users u ORDER BY u.created_at, u.username`).all();
  const deleted = db.prepare('SELECT id, username, name, role, deleted_at FROM deleted_users ORDER BY deleted_at').all()
    .map(d => ({ id: d.id, username: d.username, name: d.name, role: d.role, deletedAt: d.deleted_at }));
  res.json({ ok: true, users: users.map(toJson), deletedUsers: deleted });
});

// POST /api/users {name, username, password, role}：创建助教/销售账号
router.post('/', (req, res) => {
  const { name, username, password, role } = req.body || {};
  if(!name || !username || !password) return res.status(400).json({ ok: false, msg: '请填写完整信息' });
  if(role !== 'ta' && role !== 'sales') return res.status(400).json({ ok: false, msg: '角色仅支持助教/销售' });
  if(password.length < 6) return res.status(400).json({ ok: false, msg: '初始密码至少 6 位' });
  if(db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)){
    return res.status(400).json({ ok: false, msg: '该登录账号已存在' });
  }
  // 用户名不复用（v1.8.1 NEW-01）：tombstone 命中的账号永久锁定
  if(db.prepare('SELECT 1 FROM deleted_users WHERE username = ?').get(username)){
    return res.status(400).json({ ok: false, msg: '该登录账号已被注销，永久不可复用' });
  }
  const u = { id: uid('u_'), username, name, role,
    pass_hash: bcrypt.hashSync(password, 10), created_at: new Date().toISOString() };
  // 初始密码不写库（NULL），仅当次响应返回一次（v1.8.1 ENG-02）
  db.prepare(`INSERT INTO users (id, username, name, role, pass_hash, disabled, must_change_pwd, created_at, temp_password)
              VALUES (?,?,?,?,?,0,1,?,NULL)`)
    .run(u.id, u.username, u.name, u.role, u.pass_hash, u.created_at);
  logAudit(req.user, '创建账号', 'account', name + '（' + username + '）', '角色：' + (role === 'sales' ? '销售' : '助教'));
  res.json({ ok: true, user: { id: u.id, username, name, role, mustChangePwd: true, createdAt: u.created_at, tempPassword: password } });
});

// POST /api/users/:id/reset {password}：重置密码，该用户 session 全清；初始密码仅当次响应返回一次（不写库）
router.post('/:id/reset', (req, res) => {
  const { password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if(!u) return res.status(404).json({ ok: false, msg: '账号不存在' });
  if(!password || password.length < 6) return res.status(400).json({ ok: false, msg: '初始密码至少 6 位' });
  db.prepare('UPDATE users SET pass_hash = ?, must_change_pwd = 1, temp_password = NULL WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  logAudit(req.user, '重置密码', 'account', u.name + '（' + u.username + '）', '');
  res.json({ ok: true, tempPassword: password });
});

// POST /api/users/:id/toggle：停用/启用；不能停自己、不能停最后一个可用教务；停用即清 session
router.post('/:id/toggle', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if(!u) return res.status(404).json({ ok: false, msg: '账号不存在' });
  if(u.id === req.user.id) return res.status(400).json({ ok: false, msg: '不能停用自己的账号' });
  if(u.role === 'admin' && !u.disabled){
    const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get().c;
    if(admins <= 1) return res.status(400).json({ ok: false, msg: '至少保留一个可用的教务账号' });
  }
  const nowDisabled = u.disabled ? 0 : 1;
  db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(nowDisabled, u.id);
  if(nowDisabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);  // 停用即下线
  logAudit(req.user, nowDisabled ? '停用账号' : '启用账号', 'account', u.name + '（' + u.username + '）', '');
  res.json({ ok: true, user: { id: u.id, disabled: !!nowDisabled } });
});

/* ---- 账号删除（v1.8.1 NEW-01）：仅教务、仅已停用的助教/销售；阻断式（有任何业务关联即拒绝，不级联） ---- */
// 阻断项全查：在服务/已归档学生、records/missed/files 的 owner_id 引用、pending 的 plan_requests/unbind_requests 引用
function impactOf(userId){
  const one = (sql, ...p)=>db.prepare(sql).get(...p).c;
  return {
    activeStu:        one('SELECT COUNT(*) AS c FROM students WHERE owner_id = ? AND archived = 0', userId),
    archivedStu:      one('SELECT COUNT(*) AS c FROM students WHERE owner_id = ? AND archived = 1', userId),
    recCnt:           one('SELECT COUNT(*) AS c FROM records WHERE owner_id = ?', userId),
    missCnt:          one('SELECT COUNT(*) AS c FROM missed WHERE owner_id = ?', userId),
    fileCnt:          one('SELECT COUNT(*) AS c FROM files WHERE owner_id = ?', userId),
    pendingPlanReq:   one("SELECT COUNT(*) AS c FROM plan_requests WHERE status = 'pending' AND (owner_id = ? OR requested_by = ?)", userId, userId),
    pendingUnbindReq: one("SELECT COUNT(*) AS c FROM unbind_requests WHERE status = 'pending' AND (owner_id = ? OR requested_by = ?)", userId, userId)
  };
}
function impactTotal(im){ return Object.keys(im).reduce((s, k)=>s + im[k], 0); }
// 删除资格硬规则（不含阻断项）：目标存在、非教务、非当前账号、已停用；返回 {code, msg} 或 null
function deleteRuleViolation(u, reqUser){
  if(!u) return { code: 404, msg: '账号不存在' };
  if(u.role === 'admin') return { code: 403, msg: '教务账号不可删除' };
  if(u.id === reqUser.id) return { code: 403, msg: '不能删除当前登录账号' };
  if(!u.disabled) return { code: 403, msg: '仅已停用的账号可删除，请先停用' };
  return null;
}

// GET /api/users/:id/delete-impact：删除影响预览（不含认证材料）
router.get('/:id/delete-impact', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if(!u) return res.status(404).json({ ok: false, msg: '账号不存在' });
  const violation = deleteRuleViolation(u, req.user);
  const impact = impactOf(u.id);
  res.json({ ok: true,
    target: { id: u.id, username: u.username, name: u.name, role: u.role, disabled: !!u.disabled },
    canDelete: !violation && impactTotal(impact) === 0,
    reason: violation ? violation.msg : (impactTotal(impact) > 0 ? '存在业务关联，需先交接' : ''),
    impact });
});

// DELETE /api/users/:id {confirmUsername}：阻断式删除，单事务（重检 → tombstone → 清会话 → 删行 → 审计）
router.delete('/:id', (req, res) => {
  const confirmUsername = req.body ? req.body.confirmUsername : undefined;
  const u0 = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  const violation = deleteRuleViolation(u0, req.user);
  if(violation) return res.status(violation.code).json({ ok: false, msg: violation.msg });
  if(confirmUsername !== u0.username) return res.status(400).json({ ok: false, msg: '确认账号不匹配，请输入完整登录账号' });
  try{
    db.transaction(() => {
      // 事务内重检目标与阻断项（防预览后竞态：预览→删除之间新产生的关联在此拦截）
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      const v2 = deleteRuleViolation(u, req.user);
      if(v2){ const e = new Error(v2.msg); e.status = v2.code; throw e; }
      const impact = impactOf(u.id);
      if(impactTotal(impact) > 0){ const e = new Error('仍存在业务关联，无法删除'); e.status = 409; e.impact = impact; throw e; }
      db.prepare('INSERT INTO deleted_users (id, username, name, role, deleted_at, deleted_by) VALUES (?,?,?,?,?,?)')
        .run(u.id, u.username, u.name, u.role, nowTs(), req.user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
      logAudit(req.user, '删除账号', 'account', u.name + '（' + u.username + '）',
        '角色：' + (u.role === 'sales' ? '销售' : '助教') + ' · 删除时无业务关联 · 用户名永久锁定，业务数据与历史操作记录保留');
    })();
  }catch(e){
    if(e.status === 409) return res.status(409).json({ ok: false, msg: e.message, impact: e.impact });
    if(e.status) return res.status(e.status).json({ ok: false, msg: e.message });
    return res.status(500).json({ ok: false, msg: '删除失败，已回滚' });
  }
  res.json({ ok: true });
});

module.exports = router;
