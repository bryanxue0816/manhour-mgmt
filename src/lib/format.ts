/**
 * Shared display formatters for man-hour figures.
 *
 * Man-hour figures reach five digits at the company level (tens of thousands of
 * hours), so every user-facing hour value goes through one of these to get a
 * thousands separator. Keeping them in one place prevents the mixed
 * "68376 H" / "68,376 H" output the dashboard had before.
 *
 * There are four variants rather than one because four genuinely different
 * renderings are already in use across the four screens, and collapsing them
 * into a single function would silently change what operators see:
 *
 * | function             | example    | where                                  |
 * | -------------------- | ---------- | -------------------------------------- |
 * | `formatHours`        | `4,632 H`  | doughnut stat boxes, chart tooltips    |
 * | `formatHoursValue`   | `4,631.5`  | tables whose column header carries "H" |
 * | `formatHoursRounded` | `36,193`   | plan import preview (whole hours only) |
 * | `formatHoursBare`    | `4632`     | KPI cards                              |
 *
 * `formatHoursBare` deliberately drops the separator: the KPI card renders its
 * figure at display size in a fixed-width slot, where a comma costs a character
 * of room and buys little at four digits.
 *
 * Every locale-aware variant pins `zh-CN` explicitly rather than relying on the
 * ambient default. These strings are produced once during SSR and again during
 * hydration; if the Node process and the browser disagree on the default locale,
 * React reports a hydration mismatch on a number that is in fact correct. For
 * the values this app handles the pinned output is identical to the previous
 * ambient-default output, so this closes a failure mode without changing a
 * single rendered digit.
 */

/**
 * Hours arrive from attendance in 0.5 steps, so one decimal place is the exact
 * precision of the underlying data: it never truncates a real value and never
 * invents a digit a sum does not have.
 */
const HOURS_FORMAT: Readonly<Intl.NumberFormatOptions> = {
  maximumFractionDigits: 1,
};

/** Whole hours - the plan import template accepts integers only. */
const WHOLE_HOURS_FORMAT: Readonly<Intl.NumberFormatOptions> = {
  maximumFractionDigits: 0,
};

/** Format an hour count with a thousands separator and the "H" unit. */
export function formatHours(value: number): string {
  return `${formatHoursValue(value)} H`;
}

/**
 * Thousands separator, at most one decimal, no unit. For tables and grids whose
 * column header already carries the unit, where repeating it on every cell would
 * be noise.
 */
export function formatHoursValue(value: number): string {
  return value.toLocaleString('zh-CN', HOURS_FORMAT);
}

/** Thousands separator, no decimals, no unit. */
export function formatHoursRounded(value: number): string {
  return value.toLocaleString('zh-CN', WHOLE_HOURS_FORMAT);
}

/**
 * Rounded to an integer with NO thousands separator - see the note above on why
 * the KPI card wants it that way.
 */
export function formatHoursBare(value: number): string {
  return String(Math.round(value));
}

/**
 * Tooltip-safe variant: Recharts' `ValueType` is a union that may be undefined,
 * so narrow at runtime instead of asserting a `number` parameter signature
 * (parameter types are contravariant — a narrower signature is a type error).
 */
export function formatHoursUnknown(value: unknown): string {
  return typeof value === 'number' ? formatHours(value) : String(value ?? '');
}
