/* 微信服务号接入（docs/parent-push-plan.md 第 2/3 步）
   安全红线：AppID/AppSecret/Token/模板 ID 全部走环境变量（WECHAT_APPID / WECHAT_SECRET / WECHAT_TOKEN / WECHAT_TEMPLATE_ID），
   绝不写进仓库。未配置时 configured() 为 false，微信相关接口返回「服务号未配置」而不崩溃。 */
const crypto = require('crypto');

function cfg(){
  return {
    appid: process.env.WECHAT_APPID || '',
    secret: process.env.WECHAT_SECRET || '',
    token: process.env.WECHAT_TOKEN || '',
    templateId: process.env.WECHAT_TEMPLATE_ID || '',
    templateMode: process.env.WECHAT_TEMPLATE_MODE || 'keywords'  // keywords=多字段模板 / content=单字段 content 模板
  };
}
function configured(){
  const c = cfg();
  return !!(c.appid && c.secret && c.token);
}

/* 服务器配置验签：sha1(sort(token, timestamp, nonce).join('')) === signature（GET/POST 均验） */
function checkSignature(signature, timestamp, nonce){
  const c = cfg();
  if(!c.token || !signature || !timestamp || !nonce) return false;
  const expect = crypto.createHash('sha1').update([c.token, timestamp, nonce].sort().join('')).digest('hex');
  return expect === signature;
}

/* access_token：内存缓存，有效期 2 小时，提前 5 分钟刷新（并发调用共享同一 Promise，避免重复请求） */
let tokenCache = { token: null, expiresAt: 0 };
let tokenInflight = null;
async function getAccessToken(){
  if(!configured()) throw new Error('服务号未配置');
  const now = Date.now();
  if(tokenCache.token && tokenCache.expiresAt - 5 * 60 * 1000 > now) return tokenCache.token;
  if(tokenInflight) return tokenInflight;
  const c = cfg();
  tokenInflight = (async ()=>{
    const r = await fetch('https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=' +
      encodeURIComponent(c.appid) + '&secret=' + encodeURIComponent(c.secret));
    const d = await r.json();
    if(!d.access_token) throw new Error('access_token 获取失败：' + (d.errmsg || 'unknown'));
    tokenCache = { token: d.access_token, expiresAt: Date.now() + (d.expires_in || 7200) * 1000 };
    return tokenCache.token;
  })();
  try{ return await tokenInflight; } finally { tokenInflight = null; }
}
/* 测试用：清空 access_token 缓存 */
function _resetTokenCache(){ tokenCache = { token: null, expiresAt: 0 }; }

/* 最少量 XML 解析：微信服务器推送为固定格式 XML（内部系统、来源可控），
   用正则提取 <tag> 或 <tag><![CDATA[…]]></tag> 的值即可，不引 XML 解析库。
   注意 CDATA 闭合是三字符「]]>」——只剥「]]」会回溯把残壳吞进值里（已踩过） */
function xmlVal(xml, tag){
  const m = String(xml).match(new RegExp('<' + tag + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + tag + '>'));
  return m ? m[1].trim() : '';
}

/* 被动回复文本消息（绑定成功/提示语） */
function replyText(toUser, fromUser, content){
  return '<xml><ToUserName><![CDATA[' + toUser + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + fromUser + ']]></FromUserName>' +
    '<CreateTime>' + Math.floor(Date.now() / 1000) + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[' + content + ']]></Content></xml>';
}

module.exports = { cfg, configured, checkSignature, getAccessToken, _resetTokenCache, xmlVal, replyText };
