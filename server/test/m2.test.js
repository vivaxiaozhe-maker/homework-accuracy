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

  r = await req('GET', '/api/me', null, adminTok);
  ok(r.status === 200 && r.data.ok && r.data.user.username === 'admin' && r.data.user.role === 'admin',
    'GET /api/me 返回当前用户（刷新恢复会话用）');

  /* ---- 强制改密硬限制（v1.7.0）：待改密账号仅放行 /password /me /logout，其余 403 ---- */
  r = await req('GET', '/api/users', null, adminTok);
  ok(r.status === 403 && r.data.msg === '请先修改初始密码', '待改密账号调业务接口被硬限制 403');
  r = await req('POST', '/api/password', { oldPwd: 'admin123', newPwd: 'admin456' }, adminTok);
  ok(r.status === 200 && r.data.ok === true, '待改密账号改密（/password 放行）');
  r = await req('GET', '/api/users', null, adminTok);
  ok(r.status === 200, '改密后业务接口恢复（200）');
  // 后续用例统一用新密码
  const adminPwd = 'admin456';

  r = await req('GET', '/api/users', null, adminTok);
  ok(r.status === 200 && Array.isArray(r.data.users) && r.data.users.length === 1, '教务 GET /api/users 返回账号列表');
  ok(r.data.users[0].pass_hash === undefined && r.data.users[0].stuCnt === 0, '账号列表不含 pass_hash，附学生数统计');

  /* ---- 创建账号 ---- */
  r = await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  ok(r.status === 200 && r.data.ok === true && r.data.user.mustChangePwd === true, '创建助教账号成功（mustChangePwd=1）');
  const ta1Id = r.data.user.id;
  ok(r.data.user.tempPassword === 'ta123456', '创建账号响应带回初始密码 tempPassword');

  /* ---- 初始密码只显示一次（v1.8.1 ENG-02）：创建/重置当次响应返回；列表永不返回、写库即 NULL ---- */
  r = await req('GET', '/api/users', null, adminTok);
  const ta1Row0 = r.data.users.find(u => u.id === ta1Id);
  const adminRow0 = r.data.users.find(u => u.username === 'admin');
  ok(ta1Row0 && ta1Row0.mustChangePwd === true && ta1Row0.tempPassword === undefined,
    '待改密账号列表也不返回 tempPassword（只显示一次）');
  ok(adminRow0 && adminRow0.mustChangePwd === false && adminRow0.tempPassword === undefined,
    '已改密账号不返回 tempPassword（admin 已在硬限制用例中改密）');
  ok(db.prepare('SELECT temp_password FROM users WHERE id = ?').get(ta1Id).temp_password === null,
    '创建后 temp_password 写库即 NULL（不再长期存明文）');

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
  r = await req('GET', '/api/state', null, taTokA);
  ok(r.status === 403 && r.data.msg === '请先修改初始密码', '待改密助教调 /api/state 被硬限制 403');

  /* ---- 修改密码 ---- */
  r = await req('POST', '/api/password', { oldPwd: 'bad', newPwd: 'ta654321' }, taTokA);
  ok(r.status === 401 && r.data.ok === false, '改密原密码错误 401');
  r = await req('POST', '/api/password', { oldPwd: 'ta123456', newPwd: 'ta654321' }, taTokA);
  ok(r.status === 200 && r.data.ok === true, '改密成功');

  r = await req('GET', '/api/users', null, adminTok);
  ok(r.data.users.find(u => u.id === ta1Id).tempPassword === undefined, '本人改密后 tempPassword 已清除且不再返回');

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
  ok(r.status === 200 && r.data.ok === true && r.data.tempPassword === 'ta123456', '教务重置助教密码成功（初始密码当次响应返回一次）');
  r = await req('GET', '/api/users', null, adminTok);
  ok(r.data.users.find(u => u.id === ta1Id).tempPassword === undefined, '重置后列表不返回 tempPassword');
  ok(db.prepare('SELECT temp_password FROM users WHERE id = ?').get(ta1Id).temp_password === null, '重置后 temp_password 写库即 NULL');
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

  /* ---- 账号删除（v1.8.1 NEW-01）：tombstone + 阻断式 + 事务重检 ---- */
  // 1) 无关联已停用助教：预览 → 确认账号错误 400 → 删除成功 → tombstone/用户名锁定/不可恢复
  r = await req('POST', '/api/users', { name: '删除甲', username: 'del1', password: 'del123456', role: 'ta' }, adminTok);
  const del1Id = r.data.user.id;
  r = await req('DELETE', '/api/users/' + del1Id, { confirmUsername: 'del1' }, adminTok);
  ok(r.status === 403, '未停用账号删除被拒（403）');
  r = await req('GET', '/api/users/' + del1Id + '/delete-impact', null, adminTok);
  ok(r.status === 200 && r.data.canDelete === false && r.data.reason.indexOf('停用') !== -1, '预览：未停用 canDelete=false 并给出原因');
  await req('POST', '/api/users/' + del1Id + '/toggle', {}, adminTok);  // 停用
  r = await req('GET', '/api/users/' + del1Id + '/delete-impact', null, adminTok);
  ok(r.status === 200 && r.data.canDelete === true && r.data.impact.activeStu === 0, '预览：无关联已停用账号 canDelete=true');
  r = await req('DELETE', '/api/users/' + del1Id, { confirmUsername: 'wrong' }, adminTok);
  ok(r.status === 400, '确认账号不匹配 400');
  r = await req('DELETE', '/api/users/' + del1Id, { confirmUsername: 'del1' }, adminTok);
  ok(r.status === 200 && r.data.ok === true, '教务删除无关联已停用账号成功');
  r = await req('DELETE', '/api/users/' + del1Id, { confirmUsername: 'del1' }, adminTok);
  ok(r.status === 404, '重复删除返回 404（无部分删除）');
  const tomb = db.prepare('SELECT * FROM deleted_users WHERE id = ?').get(del1Id);
  ok(tomb && tomb.username === 'del1' && tomb.name === '删除甲' && tomb.role === 'ta' && tomb.deleted_by && !('pass_hash' in tomb),
    'tombstone 登记身份与操作人（不含认证材料）');
  r = await req('GET', '/api/users', null, adminTok);
  ok(Array.isArray(r.data.deletedUsers) && r.data.deletedUsers.some(d => d.username === 'del1'), '账号列表接口带 tombstone 名单');
  r = await req('POST', '/api/users', { name: '复用', username: 'del1', password: 'abcdef', role: 'ta' }, adminTok);
  ok(r.status === 400 && r.data.msg.indexOf('永久不可复用') !== -1, '已注销用户名永久锁定（400）');
  r = await req('POST', '/api/login', { username: 'del1', password: 'del123456' });
  ok(r.status === 401, '删除后该账号不能登录');  // 限流计数 5
  r = await req('POST', '/api/users/' + del1Id + '/reset', { password: 'abcdef' }, adminTok);
  ok(r.status === 404, '删除后重置密码 404');
  r = await req('POST', '/api/users/' + del1Id + '/toggle', {}, adminTok);
  ok(r.status === 404, '删除后启用 404');
  ok(db.prepare("SELECT 1 FROM audit_logs WHERE action = '删除账号' AND target_desc LIKE '%del1%'").get() !== undefined, '删除写审计（含目标身份摘要）');

  // 2) 旧会话 401：del2 登录拿 token → 停用+删除 → token 访问 401
  r = await req('POST', '/api/users', { name: '删除乙', username: 'del2', password: 'del123456', role: 'sales' }, adminTok);
  const del2Id = r.data.user.id;
  r = await req('POST', '/api/login', { username: 'del2', password: 'del123456', role: 'sales' });
  const del2Tok = r.data.token;
  r = await req('GET', '/api/me', null, del2Tok);
  ok(r.status === 200, '删除前会话有效');
  await req('POST', '/api/users/' + del2Id + '/toggle', {}, adminTok);
  r = await req('DELETE', '/api/users/' + del2Id, { confirmUsername: 'del2' }, adminTok);
  ok(r.status === 200, '删除销售账号成功');
  r = await req('GET', '/api/me', null, del2Tok);
  ok(r.status === 401, '删除后旧会话访问业务接口 401');

  // 3) 硬规则：教务目标 403 / 当前账号 403 / 不存在 404
  r = await req('DELETE', '/api/users/u_admin2', { confirmUsername: 'admin2' }, adminTok);
  ok(r.status === 403, '教务账号删除被拒（403，服务端硬拒绝不只隐藏按钮）');
  r = await req('DELETE', '/api/users/' + adminId, { confirmUsername: 'admin' }, adminTok);
  ok(r.status === 403, '当前登录账号删除被拒（403）');
  r = await req('DELETE', '/api/users/u_nope', { confirmUsername: 'x' }, adminTok);
  ok(r.status === 404, '删除不存在账号 404');

  // 4) 阻断项全查：在服务/归档学生 + records/missed/files owner 引用 + pending 审批 → 409 分类计数
  r = await req('POST', '/api/users', { name: '删除丙', username: 'del3', password: 'del123456', role: 'ta' }, adminTok);
  const del3Id = r.data.user.id;
  const now3 = new Date().toISOString();
  db.prepare("INSERT INTO students (id, owner_id, name, archived, sample, created_at) VALUES ('del3-stu1', ?, '关联生', 0, 0, ?)").run(del3Id, now3);
  db.prepare("INSERT INTO students (id, owner_id, name, archived, sample, created_at) VALUES ('del3-stu2', ?, '归档生', 1, 0, ?)").run(del3Id, now3);
  db.prepare("INSERT INTO records (id, student_id, owner_id, date, total, correct) VALUES ('del3-rec1', 'del3-stu1', ?, '2026-10-01', 10, 9)").run(del3Id);
  db.prepare("INSERT INTO missed (id, student_id, owner_id, date) VALUES ('del3-mis1', 'del3-stu1', ?, '2026-10-01')").run(del3Id);
  db.prepare("INSERT INTO files (id, filename, mime, size, path, created_at, owner_id) VALUES ('del3-file1', 'a.png', 'image/png', 1, '/tmp/x', ?, ?)").run(now3, del3Id);
  db.prepare("INSERT INTO plan_requests (id, student_id, owner_id, subject, old_plan, new_plan, status, requested_by, requested_at) VALUES ('del3-pr1', 'del3-stu1', ?, '学科 / AP / 统计', 3, 5, 'pending', ?, '2026-10-01')").run(del3Id, del3Id);
  db.prepare("INSERT INTO unbind_requests (id, student_id, bind_id, owner_id, requested_by, requested_at, status) VALUES ('del3-ur1', 'del3-stu1', 'b1', ?, ?, '2026-10-01', 'pending')").run(del3Id, del3Id);
  await req('POST', '/api/users/' + del3Id + '/toggle', {}, adminTok);
  r = await req('GET', '/api/users/' + del3Id + '/delete-impact', null, adminTok);
  const im3 = r.data.impact;
  ok(r.data.canDelete === false && im3.activeStu === 1 && im3.archivedStu === 1 && im3.recCnt === 1
    && im3.missCnt === 1 && im3.fileCnt === 1 && im3.pendingPlanReq === 1 && im3.pendingUnbindReq === 1,
    '预览：七类阻断项分类计数正确');
  r = await req('DELETE', '/api/users/' + del3Id, { confirmUsername: 'del3' }, adminTok);
  ok(r.status === 409 && r.data.impact && r.data.impact.recCnt === 1, '有业务关联删除 409（携带分类数量）');
  ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(del3Id) !== undefined, '409 后账号仍在（未部分删除）');

  // 5) 竞态：预览 canDelete=true 后新产生关联 → 事务内重检拒绝
  r = await req('POST', '/api/users', { name: '删除丁', username: 'del4', password: 'del123456', role: 'ta' }, adminTok);
  const del4Id = r.data.user.id;
  await req('POST', '/api/users/' + del4Id + '/toggle', {}, adminTok);
  r = await req('GET', '/api/users/' + del4Id + '/delete-impact', null, adminTok);
  ok(r.data.canDelete === true, '竞态用例：预览时无关联');
  db.prepare("INSERT INTO students (id, owner_id, name, archived, sample, created_at) VALUES ('del4-stu1', ?, '事后关联', 0, 0, ?)").run(del4Id, new Date().toISOString());
  r = await req('DELETE', '/api/users/' + del4Id, { confirmUsername: 'del4' }, adminTok);
  ok(r.status === 409 && r.data.impact.activeStu === 1, '预览后新产生关联：事务内重检拒绝（409）');
  ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(del4Id) !== undefined, '竞态拒绝后账号仍在');

  // 6) 事务回滚：tombstone 写入失败（预置主键冲突）→ users 行不动、可重试
  db.prepare("INSERT INTO users (id, username, name, role, pass_hash, disabled, must_change_pwd, created_at) VALUES ('del5-id', 'del5', '删除戊', 'ta', 'x', 1, 0, ?)").run(new Date().toISOString());
  db.prepare("INSERT INTO deleted_users (id, username, name, role, deleted_at, deleted_by) VALUES ('del5-id', 'ghost5', '占位', 'ta', '2026-01-01', 'u_x')").run();
  r = await req('DELETE', '/api/users/del5-id', { confirmUsername: 'del5' }, adminTok);
  ok(r.status === 500 && r.data.msg.indexOf('回滚') !== -1, 'tombstone 写入冲突 → 整体回滚（500）');
  ok(db.prepare("SELECT 1 FROM users WHERE id = 'del5-id'").get() !== undefined, '回滚后 users 行仍在');
  db.prepare("DELETE FROM deleted_users WHERE id = 'del5-id'").run();  // 清理占位
  r = await req('DELETE', '/api/users/del5-id', { confirmUsername: 'del5' }, adminTok);
  ok(r.status === 200, '清理冲突后同账号可正常删除（重试成功）');

  // 7) 历史归属「已删除账号」回退：孤儿学生（owner 为已删账号）搜索显示回退文案
  db.prepare("INSERT INTO students (id, owner_id, name, archived, sample, created_at) VALUES ('orph-stu1', ?, '孤儿生', 0, 0, ?)").run(del1Id, new Date().toISOString());
  r = await req('GET', '/api/search/students?q=' + encodeURIComponent('孤儿生'), null, adminTok);
  ok(r.status === 200 && r.data.students[0].ownerName === '已删除账号', '历史数据归属显示「已删除账号」回退（不留 null）');
  db.prepare("DELETE FROM students WHERE id = 'orph-stu1'").run();

  /* ---- 限流：10 次失败/分钟/IP（本测试此前已消耗 5 次失败登录） ---- */
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
