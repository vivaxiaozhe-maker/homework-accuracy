/* M9 微信服务号接入测试：验签 / XML 事件解析与绑定 / access_token 缓存 / 二维码 / 模板消息推送（零额外依赖）。
   安全红线：测试使用假配置值（test-appid 等），绝不写真 AppSecret。
   微信 API 调用用全局 fetch 桩拦截（api.weixin.qq.com），本机测试服务请求转发真 fetch。
   独立测试库（DB_PATH 临时文件）+ 随机端口起服务。运行：node test/m9.test.js */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// 独立测试 DB + 假微信配置（必须先于 require 后端）
const TEST_DB = path.join(os.tmpdir(), 'xq-m9-test-' + Date.now() + '.db');
process.env.DB_PATH = TEST_DB;
process.env.WECHAT_APPID = 'test-appid';
process.env.WECHAT_SECRET = 'test-secret-fake';
process.env.WECHAT_TOKEN = 'test-token-fake';
process.env.WECHAT_TEMPLATE_ID = 'tmpl-test-1';

/* 微信 API 桩：拦截 api.weixin.qq.com 调用并记录；其余转发真 fetch */
const realFetch = globalThis.fetch;
const wxCalls = [];
let pushErrcode = 0;  // 推送行为开关（43004 = 家长已取关）
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if(u.indexOf('api.weixin.qq.com') !== -1){
    wxCalls.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if(u.indexOf('/cgi-bin/token') !== -1) return Promise.resolve({ json: async () => ({ access_token: 'fake-at-1', expires_in: 7200 }) });
    if(u.indexOf('qrcode/create') !== -1) return Promise.resolve({ json: async () => ({ ticket: 'fake-ticket-1' }) });
    if(u.indexOf('template/send') !== -1) return Promise.resolve({ json: async () => ({ errcode: pushErrcode, errmsg: pushErrcode ? 'require unsubscribe' : 'ok' }) });
  }
  return realFetch(url, opts);
};

const { app } = require('../index');
const db = require('../db');
const wx = require('../wechat');

let pass = 0, fail = 0;
function ok(cond, name){
  if(cond){ pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name); }
}
function sign(token, ts, nonce){
  return crypto.createHash('sha1').update([token, ts, nonce].sort().join('')).digest('hex');
}

(async function main(){
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  async function req(method, p, body, token, rawText){
    const res = await realFetch(base + p, {
      method,
      headers: { ...(rawText ? { 'Content-Type': 'text/xml' } : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined || body === null ? undefined : (rawText ? body : JSON.stringify(body))
    });
    const text = await res.text();
    let data = null;
    try{ data = JSON.parse(text); }catch(e){}
    return { status: res.status, data, text };
  }

  /* ---- 账号与学生准备 ---- */
  const adminTok = (await req('POST', '/api/login', { username: 'admin', password: 'admin123', role: 'admin' })).data.token;
  await req('POST', '/api/users', { name: '王助教', username: 'ta1', password: 'ta123456', role: 'ta' }, adminTok);
  await req('POST', '/api/users', { name: '李助教', username: 'ta2', password: 'ta123456', role: 'ta' }, adminTok);
  const T1 = (await req('POST', '/api/login', { username: 'ta1', password: 'ta123456', role: 'ta' })).data.token;
  const T2 = (await req('POST', '/api/login', { username: 'ta2', password: 'ta123456', role: 'ta' })).data.token;
  const subj = '学科 / AP / 微积分BC';
  const stuA = (await req('POST', '/api/students', { name: '林小满', school: '深外', gradYear: '2027' }, T1)).data.student.id;
  await req('POST', '/api/records', { studentId: stuA, date: '2026-09-14', total: 20, correct: 18, wrongs: [7, 14], subject: subj }, T1);

  /* ---- GET 验签（服务器配置验证） ---- */
  let ts = '1700000000', nonce = 'abc123';
  let r = await req('GET', '/api/wechat/callback?signature=' + sign('test-token-fake', ts, nonce) +
    '&timestamp=' + ts + '&nonce=' + nonce + '&echostr=hello-echo');
  ok(r.status === 200 && r.text === 'hello-echo', 'GET 回调：合法签名原样返回 echostr');
  r = await req('GET', '/api/wechat/callback?signature=bad&timestamp=' + ts + '&nonce=' + nonce + '&echostr=hello-echo');
  ok(r.status === 403, 'GET 回调：非法签名 403');

  /* ---- 二维码接口（bind-qr） ---- */
  r = await req('POST', '/api/students/' + stuA + '/bind-qr', {}, T1);
  ok(r.status === 200 && r.data.ok && r.data.qrUrl.indexOf('https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=fake-ticket-1') === 0,
    'bind-qr 返回二维码图片地址（ticket 透传）');
  const bindToken = db.prepare('SELECT bind_token FROM students WHERE id = ?').get(stuA).bind_token;
  ok(!!bindToken, 'bind_token 已写入学生行（复用）');
  const qrCalls1 = wxCalls.filter(c => c.url.indexOf('qrcode/create') !== -1);
  ok(qrCalls1.length === 1 && qrCalls1[0].body.action_name === 'QR_LIMIT_STR_SCENE'
    && qrCalls1[0].body.action_info.scene.scene_str === bindToken, '二维码用 QR_LIMIT_STR_SCENE + scene_str=绑定 token');
  r = await req('POST', '/api/students/' + stuA + '/bind-qr', {}, T1);
  ok(db.prepare('SELECT bind_token FROM students WHERE id = ?').get(stuA).bind_token === bindToken, '再次生成复用同一 bind_token');
  r = await req('POST', '/api/students/' + stuA + '/bind-qr', {}, T2);
  ok(r.status === 403, '越权：助教不能给他人学生生成绑定二维码（403）');

  /* ---- access_token 缓存（提前 5 分钟刷新；并发共享） ---- */
  const wx1 = require('../wechat');
  wx1._resetTokenCache();
  const tokenCallsBefore = wxCalls.filter(c => c.url.indexOf('/cgi-bin/token') !== -1).length;
  await wx1.getAccessToken();
  await wx1.getAccessToken();
  ok(wxCalls.filter(c => c.url.indexOf('/cgi-bin/token') !== -1).length === tokenCallsBefore + 1, 'access_token 命中缓存（两次调用一次请求）');
  wx1._resetTokenCache();
  await wx1.getAccessToken();
  ok(wxCalls.filter(c => c.url.indexOf('/cgi-bin/token') !== -1).length === tokenCallsBefore + 2, '缓存清空后重新获取');

  /* ---- POST 事件：subscribe（qrscene_）绑定 → SCAN 绑定 → 取关标记 ---- */
  function eventXml(event, openid, eventKey){
    return '<xml><ToUserName><![CDATA[gh_test]]></ToUserName><FromUserName><![CDATA[' + openid + ']]></FromUserName>' +
      '<CreateTime>1700000001</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[' + event + ']]></Event>' +
      (eventKey ? '<EventKey><![CDATA[' + eventKey + ']]></EventKey>' : '') + '</xml>';
  }
  function cbQuery(){
    const t2 = '1700000002', n2 = 'nonce2';
    return '?signature=' + sign('test-token-fake', t2, n2) + '&timestamp=' + t2 + '&nonce=' + n2;
  }
  r = await req('POST', '/api/wechat/callback' + cbQuery(), eventXml('subscribe', 'openid_p1', 'qrscene_' + bindToken), null, true);
  ok(r.status === 200 && r.text.indexOf('绑定成功') !== -1 && r.text.indexOf('林小满') !== -1, 'subscribe 事件绑定成功并回复欢迎语');
  ok(r.text.indexOf('<ToUserName><![CDATA[openid_p1]]></ToUserName>') !== -1, '回复消息的 ToUserName 为家长 openid（方向正确）');
  ok(db.prepare('SELECT * FROM parent_binds WHERE student_id = ? AND openid = ? AND unbound = 0').get(stuA, 'openid_p1') !== undefined,
    '绑定写入 parent_binds（unbound=0）');
  // 重复扫码（已关注 SCAN）幂等
  r = await req('POST', '/api/wechat/callback' + cbQuery(), eventXml('SCAN', 'openid_p1', bindToken), null, true);
  ok(r.status === 200 && db.prepare('SELECT COUNT(*) AS c FROM parent_binds WHERE student_id = ? AND openid = ?').get(stuA, 'openid_p1').c === 1,
    'SCAN 事件重复绑定幂等（不重复写行）');
  // 另一家长 SCAN 绑定（一学生多家长）
  await req('POST', '/api/wechat/callback' + cbQuery(), eventXml('SCAN', 'openid_p2', bindToken), null, true);
  ok(db.prepare('SELECT COUNT(*) AS c FROM parent_binds WHERE student_id = ? AND unbound = 0').get(stuA).c === 2, '一学生可绑定多家长');
  // state 带 bindCnt
  r = await req('GET', '/api/state', null, T1);
  ok(r.data.state.students.find(s => s.id === stuA).bindCnt === 2, 'GET /api/state 学生带 bindCnt=2');
  // 非法签名 POST 被拒
  r = await req('POST', '/api/wechat/callback?signature=bad&timestamp=1&nonce=2', eventXml('subscribe', 'openid_x', 'qrscene_' + bindToken), null, true);
  ok(r.status === 403, 'POST 回调：非法签名 403（不处理事件）');

  /* ---- 模板消息推送 ---- */
  r = await req('POST', '/api/reports/push', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 200 && r.data.ok && r.data.sent === 2, '推送成功（两位绑定家长）');
  const sendCalls = wxCalls.filter(c => c.url.indexOf('template/send') !== -1);
  ok(sendCalls.length === 2 && sendCalls[0].body.touser === 'openid_p1' && sendCalls[0].body.template_id === 'tmpl-test-1',
    '模板消息结构：touser/template_id 正确');
  ok(sendCalls[0].body.url.indexOf('/r/') !== -1 && sendCalls[0].body.data.keyword1.value === '林小满'
    && sendCalls[0].body.data.keyword2.value === 'AP·微积分BC' && sendCalls[0].body.data.keyword3.value.indexOf('90%') === 0
    && sendCalls[0].body.data.first && sendCalls[0].body.data.remark, '模板消息 data 字段齐全（学生/科目短名/最近正确率/报告链接）');
  ok(db.prepare("SELECT * FROM audit_logs WHERE action = '推送报告给家长'").all().length > 0, '推送写审计日志');
  // 未绑定学生推送 → 400 提示
  const stuNoBind = (await req('POST', '/api/students', { name: '未绑定生', gradYear: '2027' }, T1)).data.student.id;
  r = await req('POST', '/api/reports/push', { studentId: stuNoBind, subject: subj }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('未绑定') !== -1, '未绑定家长推送返回 400 明确提示');
  // 越权推送
  r = await req('POST', '/api/reports/push', { studentId: stuA, subject: subj }, T2);
  ok(r.status === 403, '越权：助教不能推送他人学生报告（403）');
  // 43004 取关 → 标记绑定失效
  pushErrcode = 43004;
  r = await req('POST', '/api/reports/push', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 400 && r.data.msg.indexOf('取关') !== -1, '全部 43004 时返回失败提示');
  ok(db.prepare('SELECT COUNT(*) AS c FROM parent_binds WHERE student_id = ? AND unbound = 1').get(stuA).c === 2,
    'errcode 43004 标记绑定失效（unbound=1）');
  r = await req('GET', '/api/state', null, T1);
  ok(r.data.state.students.find(s => s.id === stuA).bindCnt === 0, '取关标记后 bindCnt 归零');
  pushErrcode = 0;
  // 取关事件：unsubscribe 标失效
  db.prepare('UPDATE parent_binds SET unbound = 0 WHERE student_id = ?').run(stuA);  // 恢复后测取关事件
  r = await req('POST', '/api/wechat/callback' + cbQuery(), eventXml('unsubscribe', 'openid_p1', ''), null, true);
  ok(r.status === 200 && db.prepare('SELECT unbound FROM parent_binds WHERE openid = ?').get('openid_p1').unbound === 1,
    'unsubscribe 事件标记该家长绑定失效');

  /* ---- 未配置服务号：不崩溃，明确提示 ---- */
  delete process.env.WECHAT_SECRET;
  r = await req('GET', '/api/wechat/callback?signature=x&timestamp=1&nonce=2&echostr=z');
  ok(r.status === 503 && r.data.msg === '服务号未配置', '未配置时 GET 回调 503「服务号未配置」');
  r = await req('POST', '/api/students/' + stuA + '/bind-qr', {}, T1);
  ok(r.status === 503 && r.data.msg === '服务号未配置', '未配置时 bind-qr 503「服务号未配置」');
  r = await req('POST', '/api/reports/push', { studentId: stuA, subject: subj }, T1);
  ok(r.status === 503 && r.data.msg === '服务号未配置', '未配置时推送 503「服务号未配置」');
  process.env.WECHAT_SECRET = 'test-secret-fake';  // 恢复

  console.log('\nM9 断言：' + (pass + fail) + ' 项，PASS ' + pass + '，FAIL ' + fail);
  srv.close();
  try{ fs.unlinkSync(TEST_DB); fs.unlinkSync(TEST_DB + '-wal'); fs.unlinkSync(TEST_DB + '-shm'); }catch(e){}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });
