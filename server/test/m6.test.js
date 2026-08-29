/* M6 安全加固测试：静态白名单 / 魔数嗅探 / 销售只读角色写接口 403 矩阵。
   零额外依赖（node 内置 fetch + FormData/Blob）。运行：node test/m6.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立测试 DB（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-m6-test-' + Date.now() + '.db');
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

  /* ---- 静态目录白名单 ---- */
  let r = await fetch(base + '/index.html');
  ok(r.status === 200 && (await r.text()).includes('学情跟踪平台'), '白名单：/index.html 200 且为前端页面');
  r = await fetch(base + '/' + encodeURIComponent('学生作业正确率.html'));
  ok(r.status === 200 && (await r.text()).includes('学情跟踪平台'), '白名单：中文文件名入口 200');
  r = await fetch(base + '/');
  ok(r.status === 200, '白名单：/ 根路径 200');
  r = await fetch(base + '/docs/backend-plan.md');
  ok(r.status === 404, '白名单：/docs/* 404');
  r = await fetch(base + '/test/smoke.js');
  ok(r.status === 404, '白名单：/test/* 404');
  r = await fetch(base + '/server/db.js');
  ok(r.status === 404, '白名单：/server/* 404');
  r = await fetch(base + '/.gitignore');
  ok(r.status === 404, '白名单：/.gitignore 404');
  r = await fetch(base + '/%2e%2e/server/db.js');
  ok(r.status === 404 || r.status === 400, '白名单：路径穿越（%2e%2e）被拦');

  /* ---- 账号准备 ---- */
  let lr = await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' });
  const adminTok = lr.data.token;
  await req('POST', '/api/users', { name: '张顾问', username: 'sales1', password: 'sales123456', role: 'sales' }, adminTok);
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  const TS = (await req('POST', '/api/login', { username: 'sales1', password: 'sales123456', role: 'sales' })).data.token;
  const T1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data.token;
  const stu = (await req('POST', '/api/students', { name: '林小满', school: '深外', gradYear: '2027' }, T1)).data.student;

  /* ---- 销售写接口 403 矩阵（每路由挑代表） ---- */
  lr = await req('POST', '/api/students', { name: 'x', gradYear: '2027' }, TS);
  ok(lr.status === 403, '矩阵：销售 POST /api/students 403');
  lr = await req('POST', '/api/records', { studentId: stu.id, date: '2026-08-28', total: 10, correct: 9, wrongs: [], subject: 'x' }, TS);
  ok(lr.status === 403, '矩阵：销售 POST /api/records 403');
  lr = await req('POST', '/api/missed', { studentId: stu.id, date: '2026-08-28', subject: 'x' }, TS);
  ok(lr.status === 403, '矩阵：销售 POST /api/missed 403');
  lr = await req('POST', '/api/plan/set', { studentId: stu.id, subject: 'x', plan: 5 }, TS);
  ok(lr.status === 403, '矩阵：销售 POST /api/plan/set 403');
  lr = await req('POST', '/api/plan-requests', { studentId: stu.id, subject: 'x', newPlan: 5 }, TS);
  ok(lr.status === 403, '矩阵：销售 POST /api/plan-requests 403');
  lr = await req('PUT', '/api/students/' + stu.id + '/subj-fields', { subjComments: { x: 'y' } }, TS);
  ok(lr.status === 403, '矩阵：销售 PUT subj-fields 403');

  /* ---- 附件魔数嗅探 ---- */
  async function upload(buf, mime, name, token){
    const fd = new FormData();
    fd.append('files', new Blob([buf], { type: mime }), name);
    const res = await fetch(base + '/api/files', { method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
    let data = null;
    try{ data = await res.json(); }catch(e){}
    return { status: res.status, data };
  }
  const pngHead = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const pdfHead = Buffer.from('%PDF-1.4\n');
  let up = await upload(Buffer.concat([pngHead, Buffer.alloc(100, 1)]), 'image/png', 'ok.png', T1);
  ok(up.status === 200, '魔数：真 PNG 头 + image/png 通过');
  const okFileId = up.data.files[0].id;
  up = await upload(Buffer.concat([pdfHead, Buffer.alloc(100, 2)]), 'image/png', 'fake.png', T1);
  ok(up.status === 400 && up.data.ok === false, '魔数：PDF 内容声明 image/png 被拒 400');
  up = await upload(Buffer.alloc(200, 0x41), 'application/pdf', 'fake.pdf', T1);
  ok(up.status === 400 && up.data.ok === false, '魔数：非 %PDF 内容声明 PDF 被拒 400');
  up = await upload(Buffer.concat([pngHead, Buffer.alloc(100, 1)]), 'application/pdf', 'fake2.pdf', T1);
  ok(up.status === 400 && up.data.ok === false, '魔数：PNG 内容声明 PDF 被拒 400');
  // 销售上传（兼有魔数真文件）也必须是 403 而非 400/200
  up = await upload(Buffer.concat([pngHead, Buffer.alloc(100, 1)]), 'image/png', 's.png', TS);
  ok(up.status === 403, '矩阵：销售上传附件 403');
  // 清理 ok 附件
  await req('DELETE', '/api/files/' + okFileId, null, T1);

  /* ---- SQL 注入冒烟（参数化复查：异常关键字不报错、无数据泄露） ---- */
  lr = await req('GET', "/api/search/students?q=" + encodeURIComponent("林' OR '1'='1"), null, TS);
  ok(lr.status === 200 && lr.data.students.length === 0, "SQL 注入冒烟：LIKE 关键字注入无效果（参数化）");

  console.log('\nM6 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
