/* 计划次数路由：首次直存 + 二次修改审批流（校验规则与前端 LocalApi 一致） */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite, parseJson, reqToJson } = require('../util');

const router = express.Router();

function todayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function getStu(id){ return db.prepare('SELECT * FROM students WHERE id = ?').get(id); }
function stuDesc(s, subject){ return (s ? s.name : '（已删除学生）') + (subject ? ' · ' + subject : ''); }

// POST /api/plan/set {studentId, subject, plan}：首次设定直存（助教/教务；已有值则拒绝，走申请）
router.post('/plan/set', requireRole('ta', 'admin'), (req, res) => {
  const { studentId, subject, plan } = req.body || {};
  const st = getStu(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(st.archived) return res.status(400).json({ ok: false, msg: '历史学生不可设置计划' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const v = parseInt(plan, 10);
  if(!Number.isInteger(v) || v < 0) return res.status(400).json({ ok: false, msg: '请填写有效的次数（0 或正整数）' });
  const plans = parseJson(st.subj_plans, {});
  if(plans[subject] !== undefined) return res.status(400).json({ ok: false, msg: '该科目已有计划次数，修改需提交申请' });
  const setAt = parseJson(st.subj_plan_set_at, {});
  plans[subject] = v;
  setAt[subject] = todayStr();
  db.prepare('UPDATE students SET subj_plans = ?, subj_plan_set_at = ? WHERE id = ?')
    .run(JSON.stringify(plans), JSON.stringify(setAt), st.id);
  logAudit(req.user, '设定应完成次数', 'plan', stuDesc(st, subject), '设定为 ' + v + ' 次', st.owner_id);
  res.json({ ok: true });
});

// POST /api/plan-requests {studentId, subject, newPlan, reason}：助教发起二次修改申请
router.post('/plan-requests', requireRole('ta', 'admin'), (req, res) => {
  const { studentId, subject, newPlan, reason } = req.body || {};
  const st = getStu(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(st.archived) return res.status(400).json({ ok: false, msg: '历史学生不可修改计划' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const plans = parseJson(st.subj_plans, {});
  const oldPlan = plans[subject] !== undefined ? plans[subject] : null;
  if(oldPlan === null) return res.status(400).json({ ok: false, msg: '首次设置无需申请，直接保存即可' });
  const v = parseInt(newPlan, 10);
  if(!Number.isInteger(v) || v < 0) return res.status(400).json({ ok: false, msg: '请填写有效的次数（0 或正整数）' });
  if(v === oldPlan) return res.status(400).json({ ok: false, msg: '次数未变化' });
  const pend = db.prepare("SELECT 1 FROM plan_requests WHERE student_id = ? AND subject = ? AND status = 'pending'")
    .get(studentId, subject);
  if(pend) return res.status(400).json({ ok: false, msg: '该科目已有待审核的修改申请，请先撤回' });
  const id = uid('pr_');
  db.prepare(`INSERT INTO plan_requests (id, student_id, owner_id, subject, old_plan, new_plan, reason, status,
              requested_by, requested_at, sample) VALUES (?,?,?,?,?,?,?,'pending',?,?,0)`)
    .run(id, st.id, st.owner_id, subject, oldPlan, v, (reason || '').trim(), req.user.id, todayStr());
  logAudit(req.user, '申请修改计划次数', 'plan', stuDesc(st, subject),
    oldPlan + ' → ' + v + ' 次' + (reason ? '，理由：' + reason : ''), st.owner_id);
  res.json({ ok: true, request: reqToJson(db.prepare('SELECT * FROM plan_requests WHERE id = ?').get(id)) });
});

// POST /api/plan-requests/:id/cancel：撤回（仅申请本人或教务，且 pending）
router.post('/plan-requests/:id/cancel', requireRole('ta', 'admin'), (req, res) => {
  const r = db.prepare('SELECT * FROM plan_requests WHERE id = ?').get(req.params.id);
  if(!r) return res.status(404).json({ ok: false, msg: '申请不存在' });
  if(r.status !== 'pending') return res.status(400).json({ ok: false, msg: '该申请已处理，不能撤回' });
  if(req.user.role !== 'admin' && r.requested_by !== req.user.id){
    return res.status(403).json({ ok: false, msg: '只能撤回自己的申请' });
  }
  db.prepare("UPDATE plan_requests SET status = 'cancelled' WHERE id = ?").run(r.id);
  logAudit(req.user, '撤回修改申请', 'plan', stuDesc(getStu(r.student_id), r.subject),
    r.old_plan + ' → ' + r.new_plan + ' 次', r.owner_id);
  res.json({ ok: true });
});

// POST /api/plan-requests/:id/review {approve, note?}：仅教务；通过时原子更新 subj_plans 与 subj_plan_set_at
router.post('/plan-requests/:id/review', requireRole('admin'), (req, res) => {
  const r = db.prepare('SELECT * FROM plan_requests WHERE id = ?').get(req.params.id);
  if(!r) return res.status(404).json({ ok: false, msg: '申请不存在' });
  if(r.status !== 'pending') return res.status(400).json({ ok: false, msg: '该申请已处理' });
  const approve = !!(req.body && req.body.approve);
  const note = req.body && req.body.note;
  const tx = db.transaction(() => {
    db.prepare("UPDATE plan_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?")
      .run(approve ? 'approved' : 'rejected', req.user.id, todayStr(), r.id);
    if(approve){
      const st = getStu(r.student_id);
      if(st){
        const plans = parseJson(st.subj_plans, {});
        const setAt = parseJson(st.subj_plan_set_at, {});
        plans[r.subject] = r.new_plan;
        setAt[r.subject] = todayStr();
        db.prepare('UPDATE students SET subj_plans = ?, subj_plan_set_at = ? WHERE id = ?')
          .run(JSON.stringify(plans), JSON.stringify(setAt), st.id);
      }
    }
  });
  tx();
  logAudit(req.user, approve ? '审批通过' : '审批驳回', 'plan', stuDesc(getStu(r.student_id), r.subject),
    r.old_plan + ' → ' + r.new_plan + ' 次' + (note ? '，' + note : ''), r.owner_id);
  res.json({ ok: true });
});

module.exports = router;
