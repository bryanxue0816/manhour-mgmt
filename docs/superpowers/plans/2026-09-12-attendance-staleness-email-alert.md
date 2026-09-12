# 考勤数据停摆管理员邮件告警（第一期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通「检测考勤停摆 → 频控 → 中文模板 → SMTP 投递/dry-run → 运维可见性」最小真实发信管道（walking skeleton），宿主 cron 每日 09:20/15:20 触发容器内独立脚本，SMTP 未配齐时自动干跑。

**Architecture:** 6 个新 alerts 纯逻辑/IO 模块 + 1 个共享邮箱校验模块，编排层 `alert-service` 全部 IO 依赖注入（内存假件测试，不碰 fs/nodemailer/prisma）；脚本薄壳仿 `fetch-attendance.ts`（相对 import、无顶层 await、finally `$disconnect`）；管理面为零 client JS 的 Server Component 子页 `/admin/alerts` + 主页只读角标；频控状态存数据卷 `alert-state.json`（意图先落盘再发送，崩溃安全），不建表、不 migration。

**Tech Stack:** Next.js 16.3 App Router（Server Component / Server Action / 原生 `<form>`）、TypeScript 5 strict、Prisma 7 better-sqlite3、Vitest 4（node 环境，禁 jsdom）、tsx、nodemailer 10（实施获批后安装）、Docker 三阶段镜像。

**依据 spec：** `docs/superpowers/specs/2026-09-10-attendance-staleness-email-alert-design.md`（2026-09-12 用户「go」书面批准，1614 行）。本计划中所有测试代码逐字取自 spec §7；模块契约逐字对齐 spec §5。

---

## 0. 执行前必读（铁律与约定，优先级高于下文任何步骤）

1. **HARD-GATE**：本计划编写阶段只产出本文件；执行阶段开工必须另有用户明确批准。未经许可不 commit/push、不打包、不连机、不启停生产容器、不跑 `npm install`（Task 7 的 nodemailer 安装是显式 🛑 请批点）。
2. **「提交检查点」≠ 自动 commit**：每个 Task 的 Step 5 在本项目语义下＝**停下，向用户报告本任务的命令输出与改动面，等书面许可后再 commit**。ManhourAutoCommit 每 20 分钟自动 `wip:` 提交 `app/`（HEAD 异常陈旧先查 `.autocommit/log.txt`）；自动 wip 不等于里程碑许可。
3. **口令与 PII**：真实邮箱值、SMTP 密码绝不落盘（用户贴进聊天也不写文件；只读长度不读值）；31 个经理邮箱本期不用；日志/视图模型只出现收件人**数量**，不出现地址值。不传 `manhour-prod.db`；永不跑 `npm run db:seed`；不手改 `actual_adjustment`；不手改任何库数据（端到端只通过真实库自然状态）。
4. **代码风格**：双引号、无分号、2 空格缩进、注释一律英文、不可变更新（spread 新对象，不 mutate 入参）。新测试 AAA、描述性命名、node 环境；**禁止引入 jsdom**。Next.js 16 的 `redirect`/Server Action/原生 form/searchParams 用法，Task 13 动手前必须先查 `node_modules/next/dist/docs/`（AGENTS.md 铁律），不凭训练数据写。
5. **TDD 纪律**：严格红→绿：先写测试文件→`npx vitest run <file>` 看红（模块不存在）→最小实现→看绿。每个 Task 结束跑对应门禁子集；Task 15 跑全量门禁五连。
6. **单测命令与计数**：单文件 `npx vitest run tests/alerts/<name>.test.ts`；全量 `npm test`。起点 **683 用例 / 35 文件全绿**；Task 9 后 **758 / 41**（spec §7.6 原列 12 例，计划按仲裁 A 补 3 例＝service 文件 15 例）；Task 11 完成后目标 **764 用例 / 42 文件**。
7. **相对 import 边界**：`scripts/*.ts` 用相对 import（`../src/lib/...`）；`src/` 内新文件一律用 `@/` 别名（与现有 lib 一致）。Task 17 镜像实测若 tsx 不解析 `@/`（R2），退路是把 alerts 链路改为相对 import，届时只在 Task 17 内机械修改，不预先做。
8. **spec 仲裁与勘误（写计划时已裁决，执行时照此；其中 🟠 项需用户确认）**：
   - **仲裁 A（dry-run 不建状态文件）**：spec §8 镜像实测旧稿写「alert-state.json 在数据卷生成」与 §5.1.7/§7.6「dry-run 永不创建/推进状态文件」矛盾。**以测试契约为准**：dry-run 永不创建状态文件；Task 10（本地）/Task 17（镜像实测）的验证改为观察横幅、JSON 日志、退出码，并断言状态文件**不存在**。补充条款：spec §5.1.7 第 5 步的 dry-run 规则原文只覆盖三个 send 决策，但若 dry-run 下 `skip`/`baseline` 仍写 `checkedState`/`baselineState`，健康系统首次干跑就会建文件，与仲裁 A 的容器实测断言冲突；故 Task 9 实现把「不存在则不创建、已存在只 touchedState」统一前置到**所有决策**，并在 §7.6 的 12 例外补 3 例钉死。
   - **仲裁 B（loader 动态 import）**：`src/lib/prisma.ts` 在模块加载期立即建 better-sqlite3 客户端，而 vitest 不加载 `.env`（缺 DATABASE_URL 即 throw）。`alerts-summary.ts` 的 `loadAlertBadgeData`/`loadAlertsPageData` 必须在函数体内**动态 import** `@/lib/db/import-log.repo`（prisma 由此进入），保证文件静态依赖 prisma-free，`tests/admin/alerts-view.test.ts` 直接 import 纯函数不炸。
   - **仲裁 C（导航与外壳）**：`MainNav` 的 `NavKey` 无 `"alerts"`，子页传 `active="admin"`（本期不扩 NavKey）；`Block` 是 `admin/page.tsx` 私有组件，alerts 子页仿 audit 页自建 `<div className="overflow-hidden rounded-lg bg-card ring-1 ring-border">` 外壳，不改 Block 可见性。
   - **仲裁 D（runbook 落点）**：spec §6.2 写的 `deploy/DEPLOY-RUNBOOK-*` 在仓库不存在；实际 runbook 是中文 `docs/DEPLOY.md`。考勤告警章作为「第 10 步附」插入该文件第 10 步与第 11 步之间，不重编现有步号。
   - **✅ 勘误 E（spec §7.2 自相矛盾）——用户已于 2026-09-12 裁决：采纳行为契约修正。** `alert-state.test.ts` 末例 spec 原文断言 `touched.lastAlertDate` 为 `null`，但同一用例中 `failed` 继承 send-first intent（`lastAlertDate: "2026-09-11"`），且 spec §5.1.3 要求 touchedState「不动任何频控日期」，两者不可能同时成立。**裁决结论：以行为契约为准**，该断言按 `expect(touched.lastAlertDate).toBe(failed.lastAlertDate)`（即 `"2026-09-11"`）执行；Task 4 内嵌的测试即最终版，无需再改 spec 或退回评审。
   - **勘误 F（spec §7.2 import 漏项）**：测试体调用了 `touchedState` 但 import 清单漏列。Task 4 的测试代码已补上，无需用户决策。

---

## 文件结构（21 新增 / 5 修改，锁文件随 Task 7）

**新增库模块（7）：**

| 文件 | 职责 |
|---|---|
| `src/lib/validation/email.ts` | 共享邮箱形状谓词 `isLikelyEmailAddress`（从 admin/actions.ts 抽取，单一事实源） |
| `src/lib/alerts/email-config.ts` | env→三态配置（live / dry-run / config-error），纯函数 |
| `src/lib/alerts/alert-state.ts` | 状态文件路径推导、temp+rename IO、9 字段状态迁移纯函数、+08:00 时间戳 |
| `src/lib/alerts/alert-decision.ts` | 11 行决策矩阵，纯函数 |
| `src/lib/alerts/alert-template.ts` | 停摆/恢复/测试三封中文 UTF-8 纯文本邮件，纯函数 |
| `src/lib/alerts/email-sender.ts` | nodemailer live 发送 / dry-run JSON 日志；错误脱敏不抛错 |
| `src/lib/alerts/alert-service.ts` | 单次扫描编排（IO 全注入）+ `exitCodeFor` |

**新增入口/页面/运维（7）：** `scripts/check-attendance-alert.ts`、`src/app/admin/alerts/page.tsx`、`src/app/admin/alerts/actions.ts`、`src/app/admin/alerts/alerts-summary.ts`、`src/app/admin/_components/AlertStatusBadge.tsx`、`deploy/cron/check-attendance-alert.sh`、`deploy/cron/crontab.example`。

**新增测试（7）：** `tests/alerts/` 下 `alert-decision.test.ts`(13)、`alert-state.test.ts`(13)、`email-config.test.ts`(18)、`alert-template.test.ts`(8)、`alert-service.test.ts`(12)、`exit-code.test.ts`(8)，加 `tests/admin/alerts-view.test.ts`(6) ＝ **78 用例**。

**修改（5+锁文件）：** `package.json`/`package-lock.json`（Task 7）、`Dockerfile`（Task 16）、`.env.production.example`（Task 14）、`src/app/admin/page.tsx`（Task 12）、`src/app/admin/actions.ts`（Task 2）、`docs/DEPLOY.md`（Task 16）。不动：schema.prisma、migration、compose、nginx、next.config、vitest 配置、tsconfig；不新增 npm script。

---

## Task 1: 基线全绿与静态 import 图核对

**Files:** 无改动（只核实）

- [ ] **Step 1: 重新生成 Prisma client 并跑基线门禁子集**

Run:

```bash
npm run db:generate && npm run typecheck && npm test
```

Expected: `npm test` 输出 `Test Files  35 passed (35)`、`Tests  683 passed (683)`；typecheck 零错误。若不是 35/683，停止——基线已脏，先查 ManhourAutoCommit 与工作区状态，不要在脏基线上开工。

- [ ] **Step 2: 核对脚本/lib 的 import 边界（R2 前置事实）**

Run:

```bash
grep -n '^import' scripts/fetch-attendance.ts
grep -rn "from \"@/" src/lib/alerts 2>/dev/null || echo "alerts dir not created yet (expected)"
```

Expected: fetch-attendance.ts 全部相对 import（`../src/lib/...`）；alerts 目录尚不存在。这两条是 Task 10（脚本相对 import）与 Task 17（`@/` 解析实测）的事实基线。

- [ ] **Step 3: 检查点（不自动 commit）**

本任务无文件改动。向用户报告基线命令输出（35 文件 / 683 用例），继续 Task 2。

---

## Task 2: 抽取共享邮箱形状谓词 email.ts（纯重构，行为不变）

**Files:**
- Create: `src/lib/validation/email.ts`
- Modify: `src/app/admin/actions.ts`（删除 `:181` 本地 `EMAIL_SHAPE`，改 import；`parseOptionalEmail` 行为不变）
- Test: 无新增测试文件（既有全量回归兜底；`tests/security/action-gates.test.ts`、`tests/admin/section-rename-action.test.ts` 覆盖 actions 模块加载）

- [ ] **Step 1: 创建 `src/lib/validation/email.ts`（完整内容）**

```ts
// Single fact source for the deliberately permissive mailbox shape. Keep this
// identical in spirit to the former admin/actions.ts EMAIL_SHAPE: one @, non-empty
// sides, at least one dot in the domain, no whitespace or list separators. A
// stricter regex rejects legitimate intranet addresses (D-150).
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function isLikelyEmailAddress(value: string): boolean {
  return EMAIL_SHAPE.test(value);
}
```

- [ ] **Step 2: 修改 `src/app/admin/actions.ts`**

在 import 区（`@/lib/auth` 一组附近）新增一行：

```ts
import { isLikelyEmailAddress } from "@/lib/validation/email";
```

删除本地正则这一行（原 `:181`）：

```ts
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
```

把 `parseOptionalEmail` 内的判断：

```ts
  if (!EMAIL_SHAPE.test(text.value)) {
```

改为：

```ts
  if (!isLikelyEmailAddress(text.value)) {
```

`parseOptionalEmail` 上方 JSDoc 原样保留（其中解释宽松正则的段落仍然成立）。

- [ ] **Step 3: 类型检查 + 全量回归**

Run:

```bash
npm run typecheck && npx vitest run tests/security/action-gates.test.ts tests/admin/section-rename-action.test.ts && npm test
```

Expected: typecheck 零错误；两个 actions 相关测试文件通过；全量仍 `683 passed (683)`、35 文件。这是行为保持型重构，任何用例变红都说明正则语义漂移，先修实现不改测试。

- [ ] **Step 4: lint**

Run: `npm run lint`
Expected: 零错误。

- [ ] **Step 5: 检查点 —— 停下报告，等许可后 commit**

建议 commit message（许可后执行）：`refactor: extract isLikelyEmailAddress as shared mailbox-shape predicate`

---

## Task 3: env→三态配置 email-config.ts（TDD，18 例）

**Files:**
- Create: `src/lib/alerts/email-config.ts`
- Test: `tests/alerts/email-config.test.ts`

- [ ] **Step 1: 写失败测试（逐字，spec §7.3）**

创建 `tests/alerts/email-config.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { loadAlertEmailConfig } from "@/lib/alerts/email-config";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...overrides };
}

describe("loadAlertEmailConfig", () => {
  it("falls back to implicit dry-run when SMTP_HOST is absent", () => {
    const config = loadAlertEmailConfig(env());

    expect(config).toMatchObject({ mode: "dry-run", reason: "smtp-not-configured" });
    if (config.mode === "dry-run") expect(config.adminEmails).toEqual([]);
  });

  it("lets forced dry-run override a fully configured live setup", () => {
    const config = loadAlertEmailConfig(
      env({
        ALERT_EMAIL_DRY_RUN: "true",
        SMTP_HOST: "mail.internal",
        SMTP_FROM: "a@cn.denso.com",
        ALERT_ADMIN_EMAIL: "b@cn.denso.com",
      }),
    );

    expect(config).toMatchObject({ mode: "dry-run", reason: "forced-by-env" });
  });

  it("parses the force flag case-insensitively after trimming", () => {
    const config = loadAlertEmailConfig(env({ ALERT_EMAIL_DRY_RUN: " True " }));

    expect(config.mode).toBe("dry-run");
  });

  it("builds a live config with default port, no TLS and no auth", () => {
    const config = loadAlertEmailConfig(
      env({
        SMTP_HOST: "mail.internal",
        SMTP_FROM: "sys@cn.denso.com",
        ALERT_ADMIN_EMAIL: "ops@cn.denso.com",
      }),
    );

    expect(config).toMatchObject({
      mode: "live",
      host: "mail.internal",
      port: 25,
      secure: false,
      user: null,
      pass: null,
    });
  });

  it("parses explicit port, secure flag and credentials", () => {
    const config = loadAlertEmailConfig(
      env({
        SMTP_HOST: "mail.internal",
        SMTP_PORT: "465",
        SMTP_SECURE: "TRUE",
        SMTP_USER: "relay",
        SMTP_PASS: "secret",
        SMTP_FROM: "sys@cn.denso.com",
        ALERT_ADMIN_EMAIL: "ops@cn.denso.com",
      }),
    );

    expect(config).toMatchObject({ mode: "live", port: 465, secure: true, user: "relay" });
  });

  it("splits, trims and caps the admin recipient list at three", () => {
    const config = loadAlertEmailConfig(
      env({
        SMTP_HOST: "mail.internal",
        SMTP_FROM: "sys@cn.denso.com",
        ALERT_ADMIN_EMAIL: " a@cn.denso.com, b@cn.denso.com ,c@cn.denso.com",
      }),
    );

    if (config.mode !== "live") throw new Error("expected live config");
    expect(config.adminEmails).toEqual([
      "a@cn.denso.com",
      "b@cn.denso.com",
      "c@cn.denso.com",
    ]);
  });

  // Base carries HOST only; each row supplies exactly the keys its scenario needs,
  // so "missing sender" really means missing.
  const sender = { SMTP_FROM: "sys@x.com" };
  const oneRecipient = { ALERT_ADMIN_EMAIL: "a@x.com" };

  it.each([
    ["four recipients", { ...sender, ALERT_ADMIN_EMAIL: "a@x.com,b@x.com,c@x.com,d@x.com" }],
    ["a malformed recipient", { ...sender, ALERT_ADMIN_EMAIL: "not-an-email" }],
    ["missing recipients", { ...sender }],
    ["missing sender", { ...oneRecipient }],
    ["a non-numeric port", { ...sender, ...oneRecipient, SMTP_PORT: "smtp" }],
    ["an out-of-range port", { ...sender, ...oneRecipient, SMTP_PORT: "500000" }],
    ["a bad secure flag", { ...sender, ...oneRecipient, SMTP_SECURE: "yes" }],
    ["username without password", { ...sender, ...oneRecipient, SMTP_USER: "relay" }],
    ["password without username", { ...sender, ...oneRecipient, SMTP_PASS: "secret" }],
  ] as const)("reports config-error for %s", (_label, extra) => {
    const config = loadAlertEmailConfig(env({ SMTP_HOST: "mail.internal", ...extra }));

    expect(config.mode).toBe("config-error");
  });

  it("accumulates every error instead of stopping at the first", () => {
    const config = loadAlertEmailConfig(env({ SMTP_HOST: "mail.internal", SMTP_PORT: "bad" }));

    if (config.mode !== "config-error") throw new Error("expected config-error");
    expect(config.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps best-effort parsed recipients in forced dry-run without erroring", () => {
    const config = loadAlertEmailConfig(
      env({ ALERT_EMAIL_DRY_RUN: "true", ALERT_ADMIN_EMAIL: "good@x.com, garbage" }),
    );

    if (config.mode !== "dry-run") throw new Error("expected dry-run");
    expect(config.adminEmails).toEqual(["good@x.com"]);
  });

  it("treats a whitespace-only host as unconfigured", () => {
    expect(loadAlertEmailConfig(env({ SMTP_HOST: "   " })).mode).toBe("dry-run");
  });
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/alerts/email-config.test.ts`
Expected: FAIL——`Failed to resolve import "@/lib/alerts/email-config"`（文件不存在）。

- [ ] **Step 3: 最小实现 `src/lib/alerts/email-config.ts`（完整内容）**

```ts
// Environment -> alert email channel configuration, resolved at the USE POINT
// (script startup, test-action invocation), never at Next.js startup. Three
// outcomes: a fully validated live config, an explicit/implicit dry-run, or a
// config-error carrying every problem found in one pass.

import { isLikelyEmailAddress } from "@/lib/validation/email";

export interface LiveEmailConfig {
  mode: "live";
  host: string;
  port: number;
  /** true = implicit TLS (nodemailer "secure", port 465 style); false = STARTTLS-optional. */
  secure: boolean;
  user: string | null;
  pass: string | null;
  from: string;
  adminEmails: string[];
}

export interface DryRunEmailConfig {
  mode: "dry-run";
  reason: "smtp-not-configured" | "forced-by-env";
  adminEmails: string[];
}

export interface ConfigErrorEmailConfig {
  mode: "config-error";
  /** All problems found in one pass, so the operator fixes everything at once. */
  errors: string[];
}

export type AlertEmailConfig =
  | LiveEmailConfig
  | DryRunEmailConfig
  | ConfigErrorEmailConfig;

const DEFAULT_SMTP_PORT = 25;
const MAX_ADMIN_RECIPIENTS = 3;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Splits the comma list, trims, drops empties, and partitions valid shapes from
 * invalid ones. Used strictly (live mode) and best-effort (dry-run mode, where
 * invalid entries are silently discarded).
 */
function parseAdminEmails(raw: string | undefined): {
  valid: string[];
  hasInvalid: boolean;
} {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  const valid = entries.filter((entry) => isLikelyEmailAddress(entry));
  return { valid, hasInvalid: valid.length !== entries.length };
}

function parseBooleanFlag(raw: string | undefined): boolean | null {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

export function loadAlertEmailConfig(env: NodeJS.ProcessEnv): AlertEmailConfig {
  const forcedDryRun = (env.ALERT_EMAIL_DRY_RUN ?? "").trim().toLowerCase() === "true";
  if (forcedDryRun) {
    // Highest precedence: even a half-configured SMTP block must not error here.
    const { valid } = parseAdminEmails(env.ALERT_ADMIN_EMAIL);
    return {
      mode: "dry-run",
      reason: "forced-by-env",
      adminEmails: valid.slice(0, MAX_ADMIN_RECIPIENTS),
    };
  }

  const host = (env.SMTP_HOST ?? "").trim();
  if (host === "") {
    // Implicit dry-run so the pipeline can ship before IT provides SMTP (D-210).
    const { valid } = parseAdminEmails(env.ALERT_ADMIN_EMAIL);
    return {
      mode: "dry-run",
      reason: "smtp-not-configured",
      adminEmails: valid.slice(0, MAX_ADMIN_RECIPIENTS),
    };
  }

  const errors: string[] = [];

  const from = (env.SMTP_FROM ?? "").trim();
  if (from === "") {
    errors.push("SMTP_FROM 未配置或为空，必须显式指定发件地址。");
  }

  const { valid: recipients, hasInvalid } = parseAdminEmails(env.ALERT_ADMIN_EMAIL);
  if (recipients.length === 0) {
    errors.push("ALERT_ADMIN_EMAIL 必须配置至少 1 个收件人。");
  } else if (recipients.length > MAX_ADMIN_RECIPIENTS) {
    errors.push(
      `ALERT_ADMIN_EMAIL 收件人最多 ${String(MAX_ADMIN_RECIPIENTS)} 个，当前 ${String(recipients.length)} 个。`,
    );
  }
  if (hasInvalid) {
    errors.push("ALERT_ADMIN_EMAIL 中存在格式不合法的邮箱地址。");
  }

  const user = (env.SMTP_USER ?? "").trim();
  const password = (env.SMTP_PASS ?? "").trim();
  if ((user === "") !== (password === "")) {
    errors.push("SMTP_USER 与 SMTP_PASS 必须同时配置（认证）或同时留空（免认证）。");
  }

  let port = DEFAULT_SMTP_PORT;
  const portRaw = env.SMTP_PORT;
  if (portRaw !== undefined && portRaw.trim() !== "") {
    const parsed = Number(portRaw.trim());
    if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
      errors.push(`SMTP_PORT 必须是 ${String(MIN_PORT)}-${String(MAX_PORT)} 之间的整数。`);
    } else {
      port = parsed;
    }
  }

  let secure = false;
  const secureFlag = parseBooleanFlag(env.SMTP_SECURE);
  if (secureFlag === null) {
    errors.push("SMTP_SECURE 只接受 true 或 false（缺省为 false）。");
  } else {
    secure = secureFlag;
  }

  if (errors.length > 0) {
    // Never silently downgrade to dry-run once SMTP_HOST claims to be configured.
    return { mode: "config-error", errors };
  }

  return {
    mode: "live",
    host,
    port,
    secure,
    user: user === "" ? null : user,
    pass: password === "" ? null : password,
    from,
    adminEmails: recipients,
  };
}
```

注意：`hasInvalid` 为 true 且同时超 3 个时累积两条收件人错误（不影响任何断言；错误累积是 spec §5.1.2 规则 3 的要求）。

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/alerts/email-config.test.ts`
Expected: 1 个文件、**18 用例全过**（含 9 行 it.each config-error）。

- [ ] **Step 5: typecheck + lint + 检查点**

Run: `npm run typecheck && npm run lint`
Expected: 零错误。随后停下报告，等许可后 commit：`feat: add three-state alert email config loader`

---

## Task 4: 频控状态文件 alert-state.ts（TDD，13 例）

**Files:**
- Create: `src/lib/alerts/alert-state.ts`
- Test: `tests/alerts/alert-state.test.ts`

> ✅ **勘误 E 已经用户 2026-09-12 裁决采纳**：下例末断言按行为契约写 `toBe(failed.lastAlertDate)`（spec 原文 `toBeNull()` 与同例上文及 §5.1.3 矛盾，以此为准，无需再请示）。另：`touchedState` 已补入 import（仲裁 F）。

- [ ] **Step 1: 写失败测试（完整内容，已含两处勘误修正）**

创建 `tests/alerts/alert-state.test.ts`：

```ts
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALERT_STATE_SCHEMA_VERSION,
  alertStatePathFor,
  baselineState,
  checkedState,
  failedState,
  intentStateFor,
  readAlertState,
  sentState,
  toStateInstant,
  touchedState,
  writeAlertState,
  type AlertState,
} from "@/lib/alerts/alert-state";

describe("alert-state file IO", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "alert-state-"));
    file = join(dir, "alert-state.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns null when the state file is absent", async () => {
    expect(await readAlertState(file)).toBeNull();
  });

  it("round-trips every field through temp-plus-rename write", async () => {
    const now = new Date("2026-09-11T01:20:00.000Z"); // 09:20 +08:00
    const original: AlertState = {
      schemaVersion: ALERT_STATE_SCHEMA_VERSION,
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-11",
      lastRecoveryDate: null,
      lastCheckAt: toStateInstant(now),
      lastAttemptAt: toStateInstant(now),
      lastSentAt: toStateInstant(now),
      lastError: null,
    };

    await writeAlertState(file, original);

    expect(await readAlertState(file)).toEqual(original);
  });

  it("leaves no temp file behind after writing", async () => {
    await writeAlertState(file, baselineState(new Date()));

    expect(await readdir(dir)).toEqual(["alert-state.json"]);
  });

  it("treats corrupt JSON as null and logs state-corrupt", async () => {
    const log = vi.fn();
    vi.stubGlobal("console", { ...console, log });
    await writeFile(file, "{not json");

    expect(await readAlertState(file)).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("state-corrupt"));
  });

  it.each([
    ["an unknown schemaVersion", { schemaVersion: 999 }],
    ["a missing required field", { schemaVersion: 1, lastState: "ok" }],
  ])("treats %s as null", async (_label, raw) => {
    await writeFile(file, JSON.stringify(raw));

    expect(await readAlertState(file)).toBeNull();
  });

  it("tolerates unknown future fields", async () => {
    const baseline = baselineState(new Date("2026-09-11T01:20:00.000Z"));
    await writeFile(file, JSON.stringify({ ...baseline, futureField: "keep-me" }));

    expect(await readAlertState(file)).toEqual(baseline);
  });

  it("derives the state path next to the SQLite file", () => {
    expect(alertStatePathFor("file:/app/data/dev.db")).toBe("/app/data/alert-state.json");
  });
});

describe("alert-state transitions", () => {
  const now = new Date("2026-09-11T01:20:00.000Z");

  it("records the first alert date when sending the first alert", () => {
    const intent = intentStateFor(baselineState(now), "send-first", "2026-09-11", now);

    expect(intent).toMatchObject({
      lastState: "stale",
      firstAlertDate: "2026-09-11",
      lastAlertDate: "2026-09-11",
    });
    expect(intent.lastAttemptAt).toBe(toStateInstant(now));
  });

  it("keeps the first alert date on a repeat", () => {
    const prev: AlertState = {
      ...baselineState(now),
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
    };

    const intent = intentStateFor(prev, "send-repeat", "2026-09-11", now);

    expect(intent.firstAlertDate).toBe("2026-09-08");
    expect(intent.lastAlertDate).toBe("2026-09-11");
  });

  it("marks recovery without erasing alert history", () => {
    const prev: AlertState = {
      ...baselineState(now),
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
    };

    const intent = intentStateFor(prev, "send-recovery", "2026-09-11", now);

    expect(intent).toMatchObject({
      lastState: "ok",
      lastRecoveryDate: "2026-09-11",
      firstAlertDate: "2026-09-08",
    });
  });

  it("renders business-time instants with a fixed +08:00 offset", () => {
    expect(toStateInstant(now)).toBe("2026-09-11T09:20:00+08:00");
  });

  it("records success and failure without mutating the intent", () => {
    const intent = intentStateFor(baselineState(now), "send-first", "2026-09-11", now);

    const succeeded = sentState(intent, now);
    const failed = failedState(intent, "connect ETIMEDOUT");
    const touched = touchedState(failed, now);

    expect(succeeded.lastSentAt).toBe(toStateInstant(now));
    expect(succeeded.lastError).toBeNull();
    expect(failed.lastError).toBe("connect ETIMEDOUT");
    expect(failed.lastSentAt).toBeNull();
    expect(intent.lastError).toBeNull();
    expect(checkedState(failed, now, "stale").lastCheckAt).toBe(toStateInstant(now));
    // Dry-run touch refreshes attempt stamps without changing cadence or state.
    expect(touched.lastAttemptAt).toBe(toStateInstant(now));
    expect(touched.lastState).toBe(failed.lastState);
    // Spec errata E (2026-09-12): the approved spec wrote toBeNull() here, but
    // `failed` inherits the send-first intent's lastAlertDate by design (same-day
    // retry suppression after a failed send depends on it), and touchedState must
    // not move cadence dates. Assert the actual contract: the date is untouched.
    expect(touched.lastAlertDate).toBe(failed.lastAlertDate);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/alerts/alert-state.test.ts`
Expected: FAIL——模块无法解析。

- [ ] **Step 3: 最小实现 `src/lib/alerts/alert-state.ts`（完整内容）**

跨平台要点：`alertStatePathFor("file:/app/data/dev.db")` 必须在 Windows 开发机上也返回 `/app/data/alert-state.json`（该值只在 Linux 容器内使用），因此 POSIX 绝对路径分支走字符串切片而非 `fileURLToPath`；本地相对 `file:./dev.db` 分支才用 URL + cwd + 原生路径转换。

```ts
// Frequency-control state for the attendance alert channel, persisted as one
// JSON file next to the SQLite database (the /app/data bind mount in the
// container). Every transition is a pure function returning a new object; the
// only IO is readAlertState()/writeAlertState(). A missing or corrupt file is
// indistinguishable from "first scan": readAlertState() returns null and the
// caller re-baselines, so the file is self-healing and needs no backup.

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ALERT_STATE_SCHEMA_VERSION = 1;

export type AlertTrackedState = "ok" | "stale" | "baseline";

export interface AlertState {
  schemaVersion: 1;
  lastState: AlertTrackedState;
  firstAlertDate: string | null; // YYYY-MM-DD, business calendar day
  lastAlertDate: string | null; // YYYY-MM-DD
  lastRecoveryDate: string | null; // YYYY-MM-DD
  lastCheckAt: string | null; // ISO-8601 with +08:00 offset
  lastAttemptAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

export type AlertIntentKind = "send-first" | "send-repeat" | "send-recovery";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRACKED_STATES: readonly AlertTrackedState[] = ["ok", "stale", "baseline"];
const STATE_FILE_NAME = "alert-state.json";

/**
 * Renders an instant as an ISO string pinned to the business zone, e.g.
 * 2026-09-11T01:20:00.000Z -> "2026-09-11T09:20:00+08:00". Built from Intl parts
 * so the host clock/time zone cannot change the output. h23 keeps midnight "00".
 */
export function toStateInstant(now: Date): string {
  const parts = STATE_INSTANT_FORMAT.formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}:${value("second")}+08:00`;
}

const STATE_INSTANT_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * Locates alert-state.json next to the SQLite file DATABASE_URL points at, so it
 * lands on the same bind mount. POSIX absolute `file:` URLs (container value
 * file:/app/data/dev.db) are handled by string slicing on purpose: converting
 * them on a Windows dev machine would mangle the path, and that value only ever
 * runs inside the Linux container. Relative URLs resolve against process.cwd().
 */
export function alertStatePathFor(databaseUrl: string | undefined): string {
  const raw = (databaseUrl ?? "").trim();
  if (raw === "") {
    return join(dirname(join(process.cwd(), "dev.db")), STATE_FILE_NAME);
  }
  if (!raw.startsWith("file:")) {
    // A bare filesystem path.
    return join(dirname(raw), STATE_FILE_NAME);
  }
  const base = pathToFileURL(join(process.cwd(), "state-base"));
  const url = new URL(raw, base);
  const pathname = decodeURIComponent(url.pathname);
  const isWindowsDrive = /^\/[A-Za-z]:[\\/]/.test(pathname);
  if (isWindowsDrive) {
    return join(dirname(fileURLToPath(url)), STATE_FILE_NAME);
  }
  const lastSlash = pathname.lastIndexOf("/");
  return `${pathname.slice(0, lastSlash)}/${STATE_FILE_NAME}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDateString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && DATE_PATTERN.test(value));
}

function isInstantString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Validates and canonicalises parsed JSON. Unknown fields are deliberately
 * DROPPED during reconstruction, so a future version's extra keys survive a
 * schemaVersion-1 write only until the first re-save; reads stay exactly the
 * declared nine-field shape.
 */
function toAlertState(raw: unknown): AlertState | null {
  if (!isRecord(raw) || raw.schemaVersion !== ALERT_STATE_SCHEMA_VERSION) {
    return null;
  }
  const {
    lastState,
    firstAlertDate,
    lastAlertDate,
    lastRecoveryDate,
    lastCheckAt,
    lastAttemptAt,
    lastSentAt,
    lastError,
  } = raw;
  if (typeof lastState !== "string" || !TRACKED_STATES.includes(lastState as AlertTrackedState)) {
    return null;
  }
  if (
    !isDateString(firstAlertDate) ||
    !isDateString(lastAlertDate) ||
    !isDateString(lastRecoveryDate) ||
    !isInstantString(lastCheckAt) ||
    !isInstantString(lastAttemptAt) ||
    !isInstantString(lastSentAt) ||
    !(lastError === null || typeof lastError === "string")
  ) {
    return null;
  }
  return {
    schemaVersion: ALERT_STATE_SCHEMA_VERSION,
    lastState: lastState as AlertTrackedState,
    firstAlertDate,
    lastAlertDate,
    lastRecoveryDate,
    lastCheckAt,
    lastAttemptAt,
    lastSentAt,
    lastError,
  };
}

/** Missing file => null. Corrupt JSON / wrong shape => state-corrupt log + null. */
export async function readAlertState(file: string): Promise<AlertState | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    console.log(
      JSON.stringify({ evt: "state-corrupt", file, reason: "unreadable", error: String(error) }),
    );
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log(JSON.stringify({ evt: "state-corrupt", file, reason: "invalid-json" }));
    return null;
  }
  const state = toAlertState(parsed);
  if (state === null) {
    console.log(JSON.stringify({ evt: "state-corrupt", file, reason: "unsupported-shape" }));
  }
  return state;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

/** Atomic write: temp file in the same directory, then rename over the target. */
export async function writeAlertState(file: string, state: AlertState): Promise<void> {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export function baselineState(now: Date): AlertState {
  return {
    schemaVersion: ALERT_STATE_SCHEMA_VERSION,
    lastState: "baseline",
    firstAlertDate: null,
    lastAlertDate: null,
    lastRecoveryDate: null,
    lastCheckAt: toStateInstant(now),
    lastAttemptAt: null,
    lastSentAt: null,
    lastError: null,
  };
}

/** skip path: refresh the check stamp and tracked level, nothing else. */
export function checkedState(
  prev: AlertState,
  now: Date,
  tracked: AlertTrackedState,
): AlertState {
  return { ...prev, lastState: tracked, lastCheckAt: toStateInstant(now) };
}

/**
 * Dry-run touch: refresh check/attempt stamps but keep every cadence date and
 * lastState untouched, so switching to live still sends a first alert today.
 */
export function touchedState(prev: AlertState, now: Date): AlertState {
  const instant = toStateInstant(now);
  return { ...prev, lastCheckAt: instant, lastAttemptAt: instant };
}

export function intentStateFor(
  prev: AlertState,
  kind: AlertIntentKind,
  today: string,
  now: Date,
): AlertState {
  const attempt = toStateInstant(now);
  if (kind === "send-first") {
    return {
      ...prev,
      lastState: "stale",
      firstAlertDate: prev.firstAlertDate ?? today,
      lastAlertDate: today,
      lastAttemptAt: attempt,
    };
  }
  if (kind === "send-repeat") {
    return {
      ...prev,
      lastState: "stale",
      firstAlertDate: prev.firstAlertDate,
      lastAlertDate: today,
      lastAttemptAt: attempt,
    };
  }
  return {
    ...prev,
    lastState: "ok",
    lastRecoveryDate: today,
    lastAttemptAt: attempt,
  };
}

export function sentState(intent: AlertState, now: Date): AlertState {
  return { ...intent, lastSentAt: toStateInstant(now), lastError: null };
}

/** The failure records the reason but moves NO date fields (same-day suppression). */
export function failedState(intent: AlertState, sanitizedError: string): AlertState {
  return { ...intent, lastError: sanitizedError };
}
```

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/alerts/alert-state.test.ts`
Expected: **13 用例全过**。重点核对：`toStateInstant` 固定断言、temp 文件不留存、未知字段被读取规整化剔除、POSIX 路径在 Windows 上字面返回。

- [ ] **Step 5: typecheck + lint + 检查点**

Run: `npm run typecheck && npm run lint`
Expected: 零错误。勘误 E 已经用户 2026-09-12 裁决（按行为契约，见 §0）。停下报告，等许可后 commit：`feat: add alert frequency-control state file and transitions`

---

## Task 5: 决策矩阵 alert-decision.ts（TDD，13 例）

**Files:**
- Create: `src/lib/alerts/alert-decision.ts`
- Test: `tests/alerts/alert-decision.test.ts`

- [ ] **Step 1: 写失败测试（逐字，spec §7.1）**

创建 `tests/alerts/alert-decision.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { decideAlertAction } from "@/lib/alerts/alert-decision";
import type { AlertState } from "@/lib/alerts/alert-state";

function state(partial: Partial<AlertState>): AlertState {
  return {
    schemaVersion: 1,
    lastState: "ok",
    firstAlertDate: null,
    lastAlertDate: null,
    lastRecoveryDate: null,
    lastCheckAt: null,
    lastAttemptAt: null,
    lastSentAt: null,
    lastError: null,
    ...partial,
  };
}

describe("decideAlertAction", () => {
  it("skips on the first ever scan when imports are healthy", () => {
    const decision = decideAlertAction({ level: "ok", today: "2026-09-11", state: null });

    expect(decision).toEqual({ kind: "skip", tracked: "ok" });
  });

  it("sends the first alert when stale data is found with no prior state", () => {
    const decision = decideAlertAction({ level: "stale", today: "2026-09-11", state: null });

    expect(decision).toEqual({ kind: "send-first", tracked: "stale" });
  });

  it("grants a one-scan baseline grace when there has never been a successful import", () => {
    const decision = decideAlertAction({ level: "never", today: "2026-09-11", state: null });

    expect(decision).toEqual({ kind: "baseline", tracked: "baseline" });
  });

  it.each([
    ["stale", "stale"],
    ["never", "stale"],
  ] as const)(
    "sends the first alert on %s after the baseline scan",
    (level, lastState) => {
      const decision = decideAlertAction({
        level,
        today: "2026-09-11",
        state: state({ lastState }),
      });

      expect(decision.kind).toBe("send-first");
    },
  );

  it("sends a first alert when staleness starts after a healthy history", () => {
    const decision = decideAlertAction({
      level: "stale",
      today: "2026-09-11",
      state: state({ lastState: "ok" }),
    });

    expect(decision).toEqual({ kind: "send-first", tracked: "stale" });
  });

  it("does not repeat an alert within the same business day", () => {
    const decision = decideAlertAction({
      level: "stale",
      today: "2026-09-11",
      state: state({ lastState: "stale", lastAlertDate: "2026-09-11" }),
    });

    expect(decision).toEqual({ kind: "skip", tracked: "stale" });
  });

  it("repeats the alert on the next business day", () => {
    const decision = decideAlertAction({
      level: "stale",
      today: "2026-09-12",
      state: state({ lastState: "stale", lastAlertDate: "2026-09-11" }),
    });

    expect(decision).toEqual({ kind: "send-repeat", tracked: "stale" });
  });

  it("sends a recovery notice when imports resume after an alert", () => {
    const decision = decideAlertAction({
      level: "ok",
      today: "2026-09-12",
      state: state({ lastState: "stale", lastRecoveryDate: null }),
    });

    expect(decision).toEqual({ kind: "send-recovery", tracked: "ok" });
  });

  it("keeps recovery idempotent within the same business day", () => {
    const decision = decideAlertAction({
      level: "ok",
      today: "2026-09-12",
      state: state({ lastState: "stale", lastRecoveryDate: "2026-09-12" }),
    });

    expect(decision).toEqual({ kind: "skip", tracked: "ok" });
  });

  it.each([
    ["ok", "ok"],
    ["ok", "baseline"],
  ] as const)("skips when level=%s and lastState=%s", (level, lastState) => {
    const decision = decideAlertAction({
      level,
      today: "2026-09-11",
      state: state({ lastState }),
    });

    expect(decision.kind).toBe("skip");
  });

  it("defensively treats never-after-ok as a first alert", () => {
    const decision = decideAlertAction({
      level: "never",
      today: "2026-09-11",
      state: state({ lastState: "ok" }),
    });

    expect(decision.kind).toBe("send-first");
  });
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/alerts/alert-decision.test.ts`
Expected: FAIL——模块无法解析。

- [ ] **Step 3: 最小实现 `src/lib/alerts/alert-decision.ts`（完整内容）**

矩阵逐行对应 spec §5.1.4；字符串日期同为 `YYYY-MM-DD` 可直接字典序比较。

```ts
// Pure decision matrix for the attendance staleness alert cadence:
// first alert, at most one repeat per business calendar day, one recovery
// notice, and a one-scan baseline grace for a never-imported empty database.

import type { StalenessLevel } from "@/lib/attendance/import-staleness";

import type { AlertState, AlertTrackedState } from "./alert-state";

export type AlertDecisionKind =
  | "skip"
  | "baseline"
  | "send-first"
  | "send-repeat"
  | "send-recovery";

export interface AlertDecision {
  kind: AlertDecisionKind;
  tracked: AlertTrackedState;
}

export function decideAlertAction(input: {
  level: StalenessLevel;
  today: string;
  state: AlertState | null;
}): AlertDecision {
  const { level, today, state } = input;

  if (level === "ok") {
    if (state === null || state.lastState === "ok" || state.lastState === "baseline") {
      return { kind: "skip", tracked: "ok" };
    }
    // Healthy again after a stale streak: one recovery notice, idempotent
    // within the same business day.
    if (state.lastRecoveryDate === today) {
      return { kind: "skip", tracked: "ok" };
    }
    return { kind: "send-recovery", tracked: "ok" };
  }

  // Cold-start grace, one scan only, for a system with no successful import
  // and no history file.
  if (level === "never" && state === null) {
    return { kind: "baseline", tracked: "baseline" };
  }

  if (state === null) {
    return { kind: "send-first", tracked: "stale" };
  }

  if (state.lastState === "baseline" || state.lastState === "ok") {
    // Defensive: never after an ok/baseline history is theoretically
    // unreachable (never means no success ever), but treat it as a first
    // alert rather than silently going quiet.
    return { kind: "send-first", tracked: "stale" };
  }

  // lastState === "stale": at most one alert per business calendar day.
  if (state.lastAlertDate !== null && state.lastAlertDate >= today) {
    return { kind: "skip", tracked: "stale" };
  }
  return { kind: "send-repeat", tracked: "stale" };
}
```

注意同日判定用 `lastAlertDate >= today`：状态文件只可能写今天或更早的业务日期，`===` 与 `>=` 等价，但 `>=` 对任何时钟倒挂也是安全的「不重发」。

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/alerts/alert-decision.test.ts`
Expected: **13 用例全过**。

- [ ] **Step 5: typecheck + lint + 检查点**

Run: `npm run typecheck && npm run lint`
Expected: 零错误。停下报告，等许可后 commit：`feat: add attendance alert decision matrix`

---

## Task 6: 三类中文邮件模板 alert-template.ts（TDD，8 例）

**Files:**
- Create: `src/lib/alerts/alert-template.ts`
- Test: `tests/alerts/alert-template.test.ts`

- [ ] **Step 1: 写失败测试（逐字，spec §7.4）**

创建 `tests/alerts/alert-template.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import {
  buildRecoveryEmail,
  buildStaleAlertEmail,
  buildTestEmail,
} from "@/lib/alerts/alert-template";

const NOW = new Date("2026-09-11T01:20:00.000Z");
const LAST = new Date("2026-09-05T01:07:00.000Z");

describe("alert templates", () => {
  it("renders the stale subject with the day count", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.subject).toBe("［工时管理系统］考勤数据停摆告警：已 5 天未成功导入考勤数据");
  });

  it("states the never-imported situation without a day count", () => {
    const mail = buildStaleAlertEmail({ level: "never", daysSince: null, latestSuccessAt: null, now: NOW });

    expect(mail.text).toContain("系统从未有过成功导入记录");
    expect(mail.text).not.toContain("距今天数：");
  });

  it("includes the formatted last-success time and generation time", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.text).toContain("末次成功导入时间：2026/09/05 09:07");
    expect(mail.text).toContain("本邮件生成时间：2026/09/11 09:20");
  });

  it("documents the PARTIAL and zero-row success convention", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.text).toContain("PARTIAL");
    expect(mail.text).toContain("数据行数为 0");
  });

  it("lists the four troubleshooting stops and the no-reply footer", () => {
    const mail = buildStaleAlertEmail({ level: "stale", daysSince: 5, latestSuccessAt: LAST, now: NOW });

    expect(mail.text).toContain("crontab");
    expect(mail.text).toContain("/mnt/hr");
    expect(mail.text).toContain("数据卷磁盘");
    expect(mail.text).toContain("/admin/audit");
    expect(mail.text).toContain("此邮件由系统自动发送，请勿回复");
  });

  it("renders the exact recovery subject", () => {
    expect(buildRecoveryEmail({ latestSuccessAt: LAST, now: NOW }).subject).toBe(
      "［工时管理系统］考勤数据导入已恢复正常",
    );
  });

  it("renders the test subject with a formatted timestamp", () => {
    const mail = buildTestEmail({ now: NOW, dryRun: false, recipientCount: 2 });

    expect(mail.subject).toBe("［工时管理系统］告警邮件通道测试（2026/09/11 09:20）");
    expect(mail.text).toContain("收件人数量：2");
  });

  it("states dry-run delivery in the test body", () => {
    const mail = buildTestEmail({ now: NOW, dryRun: true, recipientCount: 0 });

    expect(mail.text).toContain("干跑");
    expect(mail.text).toContain("不会真实投递");
  });
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/alerts/alert-template.test.ts`
Expected: FAIL——模块无法解析。

- [ ] **Step 3: 最小实现 `src/lib/alerts/alert-template.ts`（完整内容，文案逐字对齐 spec §5.4）**

```ts
// Chinese plain-text email bodies for the attendance staleness channel.
// Pure functions: every timestamp goes through formatBusinessTimestamp so the
// Asia/Shanghai zone pin lives in exactly one place. No HTML, no attachments,
// no links (phase 1 deliberately needs no APP_BASE_URL).

import { formatBusinessTimestamp } from "@/lib/db/date";

import type { StalenessLevel } from "@/lib/attendance/import-staleness";

export interface AlertEmailContent {
  subject: string;
  text: string;
}

const NO_REPLY_FOOTER = "此邮件由系统自动发送，请勿回复。";

const STALE_CONVENTION =
  "口径说明：PARTIAL（部分成功）视为成功；仅有汇总行、数据行数为 0 的文件也视为成功。距上次成功导入超过 3 个自然日即触发本邮件。";

const STALE_TROUBLESHOOTING = [
  "请按以下顺序排查：",
  "1. 宿主机的考勤抓取定时任务（crontab）是否仍在运行；",
  "2. HR 共享目录挂载 /mnt/hr 是否可访问（目录不可达时系统内不会留下导入记录）；",
  "3. 应用容器状态与数据卷磁盘空间是否正常；",
  "4. 登录后台 /admin/audit 查看最近的主数据快照，并在实际数据页查看最近的导入日志。",
].join("\n");

export function buildStaleAlertEmail(input: {
  level: StalenessLevel;
  daysSince: number | null;
  latestSuccessAt: Date | null;
  now: Date;
}): AlertEmailContent {
  const isNever = input.level === "never";
  const subject = isNever
    ? "［工时管理系统］考勤数据停摆告警：从未有成功导入考勤数据记录"
    : `［工时管理系统］考勤数据停摆告警：已 ${String(input.daysSince)} 天未成功导入考勤数据`;

  const lastSuccessLine = isNever
    ? "末次成功导入时间：无（系统从未有过成功导入记录）"
    : `末次成功导入时间：${formatBusinessTimestamp(input.latestSuccessAt as Date)}`;
  const gapLine = isNever
    ? "系统从未有过成功导入记录。"
    : `距今天数：${String(input.daysSince)} 天（按 Asia/Shanghai 时区的自然日计算）`;

  const text = [
    "管理员您好：",
    "",
    "工时管理系统检测到考勤数据导入已停摆。",
    "",
    lastSuccessLine,
    gapLine,
    `本邮件生成时间：${formatBusinessTimestamp(input.now)}`,
    "",
    STALE_CONVENTION,
    "",
    STALE_TROUBLESHOOTING,
    "",
    NO_REPLY_FOOTER,
  ].join("\n");

  return { subject, text };
}

export function buildRecoveryEmail(input: {
  latestSuccessAt: Date;
  now: Date;
}): AlertEmailContent {
  const text = [
    "管理员您好：",
    "",
    "工时管理系统的考勤数据导入已恢复正常。",
    "",
    `恢复后末次成功导入时间：${formatBusinessTimestamp(input.latestSuccessAt)}`,
    `本邮件生成时间：${formatBusinessTimestamp(input.now)}`,
    "",
    NO_REPLY_FOOTER,
  ].join("\n");

  return { subject: "［工时管理系统］考勤数据导入已恢复正常", text };
}

export function buildTestEmail(input: {
  now: Date;
  dryRun: boolean;
  recipientCount: number;
}): AlertEmailContent {
  const generatedAt = formatBusinessTimestamp(input.now);
  const modeLine = input.dryRun
    ? "发送模式：干跑（dry-run，仅写入容器日志，不会真实投递）"
    : "发送模式：真实发送";
  const text = [
    "管理员您好：",
    "",
    "这是一封告警邮件通道测试邮件，用于验证 SMTP 配置是否可用。",
    modeLine,
    `收件人数量：${String(input.recipientCount)}`,
    `本邮件生成时间：${generatedAt}`,
    "",
    NO_REPLY_FOOTER,
  ].join("\n");

  return {
    subject: `［工时管理系统］告警邮件通道测试（${generatedAt}）`,
    text,
  };
}
```

注意 never 的主题 spec §5.4 只给了「已 N 天」版式，never 主题无逐字稿；实现使用 `［工时管理系统］考勤数据停摆告警：从未有成功导入考勤数据记录`，测试不断言该主题（仅断言正文），执行者不得改动正文逐字行。

- [ ] **Step 4: 跑绿**

Run: `npx vitest run tests/alerts/alert-template.test.ts`
Expected: **8 用例全过**。

- [ ] **Step 5: typecheck + lint + 检查点**

Run: `npm run typecheck && npm run lint`
Expected: 零错误。停下报告，等许可后 commit：`feat: add Chinese plain-text alert email templates`

---

## Task 7: 🛑 请批安装 nodemailer（唯一新增运行时依赖）

**Files:**
- Modify（获批后）: `package.json`、`package-lock.json`
- 无测试

> **🛑 审批门，停下等用户明确批准。** 选型已随 spec 批准（决策 9：nodemailer 10.0.3，MIT-0、零运行时依赖、engines.node>=20），但「安装」本身是实施动作，未获批不执行。

- [ ] **Step 1: 向用户请批**

报告内容：将执行两条命令、改动 package.json 的 dependencies 与 devDependencies、重写 package-lock.json；无其他副作用。请用户回复批准。

- [ ] **Step 2: 获批后先读 registry 实值，再安装**

Run:

```bash
npm view nodemailer@10 version
npm view @types/nodemailer version
```

Expected: nodemailer 10.x 最新补丁版本（以 registry 实读为准，R7）；记录实际版本号写进报告。

```bash
npm install nodemailer@^10.0.3
npm install -D @types/nodemailer
```

Expected: 安装成功；`node_modules/nodemailer/package.json` 存在且无 dependencies（验证零传递依赖这一选型前提；若实读有运行时依赖，停下报告，Task 16 的 Dockerfile COPY 策略要相应调整）。

- [ ] **Step 3: 锁文件回归与门禁**

Run: `npm run typecheck && npm test`
Expected: 仍 735 用例（683 + Task 3/4/5/6 的 18+13+13+8＝52）全绿；typecheck 零错误。

- [ ] **Step 4: 检查点 —— 停下报告，等许可后 commit**

`package.json`/`package-lock.json` 许可后 commit message：`chore: add nodemailer for alert email delivery`

---

## Task 8: SMTP/dry-run 发送封装 email-sender.ts（无独立测试文件）

**Files:**
- Create: `src/lib/alerts/email-sender.ts`
- Test: 无独立测试文件（dry-run/live 行为由 Task 9 的 `alert-service.test.ts` 经注入假件覆盖契约；live 真实投递在 Task 15 目视门与 Task 17 容器实测验证）

本任务不走「先看红」循环（无可单测的纯逻辑分支；nodemailer 网络 IO 不在单测范围）。完成后 typecheck 即门。

- [ ] **Step 1: 实现 `src/lib/alerts/email-sender.ts`（完整内容）**

```ts
// The shared email transport for alert channels (phase 1: attendance staleness;
// phase 2 business-threshold alerts reuse this layer unchanged).
//
// Two implementations behind one interface:
//   - live:    nodemailer, one short-lived transport per script run; failures are
//              captured, sanitised and RETURNED - callers must never see a throw.
//   - dry-run: no transport; one single-line JSON log per delivery (address
//              values never logged) and a delivered/dryRun result.

import nodemailer from "nodemailer";

import type { DryRunEmailConfig, LiveEmailConfig } from "./email-config";

export interface SendEmailInput {
  to: string[];
  subject: string;
  text: string;
}

export interface SendEmailResult {
  delivered: boolean;
  dryRun: boolean;
  /** Sanitized, length-capped failure reason; never contains SMTP_PASS. */
  error?: string;
}

export interface EmailSender {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

const ERROR_MAX_LENGTH = 300;
const SECRET_PATTERN = /(pass(?:word)?|auth)\s*[=:]\s*\S+/gi;

/**
 * Strips credential-looking fragments and caps the length, so a provider error
 * like "535 auth failed for user relay pass hunter2" can land in alert-state
 * without leaking the password into the admin page.
 */
export function sanitizeSmtpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(SECRET_PATTERN, "$1=[redacted]").slice(0, ERROR_MAX_LENGTH);
}

export function createEmailSender(
  config: LiveEmailConfig | DryRunEmailConfig,
): EmailSender {
  if (config.mode === "dry-run") {
    return {
      send: async (input: SendEmailInput): Promise<SendEmailResult> => {
        // One JSON line, recipient COUNT only - addresses are PII in logs.
        console.log(
          JSON.stringify({
            evt: "alert-email-dry-run",
            toCount: input.to.length,
            subject: input.subject,
          }),
        );
        return { delivered: true, dryRun: true };
      },
    };
  }

  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user === null ? undefined : { user: config.user, pass: config.pass ?? "" },
  });

  return {
    send: async (input: SendEmailInput): Promise<SendEmailResult> => {
      try {
        await transport.sendMail({
          from: config.from,
          to: input.to.join(", "),
          subject: input.subject,
          text: input.text,
        });
        console.log(JSON.stringify({ evt: "alert-email-sent", toCount: input.to.length }));
        return { delivered: true, dryRun: false };
      } catch (error) {
        return {
          delivered: false,
          dryRun: false,
          error: sanitizeSmtpError(error),
        };
      }
    },
  };
}
```

- [ ] **Step 2: typecheck（含 @types/nodemailer）+ lint**

Run: `npm run typecheck && npm run lint`
Expected: 零错误。若 `nodemailer` 默认导入类型报错，改用 `import { createTransport } from "nodemailer"`（类型包支持具名导出），不改任何行为。

- [ ] **Step 3: 检查点 —— 停下报告，等许可后 commit**

许可后 commit message：`feat: add nodemailer-backed email sender with dry-run logging`

---

## Task 9: 单次扫描编排 alert-service.ts + exitCodeFor（TDD，23 例）

**Files:**
- Create: `src/lib/alerts/alert-service.ts`
- Test: `tests/alerts/exit-code.test.ts`（8 例）、`tests/alerts/alert-service.test.ts`（15 例＝spec §7.6 的 12 例 + 仲裁 A 补的 3 例 dry-run 不建文件）

先做小而独立的 `exitCodeFor`（红→绿），再做编排（红→绿）。

- [ ] **Step 1: 写 exit-code 失败测试（逐字，spec §7.5）**

创建 `tests/alerts/exit-code.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { exitCodeFor } from "@/lib/alerts/alert-service";

describe("exitCodeFor", () => {
  it.each([
    ["a healthy skip", undefined, 0],
    ["a baseline grace scan", undefined, 0],
    ["a dry-run delivery", undefined, 0],
    ["a successful live send", undefined, 0],
    ["config-error", "config-error", 1],
    ["a live send failure", "send-failed", 1],
    ["a database read failure", "db-read-failed", 2],
    ["a state write failure", "state-write-failed", 2],
  ] as const)("maps %s to exit code %i", (_label, code, expected) => {
    expect(exitCodeFor(code ?? undefined)).toBe(expected);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/alerts/exit-code.test.ts`
Expected: FAIL——模块无法解析。

- [ ] **Step 3: 写 alert-service 编排失败测试（spec §7.6 的 12 例逐字 + 文件末尾 3 例仲裁 A 补充）**

创建 `tests/alerts/alert-service.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { runAttendanceAlertCheck, type AlertCheckDeps } from "@/lib/alerts/alert-service";
import type { AlertEmailConfig } from "@/lib/alerts/email-config";
import type { AlertState } from "@/lib/alerts/alert-state";
import type { SendEmailInput, SendEmailResult } from "@/lib/alerts/email-sender";

const NOW = new Date("2026-09-11T01:20:00.000Z"); // 09:20 +08:00, a Friday
const NEXT_DAY = new Date("2026-09-12T01:20:00.000Z");
const STALE_SUCCESS = new Date("2026-09-05T01:07:00.000Z"); // six business days before NOW
const HEALTHY_SUCCESS = new Date("2026-09-11T01:07:00.000Z");

const liveConfig: AlertEmailConfig = {
  mode: "live",
  host: "mail.internal",
  port: 25,
  secure: false,
  user: null,
  pass: null,
  from: "sys@x.com",
  adminEmails: ["ops@x.com"],
};
const dryRunConfig: AlertEmailConfig = {
  mode: "dry-run",
  reason: "smtp-not-configured",
  adminEmails: [],
};
const configError: AlertEmailConfig = { mode: "config-error", errors: ["SMTP_FROM missing"] };

const liveOk: SendEmailResult = { delivered: true, dryRun: false };
const liveFail: SendEmailResult = {
  delivered: false,
  dryRun: false,
  error: "connect ETIMEDOUT",
};

interface HarnessOptions {
  latest: Date | null | "throw";
  initial?: AlertState | null;
  config?: AlertEmailConfig;
  queue?: SendEmailResult[];
  rejectIntentWrite?: boolean;
}

interface Harness {
  deps: AlertCheckDeps;
  sent: SendEmailInput[];
  logs: Record<string, unknown>[];
  store: () => AlertState | null;
  advanceOneDay: () => void;
}

function harness(options: HarnessOptions): Harness {
  let state: AlertState | null = options.initial ?? null;
  let clock: Date = NOW;
  const sent: SendEmailInput[] = [];
  const logs: Record<string, unknown>[] = [];
  const defaultResult: SendEmailResult =
    options.config?.mode === "dry-run"
      ? { delivered: true, dryRun: true }
      : liveOk;
  const queue = [...(options.queue ?? [defaultResult])];

  const deps: AlertCheckDeps = {
    now: () => clock,
    config: options.config ?? liveConfig,
    findLatestSuccessAt: async () => {
      if (options.latest === "throw") throw new Error("db down");
      return options.latest;
    },
    readState: async () => state,
    writeState: async (next) => {
      if (options.rejectIntentWrite && next.lastAttemptAt !== state?.lastAttemptAt) {
        throw new Error("disk full");
      }
      state = structuredClone(next);
    },
    send: async (input) => {
      sent.push(input);
      const result = queue.shift() ?? liveOk;
      if (result.dryRun) logs.push({ evt: "alert-email-dry-run" });
      return result;
    },
    log: (record) => void logs.push(record),
  };

  return {
    deps,
    sent,
    logs,
    store: () => state,
    advanceOneDay: () => {
      clock = NEXT_DAY;
    },
  };
}

describe("runAttendanceAlertCheck", () => {
  it("persists the send intent BEFORE the first live alert goes out", async () => {
    const h = harness({ latest: STALE_SUCCESS });
    let stateAtSend: AlertState | null = null;
    const originalSend = h.deps.send;
    h.deps.send = async (input) => {
      stateAtSend = h.store(); // Observed from inside the sender: ordering is the contract.
      return originalSend(input);
    };

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "send-first", exitCode: 0 });
    expect(h.sent).toHaveLength(1);
    expect(stateAtSend?.lastAlertDate).toBe("2026-09-11");
    expect(h.store()?.lastSentAt).not.toBeNull();
  });

  it("does not send twice within the same business day", async () => {
    const h = harness({ latest: STALE_SUCCESS });

    await runAttendanceAlertCheck(h.deps);
    const second = await runAttendanceAlertCheck(h.deps);

    expect(h.sent).toHaveLength(1);
    expect(second.decision).toBe("skip");
  });

  it("sends at most one repeat per next business day", async () => {
    const h = harness({ latest: STALE_SUCCESS });
    await runAttendanceAlertCheck(h.deps);

    h.advanceOneDay();
    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-repeat");
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.subject).toContain("已 7 天");
  });

  it("grants baseline grace on the first scan of a never-imported system", async () => {
    const h = harness({ latest: null });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "baseline", exitCode: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.store()?.lastState).toBe("baseline");
  });

  it("alerts on the second scan when imports have still never happened", async () => {
    const h = harness({
      latest: null,
      initial: {
        schemaVersion: 1,
        lastState: "baseline",
        firstAlertDate: null,
        lastAlertDate: null,
        lastRecoveryDate: null,
        lastCheckAt: null,
        lastAttemptAt: null,
        lastSentAt: null,
        lastError: null,
      },
    });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-first");
    expect(h.sent).toHaveLength(1);
  });

  it("sends recovery when imports resume and records the recovery date", async () => {
    const h = harness({
      latest: HEALTHY_SUCCESS,
      initial: {
        schemaVersion: 1,
        lastState: "stale",
        firstAlertDate: "2026-09-08",
        lastAlertDate: "2026-09-10",
        lastRecoveryDate: null,
        lastCheckAt: null,
        lastAttemptAt: null,
        lastSentAt: null,
        lastError: null,
      },
    });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-recovery");
    expect(h.sent[0]?.subject).toContain("已恢复正常");
    expect(h.store()).toMatchObject({ lastState: "ok", lastRecoveryDate: "2026-09-11" });
  });

  it("logs dry-run delivery without advancing any cadence date, twice on the same day", async () => {
    const h = harness({ latest: STALE_SUCCESS, config: dryRunConfig });

    const first = await runAttendanceAlertCheck(h.deps);
    const second = await runAttendanceAlertCheck(h.deps);

    expect(first).toMatchObject({ decision: "send-first", exitCode: 0 });
    expect(h.sent).toHaveLength(2);
    expect(h.logs.filter((l) => l.evt === "alert-email-dry-run")).toHaveLength(2);
    expect(h.store()).toBeNull(); // No file created: dry-run never persists send cadence.
  });

  it("still sends the live first alert on cutover day after dry-runs", async () => {
    const dry = harness({ latest: STALE_SUCCESS, config: dryRunConfig });
    await runAttendanceAlertCheck(dry.deps);

    const live = harness({ latest: STALE_SUCCESS, config: liveConfig });
    const result = await runAttendanceAlertCheck(live.deps);

    expect(result.decision).toBe("send-first");
    expect(live.sent[0]?.dryRun).toBe(false);
  });

  it("records a live send failure and does not retry within the same day", async () => {
    const h = harness({ latest: STALE_SUCCESS, queue: [liveFail] });

    const failed = await runAttendanceAlertCheck(h.deps);
    const retried = await runAttendanceAlertCheck(h.deps);

    expect(failed).toMatchObject({ exitCode: 1, errorCode: "send-failed" });
    expect(h.store()).toMatchObject({ lastError: "connect ETIMEDOUT", lastSentAt: null });
    expect(h.sent).toHaveLength(1); // Intent dated today suppresses the same-day retry.
    expect(retried.exitCode).toBe(0);
  });

  it("exits 1 on config-error without sending or touching state", async () => {
    const h = harness({ latest: STALE_SUCCESS, config: configError });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ exitCode: 1, errorCode: "config-error" });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("exits 2 when the database read fails, with no send and no state write", async () => {
    const h = harness({ latest: "throw" });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ exitCode: 2, errorCode: "db-read-failed" });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("exits 2 and never sends when the intent write fails", async () => {
    const h = harness({ latest: STALE_SUCCESS, rejectIntentWrite: true });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ exitCode: 2, errorCode: "state-write-failed" });
    expect(h.sent).toHaveLength(0);
  });

  // Plan-added cases (arbitration A extension): dry-run never creates the
  // state file on ANY decision, not just the three sending decisions.

  it("creates no state file on a dry-run cold-start baseline", async () => {
    const h = harness({ latest: null, config: dryRunConfig });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "baseline", exitCode: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("creates no state file on a healthy dry-run skip", async () => {
    const h = harness({ latest: HEALTHY_SUCCESS, config: dryRunConfig });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result).toMatchObject({ decision: "skip", exitCode: 0 });
    expect(h.sent).toHaveLength(0);
    expect(h.store()).toBeNull();
  });

  it("only touches stamps on a dry-run recovery scan with an existing file", async () => {
    const stale: AlertState = {
      schemaVersion: 1,
      lastState: "stale",
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
      lastRecoveryDate: null,
      lastCheckAt: "2026-09-10T15:00:00+08:00",
      lastAttemptAt: null,
      lastSentAt: null,
      lastError: null,
    };
    const h = harness({
      latest: HEALTHY_SUCCESS,
      config: dryRunConfig,
      initial: structuredClone(stale),
    });

    const result = await runAttendanceAlertCheck(h.deps);

    expect(result.decision).toBe("send-recovery");
    expect(h.sent).toHaveLength(1); // Dry-run "delivery" for log verification.
    expect(h.store()).toMatchObject({
      lastState: "stale", // Preserved: dry-run never rewrites tracked state.
      firstAlertDate: "2026-09-08",
      lastAlertDate: "2026-09-10",
      lastRecoveryDate: null,
    });
  });
});
```

关键契约（实现必须遵守，均被上面的用例钉死）：① intent 在 send 调用前落盘；② dry-run 日志 evt 由注入的 send 假件/真实 sender 产生，service 自身**不**再打 `alert-email-dry-run`（否则计数翻倍）；③ dry-run 状态文件不存在则不创建；④ live 发送失败 exit 1、意图日期已在故同日 skip；⑤ config-error/DB 失败不碰状态。

- [ ] **Step 4: 跑红（两文件都 FAIL）**

Run: `npx vitest run tests/alerts/exit-code.test.ts tests/alerts/alert-service.test.ts`
Expected: FAIL——模块无法解析。

- [ ] **Step 5: 最小实现 `src/lib/alerts/alert-service.ts`（完整内容）**

```ts
// One attendance staleness scan, orchestrated from injected dependencies so the
// whole pipeline is testable with in-memory fakes (no fs, nodemailer or prisma
// at import time). Crash-safety rule: for live sends the INTENT is persisted
// before delivery, so a crash between the two costs at most one email and
// never causes a resend storm on the same day.

import {
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  describeImportStaleness,
  type StalenessLevel,
} from "@/lib/attendance/import-staleness";
import { businessDayOf, formatDateOnly } from "@/lib/db/date";

import {
  baselineState,
  checkedState,
  failedState,
  intentStateFor,
  sentState,
  touchedState,
} from "./alert-state";
import type { AlertState } from "./alert-state";
import { decideAlertAction } from "./alert-decision";
import type { AlertDecisionKind } from "./alert-decision";
import { buildRecoveryEmail, buildStaleAlertEmail } from "./alert-template";
import type { AlertEmailConfig } from "./email-config";
import type { SendEmailInput, SendEmailResult } from "./email-sender";

export interface AlertCheckDeps {
  now: () => Date;
  config: AlertEmailConfig;
  findLatestSuccessAt: () => Promise<Date | null>;
  readState: () => Promise<AlertState | null>;
  writeState: (state: AlertState) => Promise<void>;
  send: (input: SendEmailInput) => Promise<SendEmailResult>;
  log: (record: Record<string, unknown>) => void;
}

export type AlertErrorCode =
  | "config-error"
  | "send-failed"
  | "db-read-failed"
  | "state-write-failed";

export interface AlertCheckResult {
  decision: AlertDecisionKind;
  exitCode: 0 | 1 | 2;
  errorCode?: AlertErrorCode;
}

export function exitCodeFor(errorCode: AlertErrorCode | undefined): 0 | 1 | 2 {
  if (errorCode === "config-error" || errorCode === "send-failed") return 1;
  if (errorCode === "db-read-failed" || errorCode === "state-write-failed") return 2;
  return 0;
}

function done(
  decision: AlertDecisionKind,
  errorCode: AlertErrorCode | undefined,
  log: (record: Record<string, unknown>) => void,
): AlertCheckResult {
  const exitCode = exitCodeFor(errorCode);
  log({ evt: "scan-done", exitCode });
  return { decision, exitCode, ...(errorCode === undefined ? {} : { errorCode }) };
}

export async function runAttendanceAlertCheck(
  deps: AlertCheckDeps,
): Promise<AlertCheckResult> {
  const { now, config, log } = deps;
  const instant = now();
  log({ evt: "scan-start" });

  // Step 1: database read. Failure short-circuits before any state IO.
  let latestSuccessAt: Date | null;
  try {
    latestSuccessAt = await deps.findLatestSuccessAt();
  } catch (error) {
    log({ evt: "db-read-failed", error: error instanceof Error ? error.message : String(error) });
    return done("skip", "db-read-failed", log);
  }

  // Step 2: compute the signal and the business calendar day.
  const staleness = describeImportStaleness(
    latestSuccessAt,
    instant,
    DEFAULT_STALENESS_THRESHOLD_DAYS,
  );
  const today = formatDateOnly(businessDayOf(instant));

  // Step 3: config gate. With config-error, sending is impossible and touching
  // cadence state would be meaningless.
  if (config.mode === "config-error") {
    log({ evt: "config-error", errors: config.errors });
    return done("skip", "config-error", log);
  }

  // Step 4: read state (corrupt files are already normalised to null) + decide.
  const prev = await deps.readState();
  const decision = decideAlertAction({ level: staleness.level, today, state: prev });
  log({
    evt: "alert-decision",
    level: staleness.level,
    daysSince: staleness.daysSince,
    decision: decision.kind,
  });

  // Step 5a: dry-run NEVER creates the state file and advances NO cadence
  // field. spec 5.1.7 states this for sending decisions; arbitration A
  // extends the same rule to skip/baseline, because the container dry-run
  // verification asserts the file stays absent on a healthy system too.
  // Sending decisions still render the mail and log one dry-run line per
  // stale scan, which is exactly what the cron verification greps for.
  if (config.mode === "dry-run") {
    if (decision.kind !== "skip" && decision.kind !== "baseline") {
      const mail = buildMail(
        decision.kind,
        staleness.level,
        staleness.daysSince,
        latestSuccessAt,
        instant,
      );
      await deps.send({ to: config.adminEmails, subject: mail.subject, text: mail.text });
    }
    if (prev !== null) {
      // Existing file: check/attempt stamps only, lastState and every date kept.
      try {
        await deps.writeState(touchedState(prev, instant));
      } catch (error) {
        // A touch failure must not upgrade a dry run to exit 2.
        log({
          evt: "state-write-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return done(decision.kind, undefined, log);
  }

  // Step 5b (live): non-sending paths refresh the check stamp / set baseline.
  if (decision.kind === "skip" || decision.kind === "baseline") {
    const next: AlertState =
      decision.kind === "baseline"
        ? baselineState(instant)
        : checkedState(prev ?? baselineState(instant), instant, decision.tracked);
    try {
      await deps.writeState(next);
    } catch (error) {
      log({
        evt: "state-write-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return done(decision.kind, "state-write-failed", log);
    }
    return done(decision.kind, undefined, log);
  }

  // Step 5c (live): persist intent FIRST; a failed intent write forbids
  // the send entirely.
  const base = prev ?? baselineState(instant);
  const intent = intentStateFor(base, decision.kind, today, instant);
  try {
    await deps.writeState(intent);
  } catch (error) {
    log({
      evt: "state-write-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return done(decision.kind, "state-write-failed", log);
  }

  const mail = buildMail(
    decision.kind,
    staleness.level,
    staleness.daysSince,
    latestSuccessAt,
    instant,
  );
  const result = await deps.send({
    to: config.adminEmails,
    subject: mail.subject,
    text: mail.text,
  });

  if (result.delivered) {
    try {
      await deps.writeState(sentState(intent, instant));
    } catch (error) {
      // The email is already out. Intent dates suppress a same-day resend;
      // surface the failed bookkeeping as an infra exit code.
      log({
        evt: "state-write-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return done(decision.kind, "state-write-failed", log);
    }
    // The sender owns the delivery events ("alert-email-sent"); the service
    // logs only orchestration, so each event appears exactly once per run.
    return done(decision.kind, undefined, log);
  }

  log({ evt: "alert-email-failed", error: result.error ?? "unknown" });
  try {
    await deps.writeState(failedState(intent, result.error ?? "unknown"));
  } catch (error) {
    log({
      evt: "state-write-failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return done(decision.kind, "state-write-failed", log);
  }
  return done(decision.kind, "send-failed", log);
}

function buildMail(
  kind: AlertDecisionKind,
  level: StalenessLevel,
  daysSince: number | null,
  latestSuccessAt: Date | null,
  now: Date,
): { subject: string; text: string } {
  // send-recovery only happens at level "ok", where a successful timestamp exists.
  if (kind === "send-recovery") {
    return buildRecoveryEmail({ latestSuccessAt: latestSuccessAt as Date, now });
  }
  return buildStaleAlertEmail({
    level,
    daysSince,
    latestSuccessAt,
    now,
  });
}
```

日志归属（spec §6 日志契约）：投递事件 `alert-email-dry-run` / `alert-email-sent` 只由 email-sender 打一行；service 只打编排事件（`scan-start`、`alert-decision`、`config-error`、`db-read-failed`、`state-write-failed`、`alert-email-failed`、`scan-done`），同一事件每次运行恰好出现一次。

- [ ] **Step 6: 跑绿（两文件 23 例）**

Run: `npx vitest run tests/alerts/`
Expected: 6 个 alerts 测试文件（decision 13 / state 13 / email-config 18 / template 8 / service 15 / exit-code 8）＝ **75 用例全过**。累计 683+75＝**758**。

- [ ] **Step 7: typecheck + lint + 全量 + 检查点**

Run: `npm run typecheck && npm run lint && npm test`
Expected: `Test Files 41 passed (41)`、`Tests 758 passed (758)`。停下报告，等许可后 commit：`feat: orchestrate attendance staleness alert scan with crash-safe cadence`

---

## Task 10: cron 入口薄壳 scripts/check-attendance-alert.ts + 本地干跑验证

**Files:**
- Create: `scripts/check-attendance-alert.ts`
- Test: 无单测（纯装配薄壳；全部逻辑在 Task 3–9 单测覆盖）。本任务以「本地真实进程跑两遍干跑」人工验证装配。

薄壳铁律（spec §5.2）：相对 import、无顶层 await、`void main().then().catch().finally(() => void prisma.$disconnect())` 收尾——逐字仿 `scripts/fetch-attendance.ts`。

- [ ] **Step 1: 创建脚本（完整内容）**

```ts
// Attendance staleness alert entry point (phase 1 walking skeleton).
//
// Run (local, env from .env):
//   node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts
// Run (production container, via deploy/cron/check-attendance-alert.sh):
//   docker compose -f docker-compose.prod.yml exec -T app \
//     node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts
//
// Exit codes (the host cron wrapper records them; see alert-service.ts):
//   0 scan completed: healthy skip, baseline grace, dry run, or a successful send
//   1 configuration error, or a live send failed
//   2 database read failed, or alert-state.json could not be written
//
// This is a thin shell: every decision is unit-tested in src/lib/alerts. The
// shell only wires the production implementations (prisma, real fs, nodemailer)
// into runAttendanceAlertCheck's injected dependencies.

import {
  alertStatePathFor,
  readAlertState,
  writeAlertState,
} from "../src/lib/alerts/alert-state";
import { runAttendanceAlertCheck } from "../src/lib/alerts/alert-service";
import { loadAlertEmailConfig } from "../src/lib/alerts/email-config";
import { createEmailSender } from "../src/lib/alerts/email-sender";
import { findLatestSuccessfulImportLog } from "../src/lib/db/import-log.repo";
import { prisma } from "../src/lib/prisma";

// Unexpected throw outside the orchestrated failure matrix (defensive): treat
// as infrastructure trouble, same class as a database failure.
const EXIT_INFRA = 2;

/** Plain-text first line for human cron logs / docker logs, before JSON lines. */
function printBanner(config: ReturnType<typeof loadAlertEmailConfig>): void {
  if (config.mode === "live") {
    console.log(
      `[attendance-alert] MODE=LIVE recipients=${String(config.adminEmails.length)}`,
    );
    return;
  }
  if (config.mode === "dry-run") {
    console.log(
      `[attendance-alert] MODE=DRY-RUN reason=${config.reason} recipients=${String(config.adminEmails.length)}`,
    );
    return;
  }
  console.log(
    `[attendance-alert] MODE=CONFIG-ERROR errors=${String(config.errors.length)}`,
  );
}

async function main(): Promise<number> {
  const config = loadAlertEmailConfig(process.env);
  printBanner(config);

  const stateFile = alertStatePathFor(process.env.DATABASE_URL);
  const sender = createEmailSender(config);

  const result = await runAttendanceAlertCheck({
    now: () => new Date(),
    config,
    findLatestSuccessAt: async () => {
      const log = await findLatestSuccessfulImportLog();
      return log === null ? null : log.importedAt;
    },
    readState: () => readAlertState(stateFile),
    writeState: (state) => writeAlertState(stateFile, state),
    send: (input) => sender.send(input),
    log: (record) => console.log(JSON.stringify(record)),
  });

  return result.exitCode;
}

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        evt: "scan-fatal",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = EXIT_INFRA;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
```

- [ ] **Step 2: typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: 零错误。

- [ ] **Step 3: 本地干跑第 1 遍（真实进程 + 本地 dev.db，只读）**

先确认 `.env` 存在（不打印内容）：`test -f .env && echo env-present`。
Expected: `env-present`。

Run:

```bash
node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
```

Expected（新功能尚未配置任何 SMTP_* 变量）：

- 首行逐字：`[attendance-alert] MODE=DRY-RUN reason=smtp-not-configured recipients=0`
- JSON 行依次含：`"evt":"scan-start"`、`"evt":"alert-decision"`（decision 随本地库实际新鲜度为 `skip`/`send-first`/`baseline` 之一，均合法）、若 decision 为发送类则含 `{"evt":"alert-email-dry-run","toCount":0,"subject":"..."}`、末行 `{"evt":"scan-done","exitCode":0}`
- `exit=0`

- [ ] **Step 4: 断言状态文件未生成 + 同日再跑一遍（仲裁 A）**

用 tsx 解析状态文件落点（不读 .env 里的任何值，只打印派生路径），随后断言文件不存在：

```bash
STATE_FILE=$(node --env-file=.env node_modules/tsx/dist/cli.mjs -e 'import("./src/lib/alerts/alert-state.ts").then((m) => process.stdout.write(m.alertStatePathFor(process.env.DATABASE_URL)))')
echo "state path: $STATE_FILE"
test ! -e "$STATE_FILE" && echo "state-absent-ok"
```

Expected: 打印一个绝对路径 + `state-absent-ok`（Git Bash 下若 `test -e` 对 Windows 盘符路径误判，改用 `node -e 'const fs=require("node:fs");process.exit(fs.existsSync(process.argv[1])?1:0)' "$STATE_FILE" && echo state-absent-ok`）。

紧接着第 2 遍运行同一条脚本命令：
- 退出码仍为 0；
- 若第一遍 decision 是发送类，第二遍**仍出现一行** `alert-email-dry-run`（干跑不推进频控，每个扫描点都留投递日志——cron 验证就靠它）；
- 状态文件依然不存在（重跑 Step 4 的断言）。

- [ ] **Step 5: config-error 路径快验（不写任何值到文件）**

Run（shell 内联环境变量优先于 `--env-file`，不修改 .env）：

```bash
SMTP_HOST=smtp.example.com SMTP_FROM=bad-value ALERT_ADMIN_EMAIL=not-an-email \
  node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
```

Expected: 首行 `[attendance-alert] MODE=CONFIG-ERROR errors=3`（SMTP_FROM/收件人/SMTP_HOST 非空但其余键缺失的错误数量以实际 email-config 文案为准，至少 ≥1）；JSON 含 `"evt":"config-error"` 与中文错误信息数组、`"evt":"scan-done","exitCode":1`；`exit=1`；不产生状态文件。

- [ ] **Step 6: 检查点 —— 停下报告，等许可后 commit**

报告三次运行的横幅、决策、退出码实测值。许可后 commit：`feat: add attendance staleness alert cron entry script`

---

## Task 11: 子页装配层 alerts-summary.ts（TDD，6 例）

**Files:**
- Create: `src/app/admin/alerts/alerts-summary.ts`
- Test: `tests/admin/alerts-view.test.ts`（spec §7.7 逐字 6 例）

两层结构（仲裁 B）：纯函数 `buildAlertBadge` / `buildAlertsPageView` 静态 import 且 prisma-free；loader 只在**函数体内动态 import** `@/lib/db/import-log.repo`（经它拖入 prisma，vitest 无 DATABASE_URL 会在建客户端时抛错）。

- [ ] **Step 1: 写失败测试（逐字，spec §7.7）**

创建 `tests/admin/alerts-view.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { buildAlertBadge, buildAlertsPageView } from "@/app/admin/alerts/alerts-summary";
import type { AlertEmailConfig } from "@/lib/alerts/email-config";
import type { AlertState } from "@/lib/alerts/alert-state";
import type { ImportStaleness } from "@/lib/attendance/import-staleness";

const OK: ImportStaleness = { level: "ok", daysSince: 0, message: null };
const STALE: ImportStaleness = { level: "stale", daysSince: 5, message: "已超过 3 天" };
const NEVER: ImportStaleness = { level: "never", daysSince: null, message: "从未导入" };
const live = (over: Partial<AlertEmailConfig> = {}): AlertEmailConfig =>
  ({ mode: "live", host: "h", port: 25, secure: false, user: null, pass: null, from: "s@x.com", adminEmails: ["a@x.com"], ...over }) as AlertEmailConfig;
const dry = (): AlertEmailConfig => ({ mode: "dry-run", reason: "smtp-not-configured", adminEmails: [] });

describe("buildAlertBadge", () => {
  it("shows a healthy channel in plan tone", () => {
    expect(buildAlertBadge({ config: live(), staleness: OK })).toMatchObject({
      tone: "ok",
      label: "告警通道：正常",
    });
  });

  it("warns that dry-run is not real protection", () => {
    expect(buildAlertBadge({ config: dry(), staleness: OK }).label).toBe(
      "告警通道：干跑中（不会真实发信）",
    );
  });

  it("reports the incident day count while stale", () => {
    expect(buildAlertBadge({ config: live(), staleness: STALE }).label).toContain("已 5 天");
  });

  it("has wording for never-imported systems", () => {
    expect(buildAlertBadge({ config: live(), staleness: NEVER }).label).toContain("从未有成功导入记录");
  });

  it("puts config errors above every other state", () => {
    const badge = buildAlertBadge({
      config: { mode: "config-error", errors: ["x"] },
      staleness: STALE,
    });
    expect(badge).toMatchObject({ tone: "danger", label: "告警通道配置错误" });
  });
});

describe("buildAlertsPageView PII masking", () => {
  it("never carries mailbox values or credentials into the view model", () => {
    const view = buildAlertsPageView({
      config: live({ pass: "super-secret", adminEmails: ["ops@cn.denso.com", "boss@cn.denso.com"] }),
      staleness: STALE,
      latestSuccessAt: new Date("2026-09-05T01:07:00.000Z"),
      state: null,
      now: new Date("2026-09-11T01:20:00.000Z"),
    });

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("super-secret");
    expect(view.channel.recipientCount).toBe(2);
  });
});
```

（逐字稿中未使用的 `AlertState` import 在本文件确实无引用——实施时删除该行，避免 lint no-unused-vars；其余逐字不动。）

- [ ] **Step 2: 跑红**

Run: `npx vitest run tests/admin/alerts-view.test.ts`
Expected: FAIL——模块无法解析。

- [ ] **Step 3: 实现 `src/app/admin/alerts/alerts-summary.ts`（完整内容）**

```ts
// View-model assembly for the admin alert badge and the /admin/alerts page.
//
// Two layers on purpose:
//   - pure builders (buildAlertBadge / buildAlertsPageView) have no prisma/fs
//     import graph and are unit-tested directly;
//   - loaders do the IO and dynamically import the prisma-backed import-log repo
//     INSIDE the function body, so merely importing this module never constructs
//     the Prisma client (vitest runs with no DATABASE_URL and its client is built
//     at module top level).
//
// PII rule: view models carry recipient COUNTS only - no mailbox values, no
// credentials (tests/admin/alerts-view.test.ts asserts it on the serialised view).

import {
  DEFAULT_STALENESS_THRESHOLD_DAYS,
  describeImportStaleness,
  type ImportStaleness,
  type StalenessLevel,
} from "@/lib/attendance/import-staleness";
import {
  alertStatePathFor,
  readAlertState,
  type AlertState,
} from "@/lib/alerts/alert-state";
import { loadAlertEmailConfig, type AlertEmailConfig } from "@/lib/alerts/email-config";
import { formatBusinessTimestamp } from "@/lib/db/date";

export interface AlertBadgeView {
  tone: "ok" | "warn" | "danger";
  label: string;
  href: "/admin/alerts";
}

const BADGE_HREF = "/admin/alerts";

// Priority (spec 5.3.1): config-error > stale/never incident > dry-run > ok.
// During a dry-run a real staleness incident still shows the danger label.
export function buildAlertBadge(input: {
  config: AlertEmailConfig;
  staleness: ImportStaleness;
}): AlertBadgeView {
  const { config, staleness } = input;

  if (config.mode === "config-error") {
    return { tone: "danger", label: "告警通道配置错误", href: BADGE_HREF };
  }
  if (staleness.level === "never") {
    return { tone: "danger", label: "考勤数据告警中：从未有成功导入记录", href: BADGE_HREF };
  }
  if (staleness.level === "stale") {
    // daysSince is null only on an unparseable stored timestamp, which is still
    // an incident the operator must investigate.
    const label =
      staleness.daysSince === null
        ? "考勤数据告警中：末次成功导入时间戳无法解析"
        : `考勤数据告警中：已 ${String(staleness.daysSince)} 天未成功导入`;
    return { tone: "danger", label, href: BADGE_HREF };
  }
  if (config.mode === "dry-run") {
    return { tone: "warn", label: "告警通道：干跑中（不会真实发信）", href: BADGE_HREF };
  }
  return { tone: "ok", label: "告警通道：正常", href: BADGE_HREF };
}

export interface AlertsPageView {
  badge: AlertBadgeView;
  channel: {
    modeLabel: string;
    reasonLabel: string | null;
    recipientCount: number;
    forcedByEnv: boolean;
    configErrors: readonly string[];
  };
  judgement: {
    level: StalenessLevel;
    daysSince: number | null;
    /** Business-local formatted timestamp, or null when there has never been a success. */
    latestSuccessAt: string | null;
    message: string | null;
  };
  frequency: AlertState | null;
}

const MODE_LABELS: Record<AlertEmailConfig["mode"], string> = {
  live: "真实发送",
  "dry-run": "干跑",
  "config-error": "配置错误",
};

const DRY_RUN_REASON_LABELS = {
  "smtp-not-configured": "未配置 SMTP_HOST，系统自动进入干跑（配置后重启容器即转为真实发送）",
  "forced-by-env": "环境变量 ALERT_EMAIL_DRY_RUN=true 强制干跑",
} as const;

export function buildAlertsPageView(input: {
  config: AlertEmailConfig;
  staleness: ImportStaleness;
  latestSuccessAt: Date | null;
  state: AlertState | null;
  now: Date;
}): AlertsPageView {
  const { config, staleness, latestSuccessAt, state } = input;
  return {
    badge: buildAlertBadge({ config, staleness }),
    channel: {
      modeLabel: MODE_LABELS[config.mode],
      reasonLabel:
        config.mode === "dry-run" ? DRY_RUN_REASON_LABELS[config.reason] : null,
      recipientCount: config.mode === "config-error" ? 0 : config.adminEmails.length,
      forcedByEnv: config.mode === "dry-run" && config.reason === "forced-by-env",
      configErrors: config.mode === "config-error" ? config.errors : [],
    },
    judgement: {
      level: staleness.level,
      daysSince: staleness.daysSince,
      latestSuccessAt:
        latestSuccessAt === null ? null : formatBusinessTimestamp(latestSuccessAt),
      message: staleness.message,
    },
    frequency: state,
  };
}

export async function loadAlertBadgeData(): Promise<{
  config: AlertEmailConfig;
  staleness: ImportStaleness;
} | null> {
  try {
    // Dynamic import: this edge pulls in the Prisma client, whose module top
    // level constructs a client and throws when DATABASE_URL is absent.
    const { findLatestSuccessfulImportLog } = await import("@/lib/db/import-log.repo");
    const config = loadAlertEmailConfig(process.env);
    const log = await findLatestSuccessfulImportLog();
    const latestSuccessAt = log === null ? null : log.importedAt;
    const staleness = describeImportStaleness(
      latestSuccessAt,
      new Date(),
      DEFAULT_STALENESS_THRESHOLD_DAYS,
    );
    return { config, staleness };
  } catch {
    return null;
  }
}

export async function loadAlertsPageData(): Promise<{
  config: AlertEmailConfig;
  staleness: ImportStaleness;
  latestSuccessAt: Date | null;
  state: AlertState | null;
} | null> {
  try {
    const { findLatestSuccessfulImportLog } = await import("@/lib/db/import-log.repo");
    const config = loadAlertEmailConfig(process.env);
    const log = await findLatestSuccessfulImportLog();
    const latestSuccessAt = log === null ? null : log.importedAt;
    const now = new Date();
    const staleness = describeImportStaleness(
      latestSuccessAt,
      now,
      DEFAULT_STALENESS_THRESHOLD_DAYS,
    );
    const state = await readAlertState(alertStatePathFor(process.env.DATABASE_URL));
    return { config, staleness, latestSuccessAt, state };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑绿 + 全量**

Run: `npx vitest run tests/admin/alerts-view.test.ts`
Expected: 6 例全过。
Run: `npm test`
Expected: `Test Files 42 passed (42)`、`Tests 764 passed (764)`。

- [ ] **Step 5: typecheck + lint + 检查点**

Run: `npm run typecheck && npm run lint`
Expected: 零错误。停下报告，等许可后 commit：`feat: assemble admin alert badge and alerts page view models`

---

## Task 12: AlertStatusBadge 组件 + 主页接线（无新增单测）

**Files:**
- Create: `src/app/admin/_components/AlertStatusBadge.tsx`
- Modify: `src/app/admin/page.tsx`（import 区、Promise.all、header 三处）
- Test: 无新增（纯展示 + 接线；回归全量 764，目视留 Task 15 的 dev server 门）

- [ ] **Step 1: 创建角标组件（完整内容）**

`src/app/admin/_components/AlertStatusBadge.tsx`：

```tsx
// Admin home badge linking to the attendance staleness alert sub-page.
// Pure presentation (server component, zero client JS): the view model -
// including the four verbatim Chinese labels - is built and unit-tested in
// ../alerts/alerts-summary.ts.

import Link from "next/link";
import type { ReactElement } from "react";

import type { AlertBadgeView } from "../alerts/alerts-summary";

// Literal class strings on purpose: Tailwind scans source text and would not
// see classes assembled by string interpolation.
const TONE_CLASS: Record<AlertBadgeView["tone"], string> = {
  ok: "text-plan",
  warn: "text-warn",
  danger: "text-challenge",
};

export function AlertStatusBadge({ view }: { view: AlertBadgeView }): ReactElement {
  return (
    <Link
      href={view.href}
      className={`mt-3 inline-flex rounded-md bg-muted/60 px-3 py-2 text-xs ring-1 ring-border ${TONE_CLASS[view.tone]}`}
    >
      {view.label}
    </Link>
  );
}
```

- [ ] **Step 2: 修改 `src/app/admin/page.tsx` —— import**

在既有相对 import 区（`./_components/KvTable` 三行）之前加两行（保持「`@/` 绝对 import 在前、相对 import 在后」的既有分组）：

```ts
import { AlertStatusBadge } from "./_components/AlertStatusBadge";
import { loadAlertBadgeData } from "./alerts/alerts-summary";
import { KvTable, type KvColumn } from "./_components/KvTable";
import { JobTitleRuleEditor } from "./_components/JobTitleRuleEditor";
import { OrgEditor } from "./_components/OrgEditor";
```

- [ ] **Step 3: 修改 `src/app/admin/page.tsx` —— 第五个并行只读 + 角标渲染**

`Promise.all` 改为五项（loader 内部已 catch-all，外层再包 `.catch(() => null)` 双保险，任何失败绝不拖垮主页）：

```ts
  const [snapshot, fiscalYears, jobTitleRules, config, alertBadge] = await Promise.all([
    loadOrgSnapshot(),
    loadFiscalYearRows(),
    findAllJobTitleRules(),
    getAllConfig(),
    // Read-only and self-swallowing: the admin home must render even when the
    // alert subsystem's database read is unavailable.
    loadAlertBadgeData().catch(() => null),
  ]);
```

D-173 警告块的 `</p>`（现 :207）之后、header 内层 `</div>`（现 :208）之前插入：

```tsx
          {alertBadge === null ? null : <AlertStatusBadge view={alertBadge} />}
```

即该处结构变为：

```tsx
            ——快照只能回答「什么时候被改成了什么样」，不能回答「是谁改的」。
          </p>
          {alertBadge === null ? null : <AlertStatusBadge view={alertBadge} />}
        </div>
      </header>
```

- [ ] **Step 4: 门禁（无新增用例，纯回归）**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 零 lint/type 错误；`Test Files 42 passed (42)`、`Tests 764 passed (764)`。

- [ ] **Step 5: 检查点 —— 停下报告，等许可后 commit**

目视确认（角标四态位置/颜色/链接）统一在 Task 15 的 🛑 dev server 目视门做，本步不启服务。许可后 commit：`feat: surface attendance alert badge on admin home`

---

## Task 13: /admin/alerts 子页 page.tsx + 测试发送 actions.ts

**Files:**
- Create: `src/app/admin/alerts/actions.ts`
- Create: `src/app/admin/alerts/page.tsx`
- Test: 无新增单测（视图模型已在 Task 11 覆盖 6 例；action 体内首行鉴权沿用既有范式；四横幅/四卡/按钮目视在 Task 15 的 dev server 门）

- [ ] **Step 0: 🛑 AGENTS.md 铁律——先查本机 Next 16 文档，再动手**

写 action/page 前必须读 `node_modules/next/dist/docs/`（本仓库安装版，非训练数据）：

```bash
ls node_modules/next/dist/docs/
grep -rl "redirect" node_modules/next/dist/docs/ | head -5
grep -rl "Server Action" node_modules/next/dist/docs/ | head -5
```

核对四件事：① `redirect()` 在 Server Action 中的抛错语义与导入路径（`next/navigation`）；② 原生 `<form action={fn}>` 对无参 action 的调用约定；③ `searchParams` 为 Promise 的取值方式（本仓库 `src/app/admin/audit/page.tsx:343-356` 已是此范式，可对照）；④ action 文件顶部 `"use server"` 要求。若文档与下方代码范式有出入，以文档为准改代码，并在报告里说明差异。

- [ ] **Step 1: 创建 `src/app/admin/alerts/actions.ts`（完整内容）**

```ts
// Server Action for the "send test email" button on /admin/alerts.
//
// Boundary rules (same as every admin action):
//   - requireAdmin() MUST be the first statement. Path/middleware/nav checks
//     are all bypassable (POSTs can hit the action directly); only the in-body
//     check is load-bearing.
//   - Test sends deliberately do NOT touch alert-state.json: they must not
//     advance firstAlertDate / lastAlertDate or suppress a real alert.
//   - The sanitised failure detail stays in container logs. The redirect query
//     carries only the outcome enum, never error text.

"use server";

import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth";
import { buildTestEmail } from "@/lib/alerts/alert-template";
import { loadAlertEmailConfig } from "@/lib/alerts/email-config";
import type { DryRunEmailConfig, LiveEmailConfig } from "@/lib/alerts/email-config";
import { createEmailSender, type EmailSender } from "@/lib/alerts/email-sender";

// Unlike the short-lived cron script, the Next server process is long-lived, so
// the transport is built lazily once and reused. Config comes from process env
// and only changes on container restart.
let cachedSender: EmailSender | null = null;

function senderFor(config: LiveEmailConfig | DryRunEmailConfig): EmailSender {
  if (cachedSender === null) {
    cachedSender = createEmailSender(config);
  }
  return cachedSender;
}

export async function sendTestAlertEmailAction(): Promise<void> {
  await requireAdmin();

  const config = loadAlertEmailConfig(process.env);
  if (config.mode === "config-error") {
    redirect("/admin/alerts?test=config-error");
  }

  const mail = buildTestEmail({
    now: new Date(),
    dryRun: config.mode === "dry-run",
    recipientCount: config.adminEmails.length,
  });
  const result = await senderFor(config).send({
    to: config.adminEmails,
    subject: mail.subject,
    text: mail.text,
  });

  if (result.dryRun) redirect("/admin/alerts?test=dry-run");
  if (result.delivered) redirect("/admin/alerts?test=sent");
  redirect("/admin/alerts?test=error");
}
```

- [ ] **Step 2: 创建 `src/app/admin/alerts/page.tsx`（完整内容）**

```tsx
// /admin/alerts - attendance staleness alert operations page (phase 1).
//
// Four read-only cards (channel / current judgement / frequency control / test
// send) and one native form posting to a Server Action. Zero client JS.
// loadAlertsPageData() fails soft to null, so this page still renders when the
// database or state file is unavailable instead of returning a 500.

import Link from "next/link";
import type { ReactElement, ReactNode } from "react";

import { MainNav } from "@/components/layout/MainNav";
import { Button } from "@/components/ui/button";
import type { AlertTrackedState } from "@/lib/alerts/alert-state";
import type { StalenessLevel } from "@/lib/attendance/import-staleness";
import { requireAdminPage } from "@/lib/auth-page";
import { formatBusinessTimestamp } from "@/lib/db/date";

import { sendTestAlertEmailAction } from "./actions";
import { buildAlertsPageView, loadAlertsPageData } from "./alerts-summary";
import type { AlertsPageView } from "./alerts-summary";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "考勤数据告警 | 工时管理系统",
  description: "考勤停摆邮件告警通道、当前判定与频控状态",
};

const TEST_BANNERS = {
  sent: "测试邮件已真实发送，请查收。",
  "dry-run":
    "当前为干跑模式：未真实发送，投递内容已写入容器日志（alert-email-dry-run）。",
  "config-error":
    "告警邮件配置有误，请修正 SMTP_* / ALERT_ADMIN_EMAIL 后重启容器。详见本页通道状态卡。",
  error: "发送失败，容器日志中可查到脱敏后的错误原因。",
} as const;

type TestOutcome = keyof typeof TEST_BANNERS;
const TEST_OUTCOMES: readonly TestOutcome[] = [
  "sent",
  "dry-run",
  "config-error",
  "error",
];

/** Only the four enumerated outcomes render a banner; anything else renders none. */
function parseTestOutcome(raw: string | undefined): TestOutcome | null {
  if (raw === undefined) return null;
  return (TEST_OUTCOMES as readonly string[]).includes(raw)
    ? (raw as TestOutcome)
    : null;
}

const TRACKED_LABELS: Record<AlertTrackedState, string> = {
  ok: "正常",
  stale: "停摆中",
  baseline: "冷启动基线（首次扫描宽限）",
};

const LEVEL_LABELS: Record<StalenessLevel, string> = {
  ok: "正常（导入新鲜）",
  stale: "停摆（超过阈值）",
  never: "从未成功导入",
};

const CONVENTION_NOTE =
  "口径说明：PARTIAL（部分成功）视为成功；仅有汇总行、数据行数为 0 的文件也视为成功。距上次成功导入超过 3 个自然日即触发告警。";

function Card({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="space-y-3">
      <h2 className="font-heading text-xl font-semibold tracking-tight">{title}</h2>
      <div className="overflow-hidden rounded-lg bg-card ring-1 ring-border">
        <div className="space-y-4 p-5">{children}</div>
      </div>
    </section>
  );
}

function KvRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="grid grid-cols-[12rem_1fr] gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function StateInstant({ value }: { value: string | null }): ReactElement {
  if (value === null) return <span className="text-muted-foreground/60">—</span>;
  return <span className="tabular-nums">{formatBusinessTimestamp(new Date(value))}</span>;
}

function StateDate({ value }: { value: string | null }): ReactElement {
  if (value === null) return <span className="text-muted-foreground/60">—</span>;
  return <span className="tabular-nums">{value}</span>;
}

function ResultBanner({ outcome }: { outcome: TestOutcome }): ReactElement {
  const tone =
    outcome === "sent"
      ? "bg-plan/10 text-plan ring-plan/25"
      : outcome === "dry-run"
        ? "bg-warn/10 text-warn ring-warn/30"
        : "bg-challenge/10 text-challenge ring-challenge/30";
  return (
    <p className={`rounded-md px-3 py-2 text-sm ring-1 ${tone}`}>{TEST_BANNERS[outcome]}</p>
  );
}

function ChannelCard({ view }: { view: AlertsPageView }): ReactElement {
  const { channel } = view;
  return (
    <Card title="通道状态">
      <dl className="space-y-2">
        <KvRow label="发送模式">
          <span className="font-medium">{channel.modeLabel}</span>
          {channel.forcedByEnv ? (
            <span className="ml-2 rounded bg-warn/10 px-1.5 py-0.5 text-xs text-warn">
              ALERT_EMAIL_DRY_RUN 强制
            </span>
          ) : null}
        </KvRow>
        <KvRow label="干跑原因">
          {channel.reasonLabel === null ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            channel.reasonLabel
          )}
        </KvRow>
        <KvRow label="收件人数量">
          <span className="tabular-nums">{channel.recipientCount}</span>
          <span className="ml-2 text-xs text-muted-foreground">（不显示邮箱地址）</span>
        </KvRow>
      </dl>
      {channel.configErrors.length > 0 ? (
        <div className="rounded-md bg-challenge/10 p-3 text-sm text-challenge ring-1 ring-challenge/30">
          <p className="font-medium">配置错误（修正 SMTP_* / ALERT_ADMIN_EMAIL 后重启容器生效）：</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {channel.configErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

function JudgementCard({ view }: { view: AlertsPageView }): ReactElement {
  const { judgement } = view;
  return (
    <Card title="当前判定">
      <dl className="space-y-2">
        <KvRow label="当前信号">{LEVEL_LABELS[judgement.level]}</KvRow>
        <KvRow label="末次成功导入时间">
          {judgement.latestSuccessAt === null ? (
            <span className="text-muted-foreground/60">—（从未有成功导入记录）</span>
          ) : (
            <span className="tabular-nums">{judgement.latestSuccessAt}</span>
          )}
        </KvRow>
        <KvRow label="距今天数">
          {judgement.daysSince === null ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            <span className="tabular-nums">{judgement.daysSince} 个自然日（Asia/Shanghai）</span>
          )}
        </KvRow>
        {judgement.message === null ? null : (
          <KvRow label="系统判定说明">{judgement.message}</KvRow>
        )}
      </dl>
      <p className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground ring-1 ring-border">
        {CONVENTION_NOTE}
      </p>
    </Card>
  );
}

function FrequencyCard({ view }: { view: AlertsPageView }): ReactElement {
  const state = view.frequency;
  if (state === null) {
    return (
      <Card title="频控状态">
        <p className="text-sm text-muted-foreground">尚未运行过扫描。</p>
        <p className="text-xs text-muted-foreground">
          状态文件在真实发送模式下首次有效扫描时创建；干跑模式永不创建或推进状态文件。
        </p>
      </Card>
    );
  }
  return (
    <Card title="频控状态">
      <dl className="space-y-2">
        <KvRow label="状态文件版本">
          <span className="tabular-nums">{state.schemaVersion}</span>
        </KvRow>
        <KvRow label="当前跟踪状态">{TRACKED_LABELS[state.lastState]}</KvRow>
        <KvRow label="首次告警日期">
          <StateDate value={state.firstAlertDate} />
        </KvRow>
        <KvRow label="最近告警日期">
          <StateDate value={state.lastAlertDate} />
        </KvRow>
        <KvRow label="最近恢复日期">
          <StateDate value={state.lastRecoveryDate} />
        </KvRow>
        <KvRow label="最近扫描时间">
          <StateInstant value={state.lastCheckAt} />
        </KvRow>
        <KvRow label="最近发送尝试时间">
          <StateInstant value={state.lastAttemptAt} />
        </KvRow>
        <KvRow label="最近成功发送时间">
          <StateInstant value={state.lastSentAt} />
        </KvRow>
        <KvRow label="最近错误（已脱敏）">
          {state.lastError === null ? (
            <span className="text-muted-foreground/60">—</span>
          ) : (
            <span className="text-challenge">{state.lastError}</span>
          )}
        </KvRow>
      </dl>
    </Card>
  );
}

function TestCard(): ReactElement {
  return (
    <Card title="测试发送">
      <p className="text-sm text-muted-foreground">
        向配置的管理员邮箱发送一封通道测试邮件。测试发送不会写入或推进频控状态。
        当前为干跑模式时，提交后只在容器日志写入一行 alert-email-dry-run，不会真实投递。
      </p>
      <form action={sendTestAlertEmailAction}>
        <Button type="submit">发送测试邮件</Button>
      </form>
    </Card>
  );
}

interface AlertsPageProps {
  /** A Promise since Next 16 - same shape as /admin/audit. */
  searchParams?: Promise<{ test?: string }>;
}

export default async function AlertsPage({
  searchParams,
}: AlertsPageProps): Promise<ReactElement> {
  // First statement: the proxy matcher is a redirect convenience, not a boundary.
  await requireAdminPage("/admin/alerts");

  const params = (await searchParams) ?? {};
  const outcome = parseTestOutcome(params.test);
  const data = await loadAlertsPageData();
  const view =
    data === null ? null : buildAlertsPageView({ ...data, now: new Date() });

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <div className="mb-5 flex items-center justify-between gap-6">
            <MainNav active="admin" />
            <span className="text-xs text-muted-foreground">管理员已登录</span>
          </div>
          <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            Alert Channel
          </p>
          <h1 className="mt-1 font-heading text-3xl font-bold tracking-tight">考勤数据告警</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            考勤数据停摆邮件告警的通道状态、实时判定、频控记录与测试发送。
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-6 py-8">
        <nav aria-label="面包屑" className="text-xs">
          <Link href="/admin" className="text-plan hover:underline">
            ← 返回主数据管理
          </Link>
        </nav>

        {outcome === null ? null : <ResultBanner outcome={outcome} />}

        {view === null ? (
          <Card title="告警状态">
            <p className="text-sm text-muted-foreground">
              告警状态暂时无法读取（数据或状态文件读取失败），请查看容器日志。
              宿主 cron 触发的定时扫描不依赖本页，仍会按计划运行。
            </p>
          </Card>
        ) : (
          <>
            <ChannelCard view={view} />
            <JudgementCard view={view} />
            <FrequencyCard view={view} />
            <TestCard />
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: 门禁**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 零类型/lint 错误；`Test Files 42 passed (42)`、`Tests 764 passed (764)`（页面不新增测试文件）。

- [ ] **Step 4: 检查点 —— 停下报告，等许可后 commit**

许可后 commit：`feat: add /admin/alerts page with test-email action`

---

## Task 14: .env.production.example 增补告警 8 键

**Files:**
- Modify: `.env.production.example`（头部穷举声明 + 文末新增一节；不创建/不修改任何真实 `.env.production`）

铁律：本文件只允许空值样板，绝不写入口令值；不碰服务器上的真实文件。

- [ ] **Step 1: 改写头部穷举声明（现 :9-13）**

将：

```
# These are ALL the environment variables the application code reads. Verified
# by searching the source: DATABASE_URL, ORG_DATA_SOURCE, ADMIN_PASSWORD,
# SESSION_SECRET, COOKIE_SECURE, NODE_ENV. Nothing else has any effect, so do
# not expect to configure ports, thresholds, or feature flags here - none exist
# yet (see D-212, deferred to v2).
```

替换为：

```
# These are ALL the environment variables the application code reads. Verified
# by searching the source: DATABASE_URL, ORG_DATA_SOURCE, ADMIN_PASSWORD,
# SESSION_SECRET, COOKIE_SECURE, NODE_ENV, plus the attendance-staleness email
# block SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM,
# ALERT_ADMIN_EMAIL, ALERT_EMAIL_DRY_RUN. Nothing else has any effect. With
# SMTP_HOST left empty the alert channel runs in safe dry-run mode - see the
# dedicated section at the bottom of this file.
```

（删除「none exist yet / D-212」那句，因为告警功能已经存在。）

- [ ] **Step 2: 在文件末尾（COOKIE_SECURE 段之后）追加告警配置节（完整内容）**

```

# -----------------------------------------------------------------------------
# Attendance staleness email alerts (optional; empty SMTP_HOST => dry-run)
# -----------------------------------------------------------------------------
# The host cron wrapper runs scripts/check-attendance-alert.ts twice every
# business day. With SMTP_HOST left empty the alert channel is in DRY-RUN:
# scans run normally and one JSON line per would-be email lands in the
# container log, but nothing is sent and no alert-state.json is created. That
# is the safe default, not a misconfiguration - fill this block and restart the
# container to start sending real email.
#
# Fail closed, never silent: once SMTP_HOST is non-empty, any invalid value in
# this block (bad port, malformed address, SMTP_FROM missing, only one of
# SMTP_USER/SMTP_PASS set, ...) puts the channel in config-error: /admin/alerts
# lists every problem and the cron job exits 1. It never quietly falls back to
# dry-run on its own.

# SMTP relay host. Empty = dry-run (see above).
SMTP_HOST=

# SMTP port. 25 is plaintext / opportunistic STARTTLS; 465 is implicit TLS and
# then SMTP_SECURE must be true. 587 normally stays SMTP_SECURE=false.
SMTP_PORT=25

# true = implicit TLS on connect (nodemailer "secure", port 465 style);
# false = plaintext with opportunistic STARTTLS upgrade.
SMTP_SECURE=false

# Leave BOTH empty for an unauthenticated internal relay. They must be set
# together: setting exactly one of them is reported as a configuration error.
SMTP_USER=
SMTP_PASS=

# Envelope From address, e.g. manhour-alerts@internal.example. Required once
# SMTP_HOST is non-empty.
SMTP_FROM=

# Comma-separated administrator mailboxes, at most 3. Invalid entries are
# silently dropped in dry-run; in live mode a single malformed entry makes the
# whole channel a config error until fixed.
ALERT_ADMIN_EMAIL=

# Escape hatch: true forces dry-run even with a fully configured SMTP block
# (e.g. during a mail-server migration). Highest precedence; false or unset
# follows the SMTP_HOST decision above.
ALERT_EMAIL_DRY_RUN=false
```

- [ ] **Step 3: 校验（不跑服务）**

Run:

```bash
grep -c '^SMTP_\|^ALERT_' .env.production.example
grep -n '=$' .env.production.example | grep -v 'ADMIN_PASSWORD=\|SESSION_SECRET=' 
```

Expected: 第一条输出 `8`（8 个告警键各出现一次）；第二条只列出新增 8 键与既有空值行，无任何非空口令值。再跑 `npm run typecheck`（不读 env，但确认未误伤其他文件）零错误。

- [ ] **Step 4: 检查点 —— 停下报告，等许可后 commit**

许可后 commit：`docs: document attendance alert SMTP environment variables`

---

## Task 15: 全量门禁五连 + 🛑 dev server 目视门

**Files:**
- 无新增/修改文件（纯验证任务）。本任务的所有动作都在实现任务 2–14 完成之后进行。

- [ ] **Step 1: Prisma client 重新生成**

Run: `npm run db:generate`
Expected: 成功退出，无 schema 漂移错误（本功能不新增 migration，但 alerts 代码依赖既有 client，确认生成产物在位）。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 退出码 0，无任何输出（仓库既有基线即零错误）。若报错，按「连续两次修复失败 → build-error-resolver」纪律处理，不得 `// @ts-expect-error` 压过。

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 无 error；warning 数量不高于本功能开工前基线（Task 1 已记录）。新增代码不允许引入 `@typescript-eslint/no-explicit-any`、未使用 import、console 直写（脚本内 stdout JSON 除外，那是既有脚本范式）。

- [ ] **Step 4: 全量单测**

Run: `npm test`
Expected: `Test Files 42 passed (42)`、`Tests 764 passed (764)`，无 skipped/only 残留。
计数对账：683 基线（35 文件）+ 75 新用例（email-config 18、alert-state 13、alert-decision 13、alert-template 8、alert-service 15、alert-exit-code 8，其中 service 文件内含两个 describe 文件共 23 例的口径见 Task 9）+ alerts-view 6 = 764（精确以 Task 9/11 正文计数锚点为准；若执行中发现锚点算术不符，先停下核对再决定修测试还是修锚点，禁止为凑数删用例）。

- [ ] **Step 5: 生产构建**

Run: `npm run build`
Expected: 构建成功；路由表中出现 `/admin/alerts` 且标记为 `ƒ (Dynamic)`（force-dynamic 生效）；无新增 client component 警告（AlertStatusBadge 是 Server Component，全页零 client JS 增量）。

- [ ] **Step 6: 🛑 请批门 —— 启动 dev server 目视验证**

**停下报告，等用户明确批准后才执行本步。** 未经许可不得 `npm run dev`、不得开浏览器、不得改任何真实 `.env`。

批准后启动（只带最小环境；DATABASE_URL 指向既有本地 dev.db，不触碰生产库）：

```bash
npm run dev
```

按下列清单逐项目视（浏览器动作由用户完成或在用户监督下完成；agent 只记录结果）：

1. **未登录跳转**：匿名打开 `http://localhost:3000/admin/alerts` → 跳登录页（requireAdminPage 范式）；登录后回到 `/admin/alerts`。
2. **子页四卡渲染**：渠道卡显示「干跑模式（未配置 SMTP，自动干跑）」类文案（逐字以 Task 13 TEST_BANNERS/标签表为准）、收件人 0；判定卡显示当前停摆级别与中文说明；频控卡九字段在「尚未运行过扫描」时显示空态文案而非空白/报错；测试卡有一个原生提交按钮。
3. **主页角标**：`/admin` 主页 D-173 块下方出现告警角标，点击进入 `/admin/alerts`；颜色三态（ok 绿/warn 黄/danger 红）在当前本地数据下与子页判定一致。
4. **测试发送（干跑）**：本地未配 SMTP 时点测试发送 → 回到 `/admin/alerts?test=dry-run` 并显示干跑横幅（actions 四出口 config-error/dry-run/sent/error 的逐字文案以 Task 13 TEST_BANNERS 为准）；dev server 终端出现一行 `{"evt":"alert-email-dry-run",...}` JSON。
5. **非法参数无横幅**：访问 `/admin/alerts?test=hacker` → 无任何结果横幅（parseTestOutcome 只认四枚举）；`?test=` 空值同样无横幅。
6. **控制台干净**：浏览器 console 与 dev server 终端均无 React key/属性警告、无未处理 promise rejection。

验收完毕后 Ctrl-C 停 dev server，报告六项逐条结果。目视发现的任何问题回对应 Task 修复（测试先行），不得在本任务里临时打补丁。

- [ ] **Step 7: 检查点 —— 停下报告**

五连输出与目视六项结果汇总报告给用户。本任务无 commit（无文件变更）。

---

## Task 16: Dockerfile runner 补包 + 宿主 cron wrapper + runbook 章节

**Files:**
- Modify: `Dockerfile`（runner 阶段两处：:202 后加 nodemailer；:223 替换为 4 行 COPY）
- Create: `deploy/cron/check-attendance-alert.sh`（版本化 wrapper，入仓库）
- Create: `deploy/cron/crontab.example`
- Modify: `docs/DEPLOY.md`（在第 10 步与第 11 步之间插入「第 10 步附：考勤停摆邮件告警」，不重编既有步号）

事实锚点（开工前已核对）：`tsconfig.json` 自含无 extends，`paths` 为 `@/* → ./src/*`，tsx 从 cwd `/app` 读取它；`deploy/` 目录尚不存在，本任务新建；现网 cron 的真实写法以服务器上的 fetch wrapper 为准（R1 未核实），仓库内唯一可参照的现网风格锚点是 DEPLOY.md 第 11 步的 `cd /opt/manhour-mgmt/app && docker compose -f docker-compose.prod.yml exec -T app …`。

- [ ] **Step 1: Dockerfile 改动一 —— tsx 之后加 nodemailer**

在 `Dockerfile` 中找到（现 :202）：

```dockerfile
COPY --from=builder --chown=node:node /app/node_modules/tsx ./node_modules/tsx
```

在其正下方新增两行：

```dockerfile
# nodemailer drives scripts/check-attendance-alert.ts. Pure JavaScript with zero
# runtime dependencies (verified by npm ls at install time, Task 7), so the one
# package directory is the whole requirement. @types/nodemailer is build-time
# only and intentionally NOT copied: tsx erases types without loading it.
COPY --from=builder --chown=node:node /app/node_modules/nodemailer ./node_modules/nodemailer
```

- [ ] **Step 2: Dockerfile 改动二 —— 单脚本 COPY 换成脚本链所需全集**

找到现 :204-223 的这段尾部（保留上方 better-sqlite3 的大段说明注释与 :222 的 better-sqlite3 COPY 不动），把最后一行：

```dockerfile
COPY --from=builder --chown=node:node /app/scripts/backup-db.mjs ./scripts/backup-db.mjs
```

替换为：

```dockerfile
# All host-run scripts, not just backup-db.mjs. fetch-attendance.ts and
# check-attendance-alert.ts are TypeScript executed with tsx, which needs
# tsconfig.json at /app (the "@/*" path alias maps to ./src/*) plus the src/lib
# and src/generated trees the alert chain imports. The backup script keeps
# working: it lives in the copied scripts/ directory and its relative data path
# is unchanged. What the alert chain actually resolves at runtime is verified
# against the built image in the image-test task; missing packages get added
# there only if the run proves them missing - no speculative COPYs here.
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/src/lib ./src/lib
COPY --from=builder --chown=node:node /app/src/generated ./src/generated
```

注意：`@prisma/adapter-better-sqlite3` 与生成客户端是否已被 standalone trace 覆盖**不在本步预判**；Task 17 在真实镜像里实测，缺什么补什么。

- [ ] **Step 3: 新建 `deploy/cron/check-attendance-alert.sh`（逐字，spec §5.6）**

```bash
#!/usr/bin/env bash
# Twice-daily attendance staleness alert check. Runs INSIDE the app container so
# it shares DATABASE_URL / SMTP_* from env_file and the /app/data bind mount.
# Exits non-zero if the container is down - the host cron MAIL/log then records it,
# which is the whole point of keeping the alarm outside the container.
set -euo pipefail

# Compose project directory - kept identical to the existing fetch wrapper.
# VERIFY against /opt/manhour-mgmt/scripts/fetch-attendance.sh at deploy time.
cd /opt/manhour-mgmt

docker compose exec -T app \
  node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts
```

- [ ] **Step 4: 新建 `deploy/cron/crontab.example`（逐字，spec §5.6）**

```cron
# Attendance staleness email alert: scans after the 09:05 / 15:05 fetches.
20 9,15 * * * /opt/manhour-mgmt/deploy/cron/check-attendance-alert.sh >> /var/log/manhour-attendance-alert.log 2>&1
```

- [ ] **Step 5: DEPLOY.md 插入「第 10 步附」章节**

在 `docs/DEPLOY.md` 中，第 10 步末尾的 `---`（现 :365）与 `## 第 11 步：配置每日自动备份`（现 :367）之间，插入以下完整章节（不改既有步号）：

```markdown
## 第 10 步附：考勤停摆邮件告警

考勤数据如果连续 3 个工作日没有成功导入，系统会给管理员发邮件提醒。扫描脚本随镜像自带，由**宿主机的定时任务**每天 09:20、15:20 在容器内执行两次（闹钟放在容器外：容器停了 cron 反而会留痕，这是有意设计）。

**默认是干跑模式，不会真的发信**：`.env.production` 里 `SMTP_HOST` 留空时，扫描照常运行、状态照常判断，"本应发出的邮件"只在容器日志里打一行 `alert-email-dry-run`，且不会创建任何状态文件。这不是配置错误，是安全默认值。

### 附-1 先手动干跑一次（不装 cron 也能验收）

```bash
cd /opt/manhour-mgmt/app
docker compose -f docker-compose.prod.yml exec -T app \
  node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
```

应该看到：第一行横幅 `[attendance-alert] MODE=DRY-RUN …`，随后若干单行 JSON 日志（`scan-start`、`alert-decision`、`scan-done`），最后 `exit=0`。

干跑验收三明治，三处缺一不可：

1. **横幅**：每次运行第一行明确印 `MODE=DRY-RUN`。
2. **日志**：本次若处于停摆/从未导入状态，日志里有 `{"evt":"alert-email-dry-run","toCount":…,"subject":…}`；健康系统则只有决策行、没有干跑发信行——两种都属正确。
3. **状态与页面**：干跑不在数据卷创建 `alert-state.json`（`docker compose -f docker-compose.prod.yml exec app ls data/` 看不到它）；浏览器登录后 `/admin` 主页角标与 `/admin/alerts` 子页都显示「干跑中」。

连跑两遍结果应完全一致（干跑不推进任何频控日期），这能证明切真发当天仍会发出首封提醒而不是被干跑历史"吃掉"。

### 附-2 安装宿主机定时任务

镜像里的脚本路径是 `scripts/check-attendance-alert.ts`；仓库 `deploy/cron/` 提供了版本化 wrapper 与 crontab 样板。把 wrapper 放到部署目录后（路径与 crontab 行保持一致）：

```bash
chmod +x /opt/manhour-mgmt/deploy/cron/check-attendance-alert.sh
crontab -e
```

加入（样板来自 `deploy/cron/crontab.example`）：

```cron
20 9,15 * * * /opt/manhour-mgmt/deploy/cron/check-attendance-alert.sh >> /var/log/manhour-attendance-alert.log 2>&1
```

> **路径必须和现网对齐**：wrapper 里的 `cd` 行样板写的是 `/opt/manhour-mgmt`，本文件第 11 步备份任务用的是 `/opt/manhour-mgmt/app` 且显式带 `-f docker-compose.prod.yml`。装之前对照服务器上既有的考勤抓取 wrapper（`/opt/manhour-mgmt/scripts/fetch-attendance.sh`，若存在）确认 compose 项目目录，以现网为准改 wrapper 里的 `cd` 行。`exec` 的 `-T` 不能省（cron 没有 TTY）。

第二天确认 `/var/log/manhour-attendance-alert.log` 有两条横幅 + JSON 记录、无报错。

### 附-3 从干运转真发（检查清单）

按顺序做，不要跳：

1. 编辑 `.env.production`：`SMTP_HOST` 填内网中继、`SMTP_FROM` 填发件地址、`ALERT_ADMIN_EMAIL` 填管理员邮箱（逗号分隔，最多 3 个）；端口/加密/认证按中继要求配（`SMTP_PORT=25`、`SMTP_SECURE=false` 是无认证内网中继的默认；465 端口须把 `SMTP_SECURE` 改 true；`SMTP_USER`/`SMTP_PASS` 必须同时留空或同时填写）。口令只在服务器上填，不进仓库、不进聊天记录。
2. `docker compose -f docker-compose.prod.yml up -d` 重启 app 容器让环境变量生效。
3. 登录 `/admin/alerts`，确认渠道卡不再显示「干跑中」、收件人数量正确、无配置错误条目；点「发送测试邮件」。
4. **确认管理员信箱真的收到测试邮件后**，再信任定时通道；随后观察下一个 09:20/15:20 的日志为 `alert-email-sent` 或（正常时）无发信行。
5. 需要临时停发（如中继迁移）时不必清空配置：把 `ALERT_EMAIL_DRY_RUN=true` 重启即强制干跑，优先级最高。

### 附-4 排查表

| 现象 | 含义与处理 |
|---|---|
| cron 跑了但脚本 `exit=1`，横幅 `MODE=CONFIG-ERROR` | 配置不合法。进 `/admin/alerts` 看渠道卡逐条错误（半配认证、端口非数字、邮箱格式错、超 3 个收件人等），改 `.env.production` 后重启。**配置错误绝不静默回退干跑。** |
| `exit=1`，日志 `alert-email-failed` | 配置通过但 SMTP 连接/认证失败（中继不可达、口令错）。页面频控卡显示最近错误；同日不会重试，下个扫描时刻按频控再试。 |
| `exit=2`，日志 `db-read-failed` | 数据库打不开/查询失败。先按第 9 步与 A-1/A-2 排查数据卷属主与 DATABASE_URL；告警此时不读不写状态、不发信。 |
| `exit=2`，日志 `state-write-failed` | 数据卷不可写（频控状态 JSON 落盘失败）。意图未能落盘时本次不发信（防重复打扰）；查 data 卷属主与磁盘。 |
| 日志有 `state-corrupt` 但 `exit=0` | 状态文件损坏，本次已按首扫自愈重写，不算故障；反复出现说明卷有问题。 |
| cron 毫无记录 | 查 cron 服务、wrapper 的 `cd` 路径与可执行位、`-T` 参数；`docker compose ps` 确认容器在跑。 |
| 页面显示「从未成功导入」 | 说明考勤抓取链路本身没通（第 10 步/SMB 挂载问题），告警是如实反映；告警通道与抓取共享 SMB 与否无关，先恢复数据导入。 |

正常健康运行时：每次扫描只有横幅 + `scan-start` + `alert-decision{decision:"skip"}` + `scan-done`，不发信、不打扰。
```

- [ ] **Step 6: 本地静态核对（不 build 镜像）**

Run:

```bash
git diff -- Dockerfile
ls deploy/cron/
grep -n '第 10 步附' docs/DEPLOY.md
```

Expected: diff 只有两处新增/替换（+nodemailer、:223 四行替换）；`ls` 见到两个文件；grep 命中新章节且前后仍是「第 10 步（暂缓）」「第 11 步」。再跑 `npm run typecheck && npm test` 期望仍 764/764（文档与 Dockerfile 改动不影响测试，做防误伤确认）。

- [ ] **Step 7: 检查点 —— 停下报告，等许可后 commit**

Windows 上 shell 脚本的可执行位需显式登记。许可后：

```bash
git add Dockerfile deploy/cron/check-attendance-alert.sh deploy/cron/crontab.example docs/DEPLOY.md
git update-index --chmod=+x deploy/cron/check-attendance-alert.sh
git commit -m "ops: package alert script in image and add host cron runbook"
```

镜像是否真的包含这些内容、tsx 是否解析 `@/`，全部留到 Task 17 实测；本任务不跑 docker。

---

## Task 17: 🛑 镜像构建与容器内实测（walking skeleton 的最后一公里）

**Files:**
- 预期无文件修改；仅当实测暴露 COPY 缺口或 tsx `@/` 不解析时，才按本任务预案改 `Dockerfile` 或 alerts 链路 import（改什么由实测输出决定，不预改）。

背景事实：`Dockerfile` 头部自述写于一台**没有 Docker 的开发机**，至今镜像从未被构建过（A-3 预警 better-sqlite3 v12 的 prebuild-install 是头号首建失败点）。因此本任务是整个 walking skeleton 唯一能证明「容器内真能跑」的环节。

- [ ] **Step 0: 🛑 请批门 —— 停下报告，等明确批准**

向用户申请：执行 `docker build`（纯本地构建，build context 为本机 `app/`，不连任何服务器、不推镜像、不起生产容器、不碰 `manhour-prod.db`）。若本机 `docker version` 显示 Docker 不存在或守护进程不可用，则本任务整体转移到具备 Docker 的机器执行，计划在此挂起并报告，不做任何绕过。

批准后先确认环境：

```bash
docker version --format '{{.Server.Version}}'
docker compose version
```

Expected: 两条都输出版本号；否则停止本任务并报告。

- [ ] **Step 1: 构建镜像（独立标签，不覆盖 :latest）**

在 `app/` 目录：

```bash
docker build -t manhour-mgmt:alert-walkthrough .
```

Expected: 三阶段全部成功。重点盯 deps 阶段：若 `@prisma/adapter-better-sqlite3` 嵌套的 better-sqlite3 v12 下载预编译产物失败而 node-gyp 兜底也失败（Dockerfile 头部与 A-3 描述的头号风险），按 Error Recovery 纪律先贴出完整错误再分析，连续两次修复失败即停下上报，不擅自升级/降级依赖版本。构建期不提供 DATABASE_URL（既有设计：构建不需要数据库）。

- [ ] **Step 2: 镜像内容五项核对**

```bash
docker run --rm --entrypoint sh manhour-mgmt:alert-walkthrough -c '
  set -e
  echo "== scripts =="; ls scripts/
  echo "== alerts lib =="; ls src/lib/alerts/
  echo "== generated client =="; ls src/generated/prisma/ | head
  echo "== nodemailer =="; ls node_modules/nodemailer/package.json && node -e "console.log(require(\"/app/node_modules/nodemailer/package.json\").version)"
  echo "== prisma adapter =="; ls node_modules/@prisma/ ; ls node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3/build/Release/ 2>/dev/null || true
  echo "== tsconfig =="; cat tsconfig.json | head -5
'
```

Expected 逐条：

1. `scripts/` 含 `backup-db.mjs`、`fetch-attendance.ts`、`check-attendance-alert.ts`。
2. `src/lib/alerts/` 含本期六个文件（email-config/alert-state/alert-decision/alert-template/email-sender/alert-service 及扩展名）。
3. `src/generated/prisma/` 有 client 产物。
4. nodemailer `package.json` 在位且版本 `10.x`（与 Task 7 锁定一致）；其 `node_modules/nodemailer/node_modules` 应为空或不存在（零传递依赖的实物证据）。
5. `@prisma/` 下能看到 `adapter-better-sqlite3`；嵌套 better-sqlite3 的原生 `.node` 在位（路径可能在 `build/Release` 或 `prebuilds`，按实际输出记录）。`@prisma/adapter` 若确实缺失导致 Step 3 运行时报错，**按实测报错补最小 COPY**（从 builder 复制对应包到 runner），一次只补报错点名的包，禁止预堆。

- [ ] **Step 3: 容器内干跑（临时卷 + 空库迁移，绝不碰任何真实库）**

用一次性 named volume 起临时容器，先在空库上跑迁移（**只 migrate，永不 seed**），再连跑两遍告警脚本：

```bash
docker volume create manhour-alert-test

docker run --rm -e DATABASE_URL=file:/app/data/test.db \
  -v manhour-alert-test:/app/data \
  --entrypoint sh manhour-mgmt:alert-walkthrough -c '
    set -e
    node node_modules/prisma/build/index.js migrate deploy
    echo "===== RUN 1 ====="
    node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
    echo "===== RUN 2 ====="
    node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
    echo "===== DATA DIR ====="
    ls -la data/
  '
```

Expected:

1. `migrate deploy` 成功建表（空库；这同时实测 runner 镜像里 Prisma 适配器链完整）。
2. 两遍运行均：首行横幅 `[attendance-alert] MODE=DRY-RUN reason=smtp-not-configured recipients=0`（逐字与 Task 10 手工验证锚点一致）→ `scan-start` → `alert-decision` 中 `level:"never"`、`decision:"baseline"`（空库无导入记录）→ `scan-done`，`exit=0`。
3. `data/` 列表只有 test.db 及其 SQLite 伴随文件，**没有 `alert-state.json`**（仲裁 A：干跑全决策域都不落盘；baseline 不发邮件，因此也没有 `alert-email-dry-run` 行——若想同时看到干跑发信行，见 Step 4 可选项）。
4. 两遍输出一致，证明 tsx 已成功解析 alerts 链路里的 `@/` import（走到 DB 查询就证明模块解析全通）。

清理：`docker volume rm manhour-alert-test`。

- [ ] **Step 4（可选）: 干跑发信行实测**

如需要在容器内看到 `alert-email-dry-run` 日志（证明 stale 分支的模板/参数组装在容器内也通），用第二个临时卷，迁移后手工插一条古老的成功导入记录再跑——**仅当用户批准这种一次性数据构造**才做，且构造只在临时卷内、随卷删除；不允许为省事故意指向 dev.db 或任何现存库。批准前跳过本步不影响 walking skeleton 成立（该分支已被 Task 9 的 15 个单测钉死）。

- [ ] **Step 5: 失败预案（只在实测失败时启用）**

- **tsx 不解析 `@/`**（报错形如找不到 `@/lib/…`）：按 spec §5.6 决策 4 的退路，把本期新增文件的 `@/` import 机械改为相对 import，以 `scripts/fetch-attendance.ts` 现网写法为准：`scripts/check-attendance-alert.ts`（本就相对）、`src/lib/alerts/alert-service.ts`、`src/app/admin/alerts/alerts-summary.ts` 等链路文件逐个核对（页面文件仍由 Next 编译，`@/` 不动，只动 tsx 容器执行链）。改完跑 `npm run typecheck && npm test`（仍 764/764）再重建镜像复测。**不改 tsconfig、不引入 tsconfig-paths 之类插件。**
- **COPY 缺口**（`Cannot find package 'xxx'` / `ERR_MODULE_NOT_FOUND`）：只把报错点名的包按 Task 16 逐包风格补进 Dockerfile，重建复测；每次只补一个，记录「报错 → 补了什么」。
- 修复产生的 Dockerfile/源码改动，单独停下报告，许可后 commit（信息按实际内容拟，如 `fix: add missing runtime copy for alert script in Dockerfile`）。

- [ ] **Step 6: R1 生产连机核实 —— 🛑 另请授权，本任务不含执行**

以下四项只有连生产机才能核实，**必须由用户逐项授权连机方式后另开会话执行**，本计划只列清单：

1. 现网镜像/部署形态：服务器上镜像实际包含什么（本次新镜像上线前，现网根本没有告警脚本——核对部署目录与镜像标签）。
2. 抓取 wrapper 真身：`/opt/manhour-mgmt/scripts/fetch-attendance.sh` 是否存在、compose 项目目录到底是 `/opt/manhour-mgmt` 还是 `/opt/manhour-mgmt/app`、是否带 `-f docker-compose.prod.yml`、容器名是否为 `app`——据此定稿 `deploy/cron/check-attendance-alert.sh` 的 `cd` 行与 crontab 路径。
3. 日志落点：现网 cron 日志约定（`/var/log/manhour-*.log` 是否即惯例、谁负责轮转）。
4. SMB 挂载：`/mnt/smb_hr:/mnt/hr:ro` 在现网 compose 中是否在位（与告警无直接耦合，但决定 `level:"never"` 是不是抓取断链的如实反映）。

- [ ] **Step 7: 检查点 —— 停下出 walking skeleton 验收报告**

报告内容（写文件，主对话三行）：构建结果（含耗时/头号风险点是否踩中）、Step 2 五项核对实物输出、Step 3 两遍运行横幅与 JSON、状态文件缺席证据、是否动用 Step 5 预案、临时卷已删、R1 四项仍待授权。至此第一期 walking skeleton 本地侧全部打通；上线动作（部署新镜像、装 cron、配真 SMTP）属另一场发布流程，不在本计划内自动推进。

---

# 计划自审（writing-plans skill 三节）

## 1. Spec coverage（逐节对账）

| spec 章节 | 落点 Task | 备注 |
|---|---|---|
| §1 背景 / §2.1 目标 | Task 1–17 全链 | walking skeleton 五段（检测→频控→模板→投递/dry-run→可见性）逐段有 task |
| §2.2 非目标 | 无对应代码（有意） | 无 digest 聚合、无 31 经理收件人、无 AlertLog 表、无当日 FAILED 即时告警；全计划无越界实现 |
| §3.1 陈旧判定链复用 | Task 9、10 | 直接 import `describeImportStaleness` + `findLatestSuccessfulImportLog().importedAt`，不重写 |
| §3.2 镜像/脚本运行时风险（R1/R2） | Task 16、17 | runner 逐包 COPY、镜像实测五项 + 容器内干跑 + `@/` 相对 import 退路 |
| §3.3 配置与部署 | Task 14、16 | env 样板 8 键 + wrapper/crontab/runbook；compose 零改动（spec 5.6 末句）已遵守 |
| §3.4 管理面先例 | Task 12、13 | 仿 audit 子页；action 体内首行 requireAdmin（server-action-path-bypass 教训） |
| §3.5 日期/邮件可复用件 | Task 2、6 | EMAIL_SHAPE 抽共享；邮件时间走既有 date 工具 |
| §3.6 测试基建 | §0 铁律、全部 TDD task | node 环境、无 jsdom、不加载 dotenv；42 文件上限与 vitest 配置一致 |
| §4 决策 D1–D9 | Task 3–13、16 | D2 3 天阈值复用、D5 三态/三明治、D6 顺手修 fetch COPY、D7 crash-safe intent、D8 状态不备份、D9 nodemailer 均有落点 |
| §5.1 模块与状态机 | Task 3–9 | 九字段 AlertState、六个迁移纯函数、决策五出口；仲裁 A 扩展覆盖全决策域 |
| §5.2 入口脚本 | Task 10 | 横幅三式、exit 0/1/2、相对 import、`$disconnect` 收尾 |
| §5.3 管理面（角标/主页/子页/action） | Task 11、12、13 | 四态角标、主页第五并行只读 null 降级、子页四卡、action 四出口 redirect |
| §5.4 邮件文案逐字 | Task 6 | 三函主题/正文逐字进测试与实现；Task 13 测试邮件走 buildTestEmail |
| §5.5 依赖评估 | Task 7 | npm view 实读门 + 零依赖核验；🛑 安装请批 |
| §5.6 调度与容器 | Task 16、17 | wrapper/crontab 逐字入仓库；Dockerfile 两处；adapter 不预堆 COPY |
| §5.7 干跑三明治 | Task 10（横幅）、12/13（页面）、16 附-1/附-3（runbook） | 三处齐备 |
| §5.8 失败矩阵 | Task 9 两测试文件 23 例 | exit 1/2 各分支、state-corrupt 自愈 exit 0、意图失败不发信 |
| §5.9 日志契约与 PII | Task 8、9、11 测试 | 每事件每次运行恰好一行；收件人只显 toCount；sanitizeSmtpError 掩码口令样式；31 个邮箱不出现在任何新增日志/视图断言 |
| §5.10 第二期预留 | 无（非目标） | 未预埋 AlertLog/digest 抽象（YAGNI） |
| §6.1 新增 21 文件 | Task 2–13、16 | 21 个逐一在 Files 段出现（含 7 个测试文件） |
| §6.2 修改 5 处 + 锁文件 | Task 2（actions.ts）、7（锁文件）、12（admin/page.tsx）、14（env 样板）、16（Dockerfile） | runbook 落点经仲裁 D 改为 `docs/DEPLOY.md`「第 10 步附」（spec 原文设想发布日新建 `deploy/DEPLOY-RUNBOOK-*`） |
| §7.1–7.7 测试 78 例 | Task 3/4/5/6/9/11 | **计划为 81 例**：spec §7.6 的 12 例经仲裁 A 扩为 15 例（+3 干跑全决策域），总数 683+81=764；spec 印的 761 为旧值 |
| §8 验证计划 | Task 10、15、17 | 门禁五连集中 Task 15；镜像实测 Task 17；目视门 Task 15 Step 6（🛑 请批） |
| §9 R1–R8 | Task 17（R1 连机四项、R2 实测与退路）、16（R3 转真发清单）、Task 9（R4/R5/R6 行为已钉死）、7（R7 实读）、13 Step 0（R8 查 Next 文档） | R3 的 IT 参数仍属上线前外部输入，干跑不被其阻塞 |
| §10 回滚 | 无独立 task（运维动作） | crontab 删行＝停用；镜像回退须 `--build`；`ALERT_EMAIL_DRY_RUN=true` 即时停发已写进 Task 14 注释与 runbook 附-3；无 migration/表，回滚无数据动作 |

**与 spec 文字不一致但已有裁决的三处**（执行时不得擅自回退）：

1. **仲裁 A（扩展）**：spec §5.1.7 原文仅要求三个 send 决策在干跑时不建状态文件，§8 镜像实测第 2 步却写「`alert-state.json` 在数据卷生成」。容器实测已确现 fetch 脚本缺 tsconfig/COPY 即此症。计划按扩展裁决：**干跑模式对全部五个决策都不建文件**，Task 9 补 3 例、Task 10/17 均断言文件缺席。
2. **✅ 勘误 E（用户 2026-09-12 裁决采纳行为契约修正）**：spec §7.2 末例自相矛盾，计划按 `toBe(failed.lastAlertDate)` 执行，Task 4 门已解除。
3. **仲裁 D**：runbook 不落新文件，落 `docs/DEPLOY.md` 第 10 步与第 11 步之间的「第 10 步附」，不重编步号。

## 2. Placeholder scan

- 全文 grep `TBD/FIXME/TODO:/fill in/placeholder`：**0 命中**（Task 7/17 的 npm registry 实读是显式验证步骤，不是占位）。
- 每个代码步均含完整代码或逐字 old/new 块；Task 16 Dockerfile 两处、Task 12 admin/page.tsx 三处、Task 14 头部替换均给了完整原文与新文。
- Task 17 Step 5 的「按报错补 COPY / 改相对 import」是**条件性预案**而非占位：触发条件、允许动作范围、禁止动作（不预堆、不改 tsconfig、不引插件）、验收命令全部写死。
- 所有 commit 均为「检查点 —— 停下报告，等许可后」语义，无自动提交；🛑 门共三个：Task 7（装依赖）、Task 15 Step 6（dev server）、Task 17 Step 0（docker build），另有 Task 17 Step 6（R1 连机）须逐项另行授权。
- 计数锚点全文已对账：683/35（Task 1）→ 735（Task 7 复核点，自审中由误写 731 修正）→ 758/41（Task 9）→ 764/42（Task 11/12/13/15/16 引用一致）。

## 3. Type consistency（跨任务签名对账）

- `AlertState`（Task 4 定义，九字段）：`schemaVersion: 1`、`lastState: AlertTrackedState`、`firstAlertDate/lastAlertDate/lastRecoveryDate: string|null`（日历日）、`lastCheckAt/lastAttemptAt/lastSentAt: string|null`（`toStateInstant` 的 +08:00 串）、`lastError: string|null`——Task 9 迁移调用、Task 11 视图装配、Task 13 频控卡九字段渲染全部同名消费，无缺漏无拼写漂移（自审中专门核过 `lastCheckAt` 不是 lastCheckedAt）。
- `AlertTrackedState = "ok"|"stale"|"baseline"`（Task 4）与 `StalenessLevel = "ok"|"stale"|"never"`（Task 5 复用 import-staleness）是两个不同类型，Task 5/9 的 decision.tracked 取前者、邮件 level 取后者，计划中未混用。
- 状态迁移六函数 `baselineState/checkedState/touchedState/intentStateFor/sentState/failedState` + IO 三件 `readAlertState/writeAlertState/alertStatePathFor` + `toStateInstant`：Task 4 定义、Task 9 消费、Task 4 测试 import 清单（含仲裁 F 补入的 touchedState）三处一致。
- `decideAlertAction({level, today, state}) => {kind, tracked}`（Task 5）：kind 五值 `"skip"|"baseline"|"send-first"|"send-repeat"|"send-recovery"`，Task 9 service 分支与 Task 17 期望输出（`level:"never", decision:"baseline"`）同名。
- 模板三函数 `buildStaleAlertEmail/buildRecoveryEmail/buildTestEmail`（Task 6）：Task 9 私有 `buildMail(kind, level, daysSince, latestSuccessAt, now)` 只映射前两个，Task 13 action 直接消费 buildTestEmail；无第三处虚构函数名（自审 grep 排除了早期草稿名）。
- `loadAlertEmailConfig(): AlertEmailConfig`（Task 3）三态判别联合：`{mode:"live",…}` / `{mode:"dry-run", reason:"smtp-not-configured"|"forced-by-env"}` / `{mode:"config-error", errors:string[]}`——Task 8 createEmailSender、Task 9 service、Task 11 summary、Task 13 页面/action、Task 10/17 横幅全部按此判别消费，reason 字面量两处使用点一致（自审中修正了 Task 17 误写的 `smtp-host-empty`）。
- `createEmailSender(config): EmailSender`（Task 8），`EmailSender.send(SendEmailInput) => Promise<SendEmailResult>`，Result 三态 `{delivered:true,dryRun:true}` / `{delivered:true,dryRun:false}` / `{delivered:false,dryRun:false,error}`——Task 9 七注入 deps.send、Task 13 缓存单例 senderFor() 均按此收窄（action 四出口依赖 result.dryRun/delivered 判别，与 redirect 四出口一一对应）。
- `runAttendanceAlertCheck(deps)`（Task 9 导出，Task 10 相对 import 消费）；`exitCodeFor(errorCode: AlertErrorCode|undefined): 0|1|2`（Task 9，独立测试文件 8 例），AlertErrorCode 四值与 Task 10 catch/then 的 exit 映射一致：config-error/send-failed→1、db-read-failed/state-write-failed→2、scan-fatal→2。
- Task 11 视图层：`AlertBadgeView{tone,label,href}`（href 固定 `/admin/alerts`）、`buildAlertBadge`/`buildAlertsPageView` 纯函数 + `loadAlertBadgeData`/`loadAlertsPageData` 薄 loader（函数体内动态 import repo，catch-all→null）——Task 12 消费 AlertBadgeView，Task 13 消费 page view，Task 11 测试 6 例与被测同名导出一致。
- Task 2 `isLikelyEmailAddress(value): boolean` 与 `EMAIL_SHAPE: RegExp`：admin/actions.ts 改 import 消费，无第二处正则定义残留。
- 日志事件名全集（scan-start/scan-done/alert-decision/config-error/state-corrupt/db-read-failed/state-write-failed/alert-email-dry-run/alert-email-sent/alert-email-failed）在 Task 8/9 的归属与 spec §5.9 逐字一致；投递事件只在 sender、编排事件只在 service，Task 9 测试以 filter 计数钉死。

---
