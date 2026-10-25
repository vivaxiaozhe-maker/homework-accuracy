/* 全局作业设置
   GET /api/homework-cycle  所有登录角色可读；未配置时默认 14 天
   PUT /api/homework-cycle  仅教务；body {days: 1–30 的整数}，写审计日志 */
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../auth');
const { logAudit } = require('../util');

const router = express.Router();
const DEFAULT_DAYS = 14;
const KEY = 'homework_cycle_days';

function validDays(v){ return Number.isInteger(v) && v >= 1 && v <= 30; }
function homeworkCycleDays(){
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  if(!row) return DEFAULT_DAYS;
  const days = Number(row.value);
  return validDays(days) ? days : DEFAULT_DAYS;
}

router.get('/homework-cycle', (req, res) => {
  res.json({ ok: true, days: homeworkCycleDays() });
});

router.put('/homework-cycle', requireAdmin, (req, res) => {
  const days = req.body && req.body.days;
  if(!validDays(days)) return res.status(400).json({ ok: false, msg: '作业周期必须为 1～30 天的整数' });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(KEY, String(days));
  logAudit(req.user, '修改作业周期', 'data', '作业设置', '作业周期：' + days + ' 天');
  res.json({ ok: true, days });
});

module.exports = router;
