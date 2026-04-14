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
-- SELECT/MULTISELECT의 value_text는 JSON 배열 문자열 (예: '["식대비"]')
-- 쿼리 시 LIKE '%값%' 사용 권장
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
-- 참조자 (결재 열람자)
-- ============================================================
CREATE TABLE IF NOT EXISTS referrers (
  instance_id TEXT NOT NULL REFERENCES instances(id),
  user_id     TEXT REFERENCES users(id),
  user_name   TEXT,                       -- 정규화 전 폴백용
  type        TEXT,                       -- USER, RELATIVE_DEPT_HEAD
  PRIMARY KEY (instance_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_referrers_user ON referrers(user_id);

-- ============================================================
-- 파일 (범용 파일 저장소)
-- ============================================================
CREATE TABLE IF NOT EXISTS files (
  file_key    TEXT PRIMARY KEY,            -- flex 파일 고유 식별자
  file_name   TEXT,
  local_path  TEXT,                        -- 로컬 파일 경로
  source      TEXT NOT NULL DEFAULT 'attachment',  -- attachment, profile, etc.
  file_size   INTEGER,
  mime_type   TEXT
);

-- ============================================================
-- 첨부파일 (인스턴스 ↔ 파일 연결)
-- ============================================================
CREATE TABLE IF NOT EXISTS attachments (
  instance_id TEXT NOT NULL REFERENCES instances(id),
  file_key    TEXT NOT NULL REFERENCES files(file_key),
  PRIMARY KEY (instance_id, file_key)
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
  created_at   TEXT NOT NULL,             -- [PG] → TIMESTAMPTZ
  updated_at   TEXT                       -- [PG] → TIMESTAMPTZ
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
  policy_id     TEXT,                     -- 휴가 정책 ID (timeOffPolicyId)
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
-- 회사 (고객사) 정보
-- 채움 소스: customer-info (실데이터), 자식 테이블 INSERT 시 placeholder
-- ============================================================
CREATE TABLE IF NOT EXISTS customers (
  id                    TEXT PRIMARY KEY,        -- customerIdHash
  name                  TEXT NOT NULL,           -- 회사명
  establish_date        TEXT,                    -- [PG] → DATE
  logo_file_key         TEXT,                    -- 로고 이미지 파일키
  logo_image_url        TEXT,
  title_image_preset_id TEXT,                    -- 커버 이미지 프리셋
  mission               TEXT,
  mission_description   TEXT,
  legal_name            TEXT,                    -- legalInfo.name
  business_reg_number   TEXT,                    -- 사업자등록번호
  corp_reg_number       TEXT,                    -- 법인등록번호
  phone_number          TEXT,
  address_full          TEXT,
  address_country       TEXT,
  address_zip           TEXT,
  jurisdiction_code     TEXT,                    -- KR, SG, …
  in_corporate_group    INTEGER DEFAULT 0,       -- [PG] → BOOLEAN
  raw                   TEXT                     -- [PG] → JSONB
);

-- ============================================================
-- 부서 (트리 구조)
-- ============================================================
CREATE TABLE IF NOT EXISTS departments (
  id                       TEXT PRIMARY KEY,     -- idHash
  customer_id              TEXT NOT NULL REFERENCES customers(id),
  parent_id                TEXT REFERENCES departments(id),
  name                     TEXT NOT NULL,
  visible                  INTEGER DEFAULT 1,    -- [PG] → BOOLEAN
  display_order            INTEGER,
  begin_date               TEXT,                 -- [PG] → DATE
  end_date                 TEXT                  -- [PG] → DATE
);

CREATE INDEX IF NOT EXISTS idx_departments_customer    ON departments(customer_id);
CREATE INDEX IF NOT EXISTS idx_departments_parent      ON departments(parent_id);
CREATE INDEX IF NOT EXISTS idx_departments_name        ON departments(customer_id, name);

-- ============================================================
-- 직함 (직위) 마스터
-- ============================================================
CREATE TABLE IF NOT EXISTS job_titles (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  name          TEXT NOT NULL,
  display_order INTEGER,
  active        INTEGER DEFAULT 1               -- [PG] → BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_job_titles_customer ON job_titles(customer_id);

-- ============================================================
-- 직무 (직군) 마스터
-- ============================================================
CREATE TABLE IF NOT EXISTS job_roles (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  name          TEXT NOT NULL,
  display_order INTEGER,
  active        INTEGER DEFAULT 1               -- [PG] → BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_job_roles_customer ON job_roles(customer_id);

-- ============================================================
-- 직급 마스터
-- ============================================================
CREATE TABLE IF NOT EXISTS job_ranks (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  name          TEXT NOT NULL,
  display_order INTEGER,
  active        INTEGER DEFAULT 1               -- [PG] → BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_job_ranks_customer ON job_ranks(customer_id);

-- ============================================================
-- 징계 종류 마스터
-- ============================================================
CREATE TABLE IF NOT EXISTS discipline_types (
  id            TEXT PRIMARY KEY,
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  type          TEXT NOT NULL,                   -- DEFAULT, CUSTOM
  name          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discipline_types_customer ON discipline_types(customer_id);

-- ============================================================
-- 직원 (HR 인사 정보)
-- ============================================================
CREATE TABLE IF NOT EXISTS employees (
  user_id                        TEXT PRIMARY KEY REFERENCES users(id),
  customer_id                    TEXT NOT NULL REFERENCES customers(id),
  employee_number                TEXT,
  company_join_date              TEXT,           -- [PG] → DATE
  company_group_join_date        TEXT,           -- [PG] → DATE
  is_group_join_date_used        INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  is_company_president           INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  company_president_order        INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_employees_customer ON employees(customer_id);
CREATE INDEX IF NOT EXISTS idx_employees_number   ON employees(employee_number);

-- ============================================================
-- 직원 직위 배정
-- ============================================================
CREATE TABLE IF NOT EXISTS user_positions (
  id                                TEXT PRIMARY KEY,
  user_id                           TEXT NOT NULL REFERENCES users(id),
  customer_id                       TEXT NOT NULL REFERENCES customers(id),
  department_id                     TEXT REFERENCES departments(id),
  job_title_id                      TEXT REFERENCES job_titles(id),
  is_head_user                      INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  is_primary                        INTEGER DEFAULT 1,  -- [PG] → BOOLEAN
  display_order                     INTEGER DEFAULT 0,
  personnel_appointment_creation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_positions_user       ON user_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_positions_dept       ON user_positions(department_id);
CREATE INDEX IF NOT EXISTS idx_user_positions_primary    ON user_positions(user_id, is_primary);

-- ============================================================
-- 직원 직무 배정
-- ============================================================
CREATE TABLE IF NOT EXISTS user_job_roles (
  id                                TEXT PRIMARY KEY,
  user_id                           TEXT NOT NULL REFERENCES users(id),
  customer_id                       TEXT NOT NULL REFERENCES customers(id),
  job_role_id                       TEXT REFERENCES job_roles(id),
  is_primary                        INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  display_order                     INTEGER DEFAULT 0,
  personnel_appointment_creation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_job_roles_user ON user_job_roles(user_id);

-- ============================================================
-- 직원 직급 배정
-- ============================================================
CREATE TABLE IF NOT EXISTS user_job_ranks (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  job_rank_id TEXT REFERENCES job_ranks(id),
  is_primary  INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  display_order INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_user_job_ranks_user ON user_job_ranks(user_id);

-- ============================================================
-- 개인 정보
-- ============================================================
CREATE TABLE IF NOT EXISTS user_personals (
  user_id                   TEXT PRIMARY KEY REFERENCES users(id),
  customer_id               TEXT NOT NULL REFERENCES customers(id),
  email                     TEXT,
  name_in_office            TEXT,
  display_name              TEXT,
  gender                    TEXT,                -- MALE, FEMALE, …
  birth_date                TEXT,               -- [PG] → DATE
  ssn_masked                TEXT,               -- 앞 6자리 + 마스킹 보관 권장
  nationality_code          TEXT,               -- KR, SG, …
  residence_country_code    TEXT,
  phone_number              TEXT,
  phone_country_code        TEXT,
  address_full              TEXT,
  address_country           TEXT,
  address_city              TEXT,
  address_zip               TEXT,
  profile_image_file_key    TEXT,
  profile_cover_preset_id   TEXT,
  about_me                  TEXT,
  handicap_value            TEXT                -- UNKNOWN, GRADE1, …
);

CREATE INDEX IF NOT EXISTS idx_user_personals_email   ON user_personals(email);
CREATE INDEX IF NOT EXISTS idx_user_personals_display ON user_personals(display_name);

-- ============================================================
-- 급여 계좌
-- ============================================================
CREATE TABLE IF NOT EXISTS payroll_bank_accounts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  type          TEXT NOT NULL DEFAULT 'PAYROLL',
  bank_code     TEXT,
  bank_name     TEXT,
  account_number TEXT
);

CREATE INDEX IF NOT EXISTS idx_payroll_accounts_user ON payroll_bank_accounts(user_id);

-- ============================================================
-- 고용 계약
-- ============================================================
CREATE TABLE IF NOT EXISTS employment_contracts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  status            TEXT NOT NULL,              -- ACTIVATED, FINISHED, …
  type              TEXT,                       -- REGULAR, CONTRACT, …
  begin_date        TEXT,                       -- [PG] → DATE
  end_date_expected TEXT,                       -- [PG] → DATE
  modified_at       TEXT,                       -- [PG] → TIMESTAMPTZ
  admin_memo        TEXT
);

CREATE INDEX IF NOT EXISTS idx_employment_contracts_user   ON employment_contracts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_employment_contracts_status ON employment_contracts(status);

-- ============================================================
-- 급여 계약
-- ============================================================
CREATE TABLE IF NOT EXISTS salary_contracts (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  customer_id         TEXT NOT NULL REFERENCES customers(id),
  status              TEXT NOT NULL,            -- ACTIVATED, FINISHED
  income_type         TEXT,                     -- EARNED, BUSINESS, …
  payment_method      TEXT,                     -- YEARLY, MONTHLY, …
  amount              INTEGER,                  -- 원 단위 연봉
  begin_date          TEXT,                     -- [PG] → DATE
  end_date            TEXT,                     -- [PG] → DATE
  end_date_expected   TEXT,                     -- [PG] → DATE
  modified_at         TEXT,                     -- [PG] → TIMESTAMPTZ
  modified_by         TEXT REFERENCES users(id),
  extra_info          TEXT,
  admin_memo          TEXT,
  comprehensive_pay_rule TEXT                   -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_salary_contracts_user   ON salary_contracts(user_id, status);
CREATE INDEX IF NOT EXISTS idx_salary_contracts_status ON salary_contracts(status, begin_date);

-- ============================================================
-- 인사발령
-- ============================================================
CREATE TABLE IF NOT EXISTS personnel_appointments (
  id                  TEXT PRIMARY KEY,
  customer_id         TEXT NOT NULL REFERENCES customers(id),
  creator_id          TEXT REFERENCES users(id),
  creator_type        TEXT,                     -- USER, SYSTEM
  status              TEXT NOT NULL,            -- SUCCESS, PENDING, FAIL
  apply_date          TEXT,                     -- [PG] → DATE
  created_at          TEXT,                     -- [PG] → TIMESTAMPTZ
  last_modified_at    TEXT,                     -- [PG] → TIMESTAMPTZ
  label_id            TEXT,
  label_name          TEXT,
  label_type          TEXT                      -- SYSTEM_DELETE, …
);

CREATE INDEX IF NOT EXISTS idx_personnel_appts_customer ON personnel_appointments(customer_id, apply_date);
CREATE INDEX IF NOT EXISTS idx_personnel_appts_status   ON personnel_appointments(status);

CREATE TABLE IF NOT EXISTS personnel_appointment_users (
  appointment_id TEXT NOT NULL REFERENCES personnel_appointments(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (appointment_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_pa_users_user ON personnel_appointment_users(user_id);

-- ============================================================
-- 퇴직 기록
-- ============================================================
CREATE TABLE IF NOT EXISTS user_resignations (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  resignation_date TEXT,                        -- [PG] → DATE
  type            TEXT,
  reason          TEXT,
  status          TEXT,
  raw             TEXT                          -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_resignations_user ON user_resignations(user_id);

-- ============================================================
-- 휴직 기록
-- ============================================================
CREATE TABLE IF NOT EXISTS leave_of_absences (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  type         TEXT,
  begin_date   TEXT,                            -- [PG] → DATE
  end_date     TEXT,                            -- [PG] → DATE
  status       TEXT,
  reason       TEXT,
  raw          TEXT                             -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_loa_user ON leave_of_absences(user_id, begin_date);

-- ============================================================
-- 부양가족
-- ============================================================
CREATE TABLE IF NOT EXISTS dependent_families (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  name        TEXT,
  relation    TEXT,                             -- SPOUSE, CHILD, …
  birth_date  TEXT,                             -- [PG] → DATE
  raw         TEXT                              -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_dependent_families_user ON dependent_families(user_id);

-- ============================================================
-- 경력 사항
-- ============================================================
CREATE TABLE IF NOT EXISTS work_experiences (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  company_name TEXT,
  department   TEXT,
  position     TEXT,
  begin_date   TEXT,                            -- [PG] → DATE
  end_date     TEXT,                            -- [PG] → DATE
  description  TEXT,
  raw          TEXT                             -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_work_experiences_user ON work_experiences(user_id);

-- ============================================================
-- 학력 사항
-- ============================================================
CREATE TABLE IF NOT EXISTS education_experiences (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  school_name   TEXT,
  major         TEXT,
  degree        TEXT,                           -- BACHELOR, MASTER, …
  begin_date    TEXT,                           -- [PG] → DATE
  end_date      TEXT,                           -- [PG] → DATE
  raw           TEXT                            -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_education_experiences_user ON education_experiences(user_id);

-- ============================================================
-- 포상
-- ============================================================
CREATE TABLE IF NOT EXISTS user_rewards (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  name         TEXT,
  date         TEXT,                            -- [PG] → DATE
  description  TEXT,
  raw          TEXT                             -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_user_rewards_user ON user_rewards(user_id, date);

-- ============================================================
-- 징계 이력
-- ============================================================
CREATE TABLE IF NOT EXISTS user_disciplines (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  discipline_type_id TEXT REFERENCES discipline_types(id),
  start_date        TEXT,                       -- [PG] → DATE
  end_date          TEXT,                       -- [PG] → DATE
  reason            TEXT,
  status            TEXT,
  raw               TEXT                        -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_user_disciplines_user ON user_disciplines(user_id, start_date);

-- ============================================================
-- 근무 규칙 (회사 단위)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_rules (
  id                        TEXT PRIMARY KEY,
  customer_id               TEXT NOT NULL REFERENCES customers(id),
  rule_name                 TEXT,
  control_type              TEXT,               -- FULL_FLEXIBLE, FIXED, …
  working_hour_type         TEXT,               -- FULL_TIME, PART_TIME
  working_period_unit       TEXT,               -- MONTH, WEEK
  working_period_count      INTEGER,
  working_period_begin_date TEXT,               -- [PG] → DATE
  auto_conversion_enabled   INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  scheduling_enabled        INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  base_agreed_day_minutes   INTEGER,
  calculation_strategy      TEXT,
  is_primary                INTEGER DEFAULT 0,  -- [PG] → BOOLEAN
  work_record_rule_id       TEXT,
  week_working_hour_rule    TEXT,               -- [PG] → JSONB
  raw                       TEXT                -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_work_rules_customer ON work_rules(customer_id);

-- ============================================================
-- 사용자 ↔ 근무규칙 배정
-- ============================================================
CREATE TABLE IF NOT EXISTS user_work_rules (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id),
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  work_rule_id    TEXT NOT NULL REFERENCES work_rules(id),
  date_from       TEXT NOT NULL,                -- [PG] → DATE
  date_to         TEXT,                         -- [PG] → DATE
  assigned_at     TEXT                          -- [PG] → TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_work_rules_user ON user_work_rules(user_id, date_from);

-- ============================================================
-- 근무 형태 마스터 (재택, 원격, 사무실, 출장 등)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_forms (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  name             TEXT NOT NULL,
  description      TEXT,
  type             TEXT NOT NULL,               -- WORK, REST
  paid_type        TEXT,                        -- PAID, UNPAID
  is_primary       INTEGER DEFAULT 0,           -- [PG] → BOOLEAN
  active           INTEGER DEFAULT 1,           -- [PG] → BOOLEAN
  display_order    INTEGER,
  emoji            TEXT,
  icon_key         TEXT,
  icon_color       TEXT,
  usage_visibility TEXT,                        -- ALL, NONE
  approval_enabled INTEGER DEFAULT 0,           -- [PG] → BOOLEAN
  approval_template_key TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_forms_customer ON work_forms(customer_id, active);

-- ============================================================
-- 근무 계획 (자동 주간 플랜)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_plan_auto (
  user_id      TEXT NOT NULL REFERENCES users(id),
  day_of_week  TEXT NOT NULL,                   -- MONDAY … SUNDAY
  time_blocks  TEXT NOT NULL DEFAULT '[]',      -- [PG] → JSONB
  PRIMARY KEY (user_id, day_of_week)
);

-- ============================================================
-- 근무 승인 규칙 (휴일근무 등)
-- ============================================================
CREATE TABLE IF NOT EXISTS work_approval_rules (
  id               TEXT PRIMARY KEY,
  customer_id      TEXT NOT NULL REFERENCES customers(id),
  type             TEXT NOT NULL,               -- HOLIDAY_WORK, OVERTIME, …
  name             TEXT,
  display_order    INTEGER,
  emoji            TEXT,
  approval_enabled INTEGER DEFAULT 0,           -- [PG] → BOOLEAN
  approval_template_key TEXT,
  description      TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_approval_rules_customer ON work_approval_rules(customer_id);

-- ============================================================
-- 근무 정산 기간
-- ============================================================
CREATE TABLE IF NOT EXISTS working_periods (
  user_id       TEXT NOT NULL REFERENCES users(id),
  from_date     TEXT NOT NULL,                  -- [PG] → DATE
  to_date       TEXT NOT NULL,                  -- [PG] → DATE
  unit          TEXT NOT NULL,                  -- MONTH, WEEK
  unit_count    INTEGER,
  zone_id       TEXT,                           -- Asia/Seoul
  PRIMARY KEY (user_id, from_date)
);

-- ============================================================
-- 휴가 정책
-- ============================================================
CREATE TABLE IF NOT EXISTS time_off_policies (
  id                   TEXT PRIMARY KEY,
  customer_id          TEXT NOT NULL REFERENCES customers(id),
  type                 TEXT NOT NULL,           -- ANNUAL, CUSTOM
  category             TEXT,                    -- ANNUAL, HOLIDAY_REPLACE, REFRESH, CUSTOM
  name                 TEXT NOT NULL,
  description          TEXT,
  display_order        INTEGER,
  emoji                TEXT,
  icon_key             TEXT,
  icon_color           TEXT,
  paid_type            TEXT,                    -- PAID, UNPAID
  paid_unit            TEXT,                    -- RATE
  paid_value           INTEGER,
  active               INTEGER DEFAULT 1,       -- [PG] → BOOLEAN
  legal_mandatory      INTEGER DEFAULT 0,       -- [PG] → BOOLEAN
  assign_method        TEXT,
  minimum_usage_limit  TEXT,                    -- HOURS, ALL
  usage_gender_limit   TEXT,                    -- NONE, FEMALE, …
  minimum_usage_minutes INTEGER,
  enable_early_use     INTEGER DEFAULT 0,       -- [PG] → BOOLEAN
  enable_over_usage    INTEGER DEFAULT 0,       -- [PG] → BOOLEAN
  approval_enabled     INTEGER DEFAULT 0,       -- [PG] → BOOLEAN
  approval_template_key TEXT,
  raw                  TEXT                     -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_time_off_policies_customer ON time_off_policies(customer_id, active);
CREATE INDEX IF NOT EXISTS idx_time_off_policies_type     ON time_off_policies(type, category);

-- ============================================================
-- 휴가 버킷 (연도별 할당 잔여량)
-- ============================================================
CREATE TABLE IF NOT EXISTS time_off_buckets (
  user_id              TEXT NOT NULL REFERENCES users(id),
  policy_id            TEXT NOT NULL REFERENCES time_off_policies(id),
  assigned_at          TEXT NOT NULL,           -- [PG] → TIMESTAMPTZ
  valid_usage_from     TEXT,                    -- [PG] → DATE
  valid_usage_to       TEXT,                    -- [PG] → DATE
  assigned_minutes     INTEGER DEFAULT 0,
  used_minutes         INTEGER DEFAULT 0,
  remaining_minutes    INTEGER DEFAULT 0,
  expiration_date      TEXT,                    -- [PG] → DATE
  assign_method        TEXT,
  PRIMARY KEY (user_id, policy_id, assigned_at)
);

CREATE INDEX IF NOT EXISTS idx_time_off_buckets_user    ON time_off_buckets(user_id, valid_usage_from);
CREATE INDEX IF NOT EXISTS idx_time_off_buckets_policy  ON time_off_buckets(policy_id);
CREATE INDEX IF NOT EXISTS idx_time_off_buckets_expiry  ON time_off_buckets(expiration_date);

-- ============================================================
-- 휴가 신청 태스크 (결재 단위)
-- ============================================================
CREATE TABLE IF NOT EXISTS time_off_tasks (
  task_key          TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  status            TEXT NOT NULL,              -- DONE, IN_PROGRESS, REJECTED
  approval_status   TEXT,                       -- APPROVED, REJECTED, PENDING
  date_from         TEXT,                       -- [PG] → DATE
  date_to           TEXT,                       -- [PG] → DATE
  date_count        INTEGER,
  memo              TEXT,
  requested_at      TEXT,                       -- [PG] → TIMESTAMPTZ
  terminated_at     TEXT,                       -- [PG] → TIMESTAMPTZ
  approval_lines    TEXT DEFAULT '[]',          -- [PG] → JSONB
  content_units     TEXT DEFAULT '[]',          -- [PG] → JSONB
  raw               TEXT                        -- [PG] → JSONB
);

CREATE INDEX IF NOT EXISTS idx_time_off_tasks_user   ON time_off_tasks(user_id, date_from);
CREATE INDEX IF NOT EXISTS idx_time_off_tasks_status ON time_off_tasks(status, requested_at);

-- ============================================================
-- 공휴일 그룹
-- ============================================================
CREATE TABLE IF NOT EXISTS holiday_groups (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  name            TEXT NOT NULL,
  is_default      INTEGER DEFAULT 0            -- [PG] → BOOLEAN
);

CREATE INDEX IF NOT EXISTS idx_holiday_groups_customer ON holiday_groups(customer_id);

CREATE TABLE IF NOT EXISTS user_holiday_groups (
  user_id           TEXT NOT NULL REFERENCES users(id),
  holiday_group_id  TEXT NOT NULL REFERENCES holiday_groups(id),
  customer_id       TEXT NOT NULL REFERENCES customers(id),
  PRIMARY KEY (user_id, holiday_group_id)
);

-- ============================================================
-- 캘린더 (개인 캘린더 메타)
-- ============================================================
CREATE TABLE IF NOT EXISTS calendars (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  customer_id   TEXT NOT NULL REFERENCES customers(id),
  summary       TEXT,
  time_zone     TEXT DEFAULT 'Asia/Seoul',
  created_at    TEXT,                           -- [PG] → TIMESTAMPTZ
  updated_at    TEXT                            -- [PG] → TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_calendars_user     ON calendars(user_id);
CREATE INDEX IF NOT EXISTS idx_calendars_customer ON calendars(customer_id);

-- ============================================================
-- 할 일 (Todo)
-- ============================================================
CREATE TABLE IF NOT EXISTS todos (
  id               TEXT PRIMARY KEY,
  type             TEXT,
  title            TEXT,
  preview_content  TEXT,
  status           TEXT NOT NULL,               -- TODO, IN_PROGRESS, DONE
  reference_type   TEXT,
  reference_key    TEXT,
  reference_json   TEXT,                        -- [PG] → JSONB
  requester_id     TEXT REFERENCES users(id),
  requester_type   TEXT,                        -- USER, SYSTEM
  created_at       TEXT,                        -- [PG] → TIMESTAMPTZ
  updated_at       TEXT                         -- [PG] → TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_todos_status     ON todos(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_todos_requester  ON todos(requester_id);

CREATE TABLE IF NOT EXISTS todo_assignees (
  todo_id   TEXT NOT NULL REFERENCES todos(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (todo_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_todo_assignees_user ON todo_assignees(user_id);

-- ============================================================
-- 피드백 / 칭찬
-- ============================================================
CREATE TABLE IF NOT EXISTS feedbacks (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,                -- RECOGNITION, FEEDBACK
  writer_id       TEXT REFERENCES users(id),
  writer_name     TEXT,
  content         TEXT,
  published_at    TEXT,                         -- [PG] → TIMESTAMPTZ
  created_at      TEXT,                         -- [PG] → TIMESTAMPTZ
  updated_at      TEXT,                         -- [PG] → TIMESTAMPTZ
  hidden          INTEGER DEFAULT 0,            -- [PG] → BOOLEAN
  purpose_templates TEXT DEFAULT '[]',          -- [PG] → JSONB
  access_scopes   TEXT DEFAULT '[]',            -- [PG] → JSONB
  reaction_metas  TEXT DEFAULT '[]',            -- [PG] → JSONB
  comment_count   INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_feedbacks_type        ON feedbacks(type, published_at);
CREATE INDEX IF NOT EXISTS idx_feedbacks_writer      ON feedbacks(writer_id, published_at);

CREATE TABLE IF NOT EXISTS feedback_receivers (
  feedback_id TEXT NOT NULL REFERENCES feedbacks(id),
  type        TEXT NOT NULL,                    -- COMPANY, DEPT_WITH_CHILDREN, USER
  target_id   TEXT,
  name        TEXT,
  UNIQUE (feedback_id, type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_receivers_target ON feedback_receivers(type, target_id);

CREATE TABLE IF NOT EXISTS feedback_reactions (
  feedback_id           TEXT NOT NULL REFERENCES feedbacks(id),
  actor_id              TEXT REFERENCES users(id),
  actor_name            TEXT,
  reaction_template_id  INTEGER,
  PRIMARY KEY (feedback_id, actor_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_reactions_feedback ON feedback_reactions(feedback_id);

-- ============================================================
-- 회사 첨부 문서 (취업규칙, 사업자등록증 등)
-- ============================================================
CREATE TABLE IF NOT EXISTS customer_attachments (
  id              TEXT PRIMARY KEY,
  customer_id     TEXT NOT NULL REFERENCES customers(id),
  type            TEXT,                         -- BUSINESS_REGISTER, EMPLOYMENT_RULE
  name            TEXT,
  description     TEXT,
  display_order   INTEGER,
  link_uri        TEXT,
  file_key        TEXT REFERENCES files(file_key),
  file_name       TEXT,
  file_url        TEXT,
  modified_at     TEXT                          -- [PG] → TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_customer_attachments_customer ON customer_attachments(customer_id, type);

-- ============================================================
-- 구독 기능
-- ============================================================
CREATE TABLE IF NOT EXISTS subscription_features (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  feature_key TEXT NOT NULL,                    -- CONTRACT, CORE_HR, …
  status      TEXT NOT NULL DEFAULT 'ACTIVE',   -- ACTIVE, EXPIRED
  PRIMARY KEY (customer_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_subscription_features_customer ON subscription_features(customer_id);

-- ============================================================
-- 이미지 프리셋
-- ============================================================
CREATE TABLE IF NOT EXISTS image_presets (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,              -- USER_PROFILE_COVER, CUSTOMER_PROFILE_COVER
  public_url        TEXT,
  public_thumb_url  TEXT
);

CREATE INDEX IF NOT EXISTS idx_image_presets_type ON image_presets(type);

-- ============================================================
-- 크롤 메타데이터
-- ============================================================
CREATE TABLE IF NOT EXISTS crawl_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 사용 예: ('last_crawled_at', '2026-04-01T09:00:00Z'), ('catalog_version', '1.0')
