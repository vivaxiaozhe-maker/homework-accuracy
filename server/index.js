/* 学情跟踪平台后端入口（M1 骨架 + M2 认证与账号 API）
   后续里程碑：M3 业务数据 API、M4 附件上传，按 docs/backend-plan.md 推进 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { auth } = require('./auth');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// helmet 安全头（其余默认头如 X-Frame-Options/frameguard、nosniff、Referrer-Policy 等保持 helmet 默认）。
// CSP 说明：前端为单文件零依赖架构（全部 JS/CSS 内联，另按需从 jsdelivr 加载 jsPDF/html2canvas），
// 默认 CSP（script-src 'self'）会禁掉内联脚本导致整页不执行，故对内联脚本/样式放行——这是该架构的必然选择；
// script-src-attr 保持 helmet 默认 'none'（事件处理属性仍被禁，缩小注入面），img-src 放行 data:/blob:（示例图与附件预览）。
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:']
    }
  }
}));
app.use(express.json({ limit: '10mb' }));

/* 静态托管白名单：仅前端入口文件（此前整库根目录暴露 docs/、test/、server/、.gitignore 等，存在安全隐患）
   中文文件名入口：Express 5 路由对非 ASCII 路径不直接匹配，改为中间件手动解码比较 */
const ROOT_DIR = path.join(__dirname, '..');
app.use((req, res, next) => {
  if(req.method !== 'GET' && req.method !== 'HEAD') return next();
  let p;
  try{ p = decodeURIComponent(req.path); }catch(e){ return next(); }
  if(p === '/' || p === '/index.html') return res.sendFile(path.join(ROOT_DIR, 'index.html'));
  if(p === '/学生作业正确率.html') return res.sendFile(path.join(ROOT_DIR, '学生作业正确率.html'));
  next();  // 其余路径一律 404（含 /docs/*、/test/*、/server/*、路径穿越尝试——Express 已规范化 .. 段）
});

// 健康检查（公开）
app.get('/api/health', (req, res) => res.json({ ok: true }));

// /api 全局守卫：除登录/健康检查外，一律先过 auth（登录校验 + 挂载 req.user / req.token）
app.use('/api', (req, res, next) => {
  if(req.path === '/login' || req.path === '/health') return next();
  auth(req, res, next);
});

// 路由挂载
app.use('/api', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/state', require('./routes/state'));
app.use('/api/students', require('./routes/students'));
app.use('/api', require('./routes/records'));      // /api/records + /api/missed
app.use('/api', require('./routes/planreq'));      // /api/plan/set + /api/plan-requests
app.use('/api/search', require('./routes/search'));
app.use('/api/audit-logs', require('./routes/audit'));
app.use('/api/files', require('./routes/files'));

// 未匹配的 /api 路由 → 404 JSON（避免落到静态页）
app.use('/api', (req, res) => res.status(404).json({ ok: false, msg: '接口不存在' }));

/* 首次启动初始化：users 表为空时创建教务管理员账号 */
function initAdmin(){
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if(cnt > 0) return;
  const initPwd = process.env.ADMIN_INIT_PASSWORD;
  if(!initPwd){
    console.warn('[警告] 未设置环境变量 ADMIN_INIT_PASSWORD，教务管理员使用默认初始密码 admin123，请尽快修改！');
  }
  db.prepare(`INSERT INTO users (id, username, name, role, pass_hash, disabled, must_change_pwd, created_at)
              VALUES (?, ?, '教务管理员', 'admin', ?, 0, 1, ?)`)
    .run('u_' + Date.now().toString(36), 'admin', bcrypt.hashSync(initPwd || 'admin123', 10), new Date().toISOString());
  console.log('[初始化] 已创建教务管理员账号 admin（首登需修改密码）');
}

initAdmin();

/* 加固：过期 session 定期清理（每小时；auth 校验时另有惰性清理兜底） */
const sessionGcTimer = setInterval(() => {
  try{
    const r = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
    if(r.changes) console.log(`[清理] 过期 session ${r.changes} 条`);
  }catch(e){ console.error('[清理] session 清理失败：', e.message); }
}, 60 * 60 * 1000);
sessionGcTimer.unref();  // 不阻止进程退出
process.on('exit', () => clearInterval(sessionGcTimer));

/* 加固：孤儿附件清理（磁盘文件 vs files 表，无库行对应的删除） */
(function cleanOrphanFiles(){
  try{
    const fs = require('fs');
    const dir = path.join(__dirname, 'uploads');
    if(!fs.existsSync(dir)) return;
    const known = new Set(db.prepare('SELECT path FROM files').all().map(r => r.path));
    let removed = 0;
    fs.readdirSync(dir).forEach(f => {
      const p = path.join(dir, f);
      if(!known.has(p)){ fs.unlinkSync(p); removed++; }
    });
    if(removed) console.log(`[清理] 孤儿附件 ${removed} 个`);
  }catch(e){ console.error('[清理] 孤儿附件清理失败：', e.message); }
})();

// 直接运行时启动服务；被测试 require 时只导出 app（测试自行起随机端口）
if(require.main === module){
  app.listen(PORT, () => console.log(`学情跟踪平台后端已启动：http://localhost:${PORT}`));
}

module.exports = { app };
