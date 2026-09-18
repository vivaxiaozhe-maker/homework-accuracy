/* M10 微信自动推送测试：push_config 开关 + 三触发点自动推送 + 三个手动推送接口（零额外依赖）。
   假配置值（test-*），微信 API 用全局 fetch 桩拦截并记录；本机请求转发真 fetch。
   独立测试库 + 随机端口。运行：node test/m10.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB = path.join(os.tmpdir(), 'xq-m10-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;
process.env.WECHAT_APPID = 'test-appid';
process.env.WECHAT_SECRET = 'test-secret-fake';
process.env.WECHAT_TOKEN = 'test-token-fake';
process.env.WECHAT_TEMPLATE_HOMEWORK = 'tmpl-homework';
process.env.WECHAT_TEMPLATE_MOCKBOOK = 'tmpl-mockbook';
process.env.WECHAT_TEMPLATE_MOCKSCORE = 'tmpl-mockscore';

/* 微信 API 桩 */
const realFetch = globalThis.fetch;
const wxCalls = [];
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if(u.indexOf('api.weixin.qq.com') !== -1){
    wxCalls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if(u.indexOf('/cgi-bin/token') !== -1) return Promise.resolve({ json: async () => ({ access_token: 'fake-at', expires_in: 7200 }) });
    if(u.indexOf('template/send') !== -1) return Promise.resolve({ json: async () => ({ errcode: 0, errmsg: 'ok' }) });
  }
  return realFetch(url, opts);
};
const sendCalls = () => wxCalls.filter(c => c.url.indexOf('template/send') !== -1);

const { app } = require('../index');
const db = require('../db');
const push = require('../push');  // 限流重置锚点（本文件按顺序会触发多次推送，分段重置避免误触 10 分钟 3 次上限）

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
    const res = await realFetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try{ data = await res.json(); }catch(e){}
    return { status: res.status, data };
  }

  /* ---- 账号与学生（含一条家长绑定） ---- */
  const adminTok = (await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' })).data.token;
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '李助教', username: 'ta2', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '张顾问', username: 'sales1', password: 'sales123456', role: 'sales' }, adminTok);
  const T1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data.token;
  const T2 = (await req('POST', '/api/login', { username: 'ta2', password: 'ta123456', role: 'ta' })).data.token;
  const TS = (await req('POST', '/api/login', { username: 'sales1', password: 'sales123456', role: 'sales' })).data.token;
  const subj = '学科 / AP / 微积分BC';
  const stuA = (await req('POST', '/api/students', { name: '林小满', gradYear: '2027' }, T1)).data.student.id;
  const stuB = (await req('POST', '/api/students', { name: '陈星宇', gradYear: '2027' }, T2)).data.student.id;
  db.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
    .run('b1', stuA, 'openid_a', new Date().toISOString());

  /* ---- 推送开关：默认全关 / 权限 / 审计 ---- */
  let r = await req('GET', '/api/push-config', null, T1);
  ok(r.status === 200 && r.data.config.homework === false && r.data.config.mockBook === false && r.data.config.mockScore === false,
    'GET /api/push-config 默认三开关全关（助教可读）');
  r = await req('GET', '/api/push-config', null, TS);
  ok(r.status === 200, '销售可读推送开关状态');
  r = await req('PUT', '/api/push-config', { config: { homework: true } }, T1);
  ok(r.status === 403, '助教不能改开关（403）');
  r = await req('PUT', '/api/push-config', { config: { homework: true } }, TS);
  ok(r.status === 403, '销售不能改开关（403）');
  r = await req('PUT', '/api/push-config', { config: { homework: true } }, adminTok);
  ok(r.status === 200 && r.data.config.homework === true && r.data.config.mockBook === false, '教务 PUT 开关生效（部分字段不影响其他）');
  ok(db.prepare("SELECT * FROM audit_logs WHERE action = '修改自动推送开关'").all().length > 0, '改开关写审计日志');

  /* ---- 自动推送：作业批改完成通知（records POST/PUT） ---- */
  push._resetRateLimit();
  let before = sendCalls().length;
  r = await req('POST', '/api/records', { studentId: stuA, date: '2026-09-15', total: 20, correct: 18, wrongs: [7, 14], subject: subj }, T1);
  ok(r.status === 200 && r.data.pushed === true, '开关开：录入作业自动推送（pushed:true）');
  ok(sendCalls().length === before + 1, '模板消息实际发送 1 次');
  const hwCall = sendCalls()[sendCalls().length - 1];
  ok(hwCall.body.template_id === 'tmpl-homework' && hwCall.body.touser === 'openid_a', '作业通知 template_id/touser 正确');
  ok(hwCall.body.data.thing15.value === 'AP·微积分BC' && hwCall.body.data.thing1.value === '林小满'
    && hwCall.body.data.character_string18.value === '90%' && hwCall.body.url.indexOf('/r/') !== -1,
    '作业通知字段映射正确（学科短名/姓名/本次正确率/报告链接）');
  // 编辑保存也触发
  const recId = r.data.record.id;
  r = await req('PUT', '/api/records/' + recId, { date: '2026-09-15', total: 20, correct: 20, wrongs: [], subject: subj }, T1);
  ok(r.status === 200 && r.data.pushed === true, '编辑作业保存也自动推送');
  // 开关关闭后不推
  await req('PUT', '/api/push-config', { config: { homework: false } }, adminTok);
  before = sendCalls().length;
  r = await req('POST', '/api/records', { studentId: stuA, date: '2026-09-16', total: 10, correct: 9, wrongs: [], subject: subj }, T1);
  ok(r.status === 200 && r.data.pushed === false && sendCalls().length === before, '开关关：保存成功但不推送（pushed:false，零调用）');

  /* ---- 自动推送：模考预约 / 模考成绩（subj-fields mock 列新旧对比） ---- */
  push._resetRateLimit();  // 上节已用 2 次额度，重置防误触限流
  before = sendCalls().length;
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { [subj]: { date: '2026-09-25' } } }, T1);
  ok(r.status === 200 && sendCalls().length === before, '预约开关关：设模考日期不推送');
  await req('PUT', '/api/push-config', { config: { mockBook: true, mockScore: true } }, adminTok);
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { [subj]: { date: '2026-09-26' } } }, T1);
  ok(r.status === 200 && r.data.pushed && r.data.pushed.mockBook === true, '预约开关开：日期变化自动推送报名通知');
  const mbCall = sendCalls()[sendCalls().length - 1];
  ok(mbCall.body.template_id === 'tmpl-mockbook' && mbCall.body.data.time4.value === '2026-09-26'
    && mbCall.body.data.thing3.value === 'AP·微积分BC模考' && mbCall.body.data.thing6.value === '林小满',
    '报名通知字段映射正确（时间/科目+模考/姓名）');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { [subj]: { date: '2026-09-26' } } }, T1);
  ok(r.status === 200 && !r.data.pushed, '日期未变化不重复推送报名通知');
  r = await req('PUT', '/api/students/' + stuA + '/subj-fields', { mock: { [subj]: { date: '2026-09-26', score: 92 } } }, T1);
  ok(r.status === 200 && r.data.pushed && r.data.pushed.mockScore === true, '录入分数自动推送成绩通知');
  const msCall = sendCalls()[sendCalls().length - 1];
  ok(msCall.body.template_id === 'tmpl-mockscore' && msCall.body.data.thing22.value === 'AP·微积分BC'
    && msCall.body.data.thing10.value === '林小满' && msCall.body.data.character_string12.value === '92 分',
    '成绩通知字段映射正确（科目短名/姓名/分数+分）');

  /* ---- 手动推送三接口 ---- */
  push._resetRateLimit();  // 上节已用 2 次额度，重置防误触限流
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200 && r.data.ok && r.data.sent === 1, '手动推送作业成绩通知成功（不受开关影响）');
  ok(sendCalls()[sendCalls().length - 1].body.data.character_string18.value === '90%', '手动作业通知用最近正确率');
  r = await req('POST', '/api/push/mock-book', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200 && r.data.sent === 1, '手动推送报名通知成功');
  r = await req('POST', '/api/push/mock-score', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200 && r.data.sent === 1, '手动推送成绩通知成功');
  // 无模考数据的手动推送
  r = await req('POST', '/api/push/mock-book', { studentId: stuA, subject: '竞赛 / AMC10' }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('模考') !== -1, '未预约模考手动推报名通知 400');
  // 未绑定学生
  r = await req('POST', '/api/push/homework', { studentId: stuB, subject: subj }, T2);
  ok(r.status === 400 && r.data.msg.indexOf('未绑定') !== -1, '未绑定家长手动推送 400 提示');
  // 越权与销售
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, T2);
  ok(r.status === 403, '助教不能推送他人学生（403）');
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, TS);
  ok(r.status === 403, '销售无推送接口权限（403）');
  r = await req('POST', '/api/push/nope', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 404, '未知推送类型 404');

  console.log('\nM10 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
