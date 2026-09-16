/* 解绑申请路由（助教解绑家长需教务审批）
   GET  /api/unbind-requests?status=pending  教务全量；助教只看到自己提交的（前端「申请中」展示用）
   POST /api/unbind-requests/:id/review {approve}  仅教务；通过时该绑定标 unbound=1 */
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../auth');
const { logAudit } = require('../util');

const router = express.Router();

function toJson(r){
  return { id: r.id, studentId: r.student_id, bindId: r.bind_id,
    studentName: r.student_name || '', ownerName: r.owner_name || '', openid: r.openid || '',
    requestedBy: r.requested_by, requestedAt: r.requested_at, status: r.status,
    reviewedBy: r.reviewed_by || null, reviewedAt: r.reviewed_at || null };
}

// GET /api/unbind-requests?status=pending（全局 /api 守卫已完成登录校验）
router.get('/', (req, res) => {
  const status = String(req.query.status || 'pending');
  const params = [status];
  let sql = `SELECT r.*, s.name AS student_name, b.openid AS openid, u.name AS owner_name
             FROM unbind_requests r
             LEFT JOIN students s ON s.id = r.student_id
             LEFT JOIN parent_binds b ON b.id = r.bind_id
             LEFT JOIN users u ON u.id = r.owner_id
             WHERE r.status = ?`;
  if(req.user.role !== 'admin'){ sql += ' AND r.requested_by = ?'; params.push(req.user.id); }  // 助教只见自己提交的
  sql += ' ORDER BY r.requested_at DESC';
  res.json({ ok: true, requests: db.prepare(sql).all(...params).map(toJson) });
});

// POST /api/unbind-requests/:id/review {approve:true|false}（仅教务）
router.post('/:id/review', requireAdmin, (req, res) => {
  const r = db.prepare('SELECT * FROM unbind_requests WHERE id = ?').get(req.params.id);
  if(!r) return res.status(404).json({ ok: false, msg: '申请不存在' });
  if(r.status !== 'pending') return res.status(400).json({ ok: false, msg: '该申请已处理' });
  const approve = !!(req.body && req.body.approve);
  db.prepare('UPDATE unbind_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
    .run(approve ? 'approved' : 'rejected', req.user.id, new Date().toISOString(), r.id);
  if(approve) db.prepare('UPDATE parent_binds SET unbound = 1 WHERE id = ?').run(r.bind_id);  // 通过即解绑（软解绑留痕）
  const st = db.prepare('SELECT name FROM students WHERE id = ?').get(r.student_id);
  logAudit(req.user, approve ? '解绑审批通过' : '解绑审批驳回', 'student', st ? st.name : '（已删除学生）', '', r.owner_id);
  res.json({ ok: true });
});

module.exports = router;
