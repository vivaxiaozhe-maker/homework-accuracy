/* M5a 端到端测试：DOM 桩加载前端脚本 + 真实后端（同进程随机端口 + 临时库），强制走 API 模式。
   运行：node test/e2e.api.js */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

/* ---------- 启动真实后端（独立测试库 + 随机端口） ---------- */
const TEST_DB = path.join(os.tmpdir(), 'xq-m5a-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;
const { app } = require('../server/index');

/* ---------- 最小 DOM 桩（与 test/smoke.js 相同） ---------- */
function makeEl(id){
  return {
    id: id, value: '', textContent: '', innerHTML: '', disabled: false,
    style: {}, dataset: {}, files: [], onclick: null, placeholder: '',
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
    clear: () => m.clear(),
    _map: m
  };
}
const alerts = [];
const windowStub = { scrollTo(){}, print(){} };

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}

(async function main(){
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  // 前端脚本里的 fetch 指向真实服务（相对路径补 origin）
  const apiFetch = (url, opts) => fetch(url.startsWith('http') ? url : base + url, opts);

  const ctx = vm.createContext({
    document: documentStub,
    window: windowStub,
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    fetch: apiFetch,
    AbortController: globalThis.AbortController,
    TextEncoder: globalThis.TextEncoder,
    alert: msg => alerts.push(String(msg)),
    console, setTimeout, clearTimeout,
    Blob: function(){},
    URL: { createObjectURL(){ return 'blob:x'; }, revokeObjectURL(){} },
    FileReader: function(){}
  });
  const sessionStore = ctx.sessionStorage;  // vm context 内同一引用

  const html = fs.readFileSync(path.join(__dirname, '..', '学生作业正确率.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  vm.runInContext(m[1], ctx, { filename: 'inline-script.js' });
  await windowStub.__ready;
  const wb = windowStub.__wb;

  /* ---- 模式探测 ---- */
  ok(wb.USE_API === true, '探测到 /api/health → 进入 API 模式');
  ok(documentStub.getElementById('login-demo').style.display === 'none', 'API 模式隐藏演示账号提示');
  ok(documentStub.getElementById('login-screen').style.display === 'flex', '未登录显示登录页');

  /* ---- 登录 ---- */
  await wb.doLogin('admin', 'wrong-pwd', 'admin');
  ok(!wb.currentUser && documentStub.getElementById('login-err').textContent.length > 0, '错误密码登录失败（错误提示）');
  await wb.doLogin('admin', 'admin123', 'admin');
  ok(wb.currentUser && wb.currentUser.username === 'admin' && wb.currentUser.role === 'admin', 'admin 登录成功');
  ok(!!wb.HttpApi._token, '登录后持有 token');
  ok(JSON.parse(sessionStore.getItem('wb_ha_v2_session')).token === wb.HttpApi._token, 'token 已存 sessionStorage');
  ok(wb.pool && Array.isArray(wb.pool.students), '登录后拉取 state 填充 pool');
  ok(documentStub.getElementById('pwd-modal').classList.contains('show'), 'admin 首登强制改密弹窗出现');
  await wb.doChangePwd('admin123', 'admin456', 'admin456');
  ok(documentStub.getElementById('login-screen').style.display === 'none'
    && documentStub.getElementById('app').style.display === 'flex', '改密后进入主界面');

  /* ---- 会话恢复（刷新场景） ---- */
  const u2 = await wb.HttpApi.restoreSession();
  ok(u2 && u2.username === 'admin', 'GET /api/me 校验 token 恢复会话');
  sessionStore.setItem('wb_ha_v2_session', JSON.stringify({ uid: 'x', token: 'bad-token', ts: 1 }));
  const u3 = await wb.HttpApi.restoreSession();
  ok(u3 === null, '无效 token 恢复会话返回 null');
  ok(documentStub.getElementById('login-screen').style.display === 'flex', '401 后强制回登录页');
  // 恢复有效会话供后续步骤
  sessionStore.setItem('wb_ha_v2_session', JSON.stringify({ uid: 'x', token: wb.HttpApi._token, ts: 1 }));

  /* ---- 账号管理经 API ---- */
  await wb.doLogin('admin', 'admin456', 'admin');
  const made = await wb.Api.createUser('王助教', 'ta1', 'ta123456', 'ta');
  ok(made.ok && made.user.role === 'ta', 'API 模式创建助教账号（经后端）');
  const dup = await wb.Api.createUser('王助教', 'ta1', 'ta123456', 'ta');
  ok(!dup.ok && dup.msg.indexOf('已存在') !== -1, 'API 模式重复账号被拒');
  // 教务直接在服务端给 ta1/ta2 各录一名学生（模拟别的助教已有数据）
  const adminToken = wb.HttpApi._token;
  const sreq = (body) => fetch(base + '/api/students', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken }, body: JSON.stringify(body) });
  // 先把学生转到 ta1 名下：教务创建后转移
  const s1 = await (await sreq({ name: '林小满', school: '深外', gradYear: '2027' })).json();
  await fetch(base + '/api/students/' + s1.student.id + '/owner', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adminToken },
    body: JSON.stringify({ ownerId: made.user.id }) });
  ok(true, '教务为 ta1 准备一名学生');

  /* ---- 助教登录只见自己数据 ---- */
  wb.doLogout();
  const taLogin = await wb.Api.login('ta1', 'ta123456', 'ta');
  ok(taLogin.ok && taLogin.user.mustChangePwd === true, '助教首次登录（需改密）');
  // doLogin 会拉 state；强制改密流程先走完
  await wb.doLogin('ta1', 'ta123456', 'ta');
  await wb.doChangePwd('ta123456', 'ta654321', 'ta654321');
  ok(wb.currentUser && wb.currentUser.username === 'ta1', '助教改密后进入主界面');
  ok(wb.state.students.length === 1 && wb.state.students[0].ownerId === wb.currentUser.id,
    '助教登录后只见自己名下学生（服务端过滤）');

  console.log('\ne2e 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
