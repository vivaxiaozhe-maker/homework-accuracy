/* 学情跟踪平台后端入口（M1：骨架 + 健康检查 + 静态托管前端）
   后续里程碑：M2 认证与账号 API、M3 业务数据 API、M4 附件上传，按 docs/backend-plan.md 推进 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const db = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(helmet());
app.use(express.json({ limit: '10mb' }));

// 静态托管仓库根目录的前端（index.html 为入口）
app.use(express.static(path.join(__dirname, '..')));

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* 首次启动初始化：users 表为空时创建教务管理员账号 */
function initAdmin(){
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if(cnt > 0) return;
  const initPwd = process.env.ADMIN_INIT_PASSWORD;
  if(!initPwd){
    console.warn('[警告] 未设置环境变量 ADMIN_INIT_PASSWORD，教务管理员使用默认初始密码 admin123，请尽快修改！');
  }
  const id = 'u_' + Date.now().toString(36);
  db.prepare(`INSERT INTO users (id, username, name, role, pass_hash, disabled, must_change_pwd, created_at)
              VALUES (?, ?, ?, 'admin', ?, 0, 1, ?)`)
    .run(id, 'admin', '教务管理员', bcrypt.hashSync(initPwd || 'admin123', 10), new Date().toISOString());
  console.log('[初始化] 已创建教务管理员账号 admin（首登需修改密码）');
}

initAdmin();
app.listen(PORT, () => console.log(`学情跟踪平台后端已启动：http://localhost:${PORT}`));
