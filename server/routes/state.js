/* 全量状态接口：GET /api/state —— 助教只见自己 owner 的数据；教务全量；销售 403
   （mock 期前端一次性拉全量；增量写接口见 records/students/planreq 路由） */
const express = require('express');
const db = require('../db');
const { stuToJson, recToJson, missToJson, reqToJson } = require('../util');

const router = express.Router();

router.get('/', (req, res) => {
  if(req.user.role === 'sales') return res.status(403).json({ ok: false, msg: '没有权限' });
  const isAdmin = req.user.role === 'admin';
  const students = (isAdmin
    ? db.prepare('SELECT * FROM students').all()
    : db.prepare('SELECT * FROM students WHERE owner_id = ?').all(req.user.id)).map(stuToJson);
  const records = (isAdmin
    ? db.prepare('SELECT * FROM records').all()
    : db.prepare('SELECT * FROM records WHERE owner_id = ?').all(req.user.id)).map(recToJson);
  const missed = (isAdmin
    ? db.prepare('SELECT * FROM missed').all()
    : db.prepare('SELECT * FROM missed WHERE owner_id = ?').all(req.user.id)).map(missToJson);
  const planRequests = (isAdmin
    ? db.prepare('SELECT * FROM plan_requests').all()
    : db.prepare('SELECT * FROM plan_requests WHERE owner_id = ?').all(req.user.id)).map(reqToJson);
  res.json({ ok: true, state: { students, records, missed, planRequests } });
});

module.exports = router;
