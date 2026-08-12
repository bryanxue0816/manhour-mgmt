// The `(部别, 课别) -> Section` lookup key, in its own module because both a pure
// calculation layer and a Prisma repository need it.
//
// It lives here rather than in section-alias.repo.ts so that lib/attendance/calc.ts can
// build its lookup maps without importing prisma: `lib/prisma.ts` constructs the client
// at module load, so one type-only-looking import would drag a native better-sqlite3
// binding and a DATABASE_URL requirement into every unit test of the D-110 examples.

/**
 * Composite lookup key for section resolution.
 *
 * `|` is safe as a separator because it cannot appear in a department or section name on
 * either side - both come from a fixed org master of Chinese names.
 *
 * Keys are built and compared VERBATIM: no trimming, no Unicode normalisation, no width
 * folding. NFKC would fold some of the very pairs the alias table exists to distinguish
 * (检查课 with 查 = U+67E5 vs 检査课 with 査 = U+67FB), turning a visible mismatch into
 * an invisible one.
 */
export function aliasKey(hrDeptName: string, hrSectionName: string): string {
  return `${hrDeptName}|${hrSectionName}`;
}
