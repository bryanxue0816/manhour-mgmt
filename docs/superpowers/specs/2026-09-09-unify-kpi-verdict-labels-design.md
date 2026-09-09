# 设计：统一三张 KPI 剩余工时卡徽章基准（达成 / 不达成）

- 日期：2026-09-09
- 状态：待用户复核（写盘，未 commit）
- 范围：`projects/manhour-mgmt/app`
- 关联：D-244（KPI emoji 判定，0909 已上线）的后续文案统一；D-243（看板 △ 脚注）仍悬置，不在本次范围

---

## 1. 背景与问题

生产看板（2026-09-09 截图）三张剩余工时卡的徽章使用了三种不同形态的文案：

| 卡片 | 绿态（剩余 ≥ 0） | 红态（剩余 < 0） |
| --- | --- | --- |
| 年计剩余 | 达成 | 超支 |
| 挑战剩余 | 优于挑战 | 未达挑战 |
| 累计剩余 | ▲ 距计划 +N H（数值句） | 同一句（仅箭头/符号变化） |

三张卡的**判定谓词早已统一**（共用 `isRemainOnTrack(remain) => remain >= 0`，恰好 0 算达成），不统一的只是**显示词与形态**。用户要求统一为同一基准词对「达成 / 不达成」，并要求字号放大 1 倍、醒目。

## 2. 目标 / 非目标

### 目标

1. 三枚徽章 100% 同词同形：剩余 `>= 0` 显绿底「达成」，`< 0` 显红底「不达成」。
2. 累计卡删除「▲/▼ 距计划 ±N H」整句——差额与方向已由卡上大号带符号数字（如 `+11359.5 H`）承载，徽章不再重复。
3. 用代码把三枚徽章绑定到**同一个标签源**，使今后三处文案不可能再次分叉。
4. 徽章字号放大 1 倍（12px → 24px），追求醒目。

### 非目标（明确不做）

- 不改判定边界：`isRemainOnTrack` 的 `>= 0`、恰好 0 = 达成，均不变。
- 不改下方达成状况表的「达成 / **未达成**」文案及其严格 `> 0` 边界（两处边界规则不同，词面差异刻意保留，见 §6.3）。
- 不动 emoji（😊/😞、`text-5xl`、aria-hidden）、绿/红品牌色底、大号数字、卡标题、四卡布局。
- 不做 D-243、不做 390px 移动端适配、不做任何顺手重构。
- 无迁移、无新依赖（明确不引入 jsdom）、无 env / schema 变更。

## 3. 现状事实（写码前已逐行核实）

- `src/lib/calc.ts:202-204` — `isRemainOnTrack(remain)` 体为 `return remain >= 0;`，JSDoc 已注明三卡共用、边界不可漂移。
- `src/components/kpi/KpiCard.tsx`：
  - `StatusPill`（48-74 行）：纯文字胶囊，`ok` 绿底（`bg-challenge/20 text-challenge`）/ 非 ok 红底（`bg-actual/20 text-actual`）；现签名 `{ ok, okLabel, ngLabel = okLabel }`，默认值专为累计卡数值句设计；样式 `px-2 py-0.5 text-xs font-medium rounded-full`。
  - 三处调用：157 行 `达成/超支`、171 行 `优于挑战/未达挑战`、188-191 行累计卡单传 `` `${arrow}距计划 ${formatSignedHoursBare(...)} H` ``；`arrow` 三元在 177-179 行。
  - 徽章位于卡片内容区大号数字**下方**、`w-fit` 左对齐独占一行（不在卡头），字号放大不与卡头标题争行宽，无换行/挤压风险。
  - 层次参照：大号数字 `text-3xl`（30px）bold；右侧 emoji `text-5xl`（48px）。徽章 24px 后层次仍为 emoji > 数字 > 徽章。
- 全仓 679 个测试用例（34 文件）**无一处断言三枚徽章的现有文案**；`tests/calc/remain-on-track.test.ts` 测的是谓词，不测文案。改文案本身零旧测试破坏面。
- `formatSignedHoursBare` 在 KpiCard 中仍被三处大号数字使用，删除累计卡数值句后 import 保留。

## 4. 设计决策

| # | 决策 | 拍板 |
| --- | --- | --- |
| D1 | 三方案中选 **A**：纯「达成/不达成」，删除累计卡数值句，大号数字保留 | 用户 2026-09-09 |
| D2 | 负向词严格用「**不达成**」（非达成表的「未达成」） | 用户原话「达成/不达成」 |
| D3 | 徽章字号 `text-xs`(12px) → `text-2xl`(24px)，即严格 2 倍；padding `px-2 py-0.5` → `px-4 py-1`，加 `leading-none`（胶囊总高约 32px）；字重 `font-medium`、圆角、绿/红底色不变 | 用户 2026-09-09「字号放大1倍，要醒目。其他OK」 |
| D4 | 标签源放 `src/lib/kpi-verdict.ts`（展示谓词的可单测纯单元），不放 KpiCard 文件内 | 架构取舍，见 §5.1 |

## 5. 详细设计

### 5.1 新模块 `src/lib/kpi-verdict.ts`（唯一标签源）

把「谓词 + 文案」绑成一个不可分割的事实源；React 零依赖，vitest 可直接单测（不需要 jsdom）。

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

取舍：常量 + 解析函数都导出——组件只用 `kpiVerdict()`；常量单独导出是给逐字哨兵测试和未来其他表面（如下钻页）复用。不把该模块放进 KpiCard.tsx，是因为仓库现有测试设施无法渲染组件（无 jsdom），文案必须能脱离 React 被断言。

### 5.2 `StatusPill` 简化（KpiCard.tsx）

签名从「双词 + 默认值」收窄为「一词」，删除仅服务 ▲/▼ 数值句的 `ngLabel` 默认参数：

```tsx
/** Compact text-only status pill: green wording when `ok`, red otherwise.
 *  Uses brand colors with 20% opacity backgrounds via Tailwind 4 opacity
 *  modifiers. The verdict face lives only in the large decorative emoji of
 *  VerdictCardBody - the pill itself deliberately carries no emoji (user
 *  decision 2026-09-09: one face per card). Wording always comes from
 *  kpiVerdict() (single label source, same decision 2026-09-09). The pill is
 *  sized text-2xl per user request for an at-a-glance verdict. */
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

### 5.3 三处调用改造

每处把「先算 ok + 内联词」换成一次 `kpiVerdict()` 解析：

```tsx
// planRemain
const verdict = kpiVerdict(data.monthPlanRemain);
return (
  <VerdictCardBody ok={verdict.ok}>
    {/* 大号数字行原样不动 */}
    <StatusPill ok={verdict.ok} label={verdict.label} />
  </VerdictCardBody>
);
```

- `planRemain`：入参 `data.monthPlanRemain`，删除字面量 `达成/超支`。
- `chalRemain`：入参 `data.monthChalRemain`，删除字面量 `优于挑战/未达挑战`。
- `cumRemain`：入参 `data.cumRemain`；**删除** 177-179 行 `arrow` 三元与「No arrow at exactly 0」注释、190 行模板句；大号数字行不动。

import 调整：`@/lib/calc` 的 `isRemainOnTrack` 在 KpiCard 中不再直接使用（三处调用点全部改用 `kpiVerdict`），替换为 `import { kpiVerdict } from "@/lib/kpi-verdict";`（组件文件沿用双引号风格）。

### 5.4 JSDoc / 注释更新（英文）

- KpiCard 文件头（1-22 行）：补记 2026-09-09 第二个用户决策——三卡徽章共用 `kpiVerdict()` 的「达成/不达成」标签源、徽章 text-2xl；把"pill beneath the figure is colored wording only"一句更新为统一措辞描述。
- `calc.ts:193-204` 的 `isRemainOnTrack` JSDoc **不动**（其中"mislabelled ... as 超支"是历史 bug 叙述，保留原样才不失真）。
- `tests/calc/remain-on-track.test.ts` 注释中作为历史叙述出现的「超支」**不动**。

### 6.5 达成状况表刻意不动

`src/components/chart/AchievementTable.tsx:89` 维持 `{cell.achieved ? '达成' : '未达成'}`，其 `makeCell`（calc.ts:70-73）维持严格 `diff > 0`。KPI 卡（`>= 0`，词「不达成」）与达成表（`> 0`，词「未达成」）的差异是 calc.ts:64-68 注释锁定的 2026-09-09 product decision；词面不同恰好提示两处边界规则不同。本次**不得**顺手统一。

## 6. 文件改动清单

| 文件 | 性质 | 改动 |
| --- | --- | --- |
| `src/lib/kpi-verdict.ts` | 新增 | 约 35 行，见 §5.1 |
| `src/components/kpi/KpiCard.tsx` | 修改 | StatusPill 签名/样式（§5.2）、三处调用（§5.3）、删 arrow、import、文件头 JSDoc |
| `tests/lib/kpi-verdict.test.ts` | 新增 | 4 用例，见 §7 |

预期无其他文件改动。打包变更面相对 0909 生产包即此 3 文件（M/A/A），实施后以解包 `diff -rq` 实测为准。

## 7. 测试策略（TDD：先红后绿）

先写 `tests/lib/kpi-verdict.test.ts`（此时模块不存在 → 红），再写 §5 实现转绿。不加任何依赖。

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

- 用例数：679 + 4 = 683，文件数 34 + 1 = 35。
- 现有 679 用例全部不动；谓词边界原有测试（remain-on-track.test.ts）继续兜底。
- 样式（text-2xl/padding/颜色）无法在无 jsdom 条件下单测，由 §8 目视覆盖。

## 8. 验证计划

1. **门禁五连**（全绿才进入发布讨论）：
   `npm run db:generate` → `npm run typecheck` → `npm run lint` → `npm test`（期望 683/683, 35 文件）→ `npm run build`。
2. **dev server 目视**（起停须用户授权，沿用上轮模式）：
   - 三枚徽章逐字均为「达成/不达成」，三卡同字号同色形；
   - 24px 徽章视觉醒目但不压过 30px 数字、不撑破卡片、四卡仍等高对齐；
   - emoji=3、绿/红底随 ok；大号带符号数字不变；累计卡无 ▲/▼ 残句；
   - 视口 1440 / 768 / 375 各看一眼（375 仅核验不溢出，不做移动端适配）；
   - 负态「不达成」若 dev 库无负值部门，以单测兜底（生产当前三卡均正）。
3. **发布**（另行请批，未许可不动）：新白名单包；相对 0909 生产包解包 `diff -rq` 锁变更面（预期即 §6 三文件）；新 SHA256SUMS；新自包含 runbook，其中 §8.5 逐字文案表更新为三卡「达成/不达成」、字号 text-2xl，emoji 探针仍期望 3、`演示数据` 仍严格 0；无迁移故仍不跑 `migrate deploy`；用户自部署、回传输出、我判读。

## 9. 风险

| 风险 | 评估 / 缓解 |
| --- | --- |
| 24px 徽章实际观感过大 | 与数字 30px / emoji 48px 的层次已核算；目视门可当场回调（仅 1 个 token 的改动） |
| 徽章变高影响四卡对齐 | 徽章独占内容区一行、四卡同组件同结构，grid 等高拉伸，影响一致；目视确认 |
| 红态在真实数据中不可见 | 单测覆盖 `-260 → 不达成`；目视以绿态 + 单测组合验收 |
| 文案再次分叉 | 结构上消除：三处均无自有字符串，只有 `kpiVerdict()` 一个出口 + 逐字哨兵测试 |
| 误改达成表/谓词边界 | §2 非目标 + §5.4/§5.5 明确冻结；diff 评审时逐项核对 |

## 10. 回滚

纯前端文案/样式改动，无数据面。上线后若需回退，在旧代码目录执行 `docker compose -f docker-compose.prod.yml up -d --build` 重建（镜像固定 tag `manhour-mgmt:latest`，回滚必须 `--build`），数据库不动。
