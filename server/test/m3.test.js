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
  // 强制改密硬限制（v1.7.0）：建号即待改密——admin 先改密才能建号，新号登录后也先改密再开展用例
  const chpwd = (tok, oldP) => req('POST', '/api/password', { oldPwd: oldP, newPwd: 'Xx' + Math.random().toString(36).slice(2, 8) + '!' }, tok);
  await chpwd(adminTok, 'admin123');
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '李助教', username: 'ta2', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '张顾问', username: 'sales1', password: 'sales123456', role: 'sales' }, adminTok);
  const ta1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data;
  const ta2 = (await req('POST', '/api/login', { username: 'ta2', password: 'ta123456', role: 'ta' })).data;
  const sales = (await req('POST', '/api/login', { username: 'sales1', password: 'sales123456', role: 'sales' })).data;
  const T1 = ta1.token, T2 = ta2.token, TS = sales.token;
  await chpwd(T1, 'ta123456'); await chpwd(T2, 'ta123456'); await chpwd(TS, 'sales123456');

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
  /* ---- 查重规则（v1.9.2）：拉丁不区分大小写；中文简繁视为不同姓名 ---- */
  r = await req('POST', '/api/students', { name: 'Alice', gradYear: '2027' }, T1);
  ok(r.status === 200, '创建英文名 Alice 成功');
  r = await req('POST', '/api/students', { name: 'alice', gradYear: '2027' }, T1);
  ok(r.status === 400, '大小写变体 alice 判重（不区分大小写）');
  r = await req('POST', '/api/students', { name: 'ALICE', gradYear: '2027' }, T1);
  ok(r.status === 400, '全大写 ALICE 同样判重');
  r = await req('POST', '/api/students', { name: '张', gradYear: '2027' }, T1);
  ok(r.status === 200, '创建简体「张」成功');
  r = await req('POST', '/api/students', { name: '張', gradYear: '2027' }, T1);
  ok(r.status === 200, '繁体「張」与简体「张」视为不同姓名，允许并存');
  // 同名组同步：往库里塞一条 ta1 同名旧档（模拟历史遗留同名合并组）
  const db = require('../db');
  db.prepare("DELETE FROM students WHERE name IN ('Alice','张','張')").run();  // 清理查重测试数据：不干扰后续「归档后全量 archived」断言
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
  ok(r.status === 400 && r.data.msg === '请填写归档原因'
    && db.prepare('SELECT archived FROM students WHERE id = ?').get(stuA).archived === 0, '归档原因必填且空原因不改变学生状态');
  r = await req('POST', '/api/students/' + stuA + '/archive', { reason: '已结课' }, T1);
  ok(r.status === 200 && r.data.updated === 2, '归档同名组');
  r = await req('GET', '/api/state', null, T1);
  ok(r.data.state.students.every(s => s.archived), '归档后 state 中标记 archived');
  // 归档字段（v1.7.1）：archivedAt/archivedReason 写库并随 state 带出
  ok(r.data.state.students.every(s => s.archivedAt && typeof s.archivedAt === 'string'), '归档写 archivedAt 并随 state 同步');
  r = await req('POST', '/api/students/' + stuA + '/restore', {}, T1);
  ok(r.status === 200, '恢复为现有学生');
  r = await req('GET', '/api/state', null, T1);
  ok(r.data.state.students.every(s => s.archivedAt === null), '恢复后归档信息清空');
  // 带原因归档
  r = await req('POST', '/api/students/' + stuA + '/archive', { reason: '已结课' }, T1);
  const archRow = db.prepare('SELECT archived_at, archived_reason FROM students WHERE id = ?').get(stuA);
  ok(r.status === 200 && archRow.archived_reason === '已结课' && archRow.archived_at, '归档原因写库（archived_reason + archived_at）');
  ok(db.prepare("SELECT * FROM audit_logs WHERE action = '归档学生' AND detail LIKE '%已结课%'").all().length > 0, '归档审计 detail 带原因');
  // 历史学生只读：直接调用写接口同样拒绝（不依赖前端隐藏入口）
  r = await req('POST', '/api/records', { studentId: stuA, date: today(), total: 10, correct: 9, wrongs: [], subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('只读') !== -1, '历史学生新增作业被服务端只读守卫拒绝');
  r = await req('POST', '/api/missed', { studentId: stuA, date: today(), subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('只读') !== -1, '历史学生登记未交被服务端只读守卫拒绝');
  r = await req('PUT', '/api/students/' + stuA, { name: '林小满', school: 'x', gradYear: '2028' }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('只读') !== -1, '历史学生基本信息编辑被服务端只读守卫拒绝');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjComments: {'学科 / AP / 微积分BC': 'x'} }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('只读') !== -1, '历史学生科目字段编辑被服务端只读守卫拒绝');
  r = await req('POST', '/api/students/' + stuA + '/restore', {}, T1);

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
  r = await req('GET', '/api/state', null, adminTok);
  const expectedActivity = db.prepare("SELECT MAX(ts) AS ts FROM audit_logs WHERE user_id = ? AND action IN ('录入作业','补录作业','修改作业','登记未交','补交未交','录入作业（无作业）','修改作业（无作业）')").get(ta1.user.id).ts;
  ok(r.data.state.taActivity.find(a=>a.ownerId===ta1.user.id).lastActionAt === expectedActivity,
    '教务 state 按同类作业动作聚合最近操作时间');
  r = await req('GET', '/api/state', null, T1);
  ok(!Object.prototype.hasOwnProperty.call(r.data.state, 'taActivity'), '助教 state 不携带 taActivity 字段');
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
  await req('POST', '/api/students/' + stuA + '/archive', { reason: '已结课' }, T1);
  r = await req('PUT', '/api/records/' + recA, { date: today(), total: 20, correct: 19, wrongs: [], subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('只读') !== -1, '历史学生编辑已有作业被服务端只读守卫拒绝');
  r = await req('DELETE', '/api/records/' + recA, null, T1);
  ok(r.status === 400 && r.data.msg.indexOf('只读') !== -1, '历史学生删除已有作业被服务端只读守卫拒绝');
  await req('POST', '/api/students/' + stuA + '/restore', {}, T1);
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

  /* ---- N01：审批前复核当前状态；待审批期间阻止科目操作/归档 ---- */
  async function setupN01(id, name, token, subject){
    const created = await req('POST', '/api/students', { id: id, name: name, gradYear: '2027' }, token);
    ok(created.status === 200, 'N01 准备学生：' + id);
    await req('POST', '/api/plan/set', { studentId: id, subject: subject, plan: 8, firstClassDate: offDay(-5) }, token);
    const pr = await req('POST', '/api/plan-requests', { studentId: id, subject: subject, newPlan: 12, reason: 'N01' }, token);
    ok(pr.status === 200, 'N01 准备待审批申请：' + id);
    return pr.data.request.id;
  }
  const n01Sub = 'N01 / 计划';
  const n01ReqA = await setupN01('n01-a', 'N01审批生', T1, n01Sub);
  r = await req('POST', '/api/students/subject-operation', { operation: 'rename', studentId: 'n01-a', studentIds: ['n01-a'], oldSubject: n01Sub, newSubject: 'N01 / 改名' }, T1);
  ok(r.status === 409 && r.data.msg.indexOf('撤回') !== -1, 'N01 待审批时阻止科目改名');
  r = await req('POST', '/api/students/subject-operation', { operation: 'delete', studentId: 'n01-a', studentIds: ['n01-a'], oldSubject: n01Sub }, T1);
  ok(r.status === 409, 'N01 待审批时阻止科目删除');
  r = await req('POST', '/api/students/n01-a/archive', { reason: '已结课' }, T1);
  ok(r.status === 409, 'N01 待审批时阻止学生归档');
  stuRow = db.prepare('SELECT * FROM students WHERE id = ?').get('n01-a');
  ok(stuRow.archived === 0 && JSON.parse(stuRow.subj_plans)[n01Sub] === 8, 'N01 被阻止后学生与计划不变');
  // 模拟升级前遗留：科目已从学生计划中消失，但旧申请仍 pending
  db.prepare('UPDATE students SET subj_plans = ? WHERE id = ?').run('{}', 'n01-a');
  r = await req('POST', '/api/plan-requests/' + n01ReqA + '/review', { approve: true }, adminTok);
  const n01RowA = db.prepare('SELECT status, reviewed_at FROM plan_requests WHERE id = ?').get(n01ReqA);
  stuRow = db.prepare('SELECT subj_plans FROM students WHERE id = ?').get('n01-a');
  ok(r.status === 409 && n01RowA.status === 'cancelled' && JSON.parse(stuRow.subj_plans)[n01Sub] === undefined,
    'N01 科目消失后旧审批失效且不写回计划');
  ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = '计划申请失效' AND target_desc LIKE '%N01%'").get() !== undefined,
    'N01 失效申请写审计');
  // 归档后遗留 pending（直接改库模拟旧数据，不经过已加守卫的归档接口）
  const n01ReqB = await setupN01('n01-b', 'N01归档生', T1, n01Sub);
  db.prepare('UPDATE students SET archived = 1 WHERE id = ?').run('n01-b');
  r = await req('POST', '/api/plan-requests/' + n01ReqB + '/review', { approve: true }, adminTok);
  ok(r.status === 409 && db.prepare('SELECT status FROM plan_requests WHERE id = ?').get(n01ReqB).status === 'cancelled'
    && JSON.parse(db.prepare('SELECT subj_plans FROM students WHERE id = ?').get('n01-b').subj_plans)[n01Sub] === 8,
  'N01 归档学生旧审批失效且计划不变');
  // 计划值已变化后旧审批失效
  const n01ReqC = await setupN01('n01-c', 'N01改值生', T1, n01Sub);
  const n01PlansC = JSON.parse(db.prepare('SELECT subj_plans FROM students WHERE id = ?').get('n01-c').subj_plans);
  n01PlansC[n01Sub] = 9;
  db.prepare('UPDATE students SET subj_plans = ? WHERE id = ?').run(JSON.stringify(n01PlansC), 'n01-c');
  r = await req('POST', '/api/plan-requests/' + n01ReqC + '/review', { approve: true }, adminTok);
  ok(r.status === 409 && JSON.parse(db.prepare('SELECT subj_plans FROM students WHERE id = ?').get('n01-c').subj_plans)[n01Sub] === 9,
    'N01 旧计划值变化后旧审批失效');
  // 正常审批仍可用
  const n01ReqD = await setupN01('n01-d', 'N01正常生', T1, n01Sub);
  r = await req('POST', '/api/plan-requests/' + n01ReqD + '/review', { approve: true }, adminTok);
  ok(r.status === 200 && JSON.parse(db.prepare('SELECT subj_plans FROM students WHERE id = ?').get('n01-d').subj_plans)[n01Sub] === 12,
    'N01 状态一致时正常审批通过');
  // 跨 owner 同名组：另一助教的同名科目不受本组 pending 影响
  const n01ReqE = await setupN01('n01-e', 'N01同名生', T1, n01Sub);
  await req('POST', '/api/students', { id: 'n01-e2', name: 'N01同名生', gradYear: '2027' }, T2);
  await req('POST', '/api/plan/set', { studentId: 'n01-e2', subject: n01Sub, plan: 8, firstClassDate: offDay(-5) }, T2);
  r = await req('POST', '/api/students/subject-operation', { operation: 'rename', studentId: 'n01-e2', studentIds: ['n01-e2'], oldSubject: n01Sub, newSubject: 'N01 / 另一组' }, T2);
  ok(r.status === 200 && JSON.parse(db.prepare('SELECT subj_plans FROM students WHERE id = ?').get('n01-e').subj_plans)[n01Sub] === 8,
    'N01 跨 owner 同名组互不阻塞' + (r.status !== 200 ? '（' + r.status + ' ' + (r.data && r.data.msg) + '）' : ''));
  await req('POST', '/api/plan-requests/' + n01ReqE + '/cancel', {}, T1);

  /* ---- N04：科目改名迁移预警身份，删除清除旧状态 ---- */
  const n04Sub = 'N04 / 原科目', n04New = 'N04 / 新科目';
  await req('POST', '/api/students', { id: 'n04-a', name: 'N04预警生', gradYear: '2027' }, T1);
  await req('POST', '/api/plan/set', { studentId: 'n04-a', subject: n04Sub, plan: 8, firstClassDate: offDay(-5) }, T1);
  r = await req('POST', '/api/alerts/action', { kind: 'planStall', refKey: 'n04-a|' + n04Sub, action: 'done' }, T1);
  ok(r.status === 200, 'N04 建立完成态预警');
  r = await req('POST', '/api/alerts/action', { kind: 'lowAcc', refKey: 'n04-a|' + n04Sub, action: 'snooze', snoozeUntil: today() }, T1);
  ok(r.status === 200, 'N04 建立当日稍后处理预警');
  r = await req('POST', '/api/students/subject-operation', { operation: 'rename', studentId: 'n04-a', studentIds: ['n04-a'], oldSubject: n04Sub, newSubject: n04New }, T1);
  const n04Keys = db.prepare("SELECT kind,ref_key,snooze_until FROM alert_actions WHERE ref_key LIKE 'n04-a|%' ORDER BY kind").all();
  ok(r.status === 200 && r.data.alerts === 2 && n04Keys.length === 2 && n04Keys.every(x=>x.ref_key === 'n04-a|' + n04New)
    && n04Keys.some(x=>x.kind === 'lowAcc' && x.snooze_until === today()),
  'N04 改名迁移 done/snooze 且保留到期日');
  const n04State = (await req('GET', '/api/state', null, T1)).data.state;
  ok(n04State.alertActions.some(a=>a.kind==='planStall' && a.refKey==='n04-a|' + n04New && a.action==='done'),
    'N04 state 使用迁移后的新预警键');
  r = await req('POST', '/api/students/subject-operation', { operation: 'delete', studentId: 'n04-a', studentIds: ['n04-a'], oldSubject: n04New }, T1);
  ok(r.status === 200 && r.data.alerts === 2
    && db.prepare("SELECT COUNT(*) c FROM alert_actions WHERE ref_key LIKE 'n04-a|%'").get().c === 0,
  'N04 删除科目清除预警状态并计数');
  await req('POST', '/api/plan/set', { studentId: 'n04-a', subject: n04New, plan: 5, firstClassDate: offDay(-1) }, T1);
  ok(db.prepare("SELECT COUNT(*) c FROM alert_actions WHERE ref_key = ?").get('n04-a|' + n04New).c === 0,
    'N04 重建同名科目不继承旧预警状态');

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

  /* ---- v1.8.2 BUG-03：搜索字面匹配（下划线/百分号/引号/反斜杠按字面；纯通配不退化全量；姓名与学校分别覆盖） ---- */
  await req('POST', '/api/students', { id: 'sch-s1', name: 'UI走查1017_a6fbb4学生', school: '深外_分校', gradYear: '2027' }, T1);
  await req('POST', '/api/students', { id: 'sch-s2', name: '百分号%学生', school: "引号'学校", gradYear: '2027' }, T1);
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('UI走查1017_a6fbb4学生'), null, TS);
  ok(r.status === 200 && r.data.students.some(s=>s.id==='sch-s1'), 'BUG-03：完整姓名含下划线可搜到');
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('1017_a6'), null, TS);
  ok(r.data.students.some(s=>s.id==='sch-s1'), 'BUG-03：下划线组合关键词字面部分匹配');
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('百分号%'), null, TS);
  ok(r.data.students.some(s=>s.id==='sch-s2'), 'BUG-03：百分号按字面匹配');
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent("引号'"), null, TS);
  ok(r.data.students.some(s=>s.id==='sch-s2'), 'BUG-03：引号在学校名中字面匹配（学校覆盖）');
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('深外_分'), null, TS);
  ok(r.data.students.some(s=>s.id==='sch-s1'), 'BUG-03：学校名含下划线可搜到（学校覆盖）');
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('_'), null, TS);
  ok(r.data.students.length > 0
    && r.data.students.every(s=>s.name.indexOf('_') !== -1 || (s.school||'').indexOf('_') !== -1),
    'BUG-03：纯「_」查询只命中字面含下划线者（不退化全量）');
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('%'), null, TS);
  ok(r.data.students.every(s=>s.name.indexOf('%') !== -1 || (s.school||'').indexOf('%') !== -1),
    'BUG-03：纯「%」查询不全量命中');

  /* ---- v1.8.2 BUG-04：科目摘要次数含无作业、正确率仅用有成绩记录（简单平均）；纯无作业/纯未交科目有入口 ---- */
  await req('POST', '/api/records', { id: 'sch-r1', studentId: 'sch-s1', date: '2026-10-11', total: 10, correct: 9, wrongs: [], subject: '摘要科目' }, T1);
  await req('POST', '/api/records', { id: 'sch-r2', studentId: 'sch-s1', date: '2026-10-12', total: 20, correct: 16, wrongs: [], subject: '摘要科目' }, T1);
  await req('POST', '/api/records', { id: 'sch-r3', studentId: 'sch-s1', date: '2026-10-13', subject: '摘要科目', noHomework: true }, T1);
  await req('POST', '/api/records', { id: 'sch-r4', studentId: 'sch-s1', date: '2026-10-13', subject: '纯无作业科', noHomework: true }, T1);
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('UI走查1017'), null, TS);
  const schSum = r.data.students.find(s=>s.id==='sch-s1');
  const sumA = schSum.subjects.find(x=>x.subject==='摘要科目');
  const sumB = schSum.subjects.find(x=>x.subject==='纯无作业科');
  ok(sumA && sumA.cnt === 3 && sumA.avg === 85, 'BUG-04：摘要次数含无作业（3 次），平均正确率仅用有成绩记录（(90+80)/2=85，不按题量加权）');
  ok(sumB && sumB.cnt === 1 && sumB.avg === null, 'BUG-04：纯无作业科目有入口，正确率 null（前端显示 —）');
  r = await req('GET', '/api/search/students/sch-s1', null, TS);
  const detA = r.data.student.subjects.find(x=>x.subject==='摘要科目');
  ok(detA && detA.done === 3 && detA.items.length === 3, 'BUG-04：详情完成数与摘要一致（3 次）');
  await req('POST', '/api/missed', { id: 'sch-m1', studentId: 'sch-s1', date: '2026-10-12', subject: '纯未交科' }, T1);
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('UI走查1017'), null, TS);
  const sumC = r.data.students[0].subjects.find(x=>x.subject==='纯未交科');
  ok(sumC && sumC.cnt === 0 && sumC.avg === null, 'BUG-04：纯未交科目有入口（0 次、正确率 —）');

  /* ---- 销售详情同日排序稳定键（v1.8.0 BUG-02）：同日期 rec 按 id 字典序在前、miss 在后，与前端 subjectItems 同规则 ---- */
  await req('POST', '/api/records', { id: 'ord-rB', studentId: stuA, date: '2026-10-10', total: 10, correct: 9, wrongs: [], subject: '排序测试科目' }, T1);
  await req('POST', '/api/records', { id: 'ord-rA', studentId: stuA, date: '2026-10-10', total: 10, correct: 8, wrongs: [1], subject: '排序测试科目' }, T1);
  await req('POST', '/api/missed', { id: 'ord-m1', studentId: stuA, date: '2026-10-10', subject: '排序测试科目' }, T1);
  r = await req('GET', '/api/search/students/' + stuA, null, TS);
  const ordSubj = r.data.student.subjects.find(x=>x.subject === '排序测试科目');
  const ordIds = ordSubj.items.map(i=>i.id).join(',');
  ok(ordIds === 'ord-rA,ord-rB,ord-m1', '销售详情同日排序稳定：rec 按 id 字典序在前、miss 在后（与前端同规则）');
  r = await req('GET', '/api/search/students/' + stuA, null, TS);
  ok(r.data.student.subjects.find(x=>x.subject === '排序测试科目').items.map(i=>i.id).join(',') === ordIds, '销售详情排序重复请求次序一致');

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

  /* ---- 客户端 id 贯穿（学生/记录/未交：采用客户端 id / 冲突 409 / 未传兼容服务端生成） ---- */
  r = await req('POST', '/api/students', { id: 'cli-stu-1', name: '客户端ID生', gradYear: '2027' }, T1);
  ok(r.status === 200 && r.data.student.id === 'cli-stu-1' && r.data.student.createdAt, 'POST /api/students 采用客户端 id（含 createdAt 回填）');
  r = await req('POST', '/api/students', { id: 'cli-stu-1', name: '另一个学生', gradYear: '2027' }, T1);
  ok(r.status === 409 && r.data.ok === false, '学生客户端 id 冲突 409');
  r = await req('POST', '/api/records', { id: 'cli-rec-1', studentId: 'cli-stu-1', date: today(), total: 10, correct: 9, wrongs: [1], subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 200 && r.data.record.id === 'cli-rec-1', 'POST /api/records 采用客户端 id');
  r = await req('POST', '/api/records', { id: 'cli-rec-1', studentId: 'cli-stu-1', date: offDay(-1), total: 10, correct: 8, wrongs: [] }, T1);
  ok(r.status === 409, '记录客户端 id 冲突 409');
  r = await req('POST', '/api/missed', { id: 'cli-mis-1', studentId: 'cli-stu-1', date: today(), subject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 200 && r.data.missed.id === 'cli-mis-1', 'POST /api/missed 采用客户端 id');
  r = await req('POST', '/api/missed', { id: 'cli-mis-1', studentId: 'cli-stu-1', date: offDay(-1), subject: '竞赛 / AMC10' }, T1);
  ok(r.status === 409, '未交客户端 id 冲突 409');
  r = await req('POST', '/api/records', { id: 'x'.repeat(65), studentId: 'cli-stu-1', date: today(), total: 5, correct: 5, wrongs: [] }, T1);
  ok(r.status === 400, '超长 id（>64 字符）400');
  r = await req('POST', '/api/records', { studentId: 'cli-stu-1', date: today(), total: 5, correct: 5, wrongs: [] }, T1);
  ok(r.status === 200 && r.data.record.id && r.data.record.id !== 'cli-rec-1', '未传 id 走服务端生成（向后兼容）');

  /* ---- 「本次无作业」第四次态（v1.4.3）：记录接口校验分支 + 双向转换 + 搜索排除 ---- */
  r = await req('POST', '/api/records', { studentId: 'cli-stu-1', date: offDay(-2), subject: '学科 / AP / 微积分BC', noHomework: true }, T1);
  ok(r.status === 200 && r.data.record.noHomework === true && r.data.record.total === 0 && r.data.record.correct === 0
    && r.data.record.wrongs.length === 0, 'POST 无作业记录：跳过题数校验，落库 0/0/[] + noHomework 标志');
  const noHwRecId = r.data.record.id;
  r = await req('POST', '/api/records', { studentId: 'cli-stu-1', subject: '学科 / AP / 微积分BC', noHomework: true }, T1);
  ok(r.status === 400, '无作业记录仍必须填日期（400）');
  ok(db.prepare("SELECT * FROM audit_logs WHERE action = '录入作业（无作业）'").all().length > 0, '无作业录入写审计（动作区分）');
  // 双向转换：正常 → 无作业（清空成绩）；无作业 → 正常
  r = await req('PUT', '/api/records/' + noHwRecId, { date: offDay(-2), noHomework: false, total: 10, correct: 8, wrongs: [2, 5] }, T1);
  ok(r.status === 200 && db.prepare('SELECT no_homework, total FROM records WHERE id = ?').get(noHwRecId).no_homework === 0, '无作业 → 正常：转换成功');
  r = await req('PUT', '/api/records/' + noHwRecId, { date: offDay(-2), noHomework: true, total: 10, correct: 8, wrongs: [2] }, T1);
  const convRow = db.prepare('SELECT no_homework, total, correct, wrongs FROM records WHERE id = ?').get(noHwRecId);
  ok(r.status === 200 && convRow.no_homework === 1 && convRow.total === 0 && convRow.correct === 0 && convRow.wrongs === '[]',
    '正常 → 无作业：清空 total/correct/wrongs');
  // 搜索口径：平均分/最近正确率排除无作业；明细行带标记
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('客户端ID生'), null, TS);
  const searchItem = r.data.students.find(s=>s.id==='cli-stu-1');
  ok(searchItem && searchItem.lastAcc === 100, '搜索最近正确率排除无作业记录（取最近一条有成绩的 100%）');
  const searchSubj = searchItem.subjects.find(s=>s.subject==='学科 / AP / 微积分BC');
  ok(searchSubj && searchSubj.avg === 90, '搜索科目平均分排除无作业记录（该科目仅 cli-rec-1 一条有成绩 90%；无作业行不计入）');
  r = await req('GET', '/api/search/students/cli-stu-1', null, TS);
  const detailItems = r.data.student.subjects.find(s=>s.subject==='学科 / AP / 微积分BC').items;
  ok(detailItems.some(i=>i.noHomework === true), '搜索明细行带 noHomework 标记');

  /* ---- 附件随转移归属（v1.7.0）：转移后新助教可读、旧助教被拒 ---- */
  const tfStu = (await req('POST', '/api/students', { name: '附件转移生', gradYear: '2027' }, T1)).data.student.id;
  const tfRec = (await req('POST', '/api/records', { studentId: tfStu, date: today(), total: 10, correct: 9, wrongs: [], subject: '学科 / AP / 微积分BC' }, T1)).data.record.id;
  const tmpFile = path.join(os.tmpdir(), 'xq-m3-file-' + Date.now() + '.png');
  fs.writeFileSync(tmpFile, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  db.prepare("INSERT INTO files (id, record_id, filename, mime, size, path, created_at, owner_id) VALUES ('tf-file-1', ?, '作业.png', 'image/png', 4, ?, ?, ?)")
    .run(tfRec, tmpFile, new Date().toISOString(), ta1.user.id);
  r = await req('GET', '/api/files/tf-file-1', null, T2);
  ok(r.status === 403, '转移前：其他助教读附件 403');
  r = await req('POST', '/api/students/' + tfStu + '/owner', { ownerId: ta2.user.id }, adminTok);
  ok(r.status === 200, '教务转移归属成功');
  r = await req('GET', '/api/files/tf-file-1', null, T2);
  ok(r.status === 200, '转移后：新助教读附件 200（files.owner_id 已随记录转移）');
  r = await req('GET', '/api/files/tf-file-1', null, T1);
  ok(r.status === 403, '转移后：原助教读附件 403');
  try{ fs.unlinkSync(tmpFile); }catch(e){}

  /* ---- subj-fields 合并语义（v1.7.0 防多人互踩）：两次分别改不同科目，旧键不被覆盖 ---- */
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjComments: { '学科 / AP / 微积分BC': '评语甲' } }, T1);
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjComments: { '竞赛 / AMC10': '评语乙' } }, T1);
  const mergedC = JSON.parse(db.prepare('SELECT subj_comments FROM students WHERE id = ?').get(stuA).subj_comments);
  ok(mergedC['学科 / AP / 微积分BC'] === '评语甲' && mergedC['竞赛 / AMC10'] === '评语乙', '评语按键合并：两次分别改不同科目均生效（旧键不被覆盖）');
  // mock null 墓碑删除（合并语义下清除需显式 null）
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '竞赛 / AMC10': { date: '2026-10-20' } } }, T1);
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '竞赛 / AMC10': null } }, T1);
  ok(!JSON.parse(db.prepare('SELECT mock FROM students WHERE id = ?').get(stuA).mock)['竞赛 / AMC10'], 'mock null 墓碑删除生效');

  /* ---- v1.7.2：subjComments/subjFirstClass null 墓碑 + plan/set null 删除/平移（科目删除/重命名清旧键） ---- */
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjComments: { '竞赛 / AMC10': null } }, T1);
  const tombC = JSON.parse(db.prepare('SELECT subj_comments FROM students WHERE id = ?').get(stuA).subj_comments);
  ok(tombC['竞赛 / AMC10'] === undefined && tombC['学科 / AP / 微积分BC'] === '评语甲', 'subjComments null 墓碑删除生效（其余键保留）');
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjFirstClass: { '测试 / 临时甲': '2026-09-01', '测试 / 临时乙': '2026-09-02' } }, T1);
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjFirstClass: { '测试 / 临时乙': null } }, T1);
  const tombFc = JSON.parse(db.prepare('SELECT subj_first_class FROM students WHERE id = ?').get(stuA).subj_first_class);
  ok(tombFc['测试 / 临时乙'] === undefined && tombFc['测试 / 临时甲'] === '2026-09-01', 'subjFirstClass null 墓碑删除生效（其余键保留）');
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjFirstClass: { '测试 / 临时甲': null } }, T1);  // 清理
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC10', plan: 8, firstClassDate: '2026-09-02' }, T1);
  ok(r.status === 200, 'plan/set 首次设定 AMC10 计划');
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC10', plan: null }, T1);
  ok(r.status === 200, 'plan/set null 删除计划键成功');
  let tombPlans = JSON.parse(db.prepare('SELECT subj_plans FROM students WHERE id = ?').get(stuA).subj_plans);
  let tombSetAt = JSON.parse(db.prepare('SELECT subj_plan_set_at FROM students WHERE id = ?').get(stuA).subj_plan_set_at);
  ok(tombPlans['竞赛 / AMC10'] === undefined && tombSetAt['竞赛 / AMC10'] === undefined && tombPlans['学科 / AP / 微积分BC'] === 12,
    'plan/set null 删除后旧键清除（其余科目计划保留）');
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC10', plan: null }, T1);
  ok(r.status === 200, 'plan/set null 幂等（无键也 200）');
  await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC10', plan: 8, firstClassDate: '2026-09-02' }, T1);
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC10', plan: null, newSubject: '竞赛 / AMC12' }, T1);
  ok(r.status === 200, 'plan/set null + newSubject 平移成功');
  tombPlans = JSON.parse(db.prepare('SELECT subj_plans FROM students WHERE id = ?').get(stuA).subj_plans);
  tombSetAt = JSON.parse(db.prepare('SELECT subj_plan_set_at FROM students WHERE id = ?').get(stuA).subj_plan_set_at);
  ok(tombPlans['竞赛 / AMC10'] === undefined && tombSetAt['竞赛 / AMC10'] === undefined
    && tombPlans['竞赛 / AMC12'] === 8 && tombSetAt['竞赛 / AMC12'] === today(),
    'plan/set 平移：次数与设定日期原样搬到新键');
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC12', plan: null, newSubject: '学科 / AP / 微积分BC' }, T1);
  ok(r.status === 400, 'plan/set 平移不覆盖新键已有计划（400）');
  r = await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC12', plan: null, newSubject: '竞赛 / AMC12' }, T1);
  ok(r.status === 400, 'plan/set newSubject 与旧键相同 400');
  await req('POST', '/api/plan/set', { studentId: stuA, subject: '竞赛 / AMC12', plan: null }, T1);  // 清理
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { subjFirstClass: { '竞赛 / AMC10': null } }, T1);  // 清理

  /* ---- v1.8.3 ENG-01：mock slot 内字段级合并（同科目 date/score 分别保存不互踩；字段级 null 墓碑；空 slot 不残留） ---- */
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '字段科目': { date: '2026-11-01' } } }, T1);
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '字段科目': { score: 88 } } }, T1);
  let mockFc = JSON.parse(db.prepare('SELECT mock FROM students WHERE id = ?').get(stuA).mock);
  ok(mockFc['字段科目'].date === '2026-11-01' && mockFc['字段科目'].score === 88, 'ENG-01：同科目先存日期再存分数，两字段都生效不互踩');
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '字段科目': { date: '2026-11-05' } } }, T1);
  mockFc = JSON.parse(db.prepare('SELECT mock FROM students WHERE id = ?').get(stuA).mock);
  ok(mockFc['字段科目'].date === '2026-11-05' && mockFc['字段科目'].score === 88, 'ENG-01：只改日期不覆盖同科目分数字段');
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '字段科目': { date: null } } }, T1);
  mockFc = JSON.parse(db.prepare('SELECT mock FROM students WHERE id = ?').get(stuA).mock);
  ok(mockFc['字段科目'] && mockFc['字段科目'].date === undefined && mockFc['字段科目'].score === 88, 'ENG-01：字段级 null 墓碑只清日期留分数');
  await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { '字段科目': { score: null } } }, T1);
  mockFc = JSON.parse(db.prepare('SELECT mock FROM students WHERE id = ?').get(stuA).mock);
  ok(mockFc['字段科目'] === undefined, 'ENG-01：字段清空后空 slot 不残留');

  /* ---- 待办预警动作接口（/api/alerts/action；state 同步 alertActions） ---- */
  r = await req('POST', '/api/missed', { studentId: stuA, date: today(), subject: '学科 / AP / 微积分BC' }, T1);
  const alertMissId = r.data.missed.id;
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'snooze', snoozeUntil: today() }, T1);
  ok(r.status === 200 && r.data.ok, '预警稍后处理（snooze）成功');
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'snooze' }, T1);
  ok(r.status === 400, 'snooze 缺 snoozeUntil 400');
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'snooze', snoozeUntil: '09-25' }, T1);
  ok(r.status === 400, 'snoozeUntil 格式错误 400');
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'nope', snoozeUntil: today() }, T1);
  ok(r.status === 400, 'action 非法 400');
  r = await req('POST', '/api/alerts/action', { kind: 'nope', refKey: alertMissId, action: 'done' }, T1);
  ok(r.status === 400, 'kind 非法 400');
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: 'no-such', action: 'done' }, T1);
  ok(r.status === 404, 'miss refKey 不存在 404');
  r = await req('POST', '/api/alerts/action', { kind: 'lowAcc', refKey: 'no-such|x', action: 'done' }, T1);
  ok(r.status === 404, 'lowAcc/planStall refKey 学生不存在 404');
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'done' }, T2);
  ok(r.status === 403, '助教不能处理他人名下学生的预警（403）');
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'done' }, TS);
  ok(r.status === 403, '销售无预警操作权限（403）');
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'done' }, T1);
  ok(r.status === 200, '预警完成（done）成功');
  ok(db.prepare("SELECT * FROM audit_logs WHERE action IN ('预警稍后处理','预警完成')").all().length >= 2, '预警 snooze/done 写审计日志');
  r = await req('GET', '/api/state', null, T1);
  const aa = r.data.state.alertActions;
  ok(Array.isArray(aa) && aa.filter(a=>a.refKey===alertMissId).length === 2, 'state 同步带 alertActions（同 ref_key 两条动作）');
  ok(aa.find(a=>a.refKey===alertMissId && a.action==='done').actorName === '王助教', 'alertActions 带操作人姓名');
  r = await req('GET', '/api/state', null, T2);
  ok(!(r.data.state.alertActions || []).some(a=>a.refKey===alertMissId), '助教 state 不含他人名下学生的预警动作');
  /* ---- 搁置（v1.8.6）：逾期未交的家长侧出清出口 ---- */
  r = await req('POST', '/api/alerts/action', { kind: 'miss', refKey: alertMissId, action: 'shelve', note: '家长暂停课程' }, T1);
  ok(r.status === 200 && r.data.ok, '预警搁置（shelve）成功');
  r = await req('POST', '/api/alerts/action', { kind: 'lowAcc', refKey: alertMissId.split('|')[0] + '|x', action: 'shelve' }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('仅未交类') !== -1, '非未交类预警不允许搁置（400）');
  ok(db.prepare("SELECT * FROM audit_logs WHERE action = '搁置逾期预警' AND detail LIKE '%家长暂停课程%'").all().length === 1,
    '搁置写审计日志（含原因）');
  r = await req('GET', '/api/state', null, T1);
  ok(r.data.state.alertActions.find(a=>a.refKey===alertMissId && a.action==='shelve').note === '家长暂停课程',
    'state 同步带搁置动作与原因');

  console.log('\nM3 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
