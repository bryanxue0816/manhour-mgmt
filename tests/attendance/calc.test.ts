// D-110 acceptance: the five worked examples from the 2026-07-13 department daily
// attendance sheet, plus the invariants that make them meaningful.
//
// Every test here runs against object literals. `lib/attendance/calc.ts` is prisma-free
// on purpose (that is why `aliasKey` lives in `lib/db/section-key.ts`), so this suite
// needs no database, no DATABASE_URL, no better-sqlite3 binding and no .xls fixture.
//
// The homoglyph pair is written as escape sequences rather than literal glyphs. 检査课
// and 检查课 are visually identical in most editors and fonts; spelling them out by
// codepoint is the only way this file stays reviewable.

import { describe, expect, it } from "vitest";

import {
  aggregateAttendance,
  buildRuleIndex,
  buildSectionIndex,
  computeAttendanceRow,
  computeAttendanceRows,
  contributionOf,
  overtimeHoursOf,
  personnelHoursOf,
  resolveSectionId,
  rowHoursOf,
  ruleVerdict,
  type AttendanceCalcContext,
  type AttendanceFacts,
  type AttendanceHourInputs,
} from "@/lib/attendance/calc";
import { aliasKey } from "@/lib/db/section-key";
import type { JobTitleRuleDto, OrgSnapshot } from "@/lib/db/types";

/** 检査课 - org master spelling (査 = U+67FB). */
const ORG_SECTION_NAME = "检査课";
/** 检查课 - HR export spelling (查 = U+67E5). Never string-equal to the above. */
const HR_SECTION_NAME = "检查课";

const QA_DEPT_NAME = "品质保证部";
const QA_SECTION_ID = "sec-inspection";

const ZERO_HOURS: AttendanceHourInputs = {
  leaveHours: 0,
  workHours: 0,
  normalOvertime: 0,
  restDayDouble: 0,
  holidayOvertime: 0,
  restDayCompensate: 0,
  compensatoryLeave: 0,
  maternityLeave: 0,
  nursingLeave: 0,
  miscarriageLeave: 0,
};

/** The seeded exclusion set, trimmed to the titles these tests exercise (D-107/D-108/D-161). */
const RULES: readonly JobTitleRuleDto[] = [
  { jobTitle: "部长", excludePersonnelHours: true, excludeOvertimeHours: true, remark: null },
  { jobTitle: "工场长", excludePersonnelHours: true, excludeOvertimeHours: true, remark: null },
  { jobTitle: "高级课长", excludePersonnelHours: true, excludeOvertimeHours: true, remark: null },
  { jobTitle: "课长", excludePersonnelHours: false, excludeOvertimeHours: true, remark: null },
];

const RULE_INDEX = buildRuleIndex(RULES);

/** 2026-07-13, the day the D-110 examples were taken from: fiscal year 2026, month 4. */
const WORK_DATE = new Date(Date.UTC(2026, 6, 13));

function hours(overrides: Partial<AttendanceHourInputs>): AttendanceHourInputs {
  return { ...ZERO_HOURS, ...overrides };
}

function facts(overrides: Partial<AttendanceFacts>): AttendanceFacts {
  return {
    ...ZERO_HOURS,
    workDate: WORK_DATE,
    hrDeptName: QA_DEPT_NAME,
    hrSectionName: HR_SECTION_NAME,
    jobTitle: null,
    ...overrides,
  };
}

/** Minimal two-section org: one section reached by alias, one reached by exact name. */
const SNAPSHOT: OrgSnapshot = {
  departments: [
    {
      id: "dept-qa",
      name: QA_DEPT_NAME,
      code: null,
      sortOrder: 4,
      managerName: null,
      managerEmail: null,
    },
  ],
  sections: [
    {
      id: QA_SECTION_ID,
      departmentId: "dept-qa",
      name: ORG_SECTION_NAME,
      sortOrder: 1,
      managerName: null,
      managerEmail: null,
    },
    {
      id: "sec-quality",
      departmentId: "dept-qa",
      name: "品质课",
      sortOrder: 2,
      managerName: null,
      managerEmail: null,
    },
  ],
};

const CONTEXT: AttendanceCalcContext = {
  sectionIndex: buildSectionIndex(SNAPSHOT),
  aliasIndex: new Map([[aliasKey(QA_DEPT_NAME, HR_SECTION_NAME), QA_SECTION_ID]]),
  ruleIndex: RULE_INDEX,
};

/**
 * The five D-110 rows, each asserted as (人员工时, 加班工时, 总工时) AFTER exclusion.
 *
 * `inputs` uses the export's own column letters: R = 请假时间, S = 上班时数,
 * Z = 平时加班, AF = 调休假时数.
 */
const D110_CASES: readonly {
  name: string;
  jobTitle: string;
  inputs: AttendanceHourInputs;
  expected: { personnelHours: number; overtimeHours: number; totalHours: number };
}[] = [
  {
    name: "薛平 课长 - 正常出勤, 人员工时计入, 加班排除",
    jobTitle: "课长",
    inputs: hours({ workHours: 8 }),
    expected: { personnelHours: 8, overtimeHours: 0, totalHours: 8 },
  },
  {
    name: "胡正 主管 - 无排除规则, 全额计入",
    jobTitle: "主管",
    inputs: hours({ workHours: 8 }),
    expected: { personnelHours: 8, overtimeHours: 0, totalHours: 8 },
  },
  {
    name: "陈勇 司机 - 用掉 8h 调休余额, 加班工时为负, 总工时归零",
    jobTitle: "司机",
    inputs: hours({ leaveHours: 8, compensatoryLeave: 8 }),
    expected: { personnelHours: 8, overtimeHours: -8, totalHours: 0 },
  },
  {
    name: "孙娟 部长 - 两侧皆排除, 当日工时恒为 0",
    jobTitle: "部长",
    inputs: hours({ workHours: 8, normalOvertime: 0.5 }),
    expected: { personnelHours: 0, overtimeHours: 0, totalHours: 0 },
  },
  {
    name: "吕燕芳 主管 - 年休假 8h 计入人员工时",
    jobTitle: "主管",
    inputs: hours({ leaveHours: 8 }),
    expected: { personnelHours: 8, overtimeHours: 0, totalHours: 8 },
  },
];

describe("D-110 单日总工时样例", () => {
  for (const testCase of D110_CASES) {
    it(testCase.name, () => {
      const verdict = ruleVerdict(testCase.jobTitle, RULE_INDEX);
      const contribution = contributionOf(rowHoursOf(testCase.inputs), verdict);
      expect(contribution).toEqual(testCase.expected);
    });
  }

  it("孙娟 的原始行小计是 8.5, 排除后的贡献必须重算而不是沿用", () => {
    const raw = rowHoursOf(hours({ workHours: 8, normalOvertime: 0.5 }));
    expect(raw.totalHours).toBe(8.5);

    const contribution = contributionOf(raw, ruleVerdict("部长", RULE_INDEX));
    expect(contribution.totalHours).toBe(0);
  });
});

describe("D-104/D-105/D-106 公式", () => {
  it("人员工时 = R + S", () => {
    expect(personnelHoursOf(hours({ leaveHours: 3.5, workHours: 4 }))).toBe(7.5);
  });

  it("加班工时 = (Z + AA + AB + AD) - (AF + AV + AY + BA)", () => {
    const value = overtimeHoursOf(
      hours({
        normalOvertime: 1,
        restDayDouble: 2,
        holidayOvertime: 4,
        restDayCompensate: 8,
        compensatoryLeave: 0.5,
        maternityLeave: 0.25,
        nursingLeave: 0.125,
        miscarriageLeave: 0.0625,
      }),
    );
    expect(value).toBe(15 - 0.9375);
  });

  it("加班工时可以为负, 不做任何 clamp", () => {
    expect(overtimeHoursOf(hours({ compensatoryLeave: 8 }))).toBe(-8);
    expect(rowHoursOf(hours({ maternityLeave: 4 })).overtimeHours).toBe(-4);
  });

  it("总工时 = 人员工时 + 加班工时", () => {
    const inputs = hours({ leaveHours: 2, workHours: 6, normalOvertime: 1.5 });
    const result = rowHoursOf(inputs);
    expect(result.personnelHours).toBe(8);
    expect(result.overtimeHours).toBe(1.5);
    expect(result.totalHours).toBe(9.5);
  });

  it("非有限数值被拒绝而不是写入数据库", () => {
    expect(() => rowHoursOf(hours({ workHours: Number.POSITIVE_INFINITY }))).toThrow();
    expect(() => rowHoursOf(hours({ workHours: Number.NaN }))).toThrow();
  });
});

describe("D-107/D-108 职务排除判定", () => {
  it("缺规则的职务两侧皆不排除 - 这是常态而非异常", () => {
    expect(ruleVerdict("主管", RULE_INDEX)).toEqual({
      excludedPersonnel: false,
      excludedOvertime: false,
    });
    expect(ruleVerdict("司机", RULE_INDEX)).toEqual({
      excludedPersonnel: false,
      excludedOvertime: false,
    });
  });

  it("职务为空匹配不到任何规则, 永不排除", () => {
    expect(ruleVerdict(null, RULE_INDEX)).toEqual({
      excludedPersonnel: false,
      excludedOvertime: false,
    });
  });

  it("部长以上两侧皆排除, 课长仅排除加班", () => {
    expect(ruleVerdict("部长", RULE_INDEX)).toEqual({
      excludedPersonnel: true,
      excludedOvertime: true,
    });
    expect(ruleVerdict("工场长", RULE_INDEX)).toEqual({
      excludedPersonnel: true,
      excludedOvertime: true,
    });
    expect(ruleVerdict("高级课长", RULE_INDEX)).toEqual({
      excludedPersonnel: true,
      excludedOvertime: true,
    });
    expect(ruleVerdict("课长", RULE_INDEX)).toEqual({
      excludedPersonnel: false,
      excludedOvertime: true,
    });
  });

  it("排除是归零而不是跳过 - 行仍然解析出课别与月份", () => {
    const row = computeAttendanceRow(
      facts({ jobTitle: "部长", workHours: 8, normalOvertime: 0.5 }),
      CONTEXT,
    );
    expect(row.sectionId).toBe(QA_SECTION_ID);
    expect(row.month).toBe(4);
    expect(row.fiscalYear).toBe(2026);
    expect(row.excludedPersonnel).toBe(true);
    expect(row.excludedOvertime).toBe(true);
    // The row keeps its own uncontributed figures; only the fold drops them.
    expect(row.personnelHours).toBe(8);
    expect(row.overtimeHours).toBe(0.5);
  });
});

describe("课别解析", () => {
  it("同形异码字通过别名表命中", () => {
    expect(ORG_SECTION_NAME).not.toBe(HR_SECTION_NAME);
    expect([...HR_SECTION_NAME].map((char) => char.codePointAt(0))).toEqual([
      0x68c0, 0x67e5, 0x8bfe,
    ]);
    expect(
      resolveSectionId({ hrDeptName: QA_DEPT_NAME, hrSectionName: HR_SECTION_NAME }, CONTEXT),
    ).toBe(QA_SECTION_ID);
  });

  it("与组织主数据完全同名时直接命中, 无需别名", () => {
    expect(resolveSectionId({ hrDeptName: QA_DEPT_NAME, hrSectionName: "品质课" }, CONTEXT)).toBe(
      "sec-quality",
    );
  });

  it("比较逐字节进行 - 不 trim, 不做 NFKC 归一", () => {
    expect(
      resolveSectionId({ hrDeptName: QA_DEPT_NAME, hrSectionName: ` ${HR_SECTION_NAME}` }, CONTEXT),
    ).toBeNull();
  });

  it("课别为空按 '部|' 查找, 未命中则归入未归属", () => {
    expect(resolveSectionId({ hrDeptName: QA_DEPT_NAME, hrSectionName: null }, CONTEXT)).toBeNull();
  });

  it("未知部别归入未归属而不是抛错", () => {
    expect(resolveSectionId({ hrDeptName: "不存在部", hrSectionName: "某课" }, CONTEXT)).toBeNull();
  });
});

describe("section x month 聚合", () => {
  it("按课别与财月折叠, 未归属工时单独成桶", () => {
    const rows: AttendanceFacts[] = [
      facts({ jobTitle: "主管", workHours: 8 }),
      facts({ jobTitle: "课长", workHours: 8, normalOvertime: 2 }),
      facts({ hrSectionName: "品质课", jobTitle: "司机", leaveHours: 8, compensatoryLeave: 8 }),
      facts({ hrDeptName: "制造部", hrSectionName: "DMHZ支援人员", jobTitle: "主管", workHours: 8 }),
    ];
    const computed = computeAttendanceRows(rows, CONTEXT);
    const result = aggregateAttendance(computed, rows);

    expect(result.aggregates).toHaveLength(2);

    const inspection = result.aggregates.find((row) => row.sectionId === QA_SECTION_ID);
    expect(inspection).toEqual({
      sectionId: QA_SECTION_ID,
      fiscalYear: 2026,
      month: 4,
      personnelHours: 16,
      overtimeHours: 0,
      totalHours: 16,
    });

    const quality = result.aggregates.find((row) => row.sectionId === "sec-quality");
    expect(quality?.personnelHours).toBe(8);
    expect(quality?.overtimeHours).toBe(-8);
    expect(quality?.totalHours).toBe(0);

    expect(result.unattributedRows).toBe(1);
    expect(result.unattributedHours).toBe(8);
    expect(result.unattributed).toEqual([
      { hrDeptName: "制造部", hrSectionName: "DMHZ支援人员", rowCount: 1, totalHours: 8 },
    ]);
  });

  it("排除可能抬高加班合计 - 任何 '排除只会减少' 的假设都是错的", () => {
    const rows: AttendanceFacts[] = [
      facts({ jobTitle: "主管", workHours: 8, normalOvertime: 4 }),
      facts({ jobTitle: "课长", workHours: 8, compensatoryLeave: 8 }),
    ];
    const computed = computeAttendanceRows(rows, CONTEXT);

    const preExclusion = computed.reduce((sum, row) => sum + row.overtimeHours, 0);
    const postExclusion = aggregateAttendance(computed, rows).aggregates[0]?.overtimeHours;

    expect(preExclusion).toBe(-4);
    expect(postExclusion).toBe(4);
  });

  it("跨财月的行不会被折叠到同一桶", () => {
    const rows: AttendanceFacts[] = [
      facts({ workDate: new Date(Date.UTC(2026, 6, 13)), workHours: 8 }),
      facts({ workDate: new Date(Date.UTC(2026, 7, 13)), workHours: 8 }),
      facts({ workDate: new Date(Date.UTC(2027, 0, 13)), workHours: 8 }),
    ];
    const result = aggregateAttendance(computeAttendanceRows(rows, CONTEXT), rows);

    expect(result.aggregates.map((row) => [row.fiscalYear, row.month])).toEqual([
      [2026, 4],
      [2026, 5],
      [2026, 10],
    ]);
  });

  it("空输入产生空聚合", () => {
    const result = aggregateAttendance([], []);
    expect(result.aggregates).toEqual([]);
    expect(result.unattributed).toEqual([]);
    expect(result.unattributedRows).toBe(0);
    expect(result.unattributedHours).toBe(0);
  });

  it("computed 与 facts 长度不一致时抛错, 不静默错位", () => {
    const rows = [facts({ workHours: 8 })];
    const computed = computeAttendanceRows(rows, CONTEXT);
    expect(() => aggregateAttendance([...computed, ...computed], rows)).toThrow(
      /index-parallel/,
    );
  });
});

describe("日期边界", () => {
  it("带时间分量的出勤日期被拒绝, 不静默截断", () => {
    expect(() =>
      computeAttendanceRow(facts({ workDate: new Date(Date.UTC(2026, 6, 13, 9)) }), CONTEXT),
    ).toThrow(/calendar day/);
  });

  it("3 月 31 日属于上一财年的第 12 月", () => {
    const row = computeAttendanceRow(
      facts({ workDate: new Date(Date.UTC(2027, 2, 31)), workHours: 8 }),
      CONTEXT,
    );
    expect(row.fiscalYear).toBe(2026);
    expect(row.month).toBe(12);
  });

  it("4 月 1 日是新财年的第 1 月", () => {
    const row = computeAttendanceRow(
      facts({ workDate: new Date(Date.UTC(2027, 3, 1)), workHours: 8 }),
      CONTEXT,
    );
    expect(row.fiscalYear).toBe(2027);
    expect(row.month).toBe(1);
  });
});
