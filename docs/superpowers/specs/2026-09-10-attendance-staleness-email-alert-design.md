# 设计：考勤数据停摆管理员邮件告警（第一期）

- 日期：2026-09-10（设计会话）；2026-09-11 落盘正式 spec
- 状态：待用户复核（写盘，未 commit）
- 范围：`projects/manhour-mgmt/app`
- 关联决策：D-124（陈旧概念）、D-135/D-210（仅公司内部 SMTP，参数待 IT）、D-150（经理邮箱是第二期收件人源）、D-169（Config 表冻结）、D-188（DATABASE_URL 须绝对路径）、D-209（N=3 自然日、PARTIAL 与 0 行汇总文件算成功）、D-212（阈值可配挂 v2）、D-228（HR 09:00/15:00 出报表，抓取 09:05/15:05）
- 与第二期关系：本期只打通「发信管道」walking skeleton 并预留共享发送层；工时阈值业务预警（AlertRule/AlertLog 两表、31 个经理邮箱、80%/100% 阈值）全部留待第二期独立 spec

> 编号说明：本文「决策 1–9」是本设计会话内的裁决编号，**不是** `projects/manhour-mgmt/DECISIONS.md` 的 D-### 编号；正式落库编号在本功能发布时按序分配。

---

## 1. 背景与问题

2026-08 现网发生过一次考勤数据静默停摆：抓取链路中断后约 19 天才被人工发现。期间系统页面照常可访问，没有任何主动信号。

代码库里「陈旧」概念早已存在并被页面复用（`describeImportStaleness`，D-124/D-209），但**没有任何外发通道**：`package.json` 无 nodemailer/node-cron/bullmq；代码实读环境变量仅 6 个；无 `/api` 路由、无 instrumentation hook；唯一调度是宿主机 crontab。

本期目标不是一次性做完所有邮件预警，而是把一条**最小但真实的发信管道**从头到尾打通——检测、频控状态、模板、SMTP 投递、干跑（dry-run）模式、运维可见性——作为 walking skeleton：

- 业务信号只选一类：**距上次成功导入超过 3 个自然日**（管理员告警）。这一类信号天然覆盖最致命的几种停摆：抓取 cron 挂了、SMB 目录掉线（此时系统内连 ImportLog 都不会留下）、容器停了、连续解析失败。
- 管道必须能在 **SMTP 参数尚未从 IT 拿到（D-210）** 的情况下先行上线：未配齐时自动进入 dry-run，全部逻辑真跑，只把投递改写为容器日志；配齐并重启后自动转真实发送。
- 第二期的工时阈值预警（D-131~D-135/D-152）将直接复用本期的配置解析、状态文件、模板与发送层，本期在接口上预留，但不实现任何第二期功能。

## 2. 目标与非目标

### 2.1 目标

1. 宿主机 cron 每日 09:20、15:20 各执行一次容器内独立检查脚本；判定陈旧（含「从未有过成功导入」）即按频控规则向管理员邮箱发告警，恢复后发恢复通知。
2. SMTP 未配置时自动 dry-run；`ALERT_EMAIL_DRY_RUN=true` 可强制停发；配齐后重启即转真发，无需改代码。
3. 管理员在后台两处看到通道状态：主页 header 一行角标、独立子页 `/admin/alerts`（详情 + 发送测试邮件按钮）。
4. 频控：首封 + 持续期间每自然日最多一封提醒 + 一封恢复通知；崩溃重试不会邮件雪崩。
5. 发送层封装为共享模块，脚本与 server action 共用，第二期共用。

### 2.2 非目标（本期明确不做）

- 不建 AlertRule / AlertLog 表，不新增第 10 个 migration，不 seed，不手改库。
- 不启用 `Department.managerEmail` / `Section.managerEmail` 这 31 个经理邮箱（D-150，第二期）。
- 不做工时阈值预警（80% 黄 / 100% 红、部课总量、跨阈值触发、同月同档一次、课责任者收件 + 红档抄送部长）。
- 不做「当日 FAILED 即时告警」（列结构被改导致全天 FAILED 时，最长约 3 个自然日后才发信——已知取舍）。
- 不做监控器自身故障的独立告警通道。
- 无 HTML 邮件、无附件；无钉钉/企微/短信；不需要 `APP_BASE_URL`（正文不含链接，只有人工排查路径）；不新增 `/api` 路由。
- 子页不做收件人编辑、不做告警历史列表（本期不建 AlertLog）、不做「手动立即扫描」按钮（手动扫描＝在服务器直接跑脚本）。
- 不把 `alert-state.json` 纳入 `backup-db.mjs` 备份。

## 3. 现状事实（写码前已逐行核实）

### 3.1 陈旧判定链（直接复用，不重写）

- `src/lib/attendance/import-staleness.ts`（109 行）导出 `DEFAULT_STALENESS_THRESHOLD_DAYS = 3`、类型 `StalenessLevel = "ok" | "stale" | "never"`、接口 `ImportStaleness { level; daysSince: number | null; message: string | null }` 与 `describeImportStaleness(latestSuccessAt: Date | null, now: Date, thresholdDays?): ImportStaleness`。`null` → never；天数按 Asia/Shanghai 自然日相减；非法入参抛错；stale 带中文 message。
- 「末次成功导入」取数：`src/lib/db/import-log.repo.ts:178-184` `findLatestSuccessfulImportLog()`，`where status in ("SUCCESS","PARTIAL")`、`orderBy importedAt desc`。**时间戳字段名是 `importedAt`**（`src/lib/db/types.ts:245`，`ImportLogDto.importedAt: Date`），目录不可达时 `scripts/fetch-attendance.ts:146-149` 退出码 1 且不写 ImportLog。
- Prisma 客户端：`src/lib/prisma.ts`（37 行）从 `@/generated/prisma/client` 导入 `PrismaClient`，用 `@prisma/adapter-better-sqlite3`；`DATABASE_URL` 缺失即 throw，生产须绝对路径 `file:/app/data/dev.db`（D-188）。

### 3.2 生产镜像与脚本运行时（本期最大的部署风险面）

- `Dockerfile` 三阶段，runner（`:134` 起）里 node_modules **不是**整棵拷贝，而是从 builder 逐包选择性 COPY：standalone 产物 `:168`、prisma CLI/engines `:198-200`、dotenv `:201`、tsx `:202`、完整 better-sqlite3 `:222`（修 standalone 只 trace 到 stub 的问题）。
- `Dockerfile:223` **只 COPY 了 `scripts/backup-db.mjs` 一个脚本**；runner 镜像中没有 `scripts/*.ts`、没有 `src/`、没有 `tsconfig.json`。
- `tsconfig.json:24-28` paths 仅 `"@/*": ["./src/*"]`，无 baseUrl，`moduleResolution: "bundler"`。tsx 解析 `@/` 依赖 tsconfig.json 在工作目录中在场。
- 现网 runbook 记载容器内用 tsx 跑 `scripts/fetch-attendance.ts`，与上述 COPY 清单矛盾。wrapper `/opt/manhour-mgmt/scripts/fetch-attendance.sh` 只存在于生产服务器（仓库内零命中）。**这是已坐实的待连机核实项，不猜测**（见 §9 风险 R1）。
- 运行用户 uid 1000（`:236`），`/app/data` 由 `:233` mkdir+chown，实际为 bind 卷；`TZ=Asia/Shanghai`（`:148`）；刻意无 HEALTHCHECK（`:242-249`）。
- 本地脚本入口用**相对路径 import**（`scripts/fetch-attendance.ts` 引 `../src/lib/...`），而 lib 内部全部用 `@/`。
- `scripts/` 现有 5 个文件（fetch-attendance.ts、backup-db.mjs、auto-commit.cmd/.mjs、import-actual-baseline.ts）。

### 3.3 配置与部署

- `.env.production.example:9-13` 有一段穷举声明：「These are ALL the environment variables the application code reads … DATABASE_URL, ORG_DATA_SOURCE, ADMIN_PASSWORD, SESSION_SECRET, COOKIE_SECURE, NODE_ENV. Nothing else has any effect」。新增告警变量时这段必须同步改写。
- `docker-compose.prod.yml:47-48` 通过 `env_file: [.env.production]` 注入；新变量写进 `.env.production` 即随容器环境生效，**compose 文件无需改动**；改值重启容器生效，不进镜像层。
- 现网抓取 cron：宿主 `5 7-20 * * *` → 服务器上的 wrapper → `docker compose exec` 容器内 tsx。HR 出报表 09:00/15:00、抓取 09:05/15:05（D-228），告警扫描定为每点 20 分。
- 容器默认 bridge 出站无限制，但到内网 SMTP 的可达性从未实测（D-210 参数也未给）。

### 3.4 管理面先例（本期照抄其模式）

- 后台只有单口令，无管理员用户对象；`src/lib/auth.ts:242` 导出 `requireAdmin()`（给 server action 用），`src/lib/auth-page.ts` 导出 `requireAdminPage(path)`（给页面用）。**实测只有 action 体内首行 `await requireAdmin()` 是承重检查**，按路径的一切区隔都可绕过。
- `src/app/admin/audit/` 是子页范本：`page.tsx` 为 Server Component（`force-dynamic`、`requireAdminPage("/admin/audit")`，零 client JS）、`_components/AuditNav.tsx`、同目录纯函数 `snapshot-summary.ts` 承担数据装配，其单测在 `tests/admin/audit-view.test.ts` 直接 import 纯函数。
- 主页 `src/app/admin/page.tsx`：`await requireAdminPage("/admin")`（`:166`）；四个独立只读在 `:168-174` 用一个 `Promise.all` 并发；header 闭合并列位于 `:208`，其内部最后一个元素是 D-173 警告块（`:201-207`），样式为 `rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground ring-1 ring-border`。语义色 chip 先例：`text-plan`/`text-warn`/`text-challenge` 配 `bg-plan/10` 等。
- `src/app/admin/actions.ts:46-49`：`"use server"`、action 接收原始字符串、**返回/转导失败而不是 throw**、首行 `requireAdmin()`；`revalidatePath` 从 `next/cache` 导入。
- 邮箱形状校验目前是 actions.ts 模块私有：`EMAIL_SHAPE`（`:181`）与 `parseOptionalEmail`（`:183-195`），均无 export；其 JSDoc（`:163-180`）已注明这些邮箱列是 D-135/D-210 告警邮件的收件人源，正则刻意宽松。

### 3.5 日期与邮件可复用件

- `src/lib/db/date.ts`：`BUSINESS_TIME_ZONE = "Asia/Shanghai"`（`:50`）、`businessDayOf(instant)`（`:104-109`，instant→业务时区日历日）、`parseDateOnly`（`:115-133`）、`formatDateOnly`（`:141-147`，日历日→`YYYY-MM-DD`）、`formatBusinessTimestamp`（`:178-180`，→`YYYY/MM/DD HH:mm`，24 小时制）。状态文件自然日字段＝`formatDateOnly(businessDayOf(now))`；邮件时间戳＝`formatBusinessTimestamp(now)`，禁止自造时区逻辑。

### 3.6 测试基建

- Vitest 4.1.10，`vitest.config.mts`：`include: ["tests/**/*.test.ts"]`、`environment: "node"`（无 jsdom，且禁止为此引入）、`@` 别名在配置里重声明。现有 35 个测试文件、683 个用例全绿。
- 测试目录按业务域分布：`tests/attendance/`、`tests/db/`、`tests/admin/`、`tests/lib/` 等；新测试落在 `tests/alerts/` 与 `tests/admin/`。

## 4. 设计决策（均已拍板冻结）

| # | 裁决 | 一句话理由 |
|---|---|---|
| 1 | 分两期：本期只做考勤停摆管理员告警，把发信管道当 walking skeleton；业务阈值预警另起 spec | 先解决「静默 19 天」事故模式，同时让第二期站在已验证的管道上 |
| 2 | 信号只有一类：每次扫描只算 `describeImportStaleness(findLatestSuccessfulImportLog()?.importedAt ?? null, now, 3)`；stale/never 都告警 | 一个信号覆盖 cron 挂、SMB 丢、容器停、连续失败；接受「当天全 FAILED 最长 3 天后才报」 |
| 3 | 收件人用新环境变量 `ALERT_ADMIN_EMAIL`（逗号分隔 1–3 个），不碰 Config 表（D-169），不做系统管理员对象 | 系统本就只有单口令；邮箱值是 PII，只进 `.env.production` 不进仓库 |
| 4 | 节奏：首封 + 持续期间每自然日最多一封提醒 + 恢复通知 | 对冲静默停摆；自然日口径而非 24h 滚动 |
| 5 | SMTP 未配齐→自动 dry-run；`ALERT_EMAIL_DRY_RUN=true` 强制停发（最高优先级）；配齐重启自动转真发；三处明示「干跑中≠受保护」 | 解除对 IT 参数（D-210）的上线阻塞，同时防止把干跑误当保护 |
| 6 | 调度＝宿主 cron `20 9,15 * * *` + 版本化 wrapper 调 `docker compose exec` 跑独立 tsx 脚本 | 容器停了闹钟仍在容器外活着，exec 失败由宿主 cron 留痕；抓取 09:05/15:05 之后扫 |
| 7 | 管理面＝主页 header 只读角标 + 独立子页 `/admin/alerts`（仿 audit：纯 Server Component、原生 form、装配抽纯函数） | 主页保持主数据语义；详情与测试发送有独立承载 |
| 8 | 频控状态＝data 卷 `alert-state.json`（temp+rename、schemaVersion、损坏自愈按无状态重基线）；不建表不备份 | 单写者、一日两跑、丢失可自愈，没有为此引入表的理由 |
| 9 | SMTP 发送层用 nodemailer 10.0.3（MIT-0、无运行时依赖、node>=20、仅服务端）；**选型已批，安装留待实施批准** | 事实标准库；评估记录见 §5.5；本期只新增这一个运行时依赖 |

**子决策（决策 3 的落地细节）**：actions.ts 里的 `EMAIL_SHAPE` 是私有正则。本期**抽取**为 `src/lib/validation/email.ts`，导出 `isLikelyEmailAddress(value: string): boolean` 作为单一事实源；`parseOptionalEmail` 改为调用它（行为不变），告警收件人列表校验也用它。不复制正则，避免两处形状漂移。

冷启动宽限（决策 4/8 的补充）：**状态文件缺失 且 从未有过成功导入记录（never）＝baseline 宽限态，当次不发信**，宽限只持续一个扫描点——第二次扫描仍 never/stale 即发首封。部署上线时系统已有历史数据，正常会立刻进入 stale→首封或 ok→静默；宽限只保护全新空库。

## 5. 详细设计

### 5.1 模块总览

```
宿主机 cron 09:20/15:20
  └─ deploy/cron/check-attendance-alert.sh（版本化 wrapper）
       └─ docker compose exec -T app \
            node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts
             └─ src/lib/alerts/alert-service.ts（编排，纯逻辑可注入）
                  ├─ attendance/import-staleness.ts（复用）
                  ├─ alerts/alert-decision.ts（决策矩阵，纯函数）
                  ├─ alerts/alert-state.ts（状态文件读写与状态迁移，纯/IO 分离）
                  ├─ alerts/alert-template.ts（三类邮件文案，纯函数）
                  ├─ alerts/email-config.ts（env→三态配置，纯函数）
                  └─ alerts/email-sender.ts（nodemailer 封装 / dry-run 投递）

浏览器：/admin 角标 ──▶ /admin/alerts 子页 ──▶ actions.ts(sendTestAlertEmailAction)
                                          （复用 email-config / email-sender / template，测试发送不改频控）
```

新增 6 个 alerts 库模块 + 1 个共享校验模块，全部在 `src/lib/` 下，接口如下。所有新代码双引号、注释英文。

#### 5.1.1 `src/lib/validation/email.ts`

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

#### 5.1.2 `src/lib/alerts/email-config.ts`

```ts
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

export function loadAlertEmailConfig(env: NodeJS.ProcessEnv): AlertEmailConfig;
```

校验规则（在**使用点**调用——脚本启动时、测试 action 触发时；绝不在 Next 启动期 throw）：

1. `ALERT_EMAIL_DRY_RUN` trim 后小写等于 `"true"` → 直接 `dry-run / forced-by-env`，**优先级最高**，不再校验 SMTP 键（半配也不报错）。
2. `SMTP_HOST` 缺失（未设或 trim 为空）→ `dry-run / smtp-not-configured`。
3. `SMTP_HOST` 存在时进入 live 校验，错误累积成列表：
   - `SMTP_FROM` 必填（不自造默认域名）。
   - `ALERT_ADMIN_EMAIL` 必填；按逗号拆分、逐项 trim、丢空串；每项须过 `isLikelyEmailAddress`；数量 1–3。
   - `SMTP_USER`/`SMTP_PASS`：同缺＝免认证；只配一个＝配置错误。
   - `SMTP_PORT` 缺省 25；显式给时须为 1–65535 整数。
   - `SMTP_SECURE` 缺省 false；只接受大小写不敏感的 `true`/`false`。
4. dry-run 下也尽力解析 `ALERT_ADMIN_EMAIL`（不报错，非法项静默丢弃），横幅与页面只显示可用收件人数量。
5. 任何分支的配置对象都**不含可被 UI 渲染的密码字段泄露路径**：live 对象持有 `pass` 仅供 sender 使用；页面装配函数（§5.6）不接受也不输出它。

#### 5.1.3 `src/lib/alerts/alert-state.ts`

```ts
export const ALERT_STATE_SCHEMA_VERSION = 1;

export type AlertTrackedState = "ok" | "stale" | "baseline";

export interface AlertState {
  schemaVersion: 1;
  lastState: AlertTrackedState;
  firstAlertDate: string | null;   // YYYY-MM-DD, business calendar day
  lastAlertDate: string | null;    // YYYY-MM-DD
  lastRecoveryDate: string | null; // YYYY-MM-DD
  lastCheckAt: string | null;      // ISO-8601 with +08:00 offset
  lastAttemptAt: string | null;
  lastSentAt: string | null;
  lastError: string | null;
}

/** /app/data/alert-state.json in the container (sibling of dev.db);
 *  derived from DATABASE_URL's directory so it lands on the same bind mount. */
export function alertStatePathFor(databaseUrl: string | undefined): string;

/** Missing file => null. Corrupt JSON / wrong schemaVersion / wrong shape =>
 *  log {evt:"state-corrupt"} and return null (self-healing re-baseline). */
export function readAlertState(file: string): Promise<AlertState | null>;

/** Atomic: write `${file}.tmp` then rename. Unknown extra fields are tolerated on read. */
export function writeAlertState(file: string, state: AlertState): Promise<void>;

export function baselineState(now: Date): AlertState;
export function checkedState(prev: AlertState, now: Date, tracked: AlertTrackedState): AlertState;
/** Dry-run touch: refresh check/attempt timestamps but keep every cadence date
 *  and lastState untouched, so switching to live still sends a first alert today. */
export function touchedState(prev: AlertState, now: Date): AlertState;
export function intentStateFor(
  prev: AlertState,
  kind: "send-first" | "send-repeat" | "send-recovery",
  today: string,
  now: Date,
): AlertState;
export function sentState(intent: AlertState, now: Date): AlertState;
export function failedState(intent: AlertState, sanitizedError: string): AlertState;

/** +08:00 instant string built from BUSINESS_TIME_ZONE Intl parts (no host-clock dependency). */
export function toStateInstant(now: Date): string;
```

迁移规则（全部纯函数，不 mutate 入参，返回新对象）：

- `send-first`：`lastState="stale"`、`firstAlertDate ??= today`、`lastAlertDate=today`、`lastAttemptAt=now`。
- `send-repeat`：保留 `firstAlertDate`、`lastAlertDate=today`、`lastAttemptAt=now`。
- `send-recovery`：`lastState="ok"`、`lastRecoveryDate=today`、`lastAttemptAt=now`；首封日期保留作历史。
- `sentState`：在 intent 基础上 `lastSentAt=now`、`lastError=null`。
- `failedState`：`lastError=<sanitized>`，**不动任何日期字段**。
- `checkedState`：只刷 `lastCheckAt` 与 `lastState`（skip 路径）。

`alertStatePathFor`：解析 `file:` URL 取目录拼 `alert-state.json`；生产为 `/app/data/alert-state.json`；相对路径按 `process.cwd()` 解析（本地开发 dev.db 就在仓库根，与现网 DATABASE_URL 约定一致）。

#### 5.1.4 `src/lib/alerts/alert-decision.ts`

```ts
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
  level: StalenessLevel; // from describeImportStaleness
  today: string;         // formatDateOnly(businessDayOf(now))
  state: AlertState | null;
}): AlertDecision;
```

完整决策矩阵（字符串日期可直接字典序比较）：

| staleness | 历史 `lastState` | 附加条件 | 决策 | 落盘 lastState |
|---|---|---|---|---|
| ok | 无 | — | skip | ok |
| ok | ok | — | skip | ok |
| ok | baseline | — | skip | ok |
| ok | stale | `lastRecoveryDate === today` | skip（同日幂等） | ok |
| ok | stale | 否则 | send-recovery | ok |
| stale | 无 | — | send-first | stale |
| never | 无 | — | **baseline（冷启动宽限，不发）** | baseline |
| stale 或 never | baseline | — | send-first（宽限仅一个扫描点） | stale |
| stale | ok | — | send-first | stale |
| stale | stale | `lastAlertDate === today` | skip（自然日内不重发） | stale |
| stale | stale | `lastAlertDate < today` | send-repeat | stale |

防御性行为（理论上不可达：never 意味着从无成功记录，不可能先出现 ok/stale 历史）：never + ok/stale 一律按 send-first 处理，并在代码注释标明。

#### 5.1.5 `src/lib/alerts/alert-template.ts`

```ts
export interface AlertEmailContent {
  subject: string;
  text: string;
}

export function buildStaleAlertEmail(input: {
  level: StalenessLevel;
  daysSince: number | null;
  latestSuccessAt: Date | null;
  now: Date;
}): AlertEmailContent;

export function buildRecoveryEmail(input: {
  latestSuccessAt: Date;
  now: Date;
}): AlertEmailContent;

export function buildTestEmail(input: { now: Date; dryRun: boolean; recipientCount: number }): AlertEmailContent;
```

中文 UTF-8 纯文本；所有时间戳走 `formatBusinessTimestamp`。逐字文案见 §5.7。

#### 5.1.6 `src/lib/alerts/email-sender.ts`

```ts
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

export function createEmailSender(
  config: LiveEmailConfig | DryRunEmailConfig,
): EmailSender;
```

- live：`nodemailer.createTransport({ host, port, secure, auth: user === null ? undefined : { user, pass } })`，每次调用 `sendMail({ from, to, subject, text })`；脚本短生命周期每次新建；server action 在 actions 模块内持惰性单例。
- dry-run：不建 transport，输出**一行** JSON 日志 `{"evt":"alert-email-dry-run","toCount":N,"subject":"..."}`（不打印地址值），返回 `{ delivered: true, dryRun: true }`。
- live 失败：捕获后经 `sanitizeSmtpError(e)`（截断 300 字、正则抹除 `(pass|password|auth)=?\S+` 片段）返回 `{ delivered: false, dryRun: false, error }`，不抛异常。

#### 5.1.7 `src/lib/alerts/alert-service.ts`

编排模块，IO 全部由 deps 注入（测试用内存假件，不碰 nodemailer/fs）：

```ts
export interface AlertCheckDeps {
  now: () => Date;
  config: AlertEmailConfig;
  findLatestSuccessAt: () => Promise<Date | null>;
  readState: () => Promise<AlertState | null>;
  writeState: (state: AlertState) => Promise<void>;
  send: (input: SendEmailInput) => Promise<SendEmailResult>;
  log: (record: Record<string, unknown>) => void;
}

export interface AlertCheckResult {
  decision: AlertDecisionKind;
  exitCode: 0 | 1 | 2;
  errorCode?:
    | "config-error"
    | "send-failed"
    | "db-read-failed"
    | "state-write-failed";
}

export function exitCodeFor(errorCode: AlertCheckResult["errorCode"]): 0 | 1 | 2;

export function runAttendanceAlertCheck(deps: AlertCheckDeps): Promise<AlertCheckResult>;
```

编排（单次扫描）：

1. **读库**：`findLatestSuccessAt()` 抛错 → 日志 `db-read-failed`，**不读不写状态、不发信**，exit 2。
2. **算信号**：`describeImportStaleness(latest, now, 3)`；`today = formatDateOnly(businessDayOf(now))`。
3. **配置闸**：`config.mode === "config-error"` → 日志 `config-error`（带错误列表），exit 1，不动状态不发信（发信不可能时频控无意义）。
4. **读状态 + 决策**：`readState()`（损坏已在其内部归一为 null 并记 `state-corrupt`）→ `decideAlertAction()`。
5. 按决策执行：
   - `skip` / `baseline`：写 `checkedState` / `baselineState`（仅刷 lastCheckAt）；写盘失败 → `state-write-failed` exit 2；否则 exit 0。
   - 三个 send 决策 + **live**：
     1. 先用 `intentStateFor` 把日期与 `lastAttemptAt` **落盘**（意图持久化）。写盘失败 → exit 2，**不发信**。
     2. 发送。成功 → `sentState` 回写 `lastSentAt`、清 `lastError`，exit 0；失败 → `failedState` 回写 `lastError`（日期已在 intent 中，故同日不会重发），exit 1。
     3. 崩溃发生在「intent 落盘之后、发送之前」：最坏少发一封、次日补发，绝不会雪崩——这是先落盘的全部目的。
   - 三个 send 决策 + **dry-run**：记 `alert-email-dry-run` 日志，**不推进任何频控日期**（保证切到 live 的当天仍会发首封）；状态文件已存在时用 `touchedState` 只刷 `lastCheckAt`/`lastAttemptAt` 并保留原 `lastState`，不存在则不创建；exit 0。因此 dry-run 每个陈旧扫描点都会留一条投递日志，恰好可用于验证 cron。
6. 每个关键节点输出一行 JSON 日志（§5.9）。

`exitCodeFor`：`config-error`/`send-failed` → 1；`db-read-failed`/`state-write-failed` → 2；无 errorCode → 0。

### 5.2 入口脚本 `scripts/check-attendance-alert.ts`

薄壳（仿 `fetch-attendance.ts`：入口相对 import、无顶层 await、收尾 `$disconnect`）：

1. 组装 prod deps：`now=()=>new Date()`；`findLatestSuccessAt`＝`findLatestSuccessfulImportLog()` 取 `importedAt`；状态文件路径＝`alertStatePathFor(process.env.DATABASE_URL)`；config＝`loadAlertEmailConfig(process.env)`；sender＝`createEmailSender(config)`；logger ＝ `console.log(JSON.stringify(...))`。
2. **首行横幅**（纯文本，给 `docker logs` / cron 日志肉眼看）：
   - live：`[attendance-alert] MODE=LIVE recipients=2`
   - dry-run：`[attendance-alert] MODE=DRY-RUN reason=smtp-not-configured recipients=0`
3. 调 `runAttendanceAlertCheck`，按 `exitCode` 设置 `process.exitCode`，`finally` 里 `void prisma.$disconnect()`。退出码契约：0＝skip/baseline/dry-run/发送成功/恢复；1＝config-error/live 发送失败；2＝DB 读不到/状态写盘失败。

### 5.3 管理面

#### 5.3.1 共享角标 `src/app/admin/_components/AlertStatusBadge.tsx`

纯展示 Server Component（无 client JS），prop 为 §5.3.3 的 `AlertBadgeView`，整块渲染为指向 `/admin/alerts` 的 `<Link>`，样式参照主页 D-173 块：`mt-3 inline-flex rounded-md bg-muted/60 px-3 py-2 text-xs ring-1 ring-border`，文本色按 tone 换 `text-plan` / `text-warn` / `text-challenge`。四态文案（逐字）：

- ok（live + 信号 ok）：`告警通道：正常`
- warn（dry-run）：`告警通道：干跑中（不会真实发信）`
- danger（stale/never）：`考勤数据告警中：已 N 天未成功导入`（never 用 `考勤数据告警中：从未有成功导入记录`）
- danger（config-error）：`告警通道配置错误`

优先级：config-error ＞ stale/never ＞ dry-run ＞ ok（dry-run 期间真发生陈旧，角标报事故，子页通道卡同时显示干跑）。

#### 5.3.2 主页改动 `src/app/admin/page.tsx`

- `:168-174` 的 `Promise.all` 增加第五个只读 `loadAlertBadgeData()`；该读取自行 catch，任何失败返回 `null`（用 `allSettled` 或 `.catch(()=>null)` 包裹，**不得拖垮主页**）。
- 在 D-173 警告块（`:207`）之后、header 内层闭合 `</div>`（`:208`）之前插入 `AlertStatusBadge`；`null` 时不渲染任何 DOM。

#### 5.3.3 子页 `/admin/alerts`

新增 `src/app/admin/alerts/`：

- `alerts-summary.ts`——装配层（仿 `audit/snapshot-summary.ts`），含纯函数与薄 IO：

```ts
export interface AlertBadgeView {
  tone: "ok" | "warn" | "danger";
  label: string;
  href: "/admin/alerts";
}

export function buildAlertBadge(input: {
  config: AlertEmailConfig;
  staleness: ImportStaleness;
}): AlertBadgeView;

export interface AlertsPageView {
  badge: AlertBadgeView;
  channel: {
    modeLabel: string;                 // 真实发送 / 干跑 / 配置错误
    reasonLabel: string | null;        // 干跑原因中文
    recipientCount: number;
    forcedByEnv: boolean;
    configErrors: readonly string[];
  };
  judgement: {
    level: StalenessLevel;
    daysSince: number | null;
    latestSuccessAt: string | null;    // formatBusinessTimestamp or null
    message: string | null;            // staleness.message
  };
  frequency: AlertState | null;
}

export function buildAlertsPageView(input: {
  config: AlertEmailConfig;
  staleness: ImportStaleness;
  latestSuccessAt: Date | null;
  state: AlertState | null;
  now: Date;
}): AlertsPageView;

/** Catch-all => null (page renders without the badge/cards data, never throws). */
export function loadAlertBadgeData(): Promise<{
  config: AlertEmailConfig;
  staleness: ImportStaleness;
} | null>;

export function loadAlertsPageData(): Promise<{
  config: AlertEmailConfig;
  staleness: ImportStaleness;
  latestSuccessAt: Date | null;
  state: AlertState | null;
} | null>;
```

视图模型里**只有收件人数量，没有地址字符串；没有任何密码字段**（单测断言）。

- `page.tsx`：`export const dynamic = "force-dynamic"`、`await requireAdminPage("/admin/alerts")`、`<nav aria-label="面包屑">` 含返回 `/admin` 链接、零 client JS。四张卡（沿用 Block 外壳：标题行 + `overflow-hidden rounded-lg bg-card ring-1 ring-border`）：
  1. **通道状态**：模式 + 干跑原因 + 收件人数量 + `ALERT_EMAIL_DRY_RUN` 是否强制；config-error 时列错误。
  2. **当前判定**：实时 staleness（末次成功时间、自然日天数、ok/stale/never、message）；注明 PARTIAL 与 0 行汇总文件算成功（D-209）。
  3. **频控状态**：状态文件 9 个字段全部展示（ISO 时间用 `formatBusinessTimestamp` 渲染），无文件时显「尚未运行过扫描」；`lastError` 存在时用 `text-challenge` 强调，无错不占位。
  4. **测试发送**：说明文字（dry-run 下只写容器日志）+ 原生 `<form action={sendTestAlertEmailAction}>` 一个提交按钮 + 根据 query 参数显示的结果横幅。
- `actions.ts`：

```ts
"use server";

export async function sendTestAlertEmailAction(): Promise<void> {
  // MUST be the first statement in the body - path/middleware/nav checks are
  // all bypassable; only an in-body check is load-bearing.
  await requireAdmin();

  const config = loadAlertEmailConfig(process.env);
  if (config.mode === "config-error") {
    redirect("/admin/alerts?test=config-error");
  }

  // Test sends deliberately do NOT touch alert-state.json frequency control.
  const mail = buildTestEmail({
    now: new Date(),
    dryRun: config.mode === "dry-run",
    recipientCount: config.adminEmails.length,
  });
  const result = await createEmailSender(config).send({
    to: config.adminEmails,
    subject: mail.subject,
    text: mail.text,
  });

  if (result.dryRun) redirect("/admin/alerts?test=dry-run");
  if (result.delivered) redirect("/admin/alerts?test=sent");
  // Sanitized failure detail lives in container logs only; the query carries
  // just the outcome code, never the error text.
  redirect("/admin/alerts?test=error");
}
```

横幅文案（逐字）：`测试邮件已真实发送，请查收。` / `当前为干跑模式：未真实发送，投递内容已写入容器日志（alert-email-dry-run）。` / `告警邮件配置有误，请修正 SMTP_* / ALERT_ADMIN_EMAIL 后重启容器。详见本页通道状态卡。` / `发送失败，容器日志中可查到脱敏后的错误原因。`。query 参数只接受上述四个枚举值，其他一律不显示横幅。

> Next.js 16 的 `redirect`、Server Action 与原生 form 的精确用法在实施时先查 `node_modules/next/dist/docs/`（AGENTS.md 铁律），不凭训练数据写。

### 5.4 邮件文案（逐字）

主题三则（`N` 为 daysSince 十进制）：

- 首封/提醒：`［工时管理系统］考勤数据停摆告警：已 N 天未成功导入考勤数据`
- 恢复：`［工时管理系统］考勤数据导入已恢复正常`
- 测试：`［工时管理系统］告警邮件通道测试（YYYY/MM/DD HH:mm）`，括号内为 `formatBusinessTimestamp(now)`。

告警正文（stale；`{...}` 为渲染值）：

```text
管理员您好：

工时管理系统检测到考勤数据导入已停摆。

末次成功导入时间：{formatBusinessTimestamp(latestSuccessAt)}
距今天数：{daysSince} 天（按 Asia/Shanghai 时区的自然日计算）
本邮件生成时间：{formatBusinessTimestamp(now)}

口径说明：PARTIAL（部分成功）视为成功；仅有汇总行、数据行数为 0 的文件也视为成功。距上次成功导入超过 3 个自然日即触发本邮件。

请按以下顺序排查：
1. 宿主机的考勤抓取定时任务（crontab）是否仍在运行；
2. HR 共享目录挂载 /mnt/hr 是否可访问（目录不可达时系统内不会留下导入记录）；
3. 应用容器状态与数据卷磁盘空间是否正常；
4. 登录后台 /admin/audit 查看最近的主数据快照，并在实际数据页查看最近的导入日志。

此邮件由系统自动发送，请勿回复。
```

never 正文差异：「末次成功导入时间」行替换为 `末次成功导入时间：无（系统从未有过成功导入记录）`，「距今天数」行替换为 `系统从未有过成功导入记录。`，其余不变。

恢复正文：

```text
管理员您好：

工时管理系统的考勤数据导入已恢复正常。

恢复后末次成功导入时间：{formatBusinessTimestamp(latestSuccessAt)}
本邮件生成时间：{formatBusinessTimestamp(now)}

此邮件由系统自动发送，请勿回复。
```

测试正文：

```text
管理员您好：

这是一封告警邮件通道测试邮件，用于验证 SMTP 配置是否可用。
发送模式：{真实发送 | 干跑（dry-run，仅写入容器日志，不会真实投递）}
收件人数量：{N}
本邮件生成时间：{formatBusinessTimestamp(now)}

此邮件由系统自动发送，请勿回复。
```

### 5.5 依赖评估（决策 9 依据）

- `nodemailer@10.0.3`：MIT-0（等同 MIT 公共领域奉献），`engines.node >=20`，**package.json 无运行时 dependencies**（无需连带 COPY 依赖包），解包约 1.39 MiB，周下载量千万级；只被服务端代码 import，不进客户端 bundle。
- 类型：nodemailer 不随包类型，需 devDependency `@types/nodemailer`（DefinitelyTyped，仅类型，构建期用）。实施时以 `npm view nodemailer@10 version` 与锁文件实际解析为准。
- 安装（`npm install nodemailer@^10.0.3` + `npm install -D @types/nodemailer`）与改 package.json/package-lock.json **属实施阶段动作，须单独获批后执行**。

### 5.6 调度与容器改动

**新增 `deploy/cron/check-attendance-alert.sh`**（版本化、入仓库；容器外闹钟）：

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

**新增 `deploy/cron/crontab.example`**：

```cron
# Attendance staleness email alert: scans after the 09:05 / 15:05 fetches.
20 9,15 * * * /opt/manhour-mgmt/deploy/cron/check-attendance-alert.sh >> /var/log/manhour-attendance-alert.log 2>&1
```

日志落点在上线时对齐现网抓取 wrapper 的实际做法后定（R1 核实项之一）。

**`Dockerfile` 改动**（runner 阶段；与现有逐包 COPY 风格一致）：

1. `:202` tsx COPY 之后新增 nodemailer COPY（无运行时依赖，单目录即可）：
   ```dockerfile
   COPY --from=builder --chown=node:node /app/node_modules/nodemailer ./node_modules/nodemailer
   ```
2. 将 `:223` 的单脚本 COPY 替换为脚本目录 + 脚本运行所需源码 + tsconfig：
   ```dockerfile
   COPY --from=builder --chown=node:node /app/scripts ./scripts
   COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
   COPY --from=builder --chown=node:node /app/src/lib ./src/lib
   COPY --from=builder --chown=node:node /app/src/generated ./src/generated
   ```
   同时补齐 fetch-attendance.ts 长期存在的同一 COPY 缺口（决策 6 已批准顺手修）。
3. `@prisma/adapter-better-sqlite3` 已在请求路径上、理论上被 standalone trace 进 `node_modules/@prisma/`；**实施第一个任务必须用构建出的镜像实测**它与生成客户端的解析，缺什么再显式补 COPY（见 §8 验证顺序），不预先堆 COPY。
4. tsx 对 `@/` 的解析以「tsconfig.json 在场」为方案；退路：若实测不解析，alerts 链路新增文件一律改用相对 import（以 fetch-attendance.ts 现网写法为准），不为此改 tsconfig 或引入插件。

`.env.production.example` 改动：重写 `:9-13` 穷举声明（加入 8 个新键），新增一节 SMTP/告警配置样板：全部键名列出、值留空、英文大段注释（沿用该文件文风），含 `SMTP_HOST`、`SMTP_PORT=25`、`SMTP_SECURE=false`、`SMTP_USER=`、`SMTP_PASS=`、`SMTP_FROM=`、`ALERT_ADMIN_EMAIL=`、`ALERT_EMAIL_DRY_RUN=false`，并写明「HOST 留空＝自动干跑」。真实邮箱与密码永不落仓库。

compose 文件**零改动**（env_file 已透传）。

### 5.7 干跑三明治（决策 5 的三处明示，缺一不可）

1. **启动横幅**：脚本每次运行第一行打印 `MODE=DRY-RUN/LIVE`（§5.2）。
2. **管理页面**：角标「干跑中（不会真实发信）」+ 子页通道卡「干跑中：当前不会真实发送邮件，配齐 SMTP 环境变量并重启后自动转真发」。
3. **runbook**：发布 runbook 必含「考勤告警」章——cron 安装步骤、干跑验收（看横幅、看 `alert-email-dry-run` 日志、看状态文件/页面）、转真发检查清单（配齐 → 重启 → 子页发测试邮件 → 收到后再依赖定时通道）、排查表（配置错误卡、exit 1/2 含义、SMB 与 cron 排查顺序）。

### 5.8 失败矩阵

| 故障 | 行为 | exit |
|---|---|---|
| DB 不可达/查询失败 | `db-read-failed` 日志；不读不写状态、不发信 | 2 |
| 状态 JSON 损坏/schemaVersion 未知 | `state-corrupt` 日志，视同首扫（null），本次决策结果正常落盘自愈 | 0* |
| 状态写盘失败（意图或回写） | `state-write-failed`；意图未落盘则不发信；发送后回写失败时 intent 已在，同日不重发 | 2 |
| SMTP 连接/认证失败（live） | `failedState` 落 lastError（页面可见）、`alert-email-failed` 日志；同日不重试，次日按频控再试 | 1 |
| 配置不全/半配认证 | config-error：脚本退出 1、子页错误卡列全部问题；**绝不静默降级干跑** | 1 |
| 容器停摆 | 宿主 cron 的 `docker compose exec` 非零并在宿主留痕；容器恢复后按真实 staleness 补发 | wrapper 非零 |
| 状态文件被误删 | stale：重发一封首封（可自愈噪声）；never：重新走一次 baseline 宽限 | 0 |

\* 损坏本身不算失败；若当次后续写盘失败则按该行 exit 2。

### 5.9 日志契约与 PII

- 脚本全部运行日志为单行 JSON：`scan-start`、`scan-done {exitCode}`、`alert-decision {level,daysSince,decision}`、`config-error {errors}`、`state-corrupt`、`db-read-failed`、`state-write-failed`、`alert-email-dry-run {toCount,subject}`、`alert-email-sent {toCount}`、`alert-email-failed {error}`；首行另有纯文本 MODE 横幅。
- **禁止出现**：邮箱地址值（只出现数量）、SMTP_PASS、SMTP_USER 也不打印、连接串。31 个经理邮箱本期不使用。
- 发送失败留痕＝容器 stdout（json-file 10m×3）+ 状态文件 `lastError/lastSentAt/lastCheckAt`，本期不建 AlertLog（留第二期）。

### 5.10 第二期预留

`email-config.ts` 的 `LiveEmailConfig.adminEmails` 与 `EmailSender.send({to})` 的收件人均为数组参数；第二期业务预警传入部课责任者列表、红档抄送部长时无需改发送层。本期不写任何 AlertRule/阈值/经理邮箱读取代码。

## 6. 文件改动清单

### 6.1 新增（21 个）

| 文件 | 性质 |
|---|---|
| `src/lib/validation/email.ts` | 共享邮箱形状谓词（从 actions.ts 抽取） |
| `src/lib/alerts/email-config.ts` | env→三态配置（纯函数） |
| `src/lib/alerts/alert-state.ts` | 状态文件 IO + 状态迁移纯函数 + 路径推导 |
| `src/lib/alerts/alert-decision.ts` | 决策矩阵（纯函数） |
| `src/lib/alerts/alert-template.ts` | 三类邮件文案（纯函数） |
| `src/lib/alerts/email-sender.ts` | nodemailer / dry-run 发送封装 |
| `src/lib/alerts/alert-service.ts` | 单次扫描编排 + exitCodeFor |
| `scripts/check-attendance-alert.ts` | cron 入口薄壳（相对 import） |
| `src/app/admin/alerts/page.tsx` | 子页 Server Component |
| `src/app/admin/alerts/actions.ts` | 测试发送 action（体内首行 requireAdmin） |
| `src/app/admin/alerts/alerts-summary.ts` | 视图装配纯函数 + 薄 IO loader |
| `src/app/admin/_components/AlertStatusBadge.tsx` | 主页/子页共用角标 |
| `deploy/cron/check-attendance-alert.sh` | 版本化宿主 wrapper |
| `deploy/cron/crontab.example` | cron 片段样板 |
| `tests/alerts/alert-decision.test.ts` | 决策矩阵 13 例 |
| `tests/alerts/alert-state.test.ts` | 状态读写/迁移 13 例 |
| `tests/alerts/email-config.test.ts` | env 组合 18 例 |
| `tests/alerts/alert-template.test.ts` | 文案要素 8 例 |
| `tests/alerts/alert-service.test.ts` | 编排/失败/干跑 12 例 |
| `tests/alerts/exit-code.test.ts` | exitCodeFor 8 例 |
| `tests/admin/alerts-view.test.ts` | 装配纯函数/PII 掩码 6 例 |

### 6.2 修改（5 个 + 锁文件）

| 文件 | 改动 |
|---|---|
| `package.json` / `package-lock.json` | +`nodemailer` dependency、+`@types/nodemailer` devDependency（实施获批后） |
| `Dockerfile` | runner 增 nodemailer COPY；单脚本 COPY 换为 scripts+src/lib+src/generated+tsconfig（见 §5.6） |
| `.env.production.example` | 改写头部穷举声明；新增 8 个告警键样板与注释 |
| `src/app/admin/page.tsx` | 第五个并行只读（失败 null）；D-173 块后插角标 |
| `src/app/admin/actions.ts` | 删本地 `EMAIL_SHAPE`，`parseOptionalEmail` 改用 `@/lib/validation/email`；行为不变 |
| 发布 runbook（发布日新建，同 `deploy/DEPLOY-RUNBOOK-*` 命名） | 新增「考勤告警」章（cron 安装/干跑验收/转真发/排查） |

预期无其他文件改动：不动 schema.prisma、不动 migration、不 seed、不碰 `*.db`、不改 compose/nginx/next.config、不新增 `/api` 路由、不新增 npm script（cron 直接调 tsx，与抓取脚本一致）。镜像打包变更面以实施时解包/`docker run ... ls` 实测为准。

## 7. 测试策略

TDD：先写测试看红，再实现到绿。新增测试全在 node 环境，AAA、描述性命名、双引号、英文注释，不为组件渲染引入 jsdom（Server Component 不做渲染测试，只测装配纯函数）。用例数：683 + 78 = **761**；文件数 35 + 7 = **42**。

### 7.1 `tests/alerts/alert-decision.test.ts`（13 例）

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

### 7.2 `tests/alerts/alert-state.test.ts`（13 例）

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
    expect(touched.lastAlertDate).toBeNull();
  });
});
```

（`toStateInstant` 断言固定：`2026-09-11T01:20:00.000Z` → `"2026-09-11T09:20:00+08:00"`，在上述各例中以该期望值替换间接比较。）

### 7.3 `tests/alerts/email-config.test.ts`（18 例）

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

### 7.4 `tests/alerts/alert-template.test.ts`（8 例）

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

### 7.5 `tests/alerts/exit-code.test.ts`（8 例）

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

### 7.6 `tests/alerts/alert-service.test.ts`（12 例）

全部 IO 走内存假件（状态仓、发送队列、固定时钟），不碰文件系统与 nodemailer：

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
});
```

### 7.7 `tests/admin/alerts-view.test.ts`（6 例）

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

## 8. 验证计划

实施顺序（TDD 小步，每步绿了再走）：① email.ts + 既有 actions 测试回归 → ② email-config → ③ alert-state → ④ alert-decision → ⑤ alert-template → ⑥ email-sender → ⑦ alert-service（含 exitCodeFor）→ ⑧ 脚本 + 本地用临时目录跑干跑全编排 → ⑨ 子页装配纯函数 + 页面/角标/action → ⑩ Dockerfile/镜像实测 → ⑪ env 样板/runbook/wrapper。

**门禁五连（每次提交前）**：

1. `npm run db:generate`
2. `npm run typecheck`
3. `npm run lint`
4. `npm test`（761/761，42 个测试文件）
5. `npm run build`

**镜像实测（部署窗口前本地构建）**——按此顺序，把 R1/R2 的不确定性变成事实：

1. 构建镜像后 `docker run --rm --entrypoint sh <image> -c "ls /app/scripts /app/src/lib/alerts /app/src/generated/prisma /app/node_modules/nodemailer /app/node_modules/@prisma/adapter-better-sqlite3 && cat /app/tsconfig.json | head -1"`，逐项确认 COPY 结果。
2. 容器内 `node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts`（无 SMTP_HOST）干跑：横幅 `MODE=DRY-RUN`、退出码 0、`alert-state.json` 在数据卷生成。
3. 造停摆判定只通过真实库数据或等待自然陈旧，**不手改库、不插数据**；本地可通过把系统时间注入脚本 `now` 的方式已在单测覆盖，端到端以干跑日志 + 页面角标为准。
4. 目视门（请批后启动）：主页角标四态、子页四卡、测试发送三横幅（dry-run/config-error/sent 或 error），逐页给用户看。
5. 发布：打包属请批动作，未许可不动；起停容器须另行授权；纯代码包，无 migration/seed，回传输出由我逐段判读。

上线前置（需连机，由用户授权或用户执行回传）：核对生产镜像现状与 fetch wrapper 内容、日志落点、SMB 挂载（§9 R1）。

## 9. 风险与遗留

| # | 风险 | 处置 |
|---|---|---|
| R1 | runbook 记载容器内跑 fetch-attendance.ts，但现镜像无 scripts/src/tsconfig；wrapper 仅存生产服务器；日志落点、SMB `/mnt/hr` 挂载（compose 手加）均未在仓库核实 | 列入上线前置核对四项；wrapper 以现网 fetch wrapper 为模板实测对齐；镜像实测清单（§8）先行落地；连机须用户授权 |
| R2 | tsx 在 runner 镜像中解析 `@/` 与生成客户端/adapter 的行为未经实测 | §8 镜像实测第 1-2 步；退路＝alerts 新文件全改相对 import；缺包则补显式 COPY，不猜 |
| R3 | IT 的 SMTP 参数与内网可达性未给（D-210） | 干跑解除编码阻塞；转真发以子页测试邮件成功 + 收件确认作为验收，不假设端口/认证 |
| R4 | 列结构变更导致全天 FAILED 时最长 3 天才告警（D2 取舍） | 本期接受；当日 FAILED 即时告警属第二期候选 |
| R5 | 状态文件丢失导致 stale 时重发首封；不备份 | 可自愈噪声，决策 8 已接受；最坏后果是多一封邮件 |
| R6 | 单写者假设被破坏（手工与 cron 重叠） | 一日两跑 + 手工测试不写频控，碰撞概率极低；temp+rename 保证不坏文件，后写者胜出，最坏多一封 |
| R7 | nodemailer 版本/类型包实际解析与评估值有出入 | 安装时以 npm registry 实读为准（10.0.3 / @types/nodemailer），安装请批 |
| R8 | 页面/action 的 Next 16 API 细节（redirect、原生 form、searchParams） | 动手前查 `node_modules/next/dist/docs/`（AGENTS.md），不凭记忆 |

遗留事项：①IT SMTP 参数；②R1 四项连机核实；③R2 镜像实测；④AlertLog 与所有第二期能力。

## 10. 回滚

1. 删除宿主 crontab 中 `20 9,15 * * *` 告警行即完全停用告警通道（容器停不停都行）。
2. 代码回滚＝重新构建/回退镜像（本仓库 tag 镜像回滚必须 `--build`）；镜像旧版本无脚本、无角标、无 env 读取，行为完全等同于上线前。
3. `alert-state.json` 留在数据卷无任何副作用（无表、无 migration 要回退）；可手工删除。
4. `.env.production` 中新增键留着不影响旧镜像；`ALERT_EMAIL_DRY_RUN=true` 可在不回滚镜像的情况下即时停发。
