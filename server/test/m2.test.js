/* M2 认证与账号 API 测试：零额外依赖（node 内置 fetch + assert）。
   独立测试库（DB_PATH 指向临时文件）+ 随机端口起服务。
   运行：npm test 或 node test/m2.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立测试 DB（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-m2-test-' + Date.now() + '.db');
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

  /* ---- 健康检查与登录 ---- */
  let r = await req('GET', '/api/health');
  ok(r.status === 200 && r.data && r.data.ok === true, 'GET /api/health 返回 ok');

  r = await req('POST', '/api/login', { username: 'admin', password: 'wrong-pwd' });
  ok(r.status === 401 && r.data.ok === false, '错误密码登录 401');  // 限流计数 1

  r = await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'ta' });
  ok(r.status === 401 && r.data.ok === false, '角色不符登录被拒（教务账号以助教角色）');  // 限流计数 2

  r = await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' });
  ok(r.status === 200 && r.data.ok === true && r.data.token && r.data.user.username === 'admin'
    && r.data.user.role === 'admin' && r.data.user.mustChangePwd === true, 'admin 登录成功返回 token/user');
  const adminTok = r.data.token;
  const adminId = r.data.user.id;

  /* ---- 登录写审计日志 ---- */
  const db = require('../db');
  const logRow = db.prepare("SELECT * FROM audit_logs WHERE action = '登录成功' ORDER BY ts DESC LIMIT 1").get();
  ok(logRow && logRow.user_id === adminId && logRow.ts.length === 19, '登录成功写入 audit_logs（ts 精确到秒）');

  /* ---- auth 中间件 ---- */
  r = await req('GET', '/api/users');
  ok(r.status === 401 && r.data.ok === false, '无 token 访问 401');
  r = await req('GET', '/api/users', null, 'fake-token-123');
  ok(r.status === 401 && r.data.ok === false, '假 token 访问 401');

  r = await req('GET', '/api/users', null, adminTok);
  ok(r.status === 200 && Array.isArray(r.data.users) && r.data.users.length === 1, '教务 GET /api/users 返回账号列表');
  ok(r.data.users[0].pass_hash === undefined && r.data.users[0].stuCnt === 0, '账号列表不含 pass_hash，附学生数统计');

  /* ---- 创建账号 ---- */
  r = await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  ok(r.status === 200 && r.data.ok === true && r.data.user.mustChangePwd === true, '创建助教账号成功（mustChangePwd=1）');
  const ta1Id = r.data.user.id;

  r = await req('POST', '/api/users', { name: '重复', username: 'ta1', password: 'abcdef', role: 'ta' }, adminTok);
  ok(r.status === 400 && r.data.ok === false, '重复 username 被拒（400）');

  r = await req('POST', '/api/users', { name: 'x', username: 'x1', password: 'abcdef', role: 'admin' }, adminTok);
  ok(r.status === 400 && r.data.ok === false, '创建账号角色限 ta/sales');

  /* ---- 助教登录与越权 ---- */
  r = await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' });
  ok(r.status === 200 && r.data.ok === true, 'ta1 登录成功');
  const taTokA = r.data.token;
  r = await req('POST', '/api/login', { username: 'ta1', password: 'ta123456' });
  const taTokB = r.data.token;  // 第二个 session（稍后验证改密后失效）

  r = await req('GET', '/api/users', null, taTokA);
  ok(r.status === 403 && r.data.ok === false, '非教务调 users 接口 403');

  /* ---- 修改密码 ---- */
  r = await req('POST', '/api/password', { oldPwd: 'bad', newPwd: 'ta654321' }, taTokA);
  ok(r.status === 401 && r.data.ok === false, '改密原密码错误 401');
  r = await req('POST', '/api/password', { oldPwd: 'ta123456', newPwd: 'ta654321' }, taTokA);
  ok(r.status === 200 && r.data.ok === true, '改密成功');

  r = await req('POST', '/api/login', { username: 'ta1', password: 'ta123456' });
  ok(r.status === 401 && r.data.ok === false, '改密后旧密码失效');  // 限流计数 3
  r = await req('POST', '/api/login', { username: 'ta1', password: 'ta654321' });
  ok(r.status === 200 && r.data.ok === true && r.data.user.mustChangePwd === false, '新密码可登录且 mustChangePwd 已清');

  r = await req('GET', '/api/users', null, taTokB);
  ok(r.status === 401, '改密后该用户其他 session 失效（旧 token 401）');
  r = await req('GET', '/api/users', null, taTokA);
  ok(r.status === 403, '改密所用的当前 session 仍有效（403=已登录但角色不符）');

  /* ---- 重置密码 ---- */
  r = await req('POST', '/api/users/' + ta1Id + '/reset', { password: 'ta123456' }, adminTok);
  ok(r.status === 200 && r.data.ok === true, '教务重置助教密码成功');
  r = await req('GET', '/api/users', null, taTokA);
  ok(r.status === 401, '重置密码后该用户 session 全清（token 401）');
  r = await req('POST', '/api/login', { username: 'ta1', password: 'ta123456' });
  ok(r.status === 200 && r.data.user.mustChangePwd === true, '重置后 mustChangePwd 重新生效');

  /* ---- 停用/启用 ---- */
  r = await req('POST', '/api/users/' + adminId + '/toggle', {}, adminTok);
  ok(r.status === 400 && r.data.ok === false, '不能停用自己的账号');
  r = await req('POST', '/api/users/' + ta1Id + '/toggle', {}, adminTok);
  ok(r.status === 200 && r.data.user.disabled === true, '停用 ta1 成功');
  r = await req('POST', '/api/login', { username: 'ta1', password: 'ta123456' });
  ok(r.status === 401 && r.data.ok === false, '停用账号拒登');  // 限流计数 4
  r = await req('POST', '/api/users/' + ta1Id + '/toggle', {}, adminTok);
  ok(r.status === 200 && r.data.user.disabled === false, '重新启用 ta1');

  /* ---- 最后一个教务保护：先造第二个教务再停 admin，再验证保护 ---- */
  // 直接对唯一教务之外再验证：当前只有一个 admin，toggle 另一个 admin 场景——用 SQL 造一个教务账号
  db.prepare(`INSERT INTO users (id, username, name, role, pass_hash, disabled, must_change_pwd, created_at)
              VALUES ('u_admin2', 'admin2', '教务二号', 'admin', 'x', 0, 0, ?)`).run(new Date().toISOString());
  r = await req('POST', '/api/users/u_admin2/toggle', {}, adminTok);
  ok(r.status === 200 && r.data.user.disabled === true, '存在其他可用教务时可停用某教务');
  r = await req('POST', '/api/users/' + adminId + '/toggle', {}, adminTok);
  ok(r.status === 400 && r.data.ok === false, '不能停用最后一个可用教务账号');

  /* ---- 限流：10 次失败/分钟/IP（本测试此前已消耗 4 次失败登录） ---- */
  let lastStatus = 0, saw401 = false;
  for(let i = 0; i < 8; i++){
    const rr = await req('POST', '/api/login', { username: 'nobody', password: 'x' });
    if(rr.status === 401) saw401 = true;
    lastStatus = rr.status;
  }
  ok(saw401 && lastStatus === 429, '登录限流：第 11 次失败尝试返回 429');

  console.log('\n断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
