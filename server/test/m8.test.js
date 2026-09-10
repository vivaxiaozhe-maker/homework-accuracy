/* M8 科目树接口测试：GET 全角色可读（默认树兜底）、PUT 仅教务 + 结构校验 + 审计（零额外依赖）。
   独立测试库（DB_PATH 指向临时文件）+ 随机端口起服务。运行：node test/m8.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立测试 DB（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-m8-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;

const { app } = require('../index');
const db = require('../db');

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

  /* ---- 账号准备 ---- */
  const adminTok = (await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' })).data.token;
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '张顾问', username: 'sales1', password: 'sales123456', role: 'sales' }, adminTok);
  const T1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data.token;
  const TS = (await req('POST', '/api/login', { username: 'sales1', password: 'sales123456', role: 'sales' })).data.token;

  /* ---- GET：默认树兜底 + 全角色可读 ---- */
  let r = await req('GET', '/api/subjects', null, T1);
  ok(r.status === 200 && r.data.ok && r.data.tree['学科']['AP'].indexOf('微积分BC') !== -1
    && r.data.tree['竞赛']['AMC10'] === null && r.data.tree['语培']['SAT'] === null,
    'GET /api/subjects 库中无记录时返回内置默认树（助教可读）');
  r = await req('GET', '/api/subjects', null, TS);
  ok(r.status === 200 && r.data.tree['学科'], '销售 GET /api/subjects 可读');
  r = await req('GET', '/api/subjects');
  ok(r.status === 401, '未登录 GET /api/subjects 401');

  /* ---- PUT 权限 ---- */
  const newTree = { '学科': { 'AP': ['微积分BC'], '新系列': ['新科目'] }, '竞赛': { 'AMC10': null } };
  r = await req('PUT', '/api/subjects', { tree: newTree }, T1);
  ok(r.status === 403 && r.data.ok === false, '助教 PUT /api/subjects 被拒（403）');
  r = await req('PUT', '/api/subjects', { tree: newTree }, TS);
  ok(r.status === 403, '销售 PUT /api/subjects 被拒（403）');

  /* ---- PUT 结构校验 ---- */
  r = await req('PUT', '/api/subjects', { tree: ['不是对象'] }, adminTok);
  ok(r.status === 400, '科目树为数组 400');
  r = await req('PUT', '/api/subjects', { tree: { '学科': '字符串而非对象' } }, adminTok);
  ok(r.status === 400, '二级为字符串 400');
  r = await req('PUT', '/api/subjects', { tree: { '学科': { 'AP': [123] } } }, adminTok);
  ok(r.status === 400, '三级含非字符串 400');

  /* ---- PUT 成功 + GET 回读 ---- */
  r = await req('PUT', '/api/subjects', { tree: newTree }, adminTok);
  ok(r.status === 200 && r.data.ok === true, '教务 PUT /api/subjects 成功');
  r = await req('GET', '/api/subjects', null, T1);
  ok(r.data.tree['学科']['新系列'][0] === '新科目' && !r.data.tree['语培'], 'GET 回读新科目树（覆盖生效）');
  const logRow = db.prepare("SELECT * FROM audit_logs WHERE action = '更新科目树' ORDER BY ts DESC LIMIT 1").get();
  ok(logRow && logRow.user_name === '教务管理员' && logRow.target_type === 'data', '更新科目树写审计日志');

  console.log('\nM8 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
