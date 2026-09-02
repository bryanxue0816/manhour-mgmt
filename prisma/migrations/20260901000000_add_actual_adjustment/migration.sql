-- D-233: 实绩调整单。纯新增表，不触碰 actual / attendance_raw 的任何现有行。
--
-- Additive only: no RedefineTables block, no data movement, no column change on any
-- existing table. Deploying this cannot alter a single stored figure - the merge that
-- makes adjustments visible lands separately, and until then this table stays empty and
-- every reported number is byte-identical to before.
--
-- Rollback needs no down migration: the table is new and empty, so reverting the code
-- simply stops reading it. Do NOT hand-drop it to "undo" - that desyncs
-- _prisma_migrations exactly as noted for 20260828000000.

-- CreateTable
CREATE TABLE "actual_adjustment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sectionId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "hours" REAL NOT NULL,
    -- Snapshot of the section-month's folded actual.totalHours at entry time. NULLABLE on
    -- purpose: null = base unknown = not checked. The writers store 0 (not null) when no
    -- actual row exists, so a fold arriving later still trips the drift check. See
    -- schema.prisma for the double-count path this exists to catch.
    "foldHoursAtEntry" REAL,
    "reason" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL DEFAULT 'admin',
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    "revokedBy" TEXT,
    CONSTRAINT "actual_adjustment_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "section" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "actual_adjustment_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "fiscal_year" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "actual_adjustment_fiscalYearId_month_idx" ON "actual_adjustment"("fiscalYearId", "month");

-- CreateIndex
CREATE INDEX "actual_adjustment_sectionId_fiscalYearId_month_idx" ON "actual_adjustment"("sectionId", "fiscalYearId", "month");
