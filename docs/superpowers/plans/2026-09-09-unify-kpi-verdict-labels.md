# 统一 KPI 徽章为「达成/不达成」+ 字号放大 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把三张剩余工时 KPI 卡徽章从三种不一致文案统一为同一标签源的「达成 / 不达成」，删除累计卡 ▲/▼ 数值句，并把徽章字号从 12px 放大到 24px。

**Architecture:** 新建一个无 React 依赖的纯模块 `src/lib/kpi-verdict.ts`，把既有判定谓词 `isRemainOnTrack`（`remain >= 0`）与逐字标签对冻结绑定为 `kpiVerdict(remain) => { ok, label }`；三张卡全部改为调用这一个出口，从结构上消除文案分叉。`KpiCard.tsx` 的 `StatusPill` 收窄为 `{ ok, label }` 并放大字号。判定边界、达成状况表、emoji、底色一律不动。

**Tech Stack:** Next.js 16 + React 18 + TypeScript、Tailwind 4 品牌色工具类、vitest 4（无 jsdom，纯函数单测）。

**Spec:** `docs/superpowers/specs/2026-09-09-unify-kpi-verdict-labels-design.md`

---

> ⚠️ **提交纪律（覆盖 writing-plans skill 默认的 frequent-commits）**
> 本仓库用户长期约束：**未经明确许可不得 `git commit` / `git push`**（外层 `d:\ClaudeCode` 与本 `app/` 两个 `.git` 同理）。ManhourAutoCommit 每 20 分钟的 `wip:` 自动提交**不**视为里程碑许可。因此本计划**不含任何 commit 步骤**；每个任务结尾是「测试检查点」而非提交。里程碑提交 / 打包在实现 + 验收全部完成后**另行请批**。

> 📌 **工作目录与事实基线**
> 所有命令在 `projects/manhour-mgmt/app/` 下执行。Shell 为 Git Bash。
> 当前测试基线：**679/679，34 文件**；本计划新增 1 个测试文件（4 用例），完成后应为 **683/683，35 文件**。
> 引号约定（已眼见）：`src/lib/*.ts` 与 `tests/**/*.ts` 用**单引号**；`src/**/*.tsx` 组件用**双引号**。新代码必须跟随所在文件约定。

---

## File Structure

| 文件 | 性质 | 单一职责 |
| --- | --- | --- |
| `tests/lib/kpi-verdict.test.ts` | 新增 | 锁定 `kpiVerdict()` 的正/负/零边界与逐字标签（漂移哨兵） |
| `src/lib/kpi-verdict.ts` | 新增 | 「谓词 + 文案」唯一事实源：冻结标签常量 + `kpiVerdict()` 纯函数 |
| `src/components/kpi/KpiCard.tsx` | 修改 | 消费唯一标签源；`StatusPill` 收窄签名 + 放大字号；删累计卡 arrow/数值句；更新 JSDoc |

不改：`src/lib/calc.ts`（谓词 `isRemainOnTrack` 与 `makeCell` 严格 `>0` 均冻结）、`src/components/chart/AchievementTable.tsx`（保持「未达成」）、`src/lib/format.ts`、任何配置 / schema / migration / 依赖。

---

## Task 1: 写失败测试（RED）

**Files:**
- Create: `tests/lib/kpi-verdict.test.ts`

- [ ] **Step 1: 新建测试文件**

写入以下完整内容（单引号、vitest 显式 import、`@/` 别名、英文注释讲 why——与 `tests/lib/format.test.ts` 风格一致）：

```ts
// Badge label source for the three remaining-hours KPI cards.
//
// The label must be resolved from the SAME predicate that drives emoji and
// pill color, so these tests pin the boundary through kpiVerdict() itself and
// pin the exact wording through the exported constant (a drift sentinel:
// rewording a badge has to be a deliberate test edit, not an unnoticed string
// tweak in one of three call sites).

import { describe, expect, it } from 'vitest';

import { KPI_VERDICT_LABELS, kpiVerdict } from '@/lib/kpi-verdict';

describe('kpiVerdict', () => {
  it('labels a positive remainder as 达成 (on track)', () => {
    expect(kpiVerdict(11359.5)).toEqual({ ok: true, label: '达成' });
  });

  it('labels a negative remainder as 不达成 (off track)', () => {
    expect(kpiVerdict(-260)).toEqual({ ok: false, label: '不达成' });
  });

  it('counts exactly zero as 达成 - the >= 0 boundary (踩线即达成)', () => {
    // Same boundary contract as isRemainOnTrack: dead-on-target is a win.
    expect(kpiVerdict(0)).toEqual({ ok: true, label: '达成' });
  });

  it('exposes the single verbatim label pair shared by all three cards', () => {
    expect(KPI_VERDICT_LABELS.onTrack).toBe('达成');
    expect(KPI_VERDICT_LABELS.offTrack).toBe('不达成');
  });
});
```

- [ ] **Step 2: 运行测试，确认它失败（RED）**

Run:

```bash
npx vitest run tests/lib/kpi-verdict.test.ts
```

Expected: FAIL / no tests pass，报错含模块解析失败，类似：

```
Error: Failed to resolve import "@/lib/kpi-verdict" from "tests/lib/kpi-verdict.test.ts"
```

> 若它意外 PASS，说明实现已存在或路径写错——停止，先核对文件路径，不要继续 Task 2。

---

## Task 2: 实现唯一标签源（GREEN）

**Files:**
- Create: `src/lib/kpi-verdict.ts`

- [ ] **Step 1: 新建纯模块**

写入以下完整内容（`src/lib/*.ts` 约定：**单引号**；复用既有谓词，不复制边界逻辑）：

```ts
// Single source of truth for the three remaining-hours KPI verdict badges.
//
// Before 2026-09-09 the three cards carried three different wordings
// (达成/超支, 优于挑战/未达挑战, and a numeric ▲/▼ sentence). The predicate was
// already shared (isRemainOnTrack); only the labels had drifted. Binding the
// label to the same predicate here makes a second wording split structurally
// impossible: cards call kpiVerdict() instead of owning strings.

import { isRemainOnTrack } from '@/lib/calc';

/** Verbatim badge labels. Tests assert these exact strings (drift sentinel). */
export const KPI_VERDICT_LABELS = {
  onTrack: '达成',
  offTrack: '不达成',
} as const;

export interface KpiVerdict {
  /** Shared >= 0 predicate result; also drives emoji and pill color. */
  ok: boolean;
  /** Badge wording resolved from the same remainder value. */
  label: string;
}

/**
 * Resolve the verdict (state + badge label) for one remaining-hours figure.
 * The boundary is exactly isRemainOnTrack's: remainder >= 0 is on track and
 * exactly 0 counts as 达成.
 */
export function kpiVerdict(remain: number): KpiVerdict {
  const ok = isRemainOnTrack(remain);
  return {
    ok,
    label: ok ? KPI_VERDICT_LABELS.onTrack : KPI_VERDICT_LABELS.offTrack,
  };
}
```

- [ ] **Step 2: 运行该测试文件，确认通过（GREEN）**

Run:

```bash
npx vitest run tests/lib/kpi-verdict.test.ts
```

Expected: PASS，`4 passed`（1 个文件，4 个用例）。

> 边界逻辑仍只有一份（在 `calc.ts`）；本文件只做「谓词结果 → 逐字词」的映射，不得在此另写 `>= 0`。

---

## Task 3: KpiCard 接线、删数值句、放大徽章

**Files:**
- Modify: `src/components/kpi/KpiCard.tsx`（`.tsx` 约定：**双引号**）

本任务是对同一文件的 6 个小编辑，逐个做、不要合并成一次大重写。

- [ ] **Step 1: 替换 import——移除谓词直引，引入唯一标签源**

把：

```tsx
import { isRemainOnTrack } from "@/lib/calc";
import { formatHoursBare, formatSignedHoursBare } from "@/lib/format";
import { cn } from "@/lib/utils";
```

替换为（删除 calc 行，在 format 与 utils 之间按字母序插入 kpi-verdict；`formatSignedHoursBare` 仍被三处大号数字使用，**保留**）：

```tsx
import { formatHoursBare, formatSignedHoursBare } from "@/lib/format";
import { kpiVerdict } from "@/lib/kpi-verdict";
import { cn } from "@/lib/utils";
```

- [ ] **Step 2: 重写 `StatusPill`——收窄签名 + 放大字号**

把当前整个 `StatusPill`（含其 JSDoc，约 48-74 行）替换为：

```tsx
/** Compact text-only status pill: green wording when `ok`, red otherwise.
 *  Uses brand colors with 20% opacity backgrounds via Tailwind 4 opacity
 *  modifiers. The verdict face lives only in the large decorative emoji of
 *  VerdictCardBody - the pill itself deliberately carries no emoji (user
 *  decision 2026-09-09: one face per card). Wording always comes from
 *  kpiVerdict() (single label source, same decision 2026-09-09), so the three
 *  cards cannot drift apart again. Sized text-2xl (24px, 2x the original
 *  text-xs) per user request for an at-a-glance verdict; leading-none and the
 *  larger padding keep the capsule tight at the bigger size. */
function StatusPill({
  ok,
  label,
}: {
  ok: boolean;
  label: string;
}): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center rounded-full px-4 py-1 text-2xl font-medium leading-none",
        ok ? "bg-challenge/20 text-challenge" : "bg-actual/20 text-actual",
      )}
    >
      {label}
    </span>
  );
}
```

变更点：props 由 `{ ok, okLabel, ngLabel = okLabel }` 收窄为 `{ ok, label }`；正文 `{ok ? okLabel : ngLabel}` 改为 `{label}`；class `px-2 py-0.5 text-xs` 改为 `px-4 py-1 text-2xl leading-none`；`rounded-full font-medium` 与绿/红品牌色底不变。

- [ ] **Step 3: 改 `planRemain` 分支**

把：

```tsx
    case "planRemain": {
      const ok = isRemainOnTrack(data.monthPlanRemain);
      return (
        <VerdictCardBody ok={ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthPlanRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={ok} okLabel="达成" ngLabel="超支" />
        </VerdictCardBody>
      );
    }
```

替换为：

```tsx
    case "planRemain": {
      const verdict = kpiVerdict(data.monthPlanRemain);
      return (
        <VerdictCardBody ok={verdict.ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthPlanRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={verdict.ok} label={verdict.label} />
        </VerdictCardBody>
      );
    }
```

- [ ] **Step 4: 改 `chalRemain` 分支**

把：

```tsx
    case "chalRemain": {
      const ok = isRemainOnTrack(data.monthChalRemain);
      return (
        <VerdictCardBody ok={ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthChalRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={ok} okLabel="优于挑战" ngLabel="未达挑战" />
        </VerdictCardBody>
      );
    }
```

替换为：

```tsx
    case "chalRemain": {
      const verdict = kpiVerdict(data.monthChalRemain);
      return (
        <VerdictCardBody ok={verdict.ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.monthChalRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={verdict.ok} label={verdict.label} />
        </VerdictCardBody>
      );
    }
```

- [ ] **Step 5: 改 `cumRemain` 分支——删除 arrow 三元与 ▲/▼ 数值句**

把：

```tsx
    case "cumRemain": {
      const ok = isRemainOnTrack(data.cumRemain);
      // No arrow at exactly 0: there is no direction to point at.
      const arrow =
        data.cumRemain > 0 ? "▲ " : data.cumRemain < 0 ? "▼ " : "";
      return (
        <VerdictCardBody ok={ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.cumRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill
            ok={ok}
            okLabel={`${arrow}距计划 ${formatSignedHoursBare(data.cumRemain)} H`}
          />
        </VerdictCardBody>
      );
    }
```

替换为（大号带符号数字行原样保留——差额与方向由它承载；徽章只剩统一词）：

```tsx
    case "cumRemain": {
      const verdict = kpiVerdict(data.cumRemain);
      return (
        <VerdictCardBody ok={verdict.ok}>
          <div className="flex items-baseline gap-1">
            <span className="text-3xl font-bold tabular-nums">
              {formatSignedHoursBare(data.cumRemain)}
            </span>
            <span className="text-sm text-muted-foreground">H</span>
          </div>
          <StatusPill ok={verdict.ok} label={verdict.label} />
        </VerdictCardBody>
      );
    }
```

- [ ] **Step 6: 更新文件头 JSDoc（英文，记载两项决策）**

把文件头 JSDoc 中从 `* The three remaining-hours cards share one threshold` 到 `* globals.css; no hardcoded hex values.` 的整段（约 13-21 行）替换为：

```
 * The three remaining-hours cards share one verdict resolved by kpiVerdict()
 * (src/lib/kpi-verdict.ts), which binds the shared on-track predicate
 * (remainder >= 0; exactly 0 is landing on target) to one verbatim label pair
 * 达成/不达成. Since 2026-09-09 all three pills draw wording from that single
 * source - previously the cards said 达成/超支 and 优于挑战/未达挑战, and a third
 * carried a numeric arrow/delta sentence; the wordings had drifted apart - so
 * the labels cannot diverge again. Each verdict card
 * carries exactly one face: a large decorative emoji at the right edge as the
 * at-a-glance cue. The pill beneath the figure is colored wording only, no
 * emoji (user decision 2026-09-09: one face per card), sized text-2xl so the
 * verdict reads at a glance (same decision: make the badge prominent). The
 * emoji is aria-hidden because the pill text already carries the verdict for
 * screen readers. Status pills keep the brand CSS-variable utilities
 * (bg-challenge / bg-actual) registered in globals.css; no hardcoded hex
 * values.
```

（保留其上方第 1-12 行的文件标题、四卡列表、无进度条叙述；只替换这一段。）

- [ ] **Step 7: 静态检查——确认无残留旧引用**

Run:

```bash
grep -n "isRemainOnTrack\|okLabel\|ngLabel\|距计划\|▲\|▼" src/components/kpi/KpiCard.tsx ; echo "exit=$?"
```

Expected: 该 grep **无任何匹配行**，末尾打印 `exit=1`（1 = 无匹配）。若仍有匹配，说明某步漏改，回到对应 Step 修正。

- [ ] **Step 8: 类型检查**

Run:

```bash
npm run typecheck
```

Expected: 退出码 0，无输出（或无 error）。

- [ ] **Step 9: 运行该组件相关 + 新模块测试**

Run:

```bash
npx vitest run tests/lib/kpi-verdict.test.ts
```

Expected: `4 passed`。（组件无渲染测试，旧 679 用例不断言徽章文案，故本任务不应导致任何旧用例失败；全量回归在 Task 4。）

---

## Task 4: 门禁五连（全绿才进入目视 / 发布讨论）

**Files:** 无新增改动；仅验证。

按顺序执行，任一失败即停，不得跳到下一步；连续两次修不好按仓库 Error Recovery Strategy 上报，不硬闯。

- [ ] **Step 1: Prisma client 生成**

Run:

```bash
npm run db:generate
```

Expected: 成功生成，退出码 0。

- [ ] **Step 2: 类型检查**

Run:

```bash
npm run typecheck
```

Expected: 退出码 0。

- [ ] **Step 3: Lint**

Run:

```bash
npm run lint
```

Expected: 退出码 0，无 error（markdown/既有的非阻塞风格警告不在此命令范围）。

- [ ] **Step 4: 全量单元测试**

Run:

```bash
npm test
```

Expected: **683/683 通过，35 文件**（基线 679/34 + 本计划新增 4 用例/1 文件）。出现任何失败即停。

- [ ] **Step 5: 生产构建**

Run:

```bash
npm run build
```

Expected: 构建成功，10 条路由编译完成，退出码 0。

---

## Task 5: 目视门（需用户授权起 dev server，人工执行）

> 此任务为**人工门**，不是自动化步骤；起停 dev server 必须先获用户授权（沿用上轮「你来停」模式）。样式（24px / padding / 颜色 / 对齐）无法在无 jsdom 下单测，只能目视覆盖。

- [ ] **Step 1: 获授权后启动 dev server**

Run（授权后）:

```bash
npm run dev
```

在浏览器打开看板页，依次用 1440 / 768 / 375 三个视口宽度核对：

- [ ] 三张剩余卡徽章逐字均为「达成」或「不达成」，三卡**同字号、同胶囊形、同色逻辑**（绿=达成，红=不达成）。
- [ ] 徽章明显比旧版大（24px），醒目但**不压过** 30px 大号数字；四张卡仍等高、底边对齐，无内容溢出或换行错位。
- [ ] 年计/挑战/累计卡右侧 emoji 各 1 个（共 3 个剩余卡有表情；actual 卡无），表情与徽章同态（😊 配「达成」/ 😞 配「不达成」）。
- [ ] 三卡大号带符号数字（如 `+11359.5 H`）维持不变；累计卡徽章内**不再有** ▲/▼ 或「距计划」残句。
- [ ] 375px 仅核验不横向溢出（本次不做移动端适配）。

- [ ] **Step 2: 负态兜底说明**

当前 dev / 生产数据三卡剩余均为正，目视大概率只见「达成」。红态「不达成」已由 `kpiVerdict(-260)` 单测锁定（Task 1），**不得**为看红态手工改数据库或插数据。

- [ ] **Step 3: 记录结果并请用户停服务**

把目视结论（三视口是否全过）写入 `.claude/out/` 报告；按用户指令停掉 dev server（不自行长期占用端口）。

---

## 完成定义（DoD）

- [ ] `tests/lib/kpi-verdict.test.ts` 4 用例存在且通过；`src/lib/kpi-verdict.ts` 为唯一标签源。
- [ ] `KpiCard.tsx` 三处徽章均调 `kpiVerdict()`，全文件 grep 不到 `isRemainOnTrack / okLabel / ngLabel / 距计划 / ▲ / ▼`。
- [ ] 徽章 class 为 `px-4 py-1 text-2xl font-medium leading-none`，绿/红品牌色底与圆角不变。
- [ ] 门禁五连全绿：db:generate / typecheck / lint / **683/683·35 文件** / build。
- [ ] 目视门三视口通过（授权后）。
- [ ] `calc.ts`、`AchievementTable.tsx`、`format.ts`、配置、schema、migration、依赖**零改动**。
- [ ] **未执行任何 git commit / push / 打包**——这些在 DoD 全绿后另行请批。

---

## 发布（不在本计划内，实现验收后另起请批）

预期变更面相对 0909 生产包**仅 3 文件**：`M src/components/kpi/KpiCard.tsx`、`A src/lib/kpi-verdict.ts`、`A tests/lib/kpi-verdict.test.ts`（以解包 `diff -rq` 实测为准）。发布时另做：新白名单 tar.gz + SHA256SUMS + 自包含 runbook（§8.5 逐字文案改三卡「达成/不达成」、新增 24px 字号目视项，emoji 探针仍期望 3、`演示数据` 仍严格 0）；无迁移故不跑 `migrate deploy`、不 seed；用户自部署、回传输出、我判读。
