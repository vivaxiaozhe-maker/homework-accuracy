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
  // 家长绑定数（学生卡显示绑定状态用；一次聚合查询避免 N+1）
  const bindMap = {};
  db.prepare('SELECT student_id, COUNT(*) AS c FROM parent_binds WHERE unbound = 0 GROUP BY student_id').all()
    .forEach(b => { bindMap[b.student_id] = b.c; });
  students.forEach(s => { s.bindCnt = bindMap[s.id] || 0; });
  const records = (isAdmin
    ? db.prepare('SELECT * FROM records').all()
    : db.prepare('SELECT * FROM records WHERE owner_id = ?').all(req.user.id)).map(recToJson);
  const missed = (isAdmin
    ? db.prepare('SELECT * FROM missed').all()
    : db.prepare('SELECT * FROM missed WHERE owner_id = ?').all(req.user.id)).map(missToJson);
  const planRequests = (isAdmin
    ? db.prepare('SELECT * FROM plan_requests').all()
    : db.prepare('SELECT * FROM plan_requests WHERE owner_id = ?').all(req.user.id)).map(reqToJson);
  // 待办预警动作（alert_actions）随 state 全量同步（少一次请求）。
  // 助教口径：自己操作的 + 涉及自己名下学生的（miss→missed 归属；lowAcc/planStall→ref_key 学生归属）
  const alertRows = db.prepare('SELECT * FROM alert_actions ORDER BY created_at').all();
  const ownerOfRef = (kind, refKey) => {
    if(kind === 'miss'){
      const m = db.prepare('SELECT owner_id FROM missed WHERE id = ?').get(refKey);
      return m ? m.owner_id : null;
    }
    const st = db.prepare('SELECT owner_id FROM students WHERE id = ?').get(String(refKey).split('|')[0]);
    return st ? st.owner_id : null;
  };
  const alertActions = alertRows
    .filter(a => isAdmin || a.actor_id === req.user.id || ownerOfRef(a.kind, a.ref_key) === req.user.id)
    .map(a => ({ id: a.id, kind: a.kind, refKey: a.ref_key, action: a.action,
      actorId: a.actor_id, actorName: a.actor_name, note: a.note || '',
      createdAt: a.created_at, snoozeUntil: a.snooze_until || null }));
  res.json({ ok: true, state: { students, records, missed, planRequests, alertActions } });
});

module.exports = router;
