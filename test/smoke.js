/* DOM 桩冒烟测试：加载 学生作业正确率.html 的内联脚本，验证账号体系与权限隔离。
   零依赖，直接运行：node test/smoke.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

/* ---------- 最小 DOM / 浏览器环境桩 ---------- */
function makeEl(id){
  return {
    id: id, value: '', textContent: '', innerHTML: '', disabled: false,
    style: {}, dataset: {}, files: [], onclick: null,
    classList: {
      _s: new Set(),
      add(...c){ c.forEach(x=>this._s.add(x)); },
      remove(...c){ c.forEach(x=>this._s.delete(x)); },
      toggle(c, f){ if(f===undefined) f=!this._s.has(c); if(f) this._s.add(c); else this._s.delete(c); },
      contains(c){ return this._s.has(c); }
    },
    addEventListener(){}, removeEventListener(){},
    appendChild(){}, click(){}, focus(){}, select(){}
  };
}
const _els = {};
const documentStub = {
  getElementById(id){ return _els[id] || (_els[id] = makeEl(id)); },
  querySelectorAll(){ return []; },
  querySelector(){ return null; },
  createElement(){ return makeEl('anon'); },
  head: makeEl('head'),
  body: makeEl('body')
};
function makeStorage(){
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear()
  };
}
const alerts = [];
const windowStub = { scrollTo(){}, print(){} };
const ctx = vm.createContext({
  document: documentStub,
  window: windowStub,
  localStorage: makeStorage(),
  sessionStorage: makeStorage(),
  crypto: globalThis.crypto,
  TextEncoder: globalThis.TextEncoder,
  alert: msg => alerts.push(String(msg)),
  console, setTimeout, clearTimeout,
  Blob: function(){},
  URL: { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} },
  FileReader: function(){}
});

/* ---------- 加载页面脚本 ---------- */
const html = fs.readFileSync(path.join(__dirname, '..', '学生作业正确率.html'), 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if(!m){ console.error('未找到 <script> 块'); process.exit(1); }
vm.runInContext(m[1], ctx, {filename: 'inline-script.js'});

/* ---------- 断言工具 ---------- */
let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

(async function main(){
  await windowStub.__ready;
  const wb = windowStub.__wb;
  const Api = wb.Api;

  /* ---- SHA-256 纯 JS 实现正确性（与标准实现一致，含中文 UTF-8 / 长输入跨块） ---- */
  ['hello', 'salt123:admin123', '教务:密码', 'a'.repeat(100)].forEach(s=>{
    const expect = nodeCrypto.createHash('sha256').update(s, 'utf8').digest('hex');
    ok(vm.runInContext('sha256Hex(' + JSON.stringify(s) + ')', ctx) === expect,
      'SHA-256 与标准一致：' + JSON.stringify(s.length > 20 ? s.slice(0,17)+'...' : s));
  });

  /* ---- 播种 ---- */
  const users = Api.listUsers();
  ok(users.length === 3, '首次运行播种 3 个账号（admin + ta1 + ta2）');
  const admin = users.find(u=>u.username==='admin');
  const ta1 = users.find(u=>u.username==='ta1');
  const ta2 = users.find(u=>u.username==='ta2');
  ok(admin && admin.role==='admin' && admin.mustChangePwd === false, 'admin 为教务且演示期不强制首登改密');
  ok(ta1 && ta2 && ta1.role==='ta' && ta2.role==='ta', 'ta1/ta2 为助教角色');
  ok(wb.pool.students.length === 10, '两位助教各有 5 名示例学生（共 10）');

  /* ---- 教务直接登录（演示不强制改密）+ 角色校验 ---- */
  let bad = await Api.login('admin', 'wrong-password', 'admin');
  ok(!bad.ok, '错误密码登录被拒');
  ok(!(await Api.login('admin', 'admin123', 'ta')).ok, '角色不符被拒（教务账号以助教角色登录）');
  ok(!(await Api.login('ta1', 'ta123456', 'admin')).ok, '角色不符被拒（助教账号以教务角色登录）');
  await wb.doLogin('admin', 'admin123', 'admin');
  ok(wb.currentUser && wb.currentUser.username === 'admin', 'admin 初始密码直接登录成功（不强制改密）');
  ok(wb.state.students.length === 10, '教务登录后直接进入主界面，见全部数据（10 名学生）');
  await wb.doChangePwd('bad-old', 'admin456', 'admin456');
  ok((await Api.login('admin', 'admin123', 'admin')).ok, '改密时原密码错误被拒，旧密码仍有效');
  await wb.doChangePwd('admin123', 'admin456', 'admin456');
  ok(!(await Api.login('admin', 'admin123', 'admin')).ok, '改密后旧密码失效');
  ok((await Api.login('admin', 'admin456', 'admin')).ok, '改密后新密码可登录');

  /* ---- 账号唯一性 ---- */
  const dup = await Api.createUser('张三', 'ta1', 'abcdef');
  ok(!dup.ok, '创建助教：重复 username 被拒');
  const made = await Api.createUser('张三', 'ta3', 'abcdef');
  ok(made.ok && made.user.mustChangePwd === true, '创建助教成功且标记首次登录需改密');

  /* ---- 教务数据范围切换 ---- */
  wb.setScope(ta1.id);
  ok(wb.state.students.length === 5 && wb.state.students.every(s=>s.ownerId===ta1.id), '教务切换数据范围到 ta1 后只见 ta1 的学生');
  ok(wb.state.records.every(r=>r.ownerId===ta1.id) && wb.state.missed.every(x=>x.ownerId===ta1.id), '范围切换后记录/未交同步过滤');
  wb.setScope('all');
  ok(wb.state.students.length === 10, '切回全部数据可见 10 名学生');

  /* ---- 助教数据隔离 ---- */
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(wb.currentUser.username === 'ta1', 'ta1 登录成功');
  ok(wb.state.students.length === 5 && wb.state.students.every(s=>s.ownerId===ta1.id), 'ta1 只见自己的学生');
  ok(wb.state.records.length > 0 && wb.state.records.every(r=>r.ownerId===ta1.id), 'ta1 的记录全部归属自己');
  ok(!wb.state.students.some(s=>s.ownerId===ta2.id) && !wb.state.records.some(r=>r.ownerId===ta2.id), 'ta1 视图中不含 ta2 的数据');

  /* ---- 助教导出只含自己数据 ---- */
  const exp = wb.buildExport();
  ok(exp.students.length === 5 && exp.students.every(s=>s.ownerId===ta1.id)
    && exp.records.every(r=>r.ownerId===ta1.id) && exp.missed.every(x=>x.ownerId===ta1.id),
    '助教导出数据只含自己的 ownerId');

  /* ---- 新录入自动打 ownerId ---- */
  const ta1Stu = wb.state.students[0];
  const setVal = (id, v) => { documentStub.getElementById(id).value = v; };
  setVal('qe-date', ''); setVal('qe-total', '10');
  setVal('qe-correct', '9'); setVal('qe-wrongs', '3');
  wb.setQuickEntry({gid: ta1Stu.id, subject: '学科 / AP / 微积分BC'});
  const recBefore = wb.pool.records.length;
  wb.saveQuickEntry();
  const newRec = wb.pool.records[wb.pool.records.length - 1];
  ok(wb.pool.records.length === recBefore + 1 && newRec.ownerId === ta1.id, '新录入作业记录自动打当前用户 ownerId');
  setVal('sl-date', '');
  wb.setQuickEntry({gid: ta1Stu.id, subject: '竞赛 / AMC10'});
  const missBefore = wb.pool.missed.length;
  wb.markMissedToday();
  const newMiss = wb.pool.missed[wb.pool.missed.length - 1];
  ok(wb.pool.missed.length === missBefore + 1 && newMiss.ownerId === ta1.id, '新登记未交记录自动打当前用户 ownerId');

  /* ---- 越权防护 ---- */
  const otherMiss = wb.pool.missed.find(x=>x.ownerId === ta2.id);
  const alertsBefore = alerts.length;
  const missCnt = wb.pool.missed.length;
  wb.removeMissed(otherMiss.id);
  ok(alerts.length > alertsBefore && wb.pool.missed.length === missCnt, '助教删除他人未交记录被拒绝');
  const ta2Stu = wb.pool.students.find(s=>s.ownerId===ta2.id);
  wb.setQuickEntry({gid: ta2Stu.id, subject: '学科 / AP / 物理1'});
  const recCnt = wb.pool.records.length;
  wb.saveQuickEntry();
  ok(wb.pool.records.length === recCnt, '助教给他人学生录入记录被拒绝');

  /* ---- 停用拒登、数据保留 ---- */
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  const tg = Api.toggleUser(ta2.id);
  ok(tg.ok && tg.user.disabled === true, '教务停用 ta2 成功');
  const selfTg = Api.toggleUser(admin.id);
  ok(!selfTg.ok, '不能停用自己的账号');
  wb.doLogout();
  const disabledLogin = await Api.login('ta2', 'ta123456', 'ta');
  ok(!disabledLogin.ok, '停用后 ta2 登录被拒');
  ok(wb.pool.students.filter(s=>s.ownerId===ta2.id).length === 5, '停用后 ta2 数据完整保留');

  /* ---- 转移归属：学生 + 记录 + 未交一并跟随 ---- */
  await wb.doLogin('admin', 'admin456', 'admin');
  const mvStu = wb.pool.students.find(s=>s.ownerId===ta1.id);
  const mvRecs = wb.pool.records.filter(r=>r.studentId===mvStu.id).length;
  const res = Api.transferStudent([mvStu.id], ta2.id);
  ok(res.ok && mvStu.ownerId === ta2.id, '转移学生归属成功');
  ok(mvRecs > 0 && wb.pool.records.filter(r=>r.studentId===mvStu.id).every(r=>r.ownerId===ta2.id),
    '转移后该生作业记录 ownerId 同步变更');
  ok(wb.pool.missed.filter(x=>x.studentId===mvStu.id).every(x=>x.ownerId===ta2.id),
    '转移后该生未交记录 ownerId 同步变更');
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(wb.state.students.length === 4 && !wb.state.students.some(s=>s.id===mvStu.id), '转移后 ta1 视图不再含该学生');

  /* ---- 数据看板（教务） ---- */
  const offDay = n => { const d = new Date(); d.setDate(d.getDate()+n);
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); };
  const dashIds = ['dash-overview','dash-trend','dash-tas','dash-cats','dash-subs','dash-alert-low','dash-alert-miss','dash-alert-sleep'];
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  ok(documentStub.getElementById('nav-dashboard').style.display !== 'none'
    && documentStub.getElementById('tab-dashboard').style.display !== 'none', '教务登录后看板入口（侧栏+底部 Tab）可见');
  ok(documentStub.getElementById('tab-data').style.display === 'none', '教务端底部 Tab 已移除「数据管理」');
  wb.setDashRange(30); wb.setDashOwner('all');
  dashIds.forEach(id=>{
    const h = documentStub.getElementById(id).innerHTML;
    ok(h.length > 0 && h.indexOf('NaN') === -1 && h.indexOf('undefined') === -1,
      '看板板块 ' + id + ' 输出无 NaN/undefined');
  });
  // 助教筛选：选 ta1 后概览只含 ta1 数据
  wb.setDashOwner(ta1.id);
  const dTa1 = wb.computeDash();
  const expectTa1 = wb.pool.records.filter(r=>r.ownerId===ta1.id && r.date >= offDay(-29)).length;
  ok(dTa1.recCnt === expectTa1 && dTa1.recCnt < wb.pool.records.length, '看板助教筛选生效：范围内录入次数只含 ta1 数据');
  // 时间范围：近 7 天 ≤ 全部
  wb.setDashOwner('all');
  wb.setDashRange(7);
  const d7 = wb.computeDash();
  wb.setDashRange(0);
  const dAll = wb.computeDash();
  ok(d7.recCnt <= dAll.recCnt && d7.recCnt === wb.pool.records.filter(r=>r.date >= offDay(-6)).length,
    '时间范围过滤生效（近7天 ≤ 全部，且口径正确）');
  wb.setDashRange(30);
  // 沉默助教徽章：ta3 创建后从未录入
  ok(wb.computeDash().taRows.some(r=>r.user.username==='ta3' && r.silent), '≥7 天未录入的助教显示「沉默」标记');
  // 预警名单：构造低分学生 / 逾期未交 / 沉睡学生
  const lowStu = {id:'dash-low-stu', name:'看板低分测试', ownerId:ta1.id};
  wb.pool.students.push(lowStu);
  wb.pool.records.push({id:'dash-low-rec', studentId:lowStu.id, date:offDay(0), total:10, correct:3,
    wrongs:[1,2,3,4,5,6,7], subject:'学科 / AP / 物理2', images:[], ownerId:ta1.id});
  wb.pool.missed.push({id:'dash-od-miss', studentId:lowStu.id, date:offDay(-5), resolved:false,
    subject:'学科 / AP / 物理2', ownerId:ta1.id});
  wb.pool.students.push({id:'dash-sleep-stu', name:'看板沉睡测试', ownerId:ta2.id});
  wb.renderDashboard();
  const dFix = wb.computeDash();
  ok(dFix.lowStus.some(g=>g.name==='看板低分测试' && g.avg===30), '预警名单：平均 <60% 的低分学生入选');
  ok(dFix.overdueList.some(x=>x.id==='dash-od-miss' && x.days===5), '预警名单：逾期未交入选且逾期天数正确');
  ok(dFix.sleepers.some(x=>x.name==='看板沉睡测试' && x.days===null), '预警名单：14 天无记录学生入选（从未有记录）');
  ok(documentStub.getElementById('dash-alert-low').innerHTML.indexOf('看板低分测试') !== -1
    && documentStub.getElementById('dash-alert-miss').innerHTML.indexOf('看板低分测试') !== -1
    && documentStub.getElementById('dash-alert-sleep').innerHTML.indexOf('看板沉睡测试') !== -1,
    '三类预警名单已渲染到页面');
  // 助教行下钻：筛选下拉同步
  wb.dashDrillTa(ta2.id);
  ok(wb.dashOwner === ta2.id && documentStub.getElementById('dash-owner').value === ta2.id, '点击助教行下钻后筛选下拉同步为该助教');
  wb.dashDrillTa(ta2.id);
  ok(wb.dashOwner === 'all', '再点同一助教行返回全部助教');

  /* ---- 助教端看板守卫 ---- */
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(documentStub.getElementById('nav-dashboard').style.display === 'none'
    && documentStub.getElementById('tab-dashboard').style.display === 'none', '助教登录后看板入口隐藏');
  ok(documentStub.getElementById('tab-data').style.display !== 'none', '助教端底部 Tab 保留「数据管理」');
  ok(dashIds.every(id=>documentStub.getElementById(id).innerHTML === ''), '助教角色下 renderDashboard 不产出内容');

  /* ---- 计划次数二次修改审批流 ---- */
  // 当前登录 ta1；取一名 ta1 的现有学生
  const planStu = wb.pool.students.find(s=>s.ownerId===ta1.id && !s.archived);
  const planSubj = '学科 / AP / 微积分BC';
  wb.setQuickEntry({gid: planStu.id, subject: planSubj});
  // 首次设置：直接生效，不产生申请
  setVal('qe-plan', '10');
  wb.savePlanCount();
  ok(planStu.subjPlans && planStu.subjPlans[planSubj]===10 && wb.pool.planRequests.length===0,
    '首次设置应完成次数直接生效，不产生申请');
  // 二次修改：生成 pending，当前次数不变
  setVal('qe-plan', '12');
  wb.savePlanCount();
  setVal('pr-reason', '课程加量');
  wb.submitPlanRequest();
  const req1 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  ok(wb.pool.planRequests.length===1 && req1.status==='pending' && req1.oldPlan===10 && req1.newPlan===12
    && req1.reason==='课程加量' && req1.ownerId===ta1.id && req1.requestedBy===ta1.id,
    '二次修改生成 pending 申请（含 oldPlan/newPlan/reason）');
  ok(planStu.subjPlans[planSubj]===10, '申请待审批期间当前次数不变');
  // 新值=旧值拦截
  let alertsB = alerts.length;
  setVal('qe-plan', '10');
  wb.savePlanCount();
  ok(wb.pool.planRequests.length===1 && alerts.length>alertsB, '新值=旧值被拦截，不产生申请');
  // 重复申请拦截
  alertsB = alerts.length;
  setVal('qe-plan', '15');
  wb.savePlanCount();
  ok(wb.pool.planRequests.length===1 && alerts.length>alertsB, '已有 pending 时重复申请被拦截');
  // 撤回后可重新申请
  ok(Api.cancelPlanRequest(req1.id).ok && req1.status==='cancelled', '助教撤回申请成功');
  ok(!Api.cancelPlanRequest(req1.id).ok, '已撤回的申请不能重复撤回');
  setVal('qe-plan', '15');
  wb.savePlanCount();
  setVal('pr-reason', '');
  wb.submitPlanRequest();
  const req2 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  ok(wb.pool.planRequests.length===2 && req2.status==='pending' && req2.newPlan===15, '撤回后可重新发起申请');
  // 越权：助教给他人学生申请
  const ta2StuP = wb.pool.students.find(s=>s.ownerId===ta2.id);
  ta2StuP.subjPlans = {'测试科目': 5};
  ok(!Api.createPlanRequest({studentId: ta2StuP.id, subject:'测试科目', newPlan: 8}).ok,
    '助教给他人学生提交申请被越权拦截');
  // 教务驳回：次数不变
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  wb.reviewPlanRequest(req2.id, false);
  documentStub.getElementById('cf-ok').onclick();  // 确认驳回
  ok(req2.status==='rejected' && planStu.subjPlans[planSubj]===10, '教务驳回后申请 rejected 且次数不变');
  // 教务通过：次数生效
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  setVal('qe-plan', '18');
  wb.savePlanCount();
  setVal('pr-reason', '');
  wb.submitPlanRequest();
  const req3 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  ok(Api.reviewPlanRequest(req3.id, true).ok && req3.status==='approved'
    && req3.reviewedBy===admin.id && planStu.subjPlans[planSubj]===18, '教务通过后应完成次数生效');
  ok(!Api.reviewPlanRequest(req3.id, true).ok, '已审批的申请不能重复审批');
  // 教务直改：免审批生效，pending 自动驳回
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  setVal('qe-plan', '20');
  wb.savePlanCount();
  setVal('pr-reason', '');
  wb.submitPlanRequest();
  const req4 = wb.pool.planRequests[wb.pool.planRequests.length-1];
  ok(req4.status==='pending' && req4.oldPlan===18, '助教再次发起申请（18 → 20）');
  wb.doLogout();
  await wb.doLogin('admin', 'admin456', 'admin');
  wb.setQuickEntry({gid: planStu.id, subject: planSubj});
  setVal('qe-plan', '25');
  wb.savePlanCount();  // 教务直改 → 确认弹窗
  documentStub.getElementById('cf-ok').onclick();  // 确认直改
  ok(planStu.subjPlans[planSubj]===25, '教务直改免审批直接生效');
  ok(req4.status==='rejected' && req4.reviewedBy===admin.id, '教务直改时 pending 申请被自动驳回');
  // 审批区块渲染无 NaN/undefined，已处理区含通过/驳回
  const prPendHtml = documentStub.getElementById('planreq-pending').innerHTML;
  const prDoneHtml = documentStub.getElementById('planreq-done').innerHTML;
  ok(prPendHtml.indexOf('NaN')===-1 && prPendHtml.indexOf('undefined')===-1
    && prDoneHtml.indexOf('NaN')===-1 && prDoneHtml.indexOf('undefined')===-1
    && prDoneHtml.indexOf('已通过')!==-1 && prDoneHtml.indexOf('已驳回')!==-1,
    '审批区块渲染无 NaN/undefined，已处理区含通过/驳回记录');
  // 徽章数量随 pending 变化
  ok(documentStub.getElementById('badge-accounts').style.display==='none', '无待审批时徽章隐藏');
  const req5 = Api.createPlanRequest({studentId: planStu.id, subject: planSubj, newPlan: 30}).request;
  wb.renderPendingBadges();
  ok(documentStub.getElementById('badge-accounts').textContent==='1'
    && documentStub.getElementById('badge-accounts').style.display!=='none', '有 1 条待审批时徽章显示数量');
  Api.reviewPlanRequest(req5.id, true);
  wb.renderPendingBadges();
  ok(documentStub.getElementById('badge-accounts').style.display==='none', '审批完成后徽章消失');
  wb.doLogout();
  await wb.doLogin('ta1', 'ta123456', 'ta');
  ok(documentStub.getElementById('badge-accounts').style.display==='none'
    && documentStub.getElementById('badge-accounts-tab').style.display==='none', '助教端不显示审批徽章');

  console.log('\n断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
