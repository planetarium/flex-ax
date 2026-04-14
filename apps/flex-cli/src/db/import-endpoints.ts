import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../logger/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readEndpoint(endpointsDir: string, filename: string): any | null {
  const filePath = path.join(endpointsDir, filename);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function importEndpoints(
  db: Database.Database,
  endpointsDir: string,
  upsertUser: (id: string | undefined, name: string | undefined | null) => void,
  logger: Logger,
): Record<string, number> {
  const counts: Record<string, number> = {};
  function inc(key: string, n = 1) { counts[key] = (counts[key] ?? 0) + n; }

  // customers FK placeholder 보장 헬퍼 (모든 sub-importer에서 공유)
  const customerPlaceholder = db.prepare(`INSERT OR IGNORE INTO customers (id, name) VALUES (?, ?)`);
  const seenCustomers = new Set<string>();
  function ensureCustomer(customerId: string | null | undefined): void {
    if (!customerId || seenCustomers.has(customerId)) return;
    seenCustomers.add(customerId);
    customerPlaceholder.run(customerId, customerId);
  }

  importCompanyOrg(db, endpointsDir, upsertUser, ensureCustomer, logger, inc);
  importEmployeeHR(db, endpointsDir, upsertUser, ensureCustomer, logger, inc);
  importPersonnelProfile(db, endpointsDir, upsertUser, ensureCustomer, logger, inc);
  importWorkTimeOff(db, endpointsDir, upsertUser, ensureCustomer, logger, inc);
  importOther(db, endpointsDir, upsertUser, ensureCustomer, logger, inc);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  logger.info(`엔드포인트 임포트 완료: 총 ${total}건`);
  for (const [k, v] of Object.entries(counts)) {
    if (v > 0) logger.info(`  ${k}: ${v}`);
  }

  return counts;
}

type Inc = (key: string, n?: number) => void;
type EnsureCustomer = (customerId: string | null | undefined) => void;

// ============================================================
// Company / Org
// ============================================================
function importCompanyOrg(
  db: Database.Database, dir: string,
  upsertUser: (id: string | undefined, name: string | undefined | null) => void,
  ensureCustomer: EnsureCustomer,
  logger: Logger, inc: Inc,
) {
  // Prepared statements (루프 밖에서 한 번만 prepare)
  const stmts = {
    customer: db.prepare(`
      INSERT OR REPLACE INTO customers
        (id, name, establish_date, logo_file_key, logo_image_url,
         title_image_preset_id, mission, mission_description,
         legal_name, business_reg_number, corp_reg_number,
         phone_number, address_full, address_country, address_zip,
         jurisdiction_code, in_corporate_group, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
    department: db.prepare(`
      INSERT OR REPLACE INTO departments (id, customer_id, parent_id, name, visible, display_order, begin_date, end_date)
      VALUES (?,?,?,?,?,?,?,?)
    `),
    jobTitle: db.prepare(`INSERT OR REPLACE INTO job_titles (id, customer_id, name, display_order, active) VALUES (?,?,?,?,?)`),
    jobRole: db.prepare(`INSERT OR REPLACE INTO job_roles (id, customer_id, name, display_order, active) VALUES (?,?,?,?,?)`),
    jobRank: db.prepare(`INSERT OR REPLACE INTO job_ranks (id, customer_id, name, display_order, active) VALUES (?,?,?,?,?)`),
    disciplineType: db.prepare(`INSERT OR REPLACE INTO discipline_types (id, customer_id, type, name) VALUES (?,?,?,?)`),
  };

  db.transaction(() => {
    // customers
    const f = readEndpoint(dir, "customer-info.json");
    if (f?.data) {
      const d = f.data as Record<string, unknown>;
      const legal = (d.legalInfo ?? {}) as Record<string, unknown>;
      const addr = (legal.address ?? {}) as Record<string, unknown>;
      stmts.customer.run(
        d.customerIdHash, legal.name ?? d.customerIdHash,
        legal.establishDate ?? null, d.logoImageFileKey ?? null,
        d.logoImageFileUrl ?? null, d.titleImagePresetIdHash ?? null,
        d.mission ?? null, d.missionDescription ?? null,
        legal.name ?? null, legal.businessRegistrationNumber ?? null,
        legal.corporationRegistrationNumber ?? null,
        legal.telephoneNumber ?? null, legal.addressFull ?? null,
        addr.addressCountry ?? null, addr.addressZipCode ?? null,
        legal.jurisdictionNationalityCode ?? null, 0, JSON.stringify(d),
      );
      inc("customers");
      // 실데이터 customers row가 이미 들어갔으므로 placeholder가 다시 시도되지 않도록 등록
      ensureCustomer(d.customerIdHash as string);
      for (const pid of (d.companyPresidentUserIdHashes ?? []) as string[]) {
        // 이름이 없으므로 placeholder로 등록 (이후 다른 엔드포인트에서 실제 이름이 들어오면 갱신됨)
        upsertUser(pid, "");
      }
    }

    // departments
    const df = readEndpoint(dir, "departments-search.json");
    for (const row of df?.data ?? []) {
      ensureCustomer(row.customerIdHash);
      stmts.department.run(
        row.idHash, row.customerIdHash, row.parentDepartmentIdHash ?? null,
        row.name, row.visible ? 1 : 0, row.displayOrder ?? null,
        row.beginDateTime ? String(row.beginDateTime).slice(0, 10) : null,
        row.endDateTime ? String(row.endDateTime).slice(0, 10) : null,
      );
      inc("departments");
    }

    // job_titles
    const jtf = readEndpoint(dir, "customer-job-titles.json");
    for (const row of jtf?.data ?? []) {
      ensureCustomer(row.customerIdHash);
      stmts.jobTitle.run(
        row.idHash, row.customerIdHash, row.name, row.displayOrder ?? null, row.active ? 1 : 0,
      );
      inc("job_titles");
    }

    // job_roles
    const jrf = readEndpoint(dir, "customer-job-roles.json");
    for (const row of jrf?.data ?? []) {
      ensureCustomer(row.customerIdHash);
      stmts.jobRole.run(
        row.idHash, row.customerIdHash, row.name, row.displayOrder ?? null, row.active ? 1 : 0,
      );
      inc("job_roles");
    }

    // job_ranks
    const jrkf = readEndpoint(dir, "customer-job-ranks.json");
    for (const row of jrkf?.data ?? []) {
      ensureCustomer(row.customerIdHash);
      stmts.jobRank.run(
        row.idHash, row.customerIdHash, row.name, row.displayOrder ?? null, row.active ? 1 : 0,
      );
      inc("job_ranks");
    }

    // discipline_types
    const dtf = readEndpoint(dir, "customer-disciplines.json");
    const custId = f?.data?.customerIdHash ?? null;
    for (const row of dtf?.data ?? []) {
      const disciplineCustomerId = row.customerIdHash ?? custId;
      if (!disciplineCustomerId) {
        logger.warn(
          `discipline_types 스킵: customer_id 없음 (disciplineIdHash=${String(row.disciplineIdHash ?? "")})`,
        );
        continue;
      }
      ensureCustomer(disciplineCustomerId);
      stmts.disciplineType.run(
        row.disciplineIdHash, disciplineCustomerId, row.type, row.name,
      );
      inc("discipline_types");
    }
  })();
}

// ============================================================
// Employee / HR
// ============================================================
function importEmployeeHR(
  db: Database.Database, dir: string,
  upsertUser: (id: string | undefined, name: string | undefined | null) => void,
  ensureCustomer: EnsureCustomer,
  _logger: Logger, inc: Inc,
) {
  const stmts = {
    employee: db.prepare(`
      INSERT OR REPLACE INTO employees
        (user_id, customer_id, employee_number, company_join_date, company_group_join_date,
         is_group_join_date_used, is_company_president, company_president_order)
      VALUES (?,?,?,?,?,?,?,?)
    `),
    userPosition: db.prepare(`
      INSERT OR REPLACE INTO user_positions
        (id, user_id, customer_id, department_id, job_title_id,
         is_head_user, is_primary, display_order, personnel_appointment_creation_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `),
    userJobRole: db.prepare(`
      INSERT OR REPLACE INTO user_job_roles
        (id, user_id, customer_id, job_role_id, is_primary, display_order, personnel_appointment_creation_id)
      VALUES (?,?,?,?,?,?,?)
    `),
    userJobRank: db.prepare(`
      INSERT OR REPLACE INTO user_job_ranks
        (id, user_id, customer_id, job_rank_id, is_primary, display_order)
      VALUES (?,?,?,?,?,?)
    `),
    userPersonal: db.prepare(`
      INSERT OR REPLACE INTO user_personals
        (user_id, customer_id, email, name_in_office, display_name, gender, birth_date,
         ssn_masked, nationality_code, residence_country_code, phone_number, phone_country_code,
         address_full, address_country, address_city, address_zip,
         profile_image_file_key, profile_cover_preset_id, about_me, handicap_value)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
    payrollBankAccount: db.prepare(`
      INSERT OR REPLACE INTO payroll_bank_accounts (id, user_id, customer_id, type, bank_code, bank_name, account_number)
      VALUES (?,?,?,?,?,?,?)
    `),
    employmentContract: db.prepare(`
      INSERT OR REPLACE INTO employment_contracts
        (id, user_id, customer_id, status, type, begin_date, end_date_expected, modified_at, admin_memo)
      VALUES (?,?,?,?,?,?,?,?,?)
    `),
    salaryContract: db.prepare(`
      INSERT OR REPLACE INTO salary_contracts
        (id, user_id, customer_id, status, income_type, payment_method, amount,
         begin_date, end_date, end_date_expected, modified_at, modified_by,
         extra_info, admin_memo, comprehensive_pay_rule)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
  };

  db.transaction(() => {
    // user-employee
    const empFile = readEndpoint(dir, "user-employee.json");
    if (empFile?.data) {
      const e = empFile.data;
      upsertUser(e.userIdHash, e.name ?? "");
      ensureCustomer(e.customerIdHash);
      stmts.employee.run(
        e.userIdHash, e.customerIdHash, e.employeeNumber ?? null,
        e.companyJoinDate ?? null, e.companyGroupJoinDate ?? null,
        e.isCompanyGroupJoinDateUsed ? 1 : 0, e.isCompanyPresident ? 1 : 0,
        e.companyPresidentOrder ?? 0,
      );
      inc("employees");
    }

    // user-employee-bundle
    const bundleFile = readEndpoint(dir, "user-employee-bundle.json");
    if (bundleFile?.data) {
      const { employee, positions = [], jobRoles = [], jobRanks = [] } = bundleFile.data;
      if (employee) {
        upsertUser(employee.userIdHash, employee.name ?? "");
        ensureCustomer(employee.customerIdHash);
        stmts.employee.run(
          employee.userIdHash, employee.customerIdHash, employee.employeeNumber ?? null,
          employee.companyJoinDate ?? null, employee.companyGroupJoinDate ?? null,
          employee.isCompanyGroupJoinDateUsed ? 1 : 0, employee.isCompanyPresident ? 1 : 0,
          employee.companyPresidentOrder ?? 0,
        );
        inc("employees");
      }
      for (const p of positions) {
        ensureCustomer(p.customerIdHash);
        stmts.userPosition.run(
          p.idHash, p.userIdHash, p.customerIdHash,
          p.departmentIdHash ?? null, p.jobTitleIdHash ?? null,
          p.isHeadUser ? 1 : 0, p.isPrimary ? 1 : 0,
          p.displayOrder ?? 0, p.personnelAppointmentCreationIdHash ?? null,
        );
        inc("user_positions");
      }
      for (const r of jobRoles) {
        ensureCustomer(r.customerIdHash);
        stmts.userJobRole.run(
          r.idHash, r.userIdHash, r.customerIdHash,
          r.jobRoleIdHash ?? null, r.isPrimary ? 1 : 0,
          r.displayOrder ?? 0, r.personnelAppointmentCreationIdHash ?? null,
        );
        inc("user_job_roles");
      }
      for (const rank of jobRanks) {
        ensureCustomer(rank.customerIdHash);
        stmts.userJobRank.run(
          rank.idHash, rank.userIdHash, rank.customerIdHash,
          rank.jobRankIdHash ?? null, rank.isPrimary ? 1 : 0,
          rank.displayOrder ?? 0,
        );
        inc("user_job_ranks");
      }
    }

    // user-personal-bundle
    const personalFile = readEndpoint(dir, "user-personal-bundle.json");
    if (personalFile?.data) {
      const { personal, payrollBankAccount } = personalFile.data;
      if (personal) {
        upsertUser(personal.userIdHash, personal.name ?? personal.displayName ?? "");
        ensureCustomer(personal.customerIdHash);
        // 스키마 주석: 앞 6자리(YYMMDD) + 마스킹. 하이픈/성별자리는 저장하지 않는다.
        const ssnMasked = personal.ssn ? personal.ssn.slice(0, 6) + "-*******" : null;
        stmts.userPersonal.run(
          personal.userIdHash, personal.customerIdHash,
          personal.email ?? null, personal.nameInOffice ?? null,
          personal.displayName ?? null, personal.gender ?? null,
          personal.birthDate ?? null, ssnMasked,
          personal.nationality?.value ?? null, personal.residenceCountry?.value ?? null,
          personal.phoneNumber ?? null, personal.phoneNumberCountry?.value ?? null,
          personal.addressFull ?? null, personal.addressCountry ?? null,
          personal.addressCity ?? null, personal.addressZipCode ?? null,
          personal.profileImageFileKey ?? null, personal.profileCoverImagePresetIdHash ?? null,
          personal.aboutMe ?? null, personal.handicap?.value ?? null,
        );
        inc("user_personals");
      }
      if (payrollBankAccount) {
        ensureCustomer(payrollBankAccount.customerIdHash);
        stmts.payrollBankAccount.run(
          payrollBankAccount.idHash, payrollBankAccount.userIdHash,
          payrollBankAccount.customerIdHash, payrollBankAccount.type ?? "PAYROLL",
          payrollBankAccount.bankCode?.code ?? null, payrollBankAccount.bankCode?.label ?? null,
          payrollBankAccount.accountNumber ?? null,
        );
        inc("payroll_bank_accounts");
      }
    }

    // employment-contracts-search
    const contractsFile = readEndpoint(dir, "employment-contracts-search.json");
    if (Array.isArray(contractsFile?.data)) {
      for (const item of contractsFile.data) {
        const emp = item.employment;
        if (!emp) continue;
        // FK 무결성을 위해 user_id를 users 테이블에 등록 (실명은 다른 엔드포인트가 채움)
        upsertUser(emp.userIdHash, "");
        ensureCustomer(emp.customerIdHash);
        stmts.employmentContract.run(
          emp.idHash, emp.userIdHash, emp.customerIdHash,
          emp.status, emp.type?.value ?? null, emp.beginDate ?? null,
          emp.endDateExpected ?? null, emp.modifiedDate ?? null,
          emp.adminMemo ?? null,
        );
        inc("employment_contracts");
      }
    }

    // user-salary-contracts
    const salaryFile = readEndpoint(dir, "user-salary-contracts.json");
    if (Array.isArray(salaryFile?.data)) {
      for (const s of salaryFile.data) {
        // user_id, modified_by 모두 users(id) FK이므로 placeholder로 등록
        upsertUser(s.userIdHash, "");
        if (s.modifyUserIdHash) upsertUser(s.modifyUserIdHash, "");
        ensureCustomer(s.customerIdHash);
        stmts.salaryContract.run(
          s.idHash, s.userIdHash, s.customerIdHash,
          s.status, s.incomeType?.value ?? null, s.paymentMethod?.value ?? null,
          s.amount ?? null, s.beginDate ?? null, s.endDate ?? null,
          s.endDateExpected ?? null, s.modifiedDate ?? null,
          s.modifyUserIdHash ?? null, s.extraInfo ?? null,
          s.adminMemo ?? null,
          s.comprehensivePayRule ? JSON.stringify(s.comprehensivePayRule) : null,
        );
        inc("salary_contracts");
      }
    }
  })();
}

// ============================================================
// Personnel / Profile
// ============================================================
function importPersonnelProfile(
  db: Database.Database, dir: string,
  upsertUser: (id: string | undefined, name: string | undefined | null) => void,
  ensureCustomer: EnsureCustomer,
  logger: Logger, inc: Inc,
) {
  /** NOT NULL 필드가 누락되면 경고 후 스킵하는 헬퍼 */
  function requireFields(
    table: string,
    id: unknown,
    fields: Record<string, unknown>,
  ): boolean {
    const missing = Object.entries(fields)
      .filter(([, v]) => v === null || v === undefined || v === "")
      .map(([k]) => k);
    if (missing.length > 0) {
      logger.warn(
        `${table} 스킵: NOT NULL 필드 누락 (${missing.join(", ")}, id=${String(id ?? "")})`,
      );
      return false;
    }
    return true;
  }

  const stmts = {
    pa: db.prepare(`
      INSERT OR REPLACE INTO personnel_appointments
        (id, customer_id, creator_id, creator_type, status, apply_date, created_at, last_modified_at, label_id, label_name, label_type)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `),
    paUser: db.prepare(`INSERT OR IGNORE INTO personnel_appointment_users (appointment_id, user_id) VALUES (?,?)`),
    resignation: db.prepare(`INSERT OR REPLACE INTO user_resignations (id, user_id, customer_id, resignation_date, type, reason, status, raw) VALUES (?,?,?,?,?,?,?,?)`),
    loa: db.prepare(`INSERT OR REPLACE INTO leave_of_absences (id, user_id, customer_id, type, begin_date, end_date, status, reason, raw) VALUES (?,?,?,?,?,?,?,?,?)`),
    depFamily: db.prepare(`INSERT OR REPLACE INTO dependent_families (id, user_id, customer_id, name, relation, birth_date, raw) VALUES (?,?,?,?,?,?,?)`),
    workExp: db.prepare(`INSERT OR REPLACE INTO work_experiences (id, user_id, customer_id, company_name, department, position, begin_date, end_date, description, raw) VALUES (?,?,?,?,?,?,?,?,?,?)`),
    eduExp: db.prepare(`INSERT OR REPLACE INTO education_experiences (id, user_id, customer_id, school_name, major, degree, begin_date, end_date, raw) VALUES (?,?,?,?,?,?,?,?,?)`),
    reward: db.prepare(`INSERT OR REPLACE INTO user_rewards (id, user_id, customer_id, name, date, description, raw) VALUES (?,?,?,?,?,?,?)`),
    discipline: db.prepare(`INSERT OR REPLACE INTO user_disciplines (id, user_id, customer_id, discipline_type_id, start_date, end_date, reason, status, raw) VALUES (?,?,?,?,?,?,?,?,?)`),
  };

  db.transaction(() => {
    // personnel_appointments
    const paFile = readEndpoint(dir, "user-personnel-appointments.json");
    const seenPA = new Set<string>();
    for (const item of paFile?.data ?? []) {
      const userId = item.userIdHash;
      for (const pa of item.personnelAppointments ?? []) {
        const id = pa.personnelAppointmentIdHash;
        if (!seenPA.has(id)) {
          seenPA.add(id);
          if (
            !requireFields("personnel_appointments", id, {
              customer_id: pa.customerIdHash,
              status: pa.status,
            })
          ) {
            continue;
          }
          // creator_id가 users(id) FK이므로 placeholder로 등록
          if (pa.creatorIdHash) upsertUser(pa.creatorIdHash, "");
          ensureCustomer(pa.customerIdHash);
          const label = pa.personnelAppointmentLabel ?? {};
          stmts.pa.run(
            id, pa.customerIdHash, pa.creatorIdHash ?? null,
            pa.creatorType ?? null, pa.status,
            pa.applyDate ? pa.applyDate.slice(0, 10) : null,
            pa.createdDate ?? null, pa.lastModifiedDate ?? null,
            pa.personnelAppointmentLabelIdHash ?? null,
            label.name ?? null, label.type ?? null,
          );
          inc("personnel_appointments");
        }
        if (userId) {
          stmts.paUser.run(id, userId);
          inc("personnel_appointment_users");
          upsertUser(userId, "");
        }
      }
    }

    // user_resignations
    for (const r of readEndpoint(dir, "user-resignations.json")?.data ?? []) {
      const id = r.idHash ?? r.id;
      if (
        !requireFields("user_resignations", id, {
          user_id: r.userIdHash,
          customer_id: r.customerIdHash,
        })
      ) continue;
      ensureCustomer(r.customerIdHash);
      stmts.resignation.run(id, r.userIdHash, r.customerIdHash, r.resignationDate ?? null, r.type ?? null, r.reason ?? null, r.status ?? null, JSON.stringify(r));
      inc("user_resignations");
    }

    // leave_of_absences
    for (const l of readEndpoint(dir, "user-leave-of-absences.json")?.data ?? []) {
      const id = l.idHash ?? l.id;
      if (
        !requireFields("leave_of_absences", id, {
          user_id: l.userIdHash,
          customer_id: l.customerIdHash,
        })
      ) continue;
      ensureCustomer(l.customerIdHash);
      stmts.loa.run(id, l.userIdHash, l.customerIdHash, l.type ?? null, l.beginDate ?? null, l.endDate ?? null, l.status ?? null, l.reason ?? null, JSON.stringify(l));
      inc("leave_of_absences");
    }

    // dependent_families
    for (const d of readEndpoint(dir, "dependent-families-search.json")?.data?.responses ?? []) {
      const id = d.idHash ?? d.id;
      if (
        !requireFields("dependent_families", id, {
          user_id: d.userIdHash,
          customer_id: d.customerIdHash,
        })
      ) continue;
      ensureCustomer(d.customerIdHash);
      stmts.depFamily.run(id, d.userIdHash, d.customerIdHash, d.name ?? null, d.relation ?? null, d.birthDate ?? null, JSON.stringify(d));
      inc("dependent_families");
    }

    // work_experiences
    for (const w of readEndpoint(dir, "work-experiences-search.json")?.data?.workExperienceResponses ?? []) {
      const id = w.idHash ?? w.id;
      if (!requireFields("work_experiences", id, { user_id: w.userIdHash, customer_id: w.customerIdHash })) continue;
      ensureCustomer(w.customerIdHash);
      stmts.workExp.run(id, w.userIdHash, w.customerIdHash, w.companyName ?? null, w.department ?? null, w.position ?? null, w.beginDate ?? null, w.endDate ?? null, w.description ?? null, JSON.stringify(w));
      inc("work_experiences");
    }

    // education_experiences
    for (const e of readEndpoint(dir, "education-experiences-search.json")?.data?.educationExperienceResponses ?? []) {
      const id = e.idHash ?? e.id;
      if (!requireFields("education_experiences", id, { user_id: e.userIdHash, customer_id: e.customerIdHash })) continue;
      ensureCustomer(e.customerIdHash);
      stmts.eduExp.run(id, e.userIdHash, e.customerIdHash, e.schoolName ?? null, e.major ?? null, e.degree ?? null, e.beginDate ?? null, e.endDate ?? null, JSON.stringify(e));
      inc("education_experiences");
    }

    // user_rewards
    for (const r of readEndpoint(dir, "user-rewards-search.json")?.data?.list ?? []) {
      const id = r.idHash ?? r.id;
      if (!requireFields("user_rewards", id, { user_id: r.userIdHash, customer_id: r.customerIdHash })) continue;
      ensureCustomer(r.customerIdHash);
      stmts.reward.run(id, r.userIdHash, r.customerIdHash, r.name ?? null, r.date ?? null, r.description ?? null, JSON.stringify(r));
      inc("user_rewards");
    }

    // user_disciplines
    for (const d of readEndpoint(dir, "user-disciplines-search.json")?.data?.list ?? []) {
      const id = d.idHash ?? d.id;
      if (!requireFields("user_disciplines", id, { user_id: d.userIdHash, customer_id: d.customerIdHash })) continue;
      ensureCustomer(d.customerIdHash);
      stmts.discipline.run(id, d.userIdHash, d.customerIdHash, d.disciplineTypeIdHash ?? null, d.startDate ?? null, d.endDate ?? null, d.reason ?? null, d.status ?? null, JSON.stringify(d));
      inc("user_disciplines");
    }
  })();
}

// ============================================================
// Work Rules / Time Off / Holidays
// ============================================================
function importWorkTimeOff(
  db: Database.Database, dir: string,
  upsertUser: (id: string | undefined, name: string | undefined | null) => void,
  ensureCustomer: EnsureCustomer,
  logger: Logger, inc: Inc,
) {
  const stmts = {
    workRule: db.prepare(`
      INSERT OR REPLACE INTO work_rules
        (id, customer_id, rule_name, control_type, working_hour_type,
         working_period_unit, working_period_count, working_period_begin_date,
         auto_conversion_enabled, scheduling_enabled, base_agreed_day_minutes,
         calculation_strategy, is_primary, work_record_rule_id, week_working_hour_rule, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
    userWorkRule: db.prepare(`
      INSERT OR REPLACE INTO user_work_rules (id, user_id, customer_id, work_rule_id, date_from, date_to, assigned_at)
      VALUES (?,?,?,?,?,?,?)
    `),
    workForm: db.prepare(`
      INSERT OR REPLACE INTO work_forms
        (id, customer_id, name, description, type, paid_type, is_primary,
         active, display_order, emoji, icon_key, icon_color,
         usage_visibility, approval_enabled, approval_template_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
    workPlanAuto: db.prepare(`INSERT OR REPLACE INTO work_plan_auto (user_id, day_of_week, time_blocks) VALUES (?,?,?)`),
    workApprovalRule: db.prepare(`
      INSERT OR REPLACE INTO work_approval_rules
        (id, customer_id, type, name, display_order, emoji, approval_enabled, approval_template_key, description)
      VALUES (?,?,?,?,?,?,?,?,?)
    `),
    workingPeriod: db.prepare(`INSERT OR REPLACE INTO working_periods (user_id, from_date, to_date, unit, unit_count, zone_id) VALUES (?,?,?,?,?,?)`),
    timeOffPolicy: db.prepare(`
      INSERT OR REPLACE INTO time_off_policies
        (id, customer_id, type, category, name, description, display_order,
         emoji, icon_key, icon_color, paid_type, paid_unit, paid_value,
         active, legal_mandatory, assign_method, minimum_usage_limit,
         usage_gender_limit, minimum_usage_minutes, enable_early_use,
         enable_over_usage, approval_enabled, approval_template_key, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
    timeOffBucket: db.prepare(`
      INSERT OR REPLACE INTO time_off_buckets
        (user_id, policy_id, assigned_at, valid_usage_from, valid_usage_to,
         assigned_minutes, used_minutes, remaining_minutes, expiration_date, assign_method)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `),
    timeOffTask: db.prepare(`
      INSERT OR REPLACE INTO time_off_tasks
        (task_key, user_id, status, approval_status, date_from, date_to,
         date_count, memo, requested_at, terminated_at, approval_lines, content_units, raw)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `),
    holidayGroup: db.prepare(`INSERT OR REPLACE INTO holiday_groups (id, customer_id, name, is_default) VALUES (?,?,?,?)`),
    userHolidayGroup: db.prepare(`INSERT OR REPLACE INTO user_holiday_groups (user_id, holiday_group_id, customer_id) VALUES (?,?,?)`),
  };

  const seenPolicies = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function insertPolicy(policyId: string, customerId: string | null, form: any) {
    if (seenPolicies.has(policyId)) return;
    if (!customerId) {
      logger.warn(
        `time_off_policies 스킵: customer_id 없음 (policyId=${policyId})`,
      );
      return;
    }
    if (!form.timeOffPolicyType) {
      logger.warn(
        `time_off_policies 스킵: type 없음 (policyId=${policyId})`,
      );
      return;
    }
    ensureCustomer(customerId);
    seenPolicies.add(policyId);
    const disp = form.displayInfo ?? {};
    const paid = form.paid ?? {};
    const appr = form.approval ?? {};
    stmts.timeOffPolicy.run(
      policyId, customerId, form.timeOffPolicyType ?? null,
      form.category ?? null, disp.name ?? "", disp.description ?? null,
      disp.displayOrder ?? null, disp.emoji?.common ?? null,
      disp.icon?.key ?? null, disp.icon?.color ?? null,
      paid.paidType ?? null, paid.paidUnit ?? null, paid.paidValue ?? null,
      form.active !== false ? 1 : 0, form.legalMandatory ? 1 : 0,
      form.assignMethod ?? null, form.minimumUsageLimit ?? null,
      form.usageGenderLimit ?? null, form.minimumUsageMinutes ?? null,
      form.enableEarlyUse ? 1 : 0, form.enableOverUsage ? 1 : 0,
      appr.enabled ? 1 : 0, appr.templateKey ?? null, JSON.stringify(form),
    );
    inc("time_off_policies");
  }

  db.transaction(() => {
    // work_rules
    const wrFile = readEndpoint(dir, "work-rules-customer.json");
    for (const r of wrFile?.data?.workRules ?? []) {
      const pr = r.workingPeriodRule ?? {};
      ensureCustomer(r.customerIdHash);
      stmts.workRule.run(
        String(r.customerWorkRuleId), r.customerIdHash,
        r.ruleName ?? null, r.controlType ?? null, r.workingHourType ?? null,
        pr.unit ?? null, pr.count ?? null, pr.beginDate ?? null,
        r.autoConversionEnabled ? 1 : 0, r.schedulingEnabled ? 1 : 0,
        r.baseAgreedDayWorkingMinutes ?? null, r.workingHourCalculationStrategy ?? null,
        r.primary ? 1 : 0,
        r.workRecordRule?.customerWorkRecordRuleId ? String(r.workRecordRule.customerWorkRecordRuleId) : null,
        r.weekWorkingHourRule ? JSON.stringify(r.weekWorkingHourRule) : "[]",
        JSON.stringify(r),
      );
      inc("work_rules");
    }

    // user_work_rules
    const uwrFile = readEndpoint(dir, "work-rules-user.json");
    const uwr = uwrFile?.data?.workRule;
    if (uwr) {
      upsertUser(uwr.userIdHash, "");
      ensureCustomer(uwr.customerIdHash);
      stmts.userWorkRule.run(
        String(uwr.userWorkRuleId), uwr.userIdHash, uwr.customerIdHash,
        String(uwr.customerWorkRuleId), uwr.dateFrom, uwr.dateTo ?? null,
        uwr.eventTimeStamp ? new Date(uwr.eventTimeStamp).toISOString() : null,
      );
      inc("user_work_rules");
    }

    // work_forms
    const wfFile = readEndpoint(dir, "work-forms.json");
    for (const wf of wfFile?.data?.workForms ?? []) {
      const disp = wf.display ?? {};
      ensureCustomer(wf.customerIdHash);
      stmts.workForm.run(
        String(wf.customerWorkFormId), wf.customerIdHash,
        disp.name ?? "", disp.description ?? null,
        wf.type ?? "WORK", wf.paid?.paidType ?? null,
        wf.isPrimary ? 1 : 0, wf.active !== false ? 1 : 0,
        disp.displayOrder ?? null, disp.emoji?.common ?? null,
        disp.icon?.key ?? null, disp.icon?.color ?? null,
        wf.usageVisibility?.usageVisibility ?? null,
        wf.approval?.enabled ? 1 : 0, wf.approval?.templateKey ?? null,
      );
      inc("work_forms");
    }

    // work_plan_auto
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wpaFile = readEndpoint(dir, "work-plan-auto.json");
    const autoWorkPlan = wpaFile?.data?.autoWorkPlan ?? {};
    const wpaUserId = wpaFile?.url?.match(/\/users\/([^/]+)\//)?.[1] ?? null;
    if (wpaUserId) {
      // FK 무결성을 위해 user_id를 users 테이블에 등록
      upsertUser(wpaUserId, "");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const dayPlan of Object.values(autoWorkPlan) as any[]) {
        if (!dayPlan?.dayOfWeek) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const timeBlocks = (dayPlan.timeBlocks ?? []).map((tb: any) => ({
          workFormId: String(tb.customerWorkFormId), from: tb.timeBlockFrom, to: tb.timeBlockTo,
        }));
        stmts.workPlanAuto.run(wpaUserId, dayPlan.dayOfWeek, JSON.stringify(timeBlocks));
        inc("work_plan_auto");
      }
    }

    // work_approval_rules
    const warFile = readEndpoint(dir, "work-approval-rules.json");
    const war = warFile?.data?.workApprovalRule;
    if (war) {
      const disp = war.display ?? {};
      ensureCustomer(war.customerIdHash);
      stmts.workApprovalRule.run(
        String(war.customerWorkApprovalRuleId), war.customerIdHash,
        war.type, disp.name ?? null, disp.displayOrder ?? null,
        disp.emoji?.common ?? null, war.approval?.enabled ? 1 : 0,
        war.approval?.templateKey ?? null, war.description ?? null,
      );
      inc("work_approval_rules");
    }

    // working_periods
    const wpFile = readEndpoint(dir, "working-periods.json");
    const period = wpFile?.data?.period;
    if (period) {
      upsertUser(period.userIdHash, "");
      stmts.workingPeriod.run(
        period.userIdHash, period.from ?? period.startDate,
        period.to ?? period.endDateInclusive, period.unit,
        period.unitCount ?? null, period.zoneId ?? null,
      );
      inc("working_periods");
    }

    // time_off_policies (from time-off-forms)
    const tofFile = readEndpoint(dir, "time-off-forms.json");
    const tofCustomerId = tofFile?.url?.match(/\/customers\/([^/]+)\//)?.[1] ?? null;
    for (const item of tofFile?.data?.timeOffForms ?? []) {
      const f = item.customerTimeOffForm ?? item;
      insertPolicy(String(f.timeOffPolicyId), f.customerIdHash ?? tofCustomerId, f);
    }

    // time_off_policies (merge from time-off-policy-detail)
    const topdFile = readEndpoint(dir, "time-off-policy-detail.json");
    if (topdFile?.data) {
      const d = topdFile.data;
      const pid = String(d.timeOffPolicyIdHash ?? d.timeOffPolicyId);
      const custId = topdFile.url?.match(/\/customers\/([^/]+)\//)?.[1] ?? null;
      insertPolicy(pid, custId, d);
    }

    // time_off_buckets
    const tobFile = readEndpoint(dir, "time-off-buckets.json");
    const tobUserId = tobFile?.url?.match(/\/users\/([^/]+)\//)?.[1] ?? null;
    if (tobUserId) {
      upsertUser(tobUserId, "");
      for (const group of tobFile?.data?.groupedBucketsItems ?? []) {
        for (const b of group.buckets ?? []) {
          stmts.timeOffBucket.run(
            tobUserId, String(b.timeOffPolicyId), b.assignedAt,
            b.validUsageFrom ?? null, b.validUsageTo ?? null,
            b.assignedTime ?? 0, b.usedTime ?? 0,
            b.remainingTime?.timeOffMinutes ?? 0,
            b.expirationDate ?? null, b.assignMethod ?? null,
          );
          inc("time_off_buckets");
        }
      }
    }

    // time_off_tasks
    const totFile = readEndpoint(dir, "time-off-approval-task.json");
    const task = totFile?.data?.task;
    const content = totFile?.data?.content;
    if (task) {
      upsertUser(task.requesterIdHash, task.requester?.name ?? "");
      const ap = task.approvalProcess ?? {};
      stmts.timeOffTask.run(
        task.taskKey, task.requesterIdHash, task.status,
        ap.status ?? null, content?.range?.from ?? null,
        content?.range?.to ?? null, content?.range?.dateCount ?? null,
        content?.memo ?? null,
        task.requestedAt ? new Date(task.requestedAt).toISOString() : null,
        ap.terminatedAt ?? null,
        JSON.stringify(ap.lines ?? []),
        JSON.stringify(content?.contentUnits ?? []),
        JSON.stringify(totFile.data),
      );
      inc("time_off_tasks");
    }

    // holiday_groups
    const hgFile = readEndpoint(dir, "holiday-groups.json");
    const hg = hgFile?.data?.customerHolidayGroup;
    if (hg) {
      ensureCustomer(hg.customerIdHash);
      stmts.holidayGroup.run(hg.customerHolidayGroupIdHash, hg.customerIdHash, hg.name, hg.defaultGroup ? 1 : 0);
      inc("holiday_groups");
    }

    // user_holiday_groups
    const uhgFile = readEndpoint(dir, "holiday-user-groups.json");
    const mapping = uhgFile?.data?.holidayGroupUserMapping;
    if (mapping) {
      upsertUser(mapping.userIdHash, "");
      ensureCustomer(mapping.customerIdHash);
      stmts.userHolidayGroup.run(mapping.userIdHash, mapping.customerHolidayGroupIdHash, mapping.customerIdHash);
      inc("user_holiday_groups");
    }
  })();
}

// ============================================================
// Other (Calendar, Todo, Feedback, Attachments, etc.)
// ============================================================
function importOther(
  db: Database.Database, dir: string,
  upsertUser: (id: string | undefined, name: string | undefined | null) => void,
  ensureCustomer: EnsureCustomer,
  _logger: Logger, inc: Inc,
) {
  const stmts = {
    calendar: db.prepare(`INSERT OR REPLACE INTO calendars (id, user_id, customer_id, summary, time_zone, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`),
    todo: db.prepare(`INSERT OR REPLACE INTO todos (id, type, title, preview_content, status, reference_type, reference_key, reference_json, requester_id, requester_type, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`),
    todoAssignee: db.prepare(`INSERT OR IGNORE INTO todo_assignees (todo_id, user_id) VALUES (?,?)`),
    feedback: db.prepare(`INSERT OR REPLACE INTO feedbacks (id, type, writer_id, writer_name, content, published_at, created_at, updated_at, hidden, purpose_templates, access_scopes, reaction_metas, comment_count) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    feedbackReceiver: db.prepare(`INSERT OR IGNORE INTO feedback_receivers (feedback_id, type, target_id, name) VALUES (?,?,?,?)`),
    feedbackReaction: db.prepare(`INSERT OR IGNORE INTO feedback_reactions (feedback_id, actor_id, actor_name, reaction_template_id) VALUES (?,?,?,?)`),
    customerAttachment: db.prepare(`INSERT OR REPLACE INTO customer_attachments (id, customer_id, type, name, description, display_order, link_uri, file_key, file_name, file_url, modified_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
    subscriptionFeature: db.prepare(`INSERT OR REPLACE INTO subscription_features (customer_id, feature_key, status) VALUES (?,?,?)`),
    imagePreset: db.prepare(`INSERT OR REPLACE INTO image_presets (id, type, public_url, public_thumb_url) VALUES (?,?,?,?)`),
  };

  db.transaction(() => {
    // calendars
    for (const filename of ["calendar-primary.json", "calendar-coworkers.json"]) {
      const raw = readEndpoint(dir, filename);
      if (!raw) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = filename === "calendar-primary.json" ? (raw.data ? [raw.data] : []) : (raw.data?.calendars ?? []);
      for (const cal of items) {
        upsertUser(cal.userIdHash, cal.userDisplayName ?? "");
        ensureCustomer(cal.customerIdHash);
        stmts.calendar.run(cal.id ?? cal.token, cal.userIdHash, cal.customerIdHash, cal.summary ?? null, cal.timeZone ?? "Asia/Seoul", cal.createdAt ?? null, cal.updatedAt ?? null);
        inc("calendars");
      }
    }

    // todos
    const todoRaw = readEndpoint(dir, "todo-search.json");
    for (const todo of todoRaw?.data?.assignedTodos ?? []) {
      const req = todo.requester?.user;
      if (req) upsertUser(req.idHash, req.name ?? "");
      stmts.todo.run(
        todo.id, todo.type ?? null, todo.title ?? null,
        todo.previewContent ?? null, todo.status,
        todo.reference?.referenceType ?? null, todo.reference?.referenceKey ?? null,
        todo.reference?.referenceJson ? JSON.stringify(todo.reference.referenceJson) : null,
        req?.idHash ?? null, todo.requester?.type ?? null,
        todo.createdAt ?? null, todo.updatedAt ?? null,
      );
      inc("todos");
      for (const target of todo.assigneeTargetPreview?.targets ?? []) {
        for (const tu of target.targetUsers ?? []) {
          const u = tu.user ?? tu;
          upsertUser(u.idHash, u.name ?? "");
          stmts.todoAssignee.run(todo.id, u.idHash);
          inc("todo_assignees");
        }
      }
    }

    // feedbacks
    const fbRaw = readEndpoint(dir, "feedback-chunk.json");
    for (const fb of fbRaw?.data?.items ?? []) {
      upsertUser(fb.writerUuid, fb.writer?.displayName ?? "");
      stmts.feedback.run(
        fb.idHash, fb.type, fb.writerUuid ?? null, fb.writer?.displayName ?? null,
        fb.content ?? null, fb.publishedAt ?? null, fb.createdAt ?? null,
        fb.updatedAt ?? null, fb.hidden ? 1 : 0,
        JSON.stringify(fb.purposeTemplates ?? []),
        JSON.stringify(fb.accessScopes ?? []),
        JSON.stringify(fb.reactionMetas ?? []),
        fb.commentMeta?.count ?? 0,
      );
      inc("feedbacks");
      for (const rec of fb.receivers ?? []) {
        stmts.feedbackReceiver.run(fb.idHash, rec.type, rec.uuid || null, rec.name ?? null);
        inc("feedback_receivers");
      }
      for (const reaction of fb.reactions ?? []) {
        upsertUser(reaction.actorUuid, reaction.actor?.displayName ?? "");
        stmts.feedbackReaction.run(fb.idHash, reaction.actorUuid ?? null, reaction.actor?.displayName ?? null, reaction.feedbackReactionTemplateId ?? null);
        inc("feedback_reactions");
      }
    }

    // customer_attachments
    // file_key가 files(file_key) FK이므로 다운로드되지 않은 파일도 placeholder로 보장
    const ensureFilePlaceholder = db.prepare("INSERT OR IGNORE INTO files (file_key) VALUES (?)");
    for (const att of readEndpoint(dir, "customer-attachments-search.json")?.data ?? []) {
      ensureCustomer(att.customerIdHash);
      const fileKey = att.fileKey ?? null;
      if (fileKey) ensureFilePlaceholder.run(fileKey);
      stmts.customerAttachment.run(
        att.idHash, att.customerIdHash, att.type ?? null, att.name ?? null,
        att.description ?? null, att.displayOrder ?? null, att.linkUri || null,
        fileKey, att.fileName ?? null, att.fileUrl ?? null,
        att.modifiedDate ?? null,
      );
      inc("customer_attachments");
    }

    // subscription_features
    const subRaw = readEndpoint(dir, "subscription-features.json");
    if (subRaw?.data) {
      const customerId = subRaw.url?.match(/customers\/([^/]+)\/features/)?.[1] ?? null;
      if (customerId) {
        ensureCustomer(customerId);
        for (const key of subRaw.data.activatedFeatureKeys ?? []) {
          stmts.subscriptionFeature.run(customerId, key, "ACTIVE");
          inc("subscription_features");
        }
        for (const key of subRaw.data.expiredFeatureKeys ?? []) {
          stmts.subscriptionFeature.run(customerId, key, "EXPIRED");
          inc("subscription_features");
        }
      }
    }

    // image_presets
    for (const preset of readEndpoint(dir, "image-presets-search.json")?.data ?? []) {
      stmts.imagePreset.run(preset.idHash, preset.type, preset.publicUrl ?? null, preset.publicThumbnailUrl ?? null);
      inc("image_presets");
    }

    // stakeholder-users → upsert users only
    for (const user of readEndpoint(dir, "stakeholder-users.json")?.data ?? []) {
      upsertUser(user.uuid, user.name ?? "");
    }
  })();
}
