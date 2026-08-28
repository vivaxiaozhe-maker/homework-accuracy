/* 认证路由：登录 / 登出 / 修改密码
   响应风格统一 {ok:true,...} / {ok:false,msg}（与前端 mock Api 形态一致，M5 平替用） */
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { createSession } = require('../auth');
const { logAudit } = require('../util');

const router = express.Router();

// 登录限流：10 次/分钟/IP，只计失败尝试（成功登录不限，避免误伤正常多人共用出口 IP）
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: (req, res) => res.status(429).json({ ok: false, msg: '尝试过于频繁，请 1 分钟后再试' })
});

// POST /api/login {username, password, role?}
router.post('/login', loginLimiter, (req, res) => {
  const { username, password, role } = req.body || {};
  if(!username || !password) return res.status(400).json({ ok: false, msg: '请输入账号和密码' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if(!u) return res.status(401).json({ ok: false, msg: '账号不存在' });
  if(role && u.role !== role){
    const roleName = { admin: '教务', ta: '助教', sales: '销售' }[u.role] || u.role;
    return res.status(401).json({ ok: false, msg: '该账号是' + roleName + '账号，请切换为「' + roleName + '」角色登录' });
  }
  if(u.disabled) return res.status(401).json({ ok: false, msg: '该账号已被停用，请联系教务' });
  if(!bcrypt.compareSync(password, u.pass_hash)) return res.status(401).json({ ok: false, msg: '密码错误' });
  const token = createSession(u.id);
  logAudit(u, '登录成功', 'auth', u.name + '（' + u.username + '）', '');
  res.json({ ok: true, token, user: {
    id: u.id, username: u.username, name: u.name, role: u.role, mustChangePwd: !!u.must_change_pwd
  }});
});

// GET /api/me（全局守卫已登录校验）：返回当前用户，供前端刷新时校验 token 并恢复会话
router.get('/me', (req, res) => {
  const u = req.user;
  res.json({ ok: true, user: {
    id: u.id, username: u.username, name: u.name, role: u.role, mustChangePwd: !!u.must_change_pwd
  }});
});

// POST /api/logout（全局 /api 守卫已挂载 req.user / req.token）
router.post('/logout', (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

// POST /api/password {oldPwd, newPwd}：验旧改新，其他 session 全部失效
router.post('/password', (req, res) => {
  const { oldPwd, newPwd } = req.body || {};
  const u = req.user;
  if(!newPwd || newPwd.length < 6) return res.status(400).json({ ok: false, msg: '新密码至少 6 位' });
  if(!bcrypt.compareSync(oldPwd || '', u.pass_hash)) return res.status(401).json({ ok: false, msg: '原密码不正确' });
  db.prepare('UPDATE users SET pass_hash = ?, must_change_pwd = 0 WHERE id = ?')
    .run(bcrypt.hashSync(newPwd, 10), u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, req.token);  // 其他端全下线
  logAudit(u, '修改密码', 'auth', u.name + '（' + u.username + '）', '');
  res.json({ ok: true });
});

module.exports = router;
