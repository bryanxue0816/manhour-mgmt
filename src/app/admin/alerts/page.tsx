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
