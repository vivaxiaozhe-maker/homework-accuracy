/* 销售/教务只读搜索：必须带关键字，服务端强制，杜绝全量拉取 */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { parseJson } = require('../util');

const router = express.Router();
router.use(requireRole('sales', 'admin'));

function accOf(r){ return r.total > 0 ? Math.round(r.correct / r.total * 100) : 0; }
function ownerName(ownerId){
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(ownerId);
  return u ? u.name : '未分配';
}

// GET /api/search/students?q=xxx：姓名/学校部分匹配，返回只读摘要
router.get('/students', (req, res) => {
  const q = (req.query.q || '').trim();
  if(!q) return res.status(400).json({ ok: false, msg: '请输入搜索关键字' });
  const like = '%' + q.replace(/[%_]/g, '') + '%';  // 去掉 LIKE 通配符，纯部分匹配
  const students = db.prepare('SELECT * FROM students WHERE name LIKE ? OR IFNULL(school, \'\') LIKE ?')
    .all(like, like);
  const recStmt = db.prepare('SELECT * FROM records WHERE student_id = ?');
  const missStmt = db.prepare('SELECT COUNT(*) AS c FROM missed WHERE student_id = ?');
  const items = students.map(s => {
    const recs = recStmt.all(s.id);
    const last = recs.length ? recs.reduce((a, b) => a.date > b.date ? a : b) : null;
    // 各科目 {正确率, 次数}
    const subMap = {};
    recs.forEach(r => {
      const k = r.subject || '未指定';
      (subMap[k] = subMap[k] || []).push(r);
    });
    const subjects = Object.keys(subMap).map(k => ({
      subject: k, cnt: subMap[k].length,
      avg: Math.round(subMap[k].reduce((x, r) => x + accOf(r), 0) / subMap[k].length)
    }));
    return { id: s.id, name: s.name, school: s.school || '', gradYear: s.grad_year || '',
      archived: !!s.archived, ownerName: ownerName(s.owner_id),
      recCnt: recs.length, missCnt: missStmt.get(s.id).c,
      lastAcc: last ? accOf(last) : null, subjects };
  });
  res.json({ ok: true, students: items });
});

// GET /api/search/students/:id：只读详情（按科目的打卡序列 + 计划/评语/建议/模考）
router.get('/students/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!s) return res.status(404).json({ ok: false, msg: '学生不存在' });
  const recs = db.prepare('SELECT * FROM records WHERE student_id = ?').all(s.id);
  const missed = db.prepare('SELECT * FROM missed WHERE student_id = ?').all(s.id);
  const plans = parseJson(s.subj_plans, {});
  // 科目全集：记录科目 + 未交科目 + 手动科目 + 计划科目
  const subjSet = new Set(parseJson(s.subjects, []));
  recs.forEach(r => subjSet.add(r.subject || '未指定'));
  missed.forEach(m => subjSet.add(m.subject || ''));
  Object.keys(plans).forEach(k => subjSet.add(k));
  const subjects = [...subjSet].filter(k => k !== '').map(k => {
    // 打卡序列：作业记录 + 未处理未交按日期合并（同日期记录在前，与前端 subjectItems 一致）
    const items = recs.filter(r => (r.subject || '未指定') === k)
      .map(r => ({ type: 'rec', date: r.date, total: r.total, correct: r.correct, acc: accOf(r), wrongs: parseJson(r.wrongs, []) }))
      .concat(missed.filter(m => (m.subject || '') === k && !m.resolved)
        .map(m => ({ type: 'miss', date: m.date })))
      .sort((a, b) => a.date === b.date ? (a.type === 'rec' ? -1 : 1) : (a.date < b.date ? -1 : 1));
    const done = items.filter(i => i.type === 'rec').length;
    return { subject: k, plan: plans[k] !== undefined ? plans[k] : null, done, items };
  });
  res.json({ ok: true, student: {
    id: s.id, name: s.name, school: s.school || '', gradYear: s.grad_year || '',
    archived: !!s.archived, ownerName: ownerName(s.owner_id),
    subjects,
    subjPlans: plans,
    subjPlanSetAt: parseJson(s.subj_plan_set_at, {}),
    subjComments: parseJson(s.subj_comments, {}),
    subjAdvice: parseJson(s.subj_advice, {}),
    mock: parseJson(s.mock, {})
  }});
});

module.exports = router;
