/* 作业记录 + 未交路由（records / missed）
   归属口径：记录的 owner_id 跟随学生归属；写操作校验归属（教务除外） */
const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite, recToJson, missToJson, parseJson } = require('../util');

const router = express.Router();
const guard = requireRole('ta', 'admin');  // 销售只读，不能写（逐路由挂载，不能用 router.use——本路由挂在 /api 根上）

function accText(total, correct){
  return '总 ' + total + ' 对 ' + correct + '（正确率 ' + (total > 0 ? Math.round(correct / total * 100) : 0) + '%）';
}
// 学生科目描述（审计用）：「姓名 · 科目」
function stuDesc(studentId, subject){
  const s = db.prepare('SELECT name FROM students WHERE id = ?').get(studentId);
  return (s ? s.name : '（已删除学生）') + (subject ? ' · ' + subject : '');
}
function validRec(date, total, correct){
  if(!date) return '请选择日期';
  if(!Number.isInteger(total) || total <= 0) return '请填写有效的总题数';
  if(!Number.isInteger(correct) || correct < 0 || correct > total) return '正确题目数需在 0 到总题数之间';
  return null;
}

/* ---------- 作业记录 ---------- */
// 附件 id 数组校验：每个文件必须存在且属当前用户（教务除外）；返回错误消息或 null
function checkFileIds(user, ids){
  if(!Array.isArray(ids)) return '附件格式不正确';
  for(const fid of ids){
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fid);
    if(!f) return '附件不存在：' + fid;
    if(user.role !== 'admin' && f.owner_id !== user.id) return '没有权限使用附件：' + fid;
  }
  return null;
}
// 保存后把附件绑定到记录（record_id），并解绑被移除的旧附件
function bindFiles(recordId, fileIds){
  db.prepare('UPDATE files SET record_id = NULL WHERE record_id = ?').run(recordId);
  const upd = db.prepare('UPDATE files SET record_id = ? WHERE id = ?');
  (fileIds || []).forEach(fid => upd.run(recordId, fid));
}

// POST /api/records {studentId, date, total, correct, wrongs, subject, images, pdfs}
router.post('/records', guard, (req, res) => {
  const { studentId, date, total, correct, wrongs, subject, images, pdfs } = req.body || {};
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const err = validRec(date, total, correct);
  if(err) return res.status(400).json({ ok: false, msg: err });
  const ferr = checkFileIds(req.user, images || []) || checkFileIds(req.user, pdfs || []);
  if(ferr) return res.status(400).json({ ok: false, msg: ferr });
  const id = uid('r_');
  db.prepare(`INSERT INTO records (id, student_id, owner_id, date, total, correct, wrongs, subject, images, pdfs, sample)
              VALUES (?,?,?,?,?,?,?,?,?,?,0)`)
    .run(id, studentId, st.owner_id, date, total, correct, JSON.stringify(wrongs || []), subject || '',
      JSON.stringify(images || []), JSON.stringify(pdfs || []));
  bindFiles(id, (images || []).concat(pdfs || []));
  logAudit(req.user, '录入作业', 'record', stuDesc(studentId, subject), '日期 ' + date + '，' + accText(total, correct), st.owner_id);
  res.json({ ok: true, record: recToJson(db.prepare('SELECT * FROM records WHERE id = ?').get(id)) });
});

// PUT /api/records/:id {date, total, correct, wrongs, subject, images, pdfs}
router.put('/records/:id', guard, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if(!r) return res.status(404).json({ ok: false, msg: '记录不存在' });
  if(!canWrite(req.user, r.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const { date, total, correct, wrongs, subject, images, pdfs } = req.body || {};
  const err = validRec(date, total, correct);
  if(err) return res.status(400).json({ ok: false, msg: err });
  // images/pdfs 未传则保持原值；传了则校验并重新绑定
  const newImages = images !== undefined ? images : parseJson(r.images, []);
  const newPdfs = pdfs !== undefined ? pdfs : parseJson(r.pdfs, []);
  const ferr = checkFileIds(req.user, newImages) || checkFileIds(req.user, newPdfs);
  if(ferr) return res.status(400).json({ ok: false, msg: ferr });
  db.prepare('UPDATE records SET date = ?, total = ?, correct = ?, wrongs = ?, subject = ?, images = ?, pdfs = ? WHERE id = ?')
    .run(date, total, correct, JSON.stringify(wrongs || []), subject !== undefined ? subject : r.subject,
      JSON.stringify(newImages), JSON.stringify(newPdfs), r.id);
  if(images !== undefined || pdfs !== undefined) bindFiles(r.id, newImages.concat(newPdfs));
  logAudit(req.user, '修改作业', 'record', stuDesc(r.student_id, subject !== undefined ? subject : r.subject),
    '日期 ' + date + '，' + accText(total, correct), r.owner_id);
  res.json({ ok: true });
});

// DELETE /api/records/:id（连带删除挂载的附件：库行 + 磁盘文件）
router.delete('/records/:id', guard, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if(!r) return res.status(404).json({ ok: false, msg: '记录不存在' });
  if(!canWrite(req.user, r.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const files = db.prepare('SELECT * FROM files WHERE record_id = ?').all(r.id);
  db.prepare('DELETE FROM files WHERE record_id = ?').run(r.id);
  files.forEach(f => { try{ fs.unlinkSync(f.path); }catch(e){} });
  db.prepare('DELETE FROM records WHERE id = ?').run(r.id);
  logAudit(req.user, '删除作业', 'record', stuDesc(r.student_id, r.subject), '日期 ' + r.date + '，' + accText(r.total, r.correct), r.owner_id);
  res.json({ ok: true });
});

/* ---------- 未交 ---------- */
// POST /api/missed {studentId, date, subject}：登记未交；同学生+日期+科目且未处理 → 防重
router.post('/missed', guard, (req, res) => {
  const { studentId, date, subject } = req.body || {};
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(!date) return res.status(400).json({ ok: false, msg: '请选择日期' });
  const dup = db.prepare(`SELECT 1 FROM missed WHERE student_id = ? AND date = ?
                          AND IFNULL(subject,'') = IFNULL(?, '') AND resolved = 0`)
    .get(studentId, date, subject || '');
  if(dup) return res.status(400).json({ ok: false, msg: '该学生在该日期已有此科目的未交记录' });
  const id = uid('m_');
  db.prepare(`INSERT INTO missed (id, student_id, owner_id, date, subject, resolved, sample)
              VALUES (?,?,?,?,?,0,0)`)
    .run(id, studentId, st.owner_id, date, subject || '');
  logAudit(req.user, '登记未交', 'missed', stuDesc(studentId, subject), '日期 ' + date, st.owner_id);
  res.json({ ok: true, missed: missToJson(db.prepare('SELECT * FROM missed WHERE id = ?').get(id)) });
});

// POST /api/missed/:id/resolve：标记补交（留痕 resolution='made-up'）
router.post('/missed/:id/resolve', guard, (req, res) => {
  const m = db.prepare('SELECT * FROM missed WHERE id = ?').get(req.params.id);
  if(!m) return res.status(404).json({ ok: false, msg: '未交记录不存在' });
  if(!canWrite(req.user, m.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(m.resolved) return res.status(400).json({ ok: false, msg: '该记录已处理' });
  const today = new Date();
  const ds = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  db.prepare("UPDATE missed SET resolved = 1, resolution = 'made-up', resolved_at = ? WHERE id = ?").run(ds, m.id);
  logAudit(req.user, '补交未交', 'missed', stuDesc(m.student_id, m.subject), '原未交日期 ' + m.date, m.owner_id);
  res.json({ ok: true });
});

// PUT /api/missed/:id {date, subject}：编辑未交（仅未处理；排除自身防重）
router.put('/missed/:id', guard, (req, res) => {
  const m = db.prepare('SELECT * FROM missed WHERE id = ?').get(req.params.id);
  if(!m) return res.status(404).json({ ok: false, msg: '未交记录不存在' });
  if(!canWrite(req.user, m.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(m.resolved) return res.status(400).json({ ok: false, msg: '该记录已处理，不能编辑' });
  const { date, subject } = req.body || {};
  if(!date) return res.status(400).json({ ok: false, msg: '请选择日期' });
  const dup = db.prepare(`SELECT 1 FROM missed WHERE student_id = ? AND date = ?
                          AND IFNULL(subject,'') = IFNULL(?, '') AND resolved = 0 AND id != ?`)
    .get(m.student_id, date, subject || '', m.id);
  if(dup) return res.status(400).json({ ok: false, msg: '该学生在该日期已有此科目的未交记录' });
  db.prepare('UPDATE missed SET date = ?, subject = ? WHERE id = ?').run(date, subject !== undefined ? subject : m.subject, m.id);
  logAudit(req.user, '编辑未交', 'missed', stuDesc(m.student_id, subject !== undefined ? subject : m.subject),
    '原未交日期 ' + m.date + ' → ' + date, m.owner_id);
  res.json({ ok: true });
});

// DELETE /api/missed/:id：软删除（resolved + resolution='deleted' + resolved_at，不物理删除）
router.delete('/missed/:id', guard, (req, res) => {
  const m = db.prepare('SELECT * FROM missed WHERE id = ?').get(req.params.id);
  if(!m) return res.status(404).json({ ok: false, msg: '未交记录不存在' });
  if(!canWrite(req.user, m.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const today = new Date();
  const ds = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  db.prepare("UPDATE missed SET resolved = 1, resolution = 'deleted', resolved_at = ? WHERE id = ?").run(ds, m.id);
  logAudit(req.user, '删除未交', 'missed', stuDesc(m.student_id, m.subject), '原未交日期 ' + m.date, m.owner_id);
  res.json({ ok: true });
});

module.exports = router;
