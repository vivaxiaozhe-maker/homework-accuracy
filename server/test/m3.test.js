/* M3 业务数据 API 测试：零额外依赖（node 内置 fetch + assert）。
   独立测试库（DB_PATH 临时文件）+ 随机端口起服务。运行：node test/m3.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立测试 DB（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-m3-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;

const { app } = require('../index');

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

(async function main(){
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  async function req(method, p, body, token){
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try{ data = await res.json(); }catch(e){}
    return { status: res.status, data };
  }
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
  const offDay = n => { const d = new Date(); d.setDate(d.getDate()+n); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };

  /* ---- 账号准备 ---- */
  let r = await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' });
  const adminTok = r.data.token;
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '李助教', username: 'ta2', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '张顾问', username: 'sales1', password: 'sales123456', role: 'sales' }, adminTok);
  const ta1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data;
  const ta2 = (await req('POST', '/api/login', { username: 'ta2', password: 'ta123456', role: 'ta' })).data;
  const sales = (await req('POST', '/api/login', { username: 'sales1', password: 'sales123456', role: 'sales' })).data;
  const T1 = ta1.token, T2 = ta2.token, TS = sales.token;

  /* ---- /api/state 角色口径 ---- */
  r = await req('GET', '/api/state', null, T1);
  ok(r.status === 200 && r.data.ok && r.data.state.students.length === 0, '助教 state 初始为空');
  r = await req('GET', '/api/state', null, TS);
  ok(r.status === 403 && r.data.ok === false, '销售调 /api/state 被拒 403');

  /* ---- 学生 ---- */
  r = await req('POST', '/api/students', { name: '林小满', school: '深外', gradYear: '2027' }, T1);
  ok(r.status === 200 && r.data.student.ownerId === ta1.user.id, '新增学生归属当前助教');
  const stuA = r.data.student.id;
  r = await req('POST', '/api/students', { name: '林小满', school: 'x', gradYear: '2027' }, T1);
  ok(r.status === 400, '同名同归属拦截');
  r = await req('POST', '/api/students', { name: '林小满', school: 'x', gradYear: '2027' }, T2);
  ok(r.status === 200, '不同助教可各录同名学生');
  const stuA2 = r.data.student.id;  // ta2 的林小满
  r = await req('POST', '/api/students', { name: '陈星宇', school: '', gradYear: '2026' }, T2);
  const stuB = r.data.student.id;
  // 同名组同步：往库里塞一条 ta1 同名旧档（模拟历史遗留同名合并组）
  const db = require('../db');
  db.prepare("INSERT INTO students (id, owner_id, name, school, grad_year, archived, sample, created_at) VALUES ('s_dup', ?, '林小满', '', '2027', 0, 0, ?)")
    .run(ta1.user.id, new Date().toISOString());
  r = await req('PUT', '/api/students/' + stuA, { name: '林小满', school: '深圳外国语', gradYear: '2028' }, T1);
  ok(r.status === 200 && r.data.updated === 2, '修改学生信息同步同名组（2 条档案）');
  const dupRow = db.prepare("SELECT * FROM students WHERE id = 's_dup'").get();
  ok(dupRow.school === '深圳外国语' && dupRow.grad_year === '2028', '同名组档案内容已同步');
  // 越权：ta2 改/归档 ta1 的学生
  r = await req('PUT', '/api/students/' + stuA, { name: '林小满', school: 'x', gradYear: '2027' }, T2);
  ok(r.status === 403, '越权：助教不能改他人学生');
  r = await req('POST', '/api/students/' + stuA + '/archive', {}, T2);
  ok(r.status === 403, '越权：助教不能归档他人学生');
  // 销售不能写
  r = await req('POST', '/api/students', { name: 'x', gradYear: '2027' }, TS);
  ok(r.status === 403, '销售不能新增学生');
  // 归档/恢复
  r = await req('POST', '/api/students/' + stuA + '/archive', {}, T1);
  ok(r.status === 200 && r.data.updated === 2, '归档同名组');
  r = await req('GET', '/api/state', null, T1);
  ok(r.data.state.students.every(s => s.archived), '归档后 state 中标记 archived');
  r = await req('POST', '/api/students/' + stuA + '/restore', {}, T1);
  ok(r.status === 200, '恢复为现有学生');

  /* ---- 记录 ---- */
  r = await req('POST', '/api/records', { studentId: stuA, date: today(), total: 20, correct: 25, wrongs: [], subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 400, 'correct > total 被拒');
  r = await req('POST', '/api/records', { studentId: stuA, date: today(), total: 20, correct: 18, wrongs: [7,14], subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 200 && r.data.record.ownerId === ta1.user.id && r.data.record.wrongs.length === 2, '新增作业记录成功（JSON 字段反序列化）');
  const recA = r.data.record.id;
  r = await req('POST', '/api/records', { studentId: stuA, date: today(), total: 10, correct: 9, wrongs: [], subject: 'x' }, T2);
  ok(r.status === 403, '越权：助教不能给他人学生录入');
  r = await req('PUT', '/api/records/' + recA, { date: today(), total: 20, correct: 19, wrongs: [7], subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 200, '编辑作业记录');
  r = await req('PUT', '/api/records/' + recA, { date: today(), total: 20, correct: 19, wrongs: [], subject: 'x' }, T2);
  ok(r.status === 403, '越权：助教不能改他人记录');
  // 转移归属连带
  r = await req('POST', '/api/students/' + stuA + '/owner', { ownerId: ta2.user.id }, adminTok);
  ok(r.status === 200, '教务转移学生归属');
  const recRow = db.prepare('SELECT owner_id FROM records WHERE id = ?').get(recA);
  ok(recRow.owner_id === ta2.user.id, '转移后作业记录 owner_id 跟随');
  r = await req('GET', '/api/state', null, T1);
  ok(!r.data.state.students.some(s => s.id === stuA), '转移后原助教 state 不再含该学生');
  // 转移回来继续用
  await req('POST', '/api/students/' + stuA + '/owner', { ownerId: ta1.user.id }, adminTok);
  r = await req('DELETE', '/api/records/' + recA, null, T1);
  ok(r.status === 200, '删除作业记录');
  r = await req('GET', '/api/state', null, T1);
  ok(!r.data.state.records.some(x => x.id === recA), '删除后 state 不再含该记录');

  /* ---- 未交 ---- */
  r = await req('POST', '/api/missed', { studentId: stuA, date: today(), subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 200 && r.data.missed.resolved === false, '登记未交成功');
  const missA = r.data.missed.id;
  r = await req('POST', '/api/missed', { studentId: stuA, date: today(), subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 400, '未交防重复（同学生+日期+科目）');
  r = await req('POST', '/api/missed', { studentId: stuA, date: offDay(-1), subject: '学科 / AP / 微积分BC' }, T1);
  const missB = r.data.missed.id;
  r = await req('PUT', '/api/missed/' + missA, { date: offDay(-1), subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 400, '编辑未交排除自身防重（改成已有日期被拒）');
  r = await req('PUT', '/api/missed/' + missA, { date: offDay(-2), subject: '学科 / AP / 微积分BC' }, T2);
  ok(r.status === 403, '越权：助教不能编辑他人未交');
  r = await req('POST', '/api/missed/' + missA + '/resolve', {}, T1);
  ok(r.status === 200, '标记补交成功');
  const missRow = db.prepare('SELECT * FROM missed WHERE id = ?').get(missA);
  ok(missRow.resolved === 1 && missRow.resolution === 'made-up' && missRow.resolved_at === today(), '补交留痕（resolution/resolved_at）');
  r = await req('DELETE', '/api/missed/' + missB, null, T2);
  ok(r.status === 403, '越权：助教不能删他人未交');
  r = await req('DELETE', '/api/missed/' + missB, null, T1);
  ok(r.status === 200, '软删除未交');
  const missRowB = db.prepare('SELECT * FROM missed WHERE id = ?').get(missB);
  ok(missRowB && missRowB.resolution === 'deleted', '软删除后仍在库（resolution=deleted）');
  r = await req('GET', '/api/state', null, T1);
  ok(!r.data.state.missed.some(m => m.id === missB && !m.resolved), '软删除后不在未处理列表口径（resolved=1）');

  /* ---- 计划次数：首次直存 + 审批流 ---- */
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '学科 / AP / 微积分BC', plan: 10 }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('第一次课程时间') !== -1, '首次设定缺 firstClassDate 被拒');
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '学科 / AP / 微积分BC', plan: 10, firstClassDate: offDay(-14) }, T1);
  ok(r.status === 200, '首次设定计划直存（含 firstClassDate）');
  let stuRow = db.prepare('SELECT * FROM students WHERE id = ?').get(stuA);
  ok(JSON.parse(stuRow.subj_plans)['学科 / AP / 微积分BC'] === 10
    && JSON.parse(stuRow.subj_plan_set_at)['学科 / AP / 微积分BC'] === today()
    && JSON.parse(stuRow.subj_first_class)['学科 / AP / 微积分BC'] === offDay(-14), '直存写入 subj_plans + set_at + firstClassDate');
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '学科 / AP / 微积分BC', plan: 12 }, T1);
  ok(r.status === 400, '已有计划值时直存被拒（提示走申请）');
  r = await req('POST', '/api/plan-requests', { studentId: stuA, subject: '学科 / AP / 微积分BC', newPlan: 12, reason: '加课' }, T1);
  ok(r.status === 200 && r.data.request.status === 'pending' && r.data.request.oldPlan === 10, '发起修改申请（pending）');
  const reqId = r.data.request.id;
  r = await req('POST', '/api/plan-requests', { studentId: stuA, subject: '学科 / AP / 微积分BC', newPlan: 15 }, T1);
  ok(r.status === 400, '重复申请拦截');
  r = await req('POST', '/api/plan-requests/' + reqId + '/cancel', {}, T2);
  ok(r.status === 403, '他人不能撤回申请');
  r = await req('POST', '/api/plan-requests/' + reqId + '/review', { approve: true }, T1);
  ok(r.status === 403, '助教不能审批');
  r = await req('POST', '/api/plan-requests/' + reqId + '/cancel', {}, T1);
  ok(r.status === 200, '本人撤回申请');
  r = await req('POST', '/api/plan-requests', { studentId: stuA, subject: '学科 / AP / 微积分BC', newPlan: 12, reason: '' }, T1);
  const reqId2 = r.data.request.id;
  r = await req('POST', '/api/plan-requests/' + reqId2 + '/review', { approve: true }, adminTok);
  ok(r.status === 200, '教务审批通过');
  stuRow = db.prepare('SELECT * FROM students WHERE id = ?').get(stuA);
  ok(JSON.parse(stuRow.subj_plans)['学科 / AP / 微积分BC'] === 12
    && JSON.parse(stuRow.subj_plan_set_at)['学科 / AP / 微积分BC'] === today(), '审批通过原子更新 subj_plans + set_at');
  r = await req('POST', '/api/plan-requests', { studentId: stuA, subject: '学科 / AP / 微积分BC', newPlan: 20 }, T1);
  const reqId3 = r.data.request.id;
  await req('POST', '/api/plan-requests/' + reqId3 + '/review', { approve: false }, adminTok);
  stuRow = db.prepare('SELECT * FROM students WHERE id = ?').get(stuA);
  ok(JSON.parse(stuRow.subj_plans)['学科 / AP / 微积分BC'] === 12, '审批驳回后计划不变');

  /* ---- M5c：学生 JSON 列合并式更新（subj-fields） ---- */
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjComments: { '学科 / AP / 微积分BC': '进步明显' } }, T1);
  ok(r.status === 200, 'subj-fields 保存评语成功');
  let stuRow2 = db.prepare('SELECT * FROM students WHERE id = ?').get(stuA);
  ok(JSON.parse(stuRow2.subj_comments)['学科 / AP / 微积分BC'] === '进步明显', '评语已写入 subj_comments 列');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjAdvice: { '学科 / AP / 微积分BC': '每周复盘错题' }, subjects: ['学科 / AP / 微积分BC', '竞赛 / AMC10'] }, T1);
  ok(r.status === 200, 'subj-fields 同时更新建议+科目列表');
  stuRow2 = db.prepare('SELECT * FROM students WHERE id = ?').get(stuA);
  ok(JSON.parse(stuRow2.subj_advice)['学科 / AP / 微积分BC'] === '每周复盘错题'
    && JSON.parse(stuRow2.subjects).length === 2, '建议与科目列表已写入');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '学科 / AP / 微积分BC': { date: '2026-09-01', score: 92 } } }, T1);
  ok(r.status === 200, 'subj-fields 保存模考成功');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { 'x': { score: 101 } } }, T1);
  ok(r.status === 400, 'mock score 越界 400');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { 'x': { date: '2026/09/01' } } }, T1);
  ok(r.status === 400, 'mock 日期格式错误 400');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjPlans: { 'x': 99 } }, T1);
  ok(r.status === 400, '白名单外字段（subjPlans）被拒');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjComments: { 'x': 'y' } }, T2);
  ok(r.status === 403, '越权：助教不能改他人学生 JSON 列');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjComments: { 'x': 'y' } }, TS);
  ok(r.status === 403, '销售不能写 subj-fields');

  /* ---- 销售搜索 ---- */  r = await req('GET', '/api/search/students', null, TS);
  ok(r.status === 400, '搜索无关键字 400');
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('林小满'), null, TS);
  ok(r.status === 200 && r.data.students.length >= 2 && r.data.students[0].ownerName, '销售搜索出结果（含归属助教名）');
  ok(r.data.students[0].pass_hash === undefined && typeof r.data.students[0].recCnt === 'number', '搜索摘要只读字段齐全');
  r = await req('GET', '/api/search/students/' + stuA, null, TS);
  ok(r.status === 200 && r.data.student.subjPlans['学科 / AP / 微积分BC'] === 12
    && Array.isArray(r.data.student.subjects), '销售只读详情（计划/科目结构）');
  r = await req('GET', '/api/search/students?q=林', null, T1);
  ok(r.status === 403, '助教不能调搜索接口');

  /* ---- 审计日志接口 ---- */
  r = await req('GET', '/api/audit-logs', null, adminTok);
  ok(r.status === 200 && r.data.total > 0 && r.data.items.length > 0
    && r.data.items[0].ts && r.data.items[0].action, '教务审计全量（含字段）');
  const adminTotal = r.data.total;
  r = await req('GET', '/api/audit-logs', null, T1);
  ok(r.data.items.every(l => l.userId === ta1.user.id || l.ownerId === ta1.user.id), '助教审计口径（自己操作或自己名下）');
  ok(r.data.total < adminTotal, '助教可见条数少于教务全量');
  r = await req('GET', '/api/audit-logs', null, TS);
  ok(r.status === 403, '销售查审计 403');
  r = await req('GET', '/api/audit-logs?type=plan', null, adminTok);
  ok(r.data.items.length > 0 && r.data.items.every(l => l.targetType === 'plan'), '审计按类型筛选');
  r = await req('GET', '/api/audit-logs?q=' + encodeURIComponent('林小满'), null, adminTok);
  ok(r.data.items.length > 0 && r.data.items.every(l => (l.targetDesc + l.detail + l.userName + l.action).includes('林小满')), '审计关键字搜索');
  const p1 = await req('GET', '/api/audit-logs?page=1&pageSize=2', null, adminTok);
  const p2 = await req('GET', '/api/audit-logs?page=2&pageSize=2', null, adminTok);
  ok(p1.data.items.length === 2 && p2.data.items.length === 2 && p1.data.items[0].id !== p2.data.items[0].id
    && p1.data.total === p2.data.total, '审计服务端分页');

  console.log('\nM3 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
