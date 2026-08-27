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

app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// 静态托管仓库根目录的前端（index.html 为入口）
app.use(express.static(path.join(__dirname, '..')));

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

// 直接运行时启动服务；被测试 require 时只导出 app（测试自行起随机端口）
if(require.main === module){
  app.listen(PORT, () => console.log(`学情跟踪平台后端已启动：http://localhost:${PORT}`));
}

module.exports = { app };
