/* M6 性能冒烟：20 助教 × 75 学生 = 1500 学生、每生 30 条记录 ≈ 4.5 万条 records + 4.5 千 missed + 1 万审计日志。
   计时断言（每项 3 次取中位数）。独立运行：npm run perf（不进 npm test 串跑） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立测试 DB（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-perf-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;

const db = require('../db');
const { app } = require('../index');
const bcrypt = require('bcryptjs');

const TA_CNT = 20, STU_PER_TA = 75, REC_PER_STU = 30, MISS_PER_STU = 3, AUDIT_CNT = 10000;

function seed(){
  const t0 = Date.now();
  const insUser = db.prepare(`INSERT INTO users (id, username, name, role, pass_hash, disabled, must_change_pwd, created_at)
                              VALUES (?,?,?,?,?,0,0,?)`);
  const insStu = db.prepare('INSERT INTO students (id, owner_id, name, school, grad_year, archived, sample, created_at) VALUES (?,?,?,?,?,0,0,?)');
  const insRec = db.prepare('INSERT INTO records (id, student_id, owner_id, date, total, correct, wrongs, subject, images, sample) VALUES (?,?,?,?,?,?,?,?,?,0)');
  const insMiss = db.prepare('INSERT INTO missed (id, student_id, owner_id, date, subject, resolved, resolution, resolved_at, sample) VALUES (?,?,?,?,?,?,?,?,0)');
  const insAudit = db.prepare('INSERT INTO audit_logs (id, ts, user_id, user_name, role, action, target_type, target_desc, detail, owner_id) VALUES (?,?,?,?,?,?,?,?,?,?)');
  const hash = bcrypt.hashSync('ta123456', 10);
  const now = new Date().toISOString();
  let seq = 0;
  const uid2 = p => p + (seq++).toString(36) + Date.now().toString(36).slice(-4);
  const taIds = [];
  db.transaction(() => {
    for(let t = 0; t < TA_CNT; t++){
      const taId = 'u_ta' + t;
      taIds.push(taId);
      insUser.run(taId, 'ta' + (t+1), '助教' + (t+1), 'ta', hash, now);
      for(let s = 0; s < STU_PER_TA; s++){
        const sid = 's_' + t + '_' + s;
        insStu.run(sid, taId, '学生' + (s+1) + '号(' + (t+1) + ')', '示例中学', '2027', now);
        for(let r = 0; r < REC_PER_STU; r++){
          insRec.run(uid2('r_'), sid, taId, '2026-08-' + String(1 + (r % 28)).padStart(2, '0'), 20, 10 + (r % 11), '[]', '学科 / AP / 微积分BC', '[]');
        }
        for(let m = 0; m < MISS_PER_STU; m++){
          insMiss.run(uid2('m_'), sid, taId, '2026-08-' + String(10 + m).padStart(2, '0'), '学科 / AP / 微积分BC', m % 2, m % 2 ? 'made-up' : null, m % 2 ? '2026-08-15' : null);
        }
      }
    }
    for(let a = 0; a < AUDIT_CNT; a++){
      const taId = taIds[a % TA_CNT];
      insAudit.run(uid2('log_'), '2026-08-27 10:' + String(a % 60).padStart(2, '0') + ':00',
        taId, '助教' + (a % TA_CNT + 1), 'ta', '录入作业', 'record', '学生X · AP·微积分BC', '总 20 对 15', taId);
    }
  })();
  console.log(`种子完成：${TA_CNT} 助教 × ${STU_PER_TA} 学生、每生 ${REC_PER_STU} 记录 + ${MISS_PER_STU} 未交、${AUDIT_CNT} 条审计（耗时 ${Date.now() - t0}ms）`);
  return taIds;
}

(async function main(){
  const taIds = seed();
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  async function req(method, p, body, token){
    const t0 = process.hrtime.bigint();
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    await res.arrayBuffer();  // 读完整响应
    return { status: res.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  }
  async function login(u, p, role){
    const r = await req('POST', '/api/login', { username: u, password: p, role });
    return r.status === 200 ? (await 0, JSON.parse(JSON.stringify(r))) : null;
  }
  const admin = await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' });
  const adminTok = admin.data ? admin.data.token : (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123', role: 'admin' }) })).json()).token;
  const taTok = (await (await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ta1', password: 'ta123456', role: 'ta' }) })).json()).token;

  // 每项跑 3 次取中位数
  async function bench(name, fn, threshold){
    const times = [];
    for(let i = 0; i < 3; i++) times.push((await fn()).ms);
    times.sort((a, b) => a - b);
    const median = times[1];
    const okPass = median < threshold;
    console.log(`${okPass ? 'PASS' : 'FAIL'}  ${name}：${median.toFixed(0)}ms（阈值 <${threshold}ms；3 次：${times.map(t => t.toFixed(0)).join('/ ')}）`);
    return okPass;
  }

  let fail = 0;
  console.log('\n---- 性能实测 ----');
  if(!await bench('GET /api/state（教务全量 1500 学生/4.5 万记录）', () => req('GET', '/api/state', null, adminTok), 1000)) fail++;
  if(!await bench('GET /api/state（助教 75 学生）', () => req('GET', '/api/state', null, taTok), 300)) fail++;
  if(!await bench('GET /api/search/students?q=林', () => req('GET', '/api/search/students?q=' + encodeURIComponent('林'), null, adminTok), 300)) fail++;
  if(!await bench('GET /api/audit-logs?page=1', () => req('GET', '/api/audit-logs?page=1&pageSize=50', null, adminTok), 300)) fail++;
  const sid0 = 's_0_0';
  if(!await bench('POST /api/records 单条写入', () => req('POST', '/api/records',
    { studentId: sid0, date: '2026-08-28', total: 20, correct: 18, wrongs: [7, 14], subject: '学科 / AP / 微积分BC' }, taTok), 100)) fail++;

  console.log('\n结果：' + (fail ? fail + ' 项超阈值 FAIL' : '全部达标 PASS'));
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('性能测试异常：', e); process.exit(1); });
