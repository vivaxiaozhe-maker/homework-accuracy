/* 数据库连接与建表（better-sqlite3，单文件 SQLite；M1 骨架，后续里程碑在此基础上加 DAO/接口） */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// DB 文件放 server/data/app.db，目录自动创建
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'app.db'));

db.pragma('journal_mode = WAL');       // 读写并发更稳
db.pragma('foreign_keys = ON');

/* 建表（IF NOT EXISTS 幂等，重复启动安全）。
   JSON 字段（subj_plans 等）以 TEXT 存 JSON 字符串，与前端 mock 数据结构对齐。 */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','ta','sales')),
  pass_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_pwd INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,               -- 归属助教 id
  name TEXT NOT NULL,
  school TEXT,
  grad_year TEXT,
  archived INTEGER NOT NULL DEFAULT 0,  -- 历史学生
  sample INTEGER NOT NULL DEFAULT 0,
  subj_plans TEXT,                      -- JSON：科目 → 应完成次数
  subj_plan_set_at TEXT,                -- JSON：科目 → 计划设定日期
  subj_comments TEXT,                   -- JSON：科目 → 老师评语
  subj_advice TEXT,                     -- JSON：科目 → 学习计划与建议
  mock TEXT,                            -- JSON：科目 → 模考 {date, score}
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_students_owner ON students(owner_id);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  date TEXT NOT NULL,
  total INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  wrongs TEXT,                          -- JSON：错题号数组
  subject TEXT,
  images TEXT,                          -- JSON：附件 id 数组（M4 起用）
  sample INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_records_student ON records(student_id);
CREATE INDEX IF NOT EXISTS idx_records_owner ON records(owner_id);
CREATE INDEX IF NOT EXISTS idx_records_date ON records(date);

CREATE TABLE IF NOT EXISTS missed (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  date TEXT NOT NULL,
  subject TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolution TEXT,                      -- 'made-up' 已补交 / 'deleted' 已删除（软删除留痕）
  resolved_at TEXT,
  sample INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_missed_student ON missed(student_id);
CREATE INDEX IF NOT EXISTS idx_missed_owner ON missed(owner_id);

CREATE TABLE IF NOT EXISTS plan_requests (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  old_plan INTEGER NOT NULL,
  new_plan INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_at TEXT,
  sample INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_planreq_student ON plan_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_planreq_status ON plan_requests(status);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_record ON files(record_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,                     -- 本地时间 YYYY-MM-DD HH:mm:ss（精确到秒）
  user_id TEXT,
  user_name TEXT,
  role TEXT,
  action TEXT NOT NULL,
  target_type TEXT,                     -- record/missed/student/plan/account/auth/data
  target_desc TEXT,
  detail TEXT,
  owner_id TEXT                         -- 数据归属快照（助教口径过滤用）
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts);
CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_logs(owner_id);
`);

module.exports = db;
