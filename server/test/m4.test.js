/* M4 附件上传测试：零额外依赖（node 内置 fetch + FormData/Blob + assert 思路沿用 m2/m3）。
   独立测试库（DB_PATH 临时文件）+ 随机端口起服务。运行：node test/m4.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// 独立测试 DB（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-m4-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;

const { app } = require('../index');
const db = require('../db');

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}
// 记录测试产生的磁盘文件，结束时清理
const uploadedPaths = [];
function trackFile(fid){
  const f = db.prepare('SELECT path FROM files WHERE id = ?').get(fid);
  if(f) uploadedPaths.push(f.path);
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
  // multipart 上传（不能手动设 Content-Type，fetch 会自动带 boundary）
  async function upload(files, token, extra){
    const fd = new FormData();
    files.forEach(f => fd.append('files', new Blob([f.data], { type: f.mime }), f.name));
    if(extra) Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
    const res = await fetch(base + '/api/files', {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : {},
      body: fd
    });
    let data = null;
    try{ data = await res.json(); }catch(e){}
    return { status: res.status, data };
  }
  // 带真实魔数的假文件（服务端做魔数嗅探）
  const pngBytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(1016, 7)]);   // 1KB 假 PNG
  const pdfBytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2038, 8)]);                                        // 2KB 假 PDF
  const bigPng = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(Math.ceil(2.1 * 1024 * 1024) - 8, 1)]);

  /* ---- 账号准备 ---- */
  let r = await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' });
  const adminTok = r.data.token;
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '李助教', username: 'ta2', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '张顾问', username: 'sales1', password: 'sales123456', role: 'sales' }, adminTok);
  const T1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data.token;
  const T2 = (await req('POST', '/api/login', { username: 'ta2', password: 'ta123456', role: 'ta' })).data.token;
  const TS = (await req('POST', '/api/login', { username: 'sales1', password: 'sales123456', role: 'sales' })).data.token;
  r = await req('POST', '/api/students', { name: '林小满', school: '深外', gradYear: '2027' }, T1);
  const stuA = r.data.student.id;

  /* ---- 上传 ---- */
  r = await upload([{ data: pngBytes, mime: 'image/png', name: '批改图.png' }], T1);
  ok(r.status === 200 && r.data.ok && r.data.files.length === 1 && r.data.files[0].id, '图片上传成功返回文件 id');
  const imgId = r.data.files[0].id;
  trackFile(imgId);
  let frow = db.prepare('SELECT * FROM files WHERE id = ?').get(imgId);
  ok(frow && frow.mime === 'image/png' && fs.existsSync(frow.path) && path.basename(frow.path) === imgId + '.png',
    'files 表落行 + 磁盘文件名 = id + 安全扩展名');

  r = await upload([{ data: pdfBytes, mime: 'application/pdf', name: '试卷.pdf' }], T1);
  ok(r.status === 200 && r.data.files[0].id, 'PDF 上传成功');
  const pdfId = r.data.files[0].id;
  trackFile(pdfId);

  r = await upload([{ data: bigPng, mime: 'image/png', name: 'big.png' }], T1);
  ok(r.status === 413 && r.data.ok === false, '超限图片（>2MB）被拒 413');

  r = await upload([{ data: new Uint8Array(100), mime: 'text/plain', name: 'a.txt' }], T1);
  ok(r.status === 400 && r.data.ok === false, '错误类型（.txt）被拒 400');

  r = await upload([{ data: pdfBytes, mime: 'image/png', name: 'fake.png' }], T1);
  ok(r.status === 400 && r.data.ok === false, '魔数不符（PDF 内容声明 image/png）被拒 400');

  r = await upload(Array.from({ length: 10 }, (_, i) => ({ data: pngBytes, mime: 'image/png', name: 'f' + i + '.png' })), T1);
  ok(r.status === 400 && r.data.ok === false, '单次 10 个文件被拒（最多 9 个）');

  r = await upload([{ data: pngBytes, mime: 'image/png', name: 'x.png' }], null);
  ok(r.status === 401, '未登录上传 401');

  r = await upload([{ data: pngBytes, mime: 'image/png', name: 'x.png' }], TS);
  ok(r.status === 403, '销售不能上传');

  /* ---- 鉴权读取 ---- */
  let res2 = await fetch(base + '/api/files/' + imgId);
  ok(res2.status === 401, '未登录读取 401');
  res2 = await fetch(base + '/api/files/' + imgId, { headers: { Authorization: 'Bearer ' + T2 } });
  ok(res2.status === 403, '助教 B 不能读助教 A 的文件');
  res2 = await fetch(base + '/api/files/' + imgId, { headers: { Authorization: 'Bearer ' + adminTok } });
  ok(res2.status === 200, '教务可读任意文件');
  res2 = await fetch(base + '/api/files/' + imgId, { headers: { Authorization: 'Bearer ' + T1 } });
  const buf = Buffer.from(await res2.arrayBuffer());
  ok(res2.status === 200 && res2.headers.get('content-type') === 'image/png' && buf.length === pngBytes.length
    && decodeURIComponent(res2.headers.get('content-disposition')).includes('批改图.png'),
    'owner 本人读取成功（mime/内容/中文文件名正确）');
  // ?token= 查询参数读取（<img>/PDF 直接引用场景）
  res2 = await fetch(base + '/api/files/' + imgId + '?token=' + encodeURIComponent(T1));
  ok(res2.status === 200, '?token= 查询参数可读取附件（img/PDF 直接引用）');
  res2 = await fetch(base + '/api/files/' + imgId + '?token=bad-token');
  ok(res2.status === 401, '?token= 无效时 401');

  /* ---- 记录绑定附件 ---- */
  r = await req('POST', '/api/records', { studentId: stuA, date: '2026-08-28', total: 20, correct: 18, wrongs: [7], subject: '学科 / AP / 微积分BC', images: [imgId], pdfs: [pdfId] }, T1);
  ok(r.status === 200 && r.data.record.images[0] === imgId && r.data.record.pdfs[0] === pdfId, '记录保存 images/pdfs 为文件 id 数组');
  const recA = r.data.record.id;
  frow = db.prepare('SELECT record_id FROM files WHERE id = ?').get(imgId);
  ok(frow.record_id === recA, '保存记录后附件 record_id 已绑定');
  // state 接口回读
  r = await req('GET', '/api/state', null, T1);
  const recInState = r.data.state.records.find(x => x.id === recA);
  ok(recInState && recInState.images[0] === imgId && recInState.pdfs[0] === pdfId, 'GET /api/state 中记录含附件 id 数组');
  // 越权绑定他人附件
  r = await req('POST', '/api/records', { studentId: stuA, date: '2026-08-28', total: 10, correct: 9, wrongs: [], subject: 'x', images: [imgId] }, T2);
  ok(r.status === 403, '助教 B 不能用助教 A 的附件建记录（学生也不归他）');
  // 直接挂 recordId 上传
  r = await upload([{ data: pngBytes, mime: 'image/png', name: '补图.png' }], T1, { recordId: recA });
  ok(r.status === 200, '带 recordId 上传成功');
  const img2 = r.data.files[0].id;
  trackFile(img2);
  const recRow = db.prepare('SELECT images FROM records WHERE id = ?').get(recA);
  ok(JSON.parse(recRow.images).includes(img2), '带 recordId 上传后自动并入记录 images');
  // 删除记录连带删附件
  r = await req('DELETE', '/api/records/' + recA, null, T1);
  ok(r.status === 200, '删除记录成功');
  ok(!db.prepare('SELECT 1 FROM files WHERE record_id = ?').get(recA), '删除记录后附件库行连带删除');
  const p1 = db.prepare('SELECT path FROM files WHERE id = ?').get(imgId);
  ok(!p1, '附件库行已删');
  ok(!fs.existsSync(path.join(__dirname, '..', 'uploads', imgId + '.png')), '删除记录后磁盘文件连带删除');

  /* ---- 删除附件（用独立的未绑定文件，避免被记录级联先行删除） ---- */
  r = await upload([{ data: pdfBytes, mime: 'application/pdf', name: '待删.pdf' }], T1);
  const delId = r.data.files[0].id;
  trackFile(delId);
  r = await req('DELETE', '/api/files/' + delId, null, T2);
  ok(r.status === 403, '助教 B 不能删助教 A 的附件');
  r = await req('DELETE', '/api/files/' + delId, null, T1);
  ok(r.status === 200, 'owner 本人可删附件');
  ok(!fs.existsSync(path.join(__dirname, '..', 'uploads', delId + '.pdf')), '删除后磁盘文件已删');
  const logRow = db.prepare("SELECT * FROM audit_logs WHERE action = '删除附件'").get();
  ok(!!logRow, '删除附件写审计日志');
  // 教务可删任意附件
  r = await upload([{ data: pngBytes, mime: 'image/png', name: '教务删.png' }], T2);
  const delId2 = r.data.files[0].id;
  trackFile(delId2);
  r = await req('DELETE', '/api/files/' + delId2, null, adminTok);
  ok(r.status === 200, '教务可删任意附件');

  console.log('\nM4 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  // 清理测试产物
  uploadedPaths.forEach(p => { try{ fs.unlinkSync(p); }catch(e){} });
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
