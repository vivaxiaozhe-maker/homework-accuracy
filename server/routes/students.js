/* 学生路由：新增 / 修改（同名组同步）/ 归档 / 恢复 / 转移归属（仅教务）/ 家长绑定二维码
   无物理删除（与前端一致：学生只归档） */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../auth');
const { uid, logAudit, canWrite, clientId, parseJson, shortSubject, stuToJson } = require('../util');
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
  // 查重：拼音/英文不区分大小写（SQLite LOWER 仅影响 ASCII 拉丁），中文简繁因码点不同自然视为不同姓名
  const clash = db.prepare('SELECT 1 FROM students WHERE owner_id = ? AND archived = 0 AND LOWER(TRIM(name)) = LOWER(?)')
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

// POST /api/students/subject-operation：同 owner 同名组科目重命名/删除，一次事务完成
router.post('/subject-operation', (req, res) => {
  const fs = require('fs');
  const body = req.body || {};
  const filesToDelete = [];
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
  const tx = db.transaction(() => {
    const anchor = db.prepare('SELECT * FROM students WHERE id = ?').get(body.studentId);
    if(!anchor) fail(404, '学生不存在');
    if(!canWrite(req.user, anchor.owner_id)) fail(403, '没有权限');
    if(anchor.archived) fail(400, '历史学生不可修改科目');
    if(body.operation !== 'rename' && body.operation !== 'delete') fail(400, '科目操作类型不合法');
    if(typeof body.oldSubject !== 'string' || !body.oldSubject.trim()) fail(400, '缺少原科目');
    const oldSubject = body.oldSubject.trim();
    const newSubject = body.operation === 'rename' && typeof body.newSubject === 'string' ? body.newSubject.trim() : '';
    if(body.operation === 'rename' && (!newSubject || newSubject === oldSubject)) fail(400, '新科目名无效');

    const group = db.prepare(`SELECT * FROM students WHERE owner_id = ? AND archived = ?
                              AND LOWER(TRIM(name)) = LOWER(TRIM(?)) ORDER BY id`)
      .all(anchor.owner_id, anchor.archived, anchor.name);
    const ids = group.map(s => s.id);
    if(!Array.isArray(body.studentIds) || body.studentIds.some(id => typeof id !== 'string')) fail(400, '学生组格式不正确');
    const submitted = body.studentIds.slice().sort();
    if(submitted.length !== ids.length || submitted.some((id, i) => id !== ids[i])) fail(409, '学生组已变化，请刷新后重试');
    const inSql = ids.map(() => '?').join(',');
    const pendingPlan = db.prepare(`SELECT 1 FROM plan_requests WHERE status = 'pending'
                                    AND subject = ? AND student_id IN (${inSql}) LIMIT 1`).get(oldSubject, ...ids);
    if(pendingPlan) fail(409, '该科目有待审批的计划修改申请，请先撤回后再改名或删除');

    const columns = ['subj_plans', 'subj_plan_set_at', 'subj_first_class', 'subj_comments', 'subj_advice', 'mock'];
    const readMap = value => {
      const parsed = parseJson(value, {});
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    };
    if(body.operation === 'rename'){
      if(db.prepare(`SELECT 1 FROM records WHERE subject = ? AND student_id IN (${inSql}) LIMIT 1`).get(newSubject, ...ids) ||
         db.prepare(`SELECT 1 FROM missed WHERE subject = ? AND student_id IN (${inSql}) LIMIT 1`).get(newSubject, ...ids)){
        fail(409, '该学生已有科目「' + newSubject + '」，不能重复命名');
      }
      for(const st of group){
        const subjects = parseJson(st.subjects, []);
        if(Array.isArray(subjects) && subjects.includes(newSubject)) fail(409, '该学生已有科目「' + newSubject + '」，不能重复命名');
        for(const col of columns){
          if(Object.prototype.hasOwnProperty.call(readMap(st[col]), newSubject)) fail(409, '该学生已有科目「' + newSubject + '」，不能重复命名');
        }
      }
    }

    let recordCount = 0, missedCount = 0, alertCount = 0;
    // 预警动作以 studentId|科目 为稳定键：改名随科目迁移，删除清除（详情保留在操作审计）
    for(const sid of ids){
      const oldKey = sid + '|' + oldSubject;
      if(body.operation === 'rename'){
        alertCount += db.prepare(`UPDATE alert_actions SET ref_key = ?
                                  WHERE kind IN ('lowAcc','planStall') AND ref_key = ?`)
          .run(sid + '|' + newSubject, oldKey).changes;
      } else {
        alertCount += db.prepare(`DELETE FROM alert_actions
                                  WHERE kind IN ('lowAcc','planStall') AND ref_key = ?`).run(oldKey).changes;
      }
    }
    if(body.operation === 'rename'){
      recordCount = db.prepare(`UPDATE records SET subject = ? WHERE subject = ? AND student_id IN (${inSql})`)
        .run(newSubject, oldSubject, ...ids).changes;
      missedCount = db.prepare(`UPDATE missed SET subject = ? WHERE subject = ? AND student_id IN (${inSql})`)
        .run(newSubject, oldSubject, ...ids).changes;
    } else {
      const recordIds = db.prepare(`SELECT id FROM records WHERE subject = ? AND student_id IN (${inSql})`)
        .all(oldSubject, ...ids).map(r => r.id);
      recordCount = recordIds.length;
      if(recordIds.length){
        const recordInSql = recordIds.map(() => '?').join(',');
        filesToDelete.push(...db.prepare(`SELECT path FROM files WHERE record_id IN (${recordInSql})`).all(...recordIds));
        db.prepare(`DELETE FROM files WHERE record_id IN (${recordInSql})`).run(...recordIds);
        db.prepare(`DELETE FROM records WHERE id IN (${recordInSql})`).run(...recordIds);
      }
      const now = new Date();
      const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      missedCount = db.prepare(`UPDATE missed SET resolved = 1, resolution = 'deleted', resolved_at = ?
                                WHERE subject = ? AND student_id IN (${inSql})`)
        .run(today, oldSubject, ...ids).changes;
    }

    for(const st of group){
      let subjects = parseJson(st.subjects, []);
      if(!Array.isArray(subjects)) subjects = [];
      const maps = columns.map(col => readMap(st[col]));
      if(body.operation === 'rename'){
        subjects = subjects.map(subject => subject === oldSubject ? newSubject : subject);
        maps.forEach(map => {
          if(Object.prototype.hasOwnProperty.call(map, oldSubject)){
            map[newSubject] = map[oldSubject];
            delete map[oldSubject];
          }
        });
      } else {
        subjects = subjects.filter(subject => subject !== oldSubject);
        maps.forEach(map => { delete map[oldSubject]; });
      }
      db.prepare(`UPDATE students SET subjects = ?, subj_plans = ?, subj_plan_set_at = ?, subj_first_class = ?,
                  subj_comments = ?, subj_advice = ?, mock = ? WHERE id = ?`)
        .run(JSON.stringify(subjects), ...maps.map(map => JSON.stringify(map)), st.id);
    }
    logAudit(req.user, body.operation === 'rename' ? '重命名科目' : '删除科目', 'student', anchor.name,
      (body.operation === 'rename' ? oldSubject + ' → ' + newSubject : oldSubject + '（含 ' + recordCount + ' 条作业记录）') +
      (alertCount ? (body.operation === 'rename' ? '，迁移预警处理 ' : '，清除预警处理 ') + alertCount + ' 条' : ''),
      anchor.owner_id);
    return { ok: true, updated: ids.length, records: recordCount, missed: missedCount, alerts: alertCount };
  });

  try{
    const result = tx();
    filesToDelete.forEach(f => { try{ fs.unlinkSync(f.path); }catch(e){} });
    res.json(result);
  }catch(e){
    res.status(e.status || 500).json({ ok: false, msg: e.status ? e.message : '科目操作失败' });
  }
});

// PUT /api/students/:id {name, school, gradYear}：修改信息，同名组（同 owner 同原名且在服务）全部档案同步
router.put('/:id', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(st.archived) return res.status(400).json({ ok: false, msg: '历史学生为只读档案，请先恢复为现有学生' });
  const { name, school, gradYear } = req.body || {};
  if(!name || !name.trim()) return res.status(400).json({ ok: false, msg: '请输入学生姓名' });
  if(!gradYear) return res.status(400).json({ ok: false, msg: '请选择毕业年份' });
  const newName = name.trim();
  // 同名组 = 同 owner + 同原名 + 未归档（与前端 merged group 口径一致）
  const group = db.prepare('SELECT id FROM students WHERE owner_id = ? AND archived = 0 AND TRIM(name) = ?')
    .all(st.owner_id, st.name.trim()).map(r => r.id);
  if(newName !== st.name.trim()){
    const clash = db.prepare('SELECT 1 FROM students WHERE owner_id = ? AND archived = 0 AND LOWER(TRIM(name)) = LOWER(?) AND id NOT IN (' + group.map(() => '?').join(',') + ')')
      .get(st.owner_id, newName, ...group);
    if(clash) return res.status(400).json({ ok: false, msg: '已有另一位同名学生「' + newName + '」，不能改成相同姓名' });
  }
  const upd = db.prepare('UPDATE students SET name = ?, school = ?, grad_year = ? WHERE id = ?');
  group.forEach(gid => upd.run(newName, (school || '').trim(), String(gradYear), gid));
  // 审计 detail 带前后值（v1.7.1）：姓名/学校/届别逐项对比
  const diffs = [];
  if(newName !== st.name.trim()) diffs.push('姓名 ' + st.name.trim() + ' → ' + newName);
  if((school || '').trim() !== (st.school || '')) diffs.push('学校 ' + (st.school || '无') + ' → ' + ((school || '').trim() || '无'));
  if(String(gradYear) !== (st.grad_year || '')) diffs.push('届别 ' + (st.grad_year || '无') + ' → ' + gradYear);
  logAudit(req.user, '修改学生信息', 'student', newName,
    diffs.length ? diffs.join('；') : '内容未变化', st.owner_id);
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
  if(flag && group.length){
    const inSql = group.map(() => '?').join(',');
    const pendingPlan = db.prepare(`SELECT 1 FROM plan_requests WHERE status = 'pending'
                                    AND student_id IN (${inSql}) LIMIT 1`).get(...group);
    if(pendingPlan) return res.status(409).json({ ok: false, msg: '该学生有待审批的计划修改申请，请先撤回后再归档' });
  }
  // v1.7.1：归档写 archived_at + 可选原因；恢复清空
  const reason = flag ? String((req.body && req.body.reason) || '').trim() : '';
  const upd = db.prepare('UPDATE students SET archived = ?, archived_at = ?, archived_reason = ? WHERE id = ?');
  group.forEach(gid => upd.run(flag, flag ? new Date().toISOString() : null, flag ? reason : null, gid));
  logAudit(req.user, flag ? '归档学生' : '恢复学生', 'student', st.name,
    flag ? ('转为历史学生' + (reason ? '，原因：' + reason : '')) : '恢复为现有学生', st.owner_id);
  res.json({ ok: true, updated: group.length });
}

// POST /api/students/:id/owner {ownerId}：仅教务，转移归属（records/missed/附件 files 连带）
router.post('/:id/owner', requireRole('admin'), (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  const target = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'ta'").get(req.body && req.body.ownerId);
  if(!target) return res.status(400).json({ ok: false, msg: '目标助教不存在' });
  db.prepare('UPDATE students SET owner_id = ? WHERE id = ?').run(target.id, st.id);
  db.prepare('UPDATE records SET owner_id = ? WHERE student_id = ?').run(target.id, st.id);
  db.prepare('UPDATE missed SET owner_id = ? WHERE student_id = ?').run(target.id, st.id);
  // 附件归属随记录转移（files.owner_id = 上传人；不转则原助教仍可读、新助教 403 且编辑成绩时 checkFileIds 受阻）
  db.prepare('UPDATE files SET owner_id = ? WHERE record_id IN (SELECT id FROM records WHERE student_id = ?)')
    .run(target.id, st.id);
  const oldOwner = db.prepare('SELECT name FROM users WHERE id = ?').get(st.owner_id);
  logAudit(req.user, '转移归属', 'student', st.name,
    '原归属 ' + (oldOwner ? oldOwner.name : '未知') + '，转移给 ' + target.name, target.id);  // v1.7.1 补前后值
  res.json({ ok: true });
});

/* PUT /api/students/:id/subj-fields：合并式更新学生 JSON 列（v1.7.0 起为按键合并：传入键覆盖/新增，未传键保留；JSON 列均支持 null 墓碑删除，v1.7.2 补齐）
   字段白名单：subjComments（评语）/ subjAdvice（学习计划与建议）/ mock（模考）/ subjects（科目列表，数组整体替换——列表语义）。
   注意：刻意不含 subj_plans——计划次数只能走 plan/set + 审批流，防止经此绕过审批 */
const SUBJ_FIELD_WHITELIST = ['subjComments', 'subjAdvice', 'mock', 'subjects', 'subjFirstClass'];
router.put('/:id/subj-fields', async (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  if(st.archived) return res.status(400).json({ ok: false, msg: '历史学生为只读档案，请先恢复为现有学生' });
  const body = req.body || {};
  const keys = Object.keys(body);
  if(!keys.length || keys.some(k => SUBJ_FIELD_WHITELIST.indexOf(k) === -1)){
    return res.status(400).json({ ok: false, msg: '仅允许更新字段：' + SUBJ_FIELD_WHITELIST.join('、') });
  }
  const oldMockAll = keys.includes('mock') ? parseJson(st.mock, {}) : null;  // 模考旧值（自动推送对比用）
  let mergedMock = null;  // 合并后的完整新值（autoMock 对比用）
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
        if(slot === null) continue;  // null = 删除墓碑（合并语义下清除该科目模考）
        if(slot.date !== undefined && slot.date !== '' && slot.date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(slot.date))){
          return res.status(400).json({ ok: false, msg: 'mock 日期格式应为 YYYY-MM-DD' });
        }
        if(slot.score !== undefined && slot.score !== null && slot.score !== ''){
          const sc = Number(slot.score);
          if(!Number.isInteger(sc) || sc < 0 || sc > 100) return res.status(400).json({ ok: false, msg: 'mock 分数需在 0-100 之间' });
        }
      }
      /* 合并语义（v1.7.0，防多人互踩）：读库内旧值 → 按键合并 → 写回。
         科目键：传入覆盖/新增，null 墓碑删除；slot 内字段（date/score）同样合并，字段值 null 为删除。
         自动推送对比照旧用「合并后的完整新值」（mergedMock 传 push.autoMock） */
      const oldCol = parseJson(st.mock, {});
      const merged = Object.assign({}, oldCol);
      for(const sub of Object.keys(v)){
        if(v[sub] === null){ delete merged[sub]; continue; }
        merged[sub] = Object.assign({}, oldCol[sub] || {}, v[sub]);
        for(const sk of Object.keys(merged[sub])){ if(merged[sub][sk] === null) delete merged[sub][sk]; }
        if(!Object.keys(merged[sub]).length) delete merged[sub];  // 空 slot 不残留
      }
      mergedMock = merged;
      setClauses.push('mock = ?'); params.push(JSON.stringify(merged)); actions.push('保存模考');
    } else if(k === 'subjFirstClass'){
      // 开课日期（修改不需审批，只记审计）：{科目: 'YYYY-MM-DD'}；null 为删除墓碑（v1.7.2，删科目/重命名清旧键用）
      if(!v || typeof v !== 'object' || Array.isArray(v)) return res.status(400).json({ ok: false, msg: 'subjFirstClass 必须是对象' });
      for(const sub of Object.keys(v)){
        if(v[sub] === null) continue;
        if(v[sub] !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(v[sub]))){
          return res.status(400).json({ ok: false, msg: '开课日期格式应为 YYYY-MM-DD' });
        }
      }
      const mergedFc = Object.assign(parseJson(st.subj_first_class, {}), v);
      for(const sub of Object.keys(mergedFc)){ if(mergedFc[sub] === null) delete mergedFc[sub]; }
      setClauses.push('subj_first_class = ?'); params.push(JSON.stringify(mergedFc)); actions.push('修改开课日期');  // 按键合并（v1.7.0）
    } else {
      if(!v || typeof v !== 'object' || Array.isArray(v)) return res.status(400).json({ ok: false, msg: k + ' 必须是对象' });
      // 按键合并（v1.7.0，防多人互踩）：传入的键覆盖/新增，未传的键保留；null 为删除墓碑（v1.7.2）
      const col = k === 'subjComments' ? 'subj_comments' : 'subj_advice';
      const mergedMap = Object.assign(parseJson(st[col], {}), v);
      for(const sub of Object.keys(mergedMap)){ if(mergedMap[sub] === null) delete mergedMap[sub]; }
      setClauses.push(col + ' = ?');
      params.push(JSON.stringify(mergedMap));
      actions.push(k === 'subjComments' ? '保存评语' : '保存学习计划与建议');
    }
  }
  db.prepare('UPDATE students SET ' + setClauses.join(', ') + ' WHERE id = ?').run(...params, st.id);
  // 审计 detail（v1.7.1）：模考列补新旧值对比（日期/分数逐科目），其余列保持键名单
  let auditDetail = keys.join('、');
  if(keys.includes('mock') && mergedMock !== null){
    const dp = [];
    Object.keys(mergedMock).forEach(sub=>{
      const o = oldMockAll[sub] || {}, n = mergedMock[sub] || {};
      const diffs = [];
      if(String(o.date ?? '') !== String(n.date ?? '')) diffs.push('日期 ' + (o.date || '无') + ' → ' + (n.date || '无'));
      if(String(o.score ?? '') !== String(n.score ?? '')) diffs.push('分数 ' + (o.score ?? '无') + ' → ' + (n.score ?? '无'));
      if(diffs.length) dp.push(shortSubject(sub) + '：' + diffs.join('，'));
    });
    Object.keys(oldMockAll).forEach(sub=>{ if(!(sub in mergedMock)) dp.push(shortSubject(sub) + '：已清除'); });
    if(dp.length) auditDetail = dp.join('；');
  }
  logAudit(req.user, actions.join('、'), 'student', st.name, auditDetail, st.owner_id);
  // 模考列变化按开关自动推送：date 变化 → 考试报名成功通知；score 变化 → 考试成绩通知（静默失败不阻塞保存）
  let pushed;
  if(oldMockAll !== null){
    const p = await push.autoMock(req, st, oldMockAll, mergedMock);
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

/* GET /api/students/:id/binds：该学生的家长绑定列表（助教仅限自己名下，教务全部）
   返回 remark（备注名，可能为空——前端空则显示「家长 N」序号） */
router.get('/:id/binds', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const binds = db.prepare('SELECT id, openid, bound_at, remark FROM parent_binds WHERE student_id = ? AND unbound = 0 ORDER BY bound_at DESC').all(st.id);
  res.json({ ok: true, binds: binds });
});

/* PUT /api/students/:id/binds/:bindId/remark {remark}：备注家长名称（助教限自己名下；≤20 字；置空即清除备注回退序号显示） */
router.put('/:id/binds/:bindId/remark', (req, res) => {
  const st = db.prepare('SELECT * FROM students WHERE id = ?').get(req.params.id);
  if(!st) return res.status(404).json({ ok: false, msg: '学生不存在' });
  if(!canWrite(req.user, st.owner_id)) return res.status(403).json({ ok: false, msg: '没有权限' });
  const b = db.prepare('SELECT * FROM parent_binds WHERE id = ? AND student_id = ?').get(req.params.bindId, st.id);
  if(!b || b.unbound) return res.status(404).json({ ok: false, msg: '绑定记录不存在' });
  const remark = String((req.body || {}).remark || '').trim().slice(0, 20);
  db.prepare('UPDATE parent_binds SET remark = ? WHERE id = ?').run(remark || null, b.id);
  logAudit(req.user, '备注家长', 'student', st.name,
    (remark ? '备注为「' + remark + '」' : '清除备注') + '（openid ' + b.openid.slice(0, 6) + '…）', st.owner_id);
  res.json({ ok: true, remark: remark });
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
