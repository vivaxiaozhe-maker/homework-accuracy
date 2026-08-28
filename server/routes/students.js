/* 学生路由：新增 / 修改（同名组同步）/ 归档 / 恢复 / 转移归属（仅教务）
   无物理删除（与前端一致：学生只归档） */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite, stuToJson } = require('../util');

const router = express.Router();
router.use(requireRole('ta', 'admin'));  // 销售只读，不能写

// POST /api/students {name, school, gradYear}：新增，归属当前用户；同名（同 owner 且在服务）拦截
router.post('/', (req, res) => {
  const { name, school, gradYear } = req.body || {};
  if(!name || !name.trim()) return res.status(400).json({ ok: false, msg: '请输入学生姓名' });
  if(!gradYear) return res.status(400).json({ ok: false, msg: '请选择毕业年份' });
  const ownerId = req.user.id;  // 助教/教务新建都归自己名下（前端口径）
  const clash = db.prepare('SELECT 1 FROM students WHERE owner_id = ? AND archived = 0 AND TRIM(name) = ?')
    .get(ownerId, name.trim());
  if(clash) return res.status(400).json({ ok: false, msg: '「' + name.trim() + '」已在现有学生中，同名不能重复录入' });
  const id = uid('s_');
  db.prepare(`INSERT INTO students (id, owner_id, name, school, grad_year, archived, sample, created_at)
              VALUES (?,?,?,?,?,0,0,?)`)
    .run(id, ownerId, name.trim(), (school || '').trim(), String(gradYear), new Date().toISOString());
  logAudit(req.user, '新增学生', 'student', name.trim(), (school || '无学校') + ' · ' + gradYear + ' 届', ownerId);
  res.json({ ok: true, student: stuToJson(db.prepare('SELECT * FROM students WHERE id = ?').get(id)) });
});

// PUT /api/students/:id {name, school, gradYear}：修改信息，同名组（同 owner 同原名且在服务）全部档案同步
router.put('/:id', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const { name, school, gradYear } = req.body || {};
  if(!name || !name.trim()) return res.status(400).json({ ok: false, msg: '请输入学生姓名' });
  if(!gradYear) return res.status(400).json({ ok: false, msg: '请选择毕业年份' });
  const newName = name.trim();
  // 同名组 = 同 owner + 同原名 + 未归档（与前端 merged group 口径一致）
  const group = db.prepare('SELECT id FROM students WHERE owner_id = ? AND archived = 0 AND TRIM(name) = ?')
    .all(st.owner_id, st.name.trim()).map(r => r.id);
  if(newName !== st.name.trim()){
    const clash = db.prepare('SELECT 1 FROM students WHERE owner_id = ? AND archived = 0 AND TRIM(name) = ? AND id NOT IN (' + group.map(() => '?').join(',') + ')')
      .get(st.owner_id, newName, ...group);
    if(clash) return res.status(400).json({ ok: false, msg: '已有另一位同名学生「' + newName + '」，不能改成相同姓名' });
  }
  const upd = db.prepare('UPDATE students SET name = ?, school = ?, grad_year = ? WHERE id = ?');
  group.forEach(gid => upd.run(newName, (school || '').trim(), String(gradYear), gid));
  logAudit(req.user, '修改学生信息', 'student', newName, (school || '无学校') + ' · ' + gradYear + ' 届', st.owner_id);
  res.json({ ok: true, updated: group.length });
});

// POST /api/students/:id/archive：归档（同名组一并归档，与前端一致）
router.post('/:id/archive', (req, res) => setArchived(req, res, 1));
// POST /api/students/:id/archive 恢复
router.post('/:id/restore', (req, res) => setArchived(req, res, 0));
function setArchived(req, res, flag){
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  // 同名组（同 owner 同名）一并操作
  const group = db.prepare('SELECT id FROM students WHERE owner_id = ? AND TRIM(name) = ?')
    .all(st.owner_id, st.name.trim()).map(r => r.id);
  const upd = db.prepare('UPDATE students SET archived = ? WHERE id = ?');
  group.forEach(gid => upd.run(flag, gid));
  logAudit(req.user, flag ? '归档学生' : '恢复学生', 'student', st.name, flag ? '转为历史学生' : '恢复为现有学生', st.owner_id);
  res.json({ ok: true, updated: group.length });
}

// POST /api/students/:id/owner {ownerId}：仅教务，转移归属（records/missed 连带）
router.post('/:id/owner', requireRole('admin'), (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'ta'").get(req.body && req.body.ownerId);
  if(!target) return res.status(400).json({ ok: false, msg: '目标助教不存在' });
  db.prepare('UPDATE students SET owner_id = ? WHERE id = ?').run(target.id, st.id);
  db.prepare('UPDATE records SET owner_id = ? WHERE student_id = ?').run(target.id, st.id);
  db.prepare('UPDATE missed SET owner_id = ? WHERE student_id = ?').run(target.id, st.id);
  logAudit(req.user, '转移归属', 'student', st.name, '转移给 ' + target.name, target.id);
  res.json({ ok: true });
});

/* PUT /api/students/:id/subj-fields：合并式更新学生 JSON 列（用请求体整体替换对应列，前端先本地改好再整体提交）
   字段白名单：subjComments（评语）/ subjAdvice（学习计划与建议）/ mock（模考）/ subjects（科目列表）。
   注意：刻意不含 subj_plans——计划次数只能走 plan/set + 审批流，防止经此绕过审批 */
const SUBJ_FIELD_WHITELIST = ['subjComments', 'subjAdvice', 'mock', 'subjects'];
router.put('/:id/subj-fields', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const body = req.body || {};
  const keys = Object.keys(body);
  if(!keys.length || keys.some(k => SUBJ_FIELD_WHITELIST.indexOf(k) === -1)){
    return res.status(400).json({ ok: false, msg: '仅允许更新字段：' + SUBJ_FIELD_WHITELIST.join('、') });
  }
  const setClauses = [];
  const params = [];
  const actions = [];
  for(const k of keys){
    const v = body[k];
    if(k === 'subjects'){
      if(!Array.isArray(v) || v.some(x => typeof x !== 'string')){
        return res.status(400).json({ ok: false, msg: 'subjects 必须是字符串数组' });
      }
      setClauses.push('subjects = ?'); params.push(JSON.stringify(v)); actions.push('科目管理');
    } else if(k === 'mock'){
      if(!v || typeof v !== 'object' || Array.isArray(v)) return res.status(400).json({ ok: false, msg: 'mock 必须是对象' });
      for(const sub of Object.keys(v)){
        const slot = v[sub] || {};
        if(slot.date !== undefined && slot.date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(slot.date))){
          return res.status(400).json({ ok: false, msg: 'mock 日期格式应为 YYYY-MM-DD' });
        }
        if(slot.score !== undefined && slot.score !== null && slot.score !== ''){
          const sc = Number(slot.score);
          if(!Number.isInteger(sc) || sc < 0 || sc > 100) return res.status(400).json({ ok: false, msg: 'mock 分数需在 0-100 之间' });
        }
      }
      setClauses.push('mock = ?'); params.push(JSON.stringify(v)); actions.push('保存模考');
    } else {
      if(!v || typeof v !== 'object' || Array.isArray(v)) return res.status(400).json({ ok: false, msg: k + ' 必须是对象' });
      setClauses.push(k === 'subjComments' ? 'subj_comments = ?' : 'subj_advice = ?');
      params.push(JSON.stringify(v));
      actions.push(k === 'subjComments' ? '保存评语' : '保存学习计划与建议');
    }
  }
  db.prepare('UPDATE students SET ' + setClauses.join(', ') + ' WHERE id = ?').run(...params, st.id);
  logAudit(req.user, actions.join('、'), 'student', st.name, keys.join('、'), st.owner_id);
  res.json({ ok: true });
});

module.exports = router;
