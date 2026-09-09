/* M7 家长报告分享测试：share_tokens + /api/reports/share + 公开页 /r/:token（零额外依赖）。
   独立测试库（DB_PATH 指向临时文件）+ 随机端口起服务。运行：node test/m7.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立测试 DB（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-m7-test-' + Date.now() + '.db');
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
  async function getText(p, token){
    const res = await fetch(base + p, token ? { headers: { Authorization: 'Bearer ' + token } } : {});
    return { status: res.status, text: await res.text() };
  }

  /* ---- 账号与学生数据准备 ---- */
  const adminTok = (await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' })).data.token;
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '李助教', username: 'ta2', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '张顾问', username: 'sales1', password: 'sales123456', role: 'sales' }, adminTok);
  const T1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data.token;
  const T2 = (await req('POST', '/api/login', { username: 'ta2', password: 'ta123456', role: 'ta' })).data.token;
  const TS = (await req('POST', '/api/login', { username: 'sales1', password: 'sales123456', role: 'sales' })).data.token;

  let r = await req('POST', '/api/students', { name: '林小满', school: '深外', gradYear: '2027' }, T1);
  const stuA = r.data.student.id;  // ta1 名下
  // 直接写库准备报告数据（科目计划/评语/建议/模考 + 2 条作业记录）
  const subj = '学科 / AP / 微积分BC';
  db.prepare('UPDATE students SET subj_plans = ?, subj_comments = ?, subj_advice = ?, mock = ? WHERE id = ?')
    .run(JSON.stringify({ [subj]: 4 }), JSON.stringify({ [subj]: '最近进步明显' }),
      JSON.stringify({ [subj]: '每周复盘错题' }), JSON.stringify({ [subj]: { date: '2026-09-20', score: 92 } }), stuA);
  const nowIso = new Date().toISOString();
  db.prepare("INSERT INTO records (id, student_id, owner_id, date, total, correct, wrongs, subject) VALUES ('m7_r1', ?, (SELECT owner_id FROM students WHERE id = ?), '2026-09-08', 20, 18, '[7,14]', ?)")
    .run(stuA, stuA, subj);
  db.prepare("INSERT INTO records (id, student_id, owner_id, date, total, correct, wrongs, subject) VALUES ('m7_r2', ?, (SELECT owner_id FROM students WHERE id = ?), '2026-09-09', 20, 12, '[3,5]', ?)")
    .run(stuA, stuA, subj);

  /* ---- 生成分享链接 ---- */
  r = await req('POST', '/api/reports/share', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200 && r.data.ok && /^\/r\/[0-9a-f]{32}$/.test(r.data.url), '生成分享链接返回 /r/<32位hex> 相对路径');
  const url = r.data.url;
  r = await req('POST', '/api/reports/share', { studentId: stuA, subject: subj }, T1);
  ok(r.data.ok && r.data.url === url && r.data.reused === true, '同学生同科目复用未过期链接');
  r = await req('POST', '/api/reports/share', { studentId: stuA }, T1);
  ok(r.status === 400, '缺科目参数 400');
  r = await req('POST', '/api/reports/share', { studentId: 'no-such', subject: subj }, T1);
  ok(r.status === 404, '学生不存在 404');
  r = await req('POST', '/api/reports/share', { studentId: stuA, subject: subj });
  ok(r.status === 401, '未登录不能生成分享链接');

  /* ---- 权限：跨助教 403 / 销售 403 ---- */
  r = await req('POST', '/api/reports/share', { studentId: stuA, subject: subj }, T2);
  ok(r.status === 403 && r.data.ok === false, '助教不能分享他人学生的报告（403）');
  r = await req('POST', '/api/reports/share', { studentId: stuA, subject: subj }, TS);
  ok(r.status === 403, '销售无分享接口权限（403）');

  /* ---- 公开报告页（免登录） ---- */
  let pg = await getText(url);
  ok(pg.status === 200 && pg.text.indexOf('作业打卡报告') !== -1, '公开页免登录可访问');
  ok(pg.text.indexOf('林小满') !== -1 && pg.text.indexOf('AP·微积分BC') !== -1 && pg.text.indexOf('深外') !== -1,
    '报告页含学生/科目短名/学校');
  ok(pg.text.indexOf('90%') !== -1 && pg.text.indexOf('2026-09-08') !== -1 && pg.text.indexOf('7、14') !== -1,
    '报告页含打卡记录（正确率/日期/错题号）');
  ok(pg.text.indexOf('最近进步明显') !== -1 && pg.text.indexOf('每周复盘错题') !== -1 && pg.text.indexOf('92 分') !== -1,
    '报告页含评语/建议/模考分数');
  ok(pg.text.indexOf('本报告由「火箭学院 · 学情跟踪平台」自动生成') !== -1, '报告页落款为新品牌');
  ok(pg.text.indexOf('<script') === -1, '报告页零 JS（CSP 最安全形态）');
  // 不泄露其他数据：页面不含任何接口/其他学生线索
  ok(pg.text.indexOf('/api/') === -1, '报告页不含任何 API 路径');

  /* ---- 审计日志 ---- */
  const logRows = db.prepare("SELECT * FROM audit_logs WHERE target_type = 'student' AND (action = '生成分享链接' OR action = '访问分享报告')").all();
  ok(logRows.some(l => l.action === '生成分享链接'), '生成链接写审计日志');
  ok(logRows.some(l => l.action === '访问分享报告'), '公开页访问写审计日志');

  /* ---- 撤销 ---- */
  r = await req('POST', '/api/reports/share/' + url.slice(3) + '/revoke', {}, T2);
  ok(r.status === 403, '非创建者助教不能撤销（403）');
  r = await req('POST', '/api/reports/share/' + url.slice(3) + '/revoke', {}, adminTok);
  ok(r.status === 200 && r.data.ok === true, '教务可撤销任意链接');
  pg = await getText(url);
  ok(pg.status === 410 && pg.text.indexOf('链接已失效') !== -1, '撤销后公开页 410 + 失效提示页');
  r = await req('POST', '/api/reports/share', { studentId: stuA, subject: subj }, T1);
  ok(r.data.ok && r.data.url !== url, '撤销后重新生成获得新 token');

  /* ---- 过期失效 ---- */
  const url2 = r.data.url;
  db.prepare('UPDATE share_tokens SET expires_at = ? WHERE token = ?')
    .run(new Date(Date.now() - 86400000).toISOString(), url2.slice(3));  // 改成昨天过期
  pg = await getText(url2);
  ok(pg.status === 410 && pg.text.indexOf('链接已失效') !== -1, '过期链接 410 + 失效提示页');

  /* ---- 未知 token ---- */
  pg = await getText('/r/' + '0'.repeat(32));
  ok(pg.status === 404 && pg.text.indexOf('链接已失效') !== -1, '未知 token 404 + 失效提示页');

  console.log('\nM7 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
