/* 推送配置 + 手动推送路由
   GET  /api/push-config            全角色可读（开关状态；默认全关）
   PUT  /api/push-config            仅教务，整体替换三个开关，写审计
   POST /api/push/:kind             手动推送（homework / mock-book / mock-score），助教本人/教务，归属校验 */
const express = require('express');
const db = require('../db');
const { requireRole, requireAdmin } = require('../auth');
const { logAudit, canWrite } = require('../util');
const push = require('../push');

const router = express.Router();

// GET /api/push-config（全局 /api 守卫已完成登录校验；全角色可读）
router.get('/push-config', (req, res) => {
  res.json({ ok: true, config: push.pushConfig() });
});

// PUT /api/push-config {config:{homework,mockBook,mockScore}}（仅教务）
router.put('/push-config', requireAdmin, (req, res) => {
  const c = (req.body && (req.body.config || req.body)) || {};
  push.savePushConfig(c);
  const saved = push.pushConfig();
  logAudit(req.user, '修改自动推送开关', 'data', '微信自动推送',
    Object.keys(saved).map(k => (k === 'homework' ? '作业成绩' : k === 'mockBook' ? '模考预约' : '模考成绩') + (saved[k] ? '开' : '关')).join('、'));
  res.json({ ok: true, config: saved });
});

// POST /api/push/:kind {studentId, subject}（手动推送；开关不影响手动推送——手动是「家长没收到时补推」）
const KIND_MAP = { homework: 'homework', 'mock-book': 'mockBook', 'mock-score': 'mockScore' };
router.post('/push/:kind', requireRole('ta', 'admin'), async (req, res) => {
  const kind = KIND_MAP[req.params.kind];
  if(!kind) return res.status(404).json({ ok: false, msg: '接口不存在' });
  const { studentId, subject } = req.body || {};
  if(!studentId || !subject) return res.status(400).json({ ok: false, msg: '缺少学生或科目' });
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限操作该数据' });
  const r = await push.pushTemplate(req.user, st, kind, subject, push.shareUrlFor(req, st, subject));
  if(r.err) return res.status(r.status || 500).json({ ok: false, msg: r.err });
  res.json({ ok: true, sent: r.sent });
});

module.exports = router;
