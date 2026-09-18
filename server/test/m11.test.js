/* M11 推送落地页分类渲染 + 空字段隐藏 + 推送频率限制测试（零额外依赖）。
   假配置值；微信 API 用全局 fetch 桩；独立测试库 + 随机端口。运行：node test/m11.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB = path.join(os.tmpdir(), 'xq-m11-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;
process.env.WECHAT_APPID = 'test-appid';
process.env.WECHAT_SECRET = 'test-secret-fake';
process.env.WECHAT_TOKEN = 'test-token-fake';
process.env.WECHAT_TEMPLATE_HOMEWORK = 'tmpl-homework';
process.env.WECHAT_TEMPLATE_MOCKBOOK = 'tmpl-mockbook';
process.env.WECHAT_TEMPLATE_MOCKSCORE = 'tmpl-mockscore';

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if(u.indexOf('api.weixin.qq.com') !== -1){
    if(u.indexOf('/cgi-bin/token') !== -1) return Promise.resolve({ json: async () => ({ access_token: 'fake-at', expires_in: 7200 }) });
    if(u.indexOf('template/send') !== -1) return Promise.resolve({ json: async () => ({ errcode: 0, errmsg: 'ok' }) });
  }
  return realFetch(url, opts);
};

const { app } = require('../index');
const db = require('../db');
const push = require('../push');

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
  async function getText(p){
    const res = await realFetch(base + p);
    return { status: res.status, text: await res.text() };
  }
  const shareTokenOf = (stuId, subject, kind) =>
    db.prepare("SELECT token FROM share_tokens WHERE student_id = ? AND subject = ? AND IFNULL(kind,'homework') = ?").get(stuId, subject, kind).token;

  /* ---- 账号与学生数据 ---- */
  const adminTok = (await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' })).data.token;
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  const T1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data.token;
  const subj = '学科 / AP / 微积分BC';
  const subj2 = '竞赛 / AMC10';
  // 数据全的学生（评语/建议/双科目模考/作业记录）
  const stuA = (await req('POST', '/api/students', { name: '林小满', gradYear: '2027' }, T1)).data.student.id;
  db.prepare('UPDATE students SET subj_comments = ?, subj_advice = ?, mock = ? WHERE id = ?')
    .run(JSON.stringify({ [subj]: '进步明显' }), JSON.stringify({ [subj]: '每周复盘' }),
      JSON.stringify({ [subj]: { date: '2026-09-25', score: 92 }, [subj2]: { date: '2026-09-01', score: 78 } }), stuA);
  await req('POST', '/api/records', { studentId: stuA, date: '2026-09-15', total: 20, correct: 18, wrongs: [7, 14], subject: subj }, T1);
  // 空数据学生（无评语/无建议/无模考/无记录）
  const stuB = (await req('POST', '/api/students', { name: '陈星宇', gradYear: '2027' }, T1)).data.student.id;
  db.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
    .run('b1', stuA, 'openid_a', new Date().toISOString());
  db.prepare('INSERT INTO parent_binds (id, student_id, openid, bound_at, unbound) VALUES (?,?,?,?,0)')
    .run('b2', stuB, 'openid_b', new Date().toISOString());  // stuB 也要能推送（空字段隐藏用例）

  /* ---- kind 写入与落地页分类渲染 ---- */
  push._resetRateLimit();
  let r = await req('POST', '/api/push/mock-book', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200, '手动推送报名通知成功');
  ok(db.prepare("SELECT IFNULL(kind,'homework') AS k FROM share_tokens WHERE token = ?").get(shareTokenOf(stuA, subj, 'mockbook')).k === 'mockbook',
    '报名推送生成的分享链接 kind=mockbook');
  let pg = await getText('/r/' + shareTokenOf(stuA, subj, 'mockbook'));
  ok(pg.status === 200 && pg.text.indexOf('模考预约提醒') !== -1 && pg.text.indexOf('2026-09-25') !== -1,
    '报名落地页：预约时间大卡渲染');
  ok(pg.text.indexOf('备考提示') !== -1 && pg.text.indexOf('近期作业表现') !== -1 && pg.text.indexOf('90%') !== -1,
    '报名落地页：备考提示 + 近期作业摘要（有记录时）');
  ok(pg.text.indexOf('作业打卡报告') === -1, '报名落地页不渲染作业报告版式');

  r = await req('POST', '/api/push/mock-score', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200, '手动推送成绩通知成功');
  pg = await getText('/r/' + shareTokenOf(stuA, subj, 'mockscore'));
  ok(pg.text.indexOf('模考成绩通知') !== -1 && pg.text.indexOf('92 分') !== -1 && pg.text.indexOf('模考日期 2026-09-25') !== -1,
    '成绩落地页：分数大卡渲染（含日期）');
  ok(pg.text.indexOf('其他科目模考成绩') !== -1 && pg.text.indexOf('78 分') !== -1 && pg.text.indexOf('AMC10') !== -1,
    '成绩落地页：其他科目模考对比（有则显示）');

  /* ---- 空字段隐藏（作业成绩落地页） ---- */
  r = await req('POST', '/api/reports/share', { studentId: stuB, subject: subj }, T1);
  ok(r.status === 200, '空数据学生分享链接生成成功');
  pg = await getText(r.data.url);
  ok(pg.text.indexOf('作业打卡报告') !== -1, '空数据学生作业页仍含基础结构');
  ok(pg.text.indexOf('老师评语') === -1 && pg.text.indexOf('学习计划与建议') === -1 && pg.text.indexOf('模考信息') === -1,
    '空字段隐藏：无评语/无建议/无模考则对应区块标题不出现');
  // 报名落地页：无作业记录时摘要区块隐藏
  db.prepare('UPDATE students SET mock = ? WHERE id = ?').run(JSON.stringify({ [subj]: { date: '2026-10-01' } }), stuB);
  push._resetRateLimit();
  r = await req('POST', '/api/push/mock-book', { studentId: stuB, subject: subj }, T1);
  ok(r.status === 200, '空数据学生报名推送成功');
  pg = await getText('/r/' + shareTokenOf(stuB, subj, 'mockbook'));
  ok(pg.text.indexOf('模考预约提醒') !== -1 && pg.text.indexOf('近期作业表现') === -1,
    '空字段隐藏：无作业记录时报名页不显示「近期作业表现」区块');
  // 成绩落地页：无其他科目模考时对比区块隐藏
  db.prepare('UPDATE students SET mock = ? WHERE id = ?').run(JSON.stringify({ [subj]: { date: '2026-10-01', score: 85 } }), stuB);
  push._resetRateLimit();
  await req('POST', '/api/push/mock-score', { studentId: stuB, subject: subj }, T1);
  pg = await getText('/r/' + shareTokenOf(stuB, subj, 'mockscore'));
  ok(pg.text.indexOf('85 分') !== -1 && pg.text.indexOf('其他科目模考成绩') === -1,
    '空字段隐藏：无其他科目模考时对比区块不出现');

  /* ---- 频率限制：窗口内 3 次通过、第 4 次丢弃/提示、滑动后恢复 ---- */
  push._resetRateLimit();
  await req('PUT', '/api/push-config', { config: { homework: true } }, adminTok);
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, T1);  // 1
  ok(r.status === 200, '限流窗口内第 1 次推送通过');
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, T1);  // 2
  ok(r.status === 200, '限流窗口内第 2 次推送通过');
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, T1);  // 3
  ok(r.status === 200, '限流窗口内第 3 次推送通过');
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, T1);  // 4
  ok(r.status === 429 && r.data.msg.indexOf('频率已达上限') !== -1, '第 4 次手动推送被限流（429 + 明确提示）');
  // 自动推送超限：静默丢弃 + 审计「限流丢弃」
  const dropBefore = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = '限流丢弃'").get().c;
  r = await req('POST', '/api/records', { studentId: stuA, date: '2026-09-16', total: 10, correct: 9, wrongs: [], subject: subj }, T1);
  ok(r.status === 200 && r.data.pushed === false, '自动推送超限静默丢弃（pushed:false，保存不受影响）');
  ok(db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = '限流丢弃'").get().c === dropBefore + 1, '限流丢弃写审计日志');
  // 窗口滑动后恢复（把窗口内记录全部拨到 10 分钟前）
  push._rateHits.homework.forEach((h, i) => { push._rateHits.homework[i] = Date.now() - 11 * 60 * 1000; });
  r = await req('POST', '/api/push/homework', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200 && r.data.ok, '窗口滑动后推送恢复');

  console.log('\nM11 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
