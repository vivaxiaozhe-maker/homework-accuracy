/* 账号管理路由（仅教务；全局 /api 守卫已完成登录校验） */
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../auth');
const { uid, logAudit } = require('../util');

const router = express.Router();
router.use(requireAdmin);

function toJson(u){
  return {
    id: u.id, username: u.username, name: u.name, role: u.role,
    disabled: !!u.disabled, mustChangePwd: !!u.must_change_pwd, createdAt: u.created_at,
    stuCnt: u.stu_cnt !== undefined ? u.stu_cnt : undefined
  };
}

// GET /api/users：全部账号（不含 pass_hash），附学生数统计
router.get('/', (req, res) => {
  const users = db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM students s WHERE s.owner_id = u.id) AS stu_cnt
                            FROM users u ORDER BY u.created_at, u.username`).all();
  res.json({ ok: true, users: users.map(toJson) });
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
  const u = { id: uid('u_'), username, name, role,
    pass_hash: bcrypt.hashSync(password, 10), created_at: new Date().toISOString() };
  db.prepare(`INSERT INTO users (id, username, name, role, pass_hash, disabled, must_change_pwd, created_at)
              VALUES (?,?,?,?,?,0,1,?)`)
    .run(u.id, u.username, u.name, u.role, u.pass_hash, u.created_at);
  logAudit(req.user, '创建账号', 'account', name + '（' + username + '）', '角色：' + (role === 'sales' ? '销售' : '助教'));
  res.json({ ok: true, user: { id: u.id, username, name, role, mustChangePwd: true, createdAt: u.created_at } });
});

// POST /api/users/:id/reset {password}：重置密码，该用户 session 全清
router.post('/:id/reset', (req, res) => {
  const { password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if(!u) return res.status(404).json({ ok: false, msg: '账号不存在' });
  if(!password || password.length < 6) return res.status(400).json({ ok: false, msg: '初始密码至少 6 位' });
  db.prepare('UPDATE users SET pass_hash = ?, must_change_pwd = 1 WHERE id = ?')
    .run(bcrypt.hashSync(password, 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  logAudit(req.user, '重置密码', 'account', u.name + '（' + u.username + '）', '');
  res.json({ ok: true });
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

module.exports = router;
