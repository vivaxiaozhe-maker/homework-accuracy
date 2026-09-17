/* 学生路由：新增 / 修改（同名组同步）/ 归档 / 恢复 / 转移归属（仅教务）/ 家长绑定二维码
   无物理删除（与前端一致：学生只归档） */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite, clientId, parseJson, stuToJson } = require('../util');
const wx = require('../wechat');
const push = require('../push');

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
  // 客户端可选 id（贯穿式，前端不再回填替换）；未传走服务端生成
  const cid = clientId(req.body.id, 'students');
  if(cid === 'invalid') return res.status(400).json({ ok: false, msg: 'id 不合法' });
  if(cid === 'conflict') return res.status(409).json({ ok: false, msg: 'id 冲突，请刷新后重试' });
  const id = cid || uid('s_');
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
const SUBJ_FIELD_WHITELIST = ['subjComments', 'subjAdvice', 'mock', 'subjects', 'subjFirstClass'];
router.put('/:id/subj-fields', async (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const body = req.body || {};
  const keys = Object.keys(body);
  if(!keys.length || keys.some(k => SUBJ_FIELD_WHITELIST.indexOf(k) === -1)){
    return res.status(400).json({ ok: false, msg: '仅允许更新字段：' + SUBJ_FIELD_WHITELIST.join('、') });
  }
  const oldMockAll = keys.includes('mock') ? parseJson(st.mock, {}) : null;  // 模考旧值（自动推送对比用）
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
    } else if(k === 'subjFirstClass'){
      // 开课日期（修改不需审批，只记审计）：{科目: 'YYYY-MM-DD'}
      if(!v || typeof v !== 'object' || Array.isArray(v)) return res.status(400).json({ ok: false, msg: 'subjFirstClass 必须是对象' });
      for(const sub of Object.keys(v)){
        if(v[sub] !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v[sub]))){
          return res.status(400).json({ ok: false, msg: '开课日期格式应为 YYYY-MM-DD' });
        }
      }
      setClauses.push('subj_first_class = ?'); params.push(JSON.stringify(v)); actions.push('修改开课日期');
    } else {
      if(!v || typeof v !== 'object' || Array.isArray(v)) return res.status(400).json({ ok: false, msg: k + ' 必须是对象' });
      setClauses.push(k === 'subjComments' ? 'subj_comments = ?' : 'subj_advice = ?');
      params.push(JSON.stringify(v));
      actions.push(k === 'subjComments' ? '保存评语' : '保存学习计划与建议');
    }
  }
  db.prepare('UPDATE students SET ' + setClauses.join(', ') + ' WHERE id = ?').run(...params, st.id);
  logAudit(req.user, actions.join('、'), 'student', st.name, keys.join('、'), st.owner_id);
  // 模考列变化按开关自动推送：date 变化 → 考试报名成功通知；score 变化 → 考试成绩通知（静默失败不阻塞保存）
  let pushed;
  if(oldMockAll !== null){
    const p = await push.autoMock(req, st, oldMockAll, body.mock);
    if(p.mockBook || p.mockScore) pushed = p;
  }
  res.json(Object.assign({ ok: true }, pushed ? { pushed: pushed } : {}));
});

/* POST /api/students/:id/bind-qr：家长绑定二维码（带参数永久二维码，scene_str = 学生绑定 token）
   助教本人/教务可调；bind_token 首次生成后写入 students 表复用（同一学生二维码不变，可重复转发） */
router.post('/:id/bind-qr', async (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(!wx.configured()) return res.status(503).json({ ok: false, msg: '服务号未配置' });
  if(!st.bind_token){
    db.prepare('UPDATE students SET bind_token = ? WHERE id = ?').run(uid('bind_'), st.id);
    st.bind_token = db.prepare('SELECT bind_token FROM students WHERE id = ?').get(st.id).bind_token;
  }
  try{
    const accessToken = await wx.getAccessToken();
    const qr = await fetch('https://api.weixin.qq.com/cgi-bin/qrcode/create?access_token=' + accessToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action_name: 'QR_LIMIT_STR_SCENE', action_info: { scene: { scene_str: st.bind_token } } })
    });
    const d = await qr.json();
    if(!d.ticket) return res.status(502).json({ ok: false, msg: '二维码生成失败：' + (d.errmsg || '未知错误') });
    logAudit(req.user, '生成家长绑定二维码', 'student', st.name, '', st.owner_id);
    // 前端直接当 <img src> 用（CSP img-src 已放行 mp.weixin.qq.com）
    res.json({ ok: true, qrUrl: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=' + encodeURIComponent(d.ticket) });
  }catch(e){
    res.status(502).json({ ok: false, msg: '微信接口调用失败：' + e.message });
  }
});

/* GET /api/students/:id/binds：该学生的家长绑定列表（助教仅限自己名下，教务全部） */
router.get('/:id/binds', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const binds = db.prepare('SELECT id, openid, bound_at FROM parent_binds WHERE student_id = ? AND unbound = 0 ORDER BY bound_at DESC').all(st.id);
  res.json({ ok: true, binds: binds });
});

/* POST /api/students/:id/binds/:bindId/unbind：手动解绑家长（软解绑 unbound=1 留痕不删行；与家长取关自动失效同口径）
   仅教务可直接解绑；助教走 unbind-request 申请审批 */
router.post('/:id/binds/:bindId/unbind', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(req.user.role !== 'admin') return res.status(403).json({ ok: false, msg: '助教解绑需提交申请，由教务审批' });
  const b = db.prepare('SELECT * FROM parent_binds WHERE id = ? AND student_id = ?').get(req.params.bindId, st.id);
  if(!b) return res.status(404).json({ ok: false, msg: '绑定记录不存在' });
  if(!b.unbound){
    db.prepare('UPDATE parent_binds SET unbound = 1 WHERE id = ?').run(b.id);
    logAudit(req.user, '解绑家长微信', 'student', st.name, 'openid ' + b.openid.slice(0, 6) + '…', st.owner_id);
  }
  res.json({ ok: true });  // 重复解绑幂等
});

/* POST /api/students/:id/binds/:bindId/unbind-request：助教发起解绑申请（归属校验；同一绑定同时最多一条 pending） */
router.post('/:id/binds/:bindId/unbind-request', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(req.user.role === 'admin') return res.status(400).json({ ok: false, msg: '教务可直接解绑，无需申请' });
  const b = db.prepare('SELECT * FROM parent_binds WHERE id = ? AND student_id = ?').get(req.params.bindId, st.id);
  if(!b || b.unbound) return res.status(404).json({ ok: false, msg: '绑定记录不存在' });
  const dup = db.prepare("SELECT 1 FROM unbind_requests WHERE bind_id = ? AND status = 'pending'").get(b.id);
  if(dup) return res.status(400).json({ ok: false, msg: '该绑定已有待审批的解绑申请' });
  const id = uid('ubr_');
  db.prepare(`INSERT INTO unbind_requests (id, student_id, bind_id, owner_id, requested_by, requested_at, status)
              VALUES (?,?,?,?,?,?,'pending')`)
    .run(id, st.id, b.id, st.owner_id, req.user.id, new Date().toISOString());
  logAudit(req.user, '申请解绑家长', 'student', st.name, 'openid ' + b.openid.slice(0, 6) + '…', st.owner_id);
  res.json({ ok: true, request: { id: id, status: 'pending' } });
});

module.exports = router;
