-- flex-ax database schema
-- SQLite 호환, PostgreSQL 마이그레이션 최소 friction 목표
--
-- 이관 시 변경 사항:
--   1. TEXT (ISO 8601) → TIMESTAMPTZ
--   2. TEXT (JSON) → JSONB
--   3. INTEGER (0/1) → BOOLEAN
--   4. AUTOINCREMENT → GENERATED ALWAYS AS IDENTITY (선택)
--
-- 아래 주석의 [PG] 는 PostgreSQL 이관 시 변경할 부분

-- ============================================================
-- 사용자
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,            -- flex idHash
  name       TEXT NOT NULL,               -- 최근 표시 이름
  aliases    TEXT DEFAULT '[]'            -- [PG] → JSONB, 별칭 배열 ["Swen", "JC"]
);

-- ============================================================
-- 템플릿 (결재 양식)
-- ============================================================
CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT,
  created_at TEXT,                        -- [PG] → TIMESTAMPTZ
  updated_at TEXT,                        -- [PG] → TIMESTAMPTZ
  raw        TEXT                         -- [PG] → JSONB
);

-- ============================================================
-- 템플릿 필드 정의
-- ============================================================
CREATE TABLE IF NOT EXISTS template_fields (
  template_id TEXT NOT NULL REFERENCES templates(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,              -- STRING, DATE, SELECT, AMOUNT_OF_MONEY, NUMBER, MULTISELECT, TASK_REFERENCE
  required    INTEGER DEFAULT 0,          -- [PG] → BOOLEAN DEFAULT false
  options     TEXT,                        -- [PG] → JSONB, 선택지 배열 ["국내출장","국외출장"]
  currency    TEXT,                        -- AMOUNT_OF_MONEY: KRW, USD
  sort_order  INTEGER,
  PRIMARY KEY (template_id, name)
);

-- ============================================================
-- 인스턴스 (결재 문서)
-- ============================================================
CREATE TABLE IF NOT EXISTS instances (
  id              TEXT PRIMARY KEY,
  document_number TEXT NOT NULL,
  template_id     TEXT NOT NULL REFERENCES templates(id),
  drafter_id      TEXT REFERENCES users(id),
  drafted_at      TEXT NOT NULL,          -- [PG] → TIMESTAMPTZ
  status          TEXT NOT NULL,
  content_html    TEXT,
  raw             TEXT                    -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_instances_template_status ON instances(template_id, status);
CREATE INDEX IF NOT EXISTS idx_instances_drafter         ON instances(drafter_id, drafted_at);
CREATE INDEX IF NOT EXISTS idx_instances_drafted_at      ON instances(drafted_at);
CREATE INDEX IF NOT EXISTS idx_instances_status          ON instances(status);
CREATE INDEX IF NOT EXISTS idx_instances_doc_number      ON instances(document_number);

-- ============================================================
-- 필드값 (EAV)
-- ============================================================
CREATE TABLE IF NOT EXISTS field_values (
  instance_id  TEXT NOT NULL REFERENCES instances(id),
  field_name   TEXT NOT NULL,
  field_type   TEXT NOT NULL,
  value_text   TEXT,                      -- 원본 문자열
  value_number REAL,                      -- [PG] → NUMERIC, 파싱된 숫자
  value_date   TEXT,                      -- [PG] → DATE, ISO 날짜
  currency     TEXT,                      -- KRW, USD
  PRIMARY KEY (instance_id, field_name)
);

CREATE INDEX IF NOT EXISTS idx_fv_name_text   ON field_values(field_name, value_text);
CREATE INDEX IF NOT EXISTS idx_fv_name_number ON field_values(field_name, value_number) WHERE value_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fv_name_date   ON field_values(field_name, value_date)   WHERE value_date IS NOT NULL;

-- ============================================================
-- 결재선
-- ============================================================
CREATE TABLE IF NOT EXISTS approval_lines (
  instance_id  TEXT NOT NULL REFERENCES instances(id),
  step_order   INTEGER NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  type         TEXT NOT NULL,             -- USER, RELATIVE_DEPT_HEAD
  approver_id  TEXT REFERENCES users(id),
  approver_name TEXT,                     -- 정규화 전 폴백용
  status       TEXT NOT NULL,
  processed_at TEXT,                      -- [PG] → TIMESTAMPTZ
  PRIMARY KEY (instance_id, step_order, seq)
);

CREATE INDEX IF NOT EXISTS idx_al_approver ON approval_lines(approver_id, status);
CREATE INDEX IF NOT EXISTS idx_al_status   ON approval_lines(status, processed_at);

-- ============================================================
-- 첨부파일
-- ============================================================
CREATE TABLE IF NOT EXISTS attachments (
  instance_id TEXT NOT NULL REFERENCES instances(id),
  file_name   TEXT NOT NULL,
  file_key    TEXT,
  file_size   INTEGER,
  mime_type   TEXT,
  local_path  TEXT,
  PRIMARY KEY (instance_id, file_name)
);

-- ============================================================
-- 코멘트/수정 이력
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES instances(id),
  author_id    TEXT REFERENCES users(id),
  author_name  TEXT,                      -- 정규화 전 폴백용
  type         TEXT NOT NULL,             -- WRITE, APPROVE, CANCEL, NORMAL, UPDATE
  content      TEXT,
  is_system    INTEGER DEFAULT 0,         -- [PG] → BOOLEAN DEFAULT false
  created_at   TEXT NOT NULL              -- [PG] → TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comments_instance ON comments(instance_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_author   ON comments(author_id, created_at);

-- ============================================================
-- 근태/휴가
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id),
  type          TEXT NOT NULL,            -- ANNUAL, CUSTOM, etc.
  date_from     TEXT,                     -- [PG] → DATE
  date_to       TEXT,                     -- [PG] → DATE
  days          REAL,                     -- 사용 일수 (0.5 = 반차)
  minutes       INTEGER,                  -- 사용 분
  status        TEXT NOT NULL,
  applied_at    TEXT,                     -- [PG] → TIMESTAMPTZ
  raw           TEXT                      -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_attendance_user   ON attendance(user_id, date_from);
CREATE INDEX IF NOT EXISTS idx_attendance_status ON attendance(status);
CREATE INDEX IF NOT EXISTS idx_attendance_type   ON attendance(type, date_from);

-- ============================================================
-- 크롤 메타데이터
-- ============================================================
CREATE TABLE IF NOT EXISTS crawl_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 사용 예: ('last_crawled_at', '2026-04-01T09:00:00Z'), ('catalog_version', '1.0')
