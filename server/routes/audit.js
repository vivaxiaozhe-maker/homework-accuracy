/* 审计日志查询：GET /api/audit-logs?q=&type=&range=&page=&pageSize=
   教务全量；助教只看 userId=自己 或 ownerId=自己；销售 403；服务端分页（默认 50 条/页） */
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  if(req.user.role === 'sales') return res.status(403).json({ ok: false, msg: '没有权限' });
  const q = (req.query.q || '').trim();
  const type = (req.query.type || '').trim();
  const range = parseInt(req.query.range || '0', 10);  // 1=今天 7/30=近N天 0=全部
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize || '50', 10)));

  const where = [];
  const params = [];
  if(req.user.role === 'ta'){  // 助教口径：自己的操作 + 自己名下数据相关
    where.push('(user_id = ? OR owner_id = ?)');
    params.push(req.user.id, req.user.id);
  }
  if(range > 0){
    const start = new Date();
    start.setDate(start.getDate() - (range - 1));
    const ds = start.getFullYear() + '-' + String(start.getMonth()+1).padStart(2,'0') + '-' + String(start.getDate()).padStart(2,'0');
    where.push('ts >= ?');
    params.push(ds);
  }
  if(type){ where.push('target_type = ?'); params.push(type); }
  if(q){
    where.push("(target_desc LIKE ? OR detail LIKE ? OR user_name LIKE ? OR action LIKE ?)");
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_logs' + whereSql).get(...params).c;
  const items = db.prepare('SELECT * FROM audit_logs' + whereSql + ' ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
    .all(...params, pageSize, (page - 1) * pageSize)
    .map(l => ({ id: l.id, ts: l.ts, userId: l.user_id, userName: l.user_name, role: l.role,
      action: l.action, targetType: l.target_type, targetDesc: l.target_desc || '',
      detail: l.detail || '', ownerId: l.owner_id }));
  res.json({ ok: true, total, page, pageSize, items });
});

module.exports = router;
