/* 作业记录 + 未交路由（records / missed）
   归属口径：记录的 owner_id 跟随学生归属；写操作校验归属（教务除外） */
const express = require('express');
const fs = require('fs');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite, clientId, recToJson, missToJson, parseJson } = require('../util');
const push = require('../push');

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
// 历史学生只读：作业/未交写操作统一拒绝；恢复为现有学生后才可继续录入
function rejectArchived(res, studentId){
  const st = db.prepare('SELECT archived FROM students WHERE id = ?').get(studentId);
  if(st && st.archived){
    res.status(400).json({ok:false,msg:'历史学生为只读档案，请先恢复为现有学生'});
    return true;
  }
  return false;
}
function validRec(date, total, correct, noHomework){
  if(!date) return '请选择日期';
  if(noHomework) return null;  // 无作业打卡：只需日期，total/correct 恒为 0/0
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

/* POST /api/records/makeup：补交事务（创建成绩 + 指定未交 marked made-up + 附件绑定 + 审计）。
   recordId 由客户端生成并贯穿；同 missedId + recordId + 同负载重试返回已存结果，不重复推送。 */
function sameMakeupRecord(r, studentId, body, noHw){
  const jsonEq = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  return r.student_id === studentId && r.date === body.date && r.total === (noHw ? 0 : body.total)
    && r.correct === (noHw ? 0 : body.correct) && (r.subject || '') === (body.subject || '')
    && !!r.no_homework === noHw && jsonEq(parseJson(r.wrongs, []), noHw ? [] : (body.wrongs || []))
    && jsonEq(parseJson(r.images, []), body.images || []) && jsonEq(parseJson(r.pdfs, []), body.pdfs || []);
}
router.post('/records/makeup', guard, async (req, res) => {
  const body = req.body || {};
  const missedId = body.missedId;
  const recordId = body.recordId || body.id;
  if(!missedId || !recordId) return res.status(400).json({ok:false,msg:'缺少未交记录或成绩 ID'});
  if(typeof recordId !== 'string' || recordId.length > 64 || !/^[A-Za-z0-9_\-.:]+$/.test(recordId)){
    return res.status(400).json({ok:false,msg:'recordId 不合法'});
  }
  const m = db.prepare('SELECT * FROM missed WHERE id = ?').get(missedId);
  if(!m) return res.status(404).json({ok:false,msg:'未交记录不存在'});
  if(!canWrite(req.user, m.owner_id)) return res.status(403).json({ok:false,msg:'没有权限'});
  if(body.studentId && body.studentId !== m.student_id) return res.status(400).json({ok:false,msg:'学生与未交记录不匹配'});
  const noHw = !!body.noHomework;
  const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  if(m.resolved){
    if(m.resolution === 'made-up' && existing && sameMakeupRecord(existing, m.student_id, body, noHw)){
      return res.json({ok:true,record:recToJson(existing),missed:missToJson(m),idempotent:true,pushed:false});
    }
    return res.status(400).json({ok:false,msg:'该未交记录已处理'});
  }
  if(existing) return res.status(409).json({ok:false,msg:'recordId 已存在，请刷新后重试'});
  const err = validRec(body.date, noHw ? 0 : body.total, noHw ? 0 : body.correct, noHw);
  if(err) return res.status(400).json({ok:false,msg:err});
  const ferr = checkFileIds(req.user, body.images || []) || checkFileIds(req.user, body.pdfs || []);
  if(ferr) return res.status(400).json({ok:false,msg:ferr});
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(m.student_id);
  if(!st) return res.status(404).json({ok:false,msg:'学生不存在'});
  if(rejectArchived(res, st.id)) return;
  const today = new Date();
  const ds = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  try{
    db.transaction(() => {
      db.prepare(`INSERT INTO records (id, student_id, owner_id, date, total, correct, wrongs, subject, images, pdfs, sample, no_homework)
                  VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`)
        .run(recordId, m.student_id, m.owner_id, body.date, noHw ? 0 : body.total, noHw ? 0 : body.correct,
          JSON.stringify(noHw ? [] : (body.wrongs || [])), m.subject || body.subject || '',
          JSON.stringify(body.images || []), JSON.stringify(body.pdfs || []), noHw ? 1 : 0);
      bindFiles(recordId, (body.images || []).concat(body.pdfs || []));
      const changed = db.prepare("UPDATE missed SET resolved = 1, resolution = 'made-up', resolved_at = ? WHERE id = ? AND resolved = 0")
        .run(ds, m.id).changes;
      if(changed !== 1) throw new Error('未交记录已被其他请求处理');
      logAudit(req.user, '补录作业', 'record', stuDesc(m.student_id, m.subject || body.subject),
        '日期 ' + body.date + (noHw ? '（无作业）' : '，' + accText(body.total, body.correct)), m.owner_id);
      logAudit(req.user, '补交未交', 'missed', stuDesc(m.student_id, m.subject), '原未交日期 ' + m.date, m.owner_id);
    })();
  }catch(e){
    console.error('[补交事务] 已回滚：', e.message);
    return res.status(500).json({ok:false,msg:'补交保存失败，请重试'});
  }
  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  const missed = db.prepare('SELECT * FROM missed WHERE id = ?').get(missedId);
  const pushed = await push.autoHomework(req, st, record.subject || '');
  res.json({ok:true,record:recToJson(record),missed:missToJson(missed),pushed});
});

// POST /api/records {studentId, date, total, correct, wrongs, subject, images, pdfs, noHomework}
// noHomework=true：本次无作业（第四次态），只校验日期，total/correct 落库 0/0；仍按开关触发自动推送
// 保存成功后按开关自动推送「作业批改完成通知」（静默失败不阻塞保存；响应带 pushed 供前端提示）
router.post('/records', guard, async (req, res) => {
  const { studentId, date, total, correct, wrongs, subject, images, pdfs, noHomework } = req.body || {};
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(rejectArchived(res, st.id)) return;
  const noHw = !!noHomework;
  const err = validRec(date, noHw ? 0 : total, noHw ? 0 : correct, noHw);
  if(err) return res.status(400).json({ ok: false, msg: err });
  const ferr = checkFileIds(req.user, images || []) || checkFileIds(req.user, pdfs || []);
  if(ferr) return res.status(400).json({ ok: false, msg: ferr });
  // 客户端可选 id（贯穿式，前端不再回填替换）；未传走服务端生成
  const cid = clientId(req.body.id, 'records');
  if(cid === 'invalid') return res.status(400).json({ ok: false, msg: 'id 不合法' });
  if(cid === 'conflict') return res.status(409).json({ ok: false, msg: 'id 冲突，请刷新后重试' });
  const id = cid || uid('r_');
  db.prepare(`INSERT INTO records (id, student_id, owner_id, date, total, correct, wrongs, subject, images, pdfs, sample, no_homework)
              VALUES (?,?,?,?,?,?,?,?,?,?,0,?)`)
    .run(id, studentId, st.owner_id, date, noHw ? 0 : total, noHw ? 0 : correct,
      JSON.stringify(noHw ? [] : (wrongs || [])), subject || '',
      JSON.stringify(images || []), JSON.stringify(pdfs || []), noHw ? 1 : 0);
  bindFiles(id, (images || []).concat(pdfs || []));
  if(noHw) logAudit(req.user, '录入作业（无作业）', 'record', stuDesc(studentId, subject), '日期 ' + date, st.owner_id);
  else logAudit(req.user, '录入作业', 'record', stuDesc(studentId, subject), '日期 ' + date + '，' + accText(total, correct), st.owner_id);
  const pushed = await push.autoHomework(req, st, subject || '');
  res.json({ ok: true, record: recToJson(db.prepare('SELECT * FROM records WHERE id = ?').get(id)), pushed: pushed });
});

// PUT /api/records/:id {date, total, correct, wrongs, subject, images, pdfs, noHomework}
// 支持双向转换：正常 ↔ 无作业（转无作业时清空 total/correct/wrongs 为 0/0/[]）；未传 noHomework 保持原态
// 编辑保存同样按开关自动推送（重新批改也算批改完成）
router.put('/records/:id', guard, async (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if(!r) return res.status(404).json({ ok: false, msg: '记录不存在' });
  if(!canWrite(req.user, r.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(rejectArchived(res, r.student_id)) return;
  const { date, total, correct, wrongs, subject, images, pdfs, noHomework } = req.body || {};
  const noHw = noHomework !== undefined ? !!noHomework : !!r.no_homework;
  const err = validRec(date, noHw ? 0 : total, noHw ? 0 : correct, noHw);
  if(err) return res.status(400).json({ ok: false, msg: err });
  // images/pdfs 未传则保持原值；传了则校验并重新绑定
  const newImages = images !== undefined ? images : parseJson(r.images, []);
  const newPdfs = pdfs !== undefined ? pdfs : parseJson(r.pdfs, []);
  const ferr = checkFileIds(req.user, newImages) || checkFileIds(req.user, newPdfs);
  if(ferr) return res.status(400).json({ ok: false, msg: ferr });
  db.prepare('UPDATE records SET date = ?, total = ?, correct = ?, wrongs = ?, subject = ?, images = ?, pdfs = ?, no_homework = ? WHERE id = ?')
    .run(date, noHw ? 0 : total, noHw ? 0 : correct,
      JSON.stringify(noHw ? [] : (wrongs || [])), subject !== undefined ? subject : r.subject,
      JSON.stringify(newImages), JSON.stringify(newPdfs), noHw ? 1 : 0, r.id);
  if(images !== undefined || pdfs !== undefined) bindFiles(r.id, newImages.concat(newPdfs));
  logAudit(req.user, noHw ? '修改作业（无作业）' : '修改作业', 'record', stuDesc(r.student_id, subject !== undefined ? subject : r.subject),
    '日期 ' + date + (noHw ? '' : '，' + accText(total, correct)), r.owner_id);
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(r.student_id);
  const pushed = st ? await push.autoHomework(req, st, subject !== undefined ? subject : r.subject) : false;
  res.json({ ok: true, pushed: pushed });
});

// DELETE /api/records/:id（连带删除挂载的附件：库行 + 磁盘文件）
router.delete('/records/:id', guard, (req, res) => {
  const r = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if(!r) return res.status(404).json({ ok: false, msg: '记录不存在' });
  if(!canWrite(req.user, r.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(rejectArchived(res, r.student_id)) return;
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
  if(rejectArchived(res, st.id)) return;
  if(!date) return res.status(400).json({ ok: false, msg: '请选择日期' });
  const dup = db.prepare(`SELECT 1 FROM missed WHERE student_id = ? AND date = ?
                          AND IFNULL(subject,'') = IFNULL(?, '') AND resolved = 0`)
    .get(studentId, date, subject || '');
  if(dup) return res.status(400).json({ ok: false, msg: '该学生在该日期已有此科目的未交记录' });
  // 客户端可选 id（贯穿式）；未传走服务端生成
  const cid = clientId(req.body.id, 'missed');
  if(cid === 'invalid') return res.status(400).json({ ok: false, msg: 'id 不合法' });
  if(cid === 'conflict') return res.status(409).json({ ok: false, msg: 'id 冲突，请刷新后重试' });
  const id = cid || uid('m_');
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
  if(rejectArchived(res, m.student_id)) return;
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
  if(rejectArchived(res, m.student_id)) return;
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
  if(rejectArchived(res, m.student_id)) return;
  const today = new Date();
  const ds = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
  db.prepare("UPDATE missed SET resolved = 1, resolution = 'deleted', resolved_at = ? WHERE id = ?").run(ds, m.id);
  logAudit(req.user, '删除未交', 'missed', stuDesc(m.student_id, m.subject), '原未交日期 ' + m.date, m.owner_id);
  res.json({ ok: true });
});

module.exports = router;
