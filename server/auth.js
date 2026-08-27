/* 认证与角色中间件（token 存 sessions 表，有效期 7 天） */
const crypto = require('crypto');
const db = require('./db');

const SESSION_DAYS = 7;
function nowIso(){ return new Date().toISOString(); }

// 签发 token 并写 sessions 表
function createSession(userId){
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now.toISOString(), exp.toISOString());
  return token;
}

// auth 中间件：Authorization: Bearer <token> → req.user；顺带惰性清理过期 session
function auth(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if(!token) return res.status(401).json({ ok: false, msg: '未登录或登录已过期' });
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());  // 惰性清理
  const sess = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if(!sess) return res.status(401).json({ ok: false, msg: '未登录或登录已过期' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
  if(!user || user.disabled) return res.status(401).json({ ok: false, msg: '未登录或登录已过期' });
  req.user = user;
  req.token = token;
  next();
}

// 角色中间件工厂；常用三个直接导出
function requireRole(...roles){
  return (req, res, next) => {
    if(!req.user || roles.indexOf(req.user.role) === -1){
      return res.status(403).json({ ok: false, msg: '没有权限' });
    }
    next();
  };
}
const requireAdmin = requireRole('admin');
const requireTA = requireRole('ta');
const requireSales = requireRole('sales');

module.exports = { auth, createSession, requireRole, requireAdmin, requireTA, requireSales };
