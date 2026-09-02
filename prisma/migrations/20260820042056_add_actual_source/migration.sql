-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_actual" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sectionId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "personnelHours" REAL NOT NULL DEFAULT 0,
    "overtimeHours" REAL NOT NULL DEFAULT 0,
    "totalHours" REAL NOT NULL DEFAULT 0,
    "source" TEXT NOT NULL DEFAULT 'fold',
    "sourceFile" TEXT,
    "fetchedAt" DATETIME,
    "lastComputedAt" DATETIME NOT NULL,
    CONSTRAINT "actual_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "section" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "actual_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "fiscal_year" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_actual" ("fetchedAt", "fiscalYearId", "id", "lastComputedAt", "month", "overtimeHours", "personnelHours", "sectionId", "sourceFile", "totalHours") SELECT "fetchedAt", "fiscalYearId", "id", "lastComputedAt", "month", "overtimeHours", "personnelHours", "sectionId", "sourceFile", "totalHours" FROM "actual";
DROP TABLE "actual";
ALTER TABLE "new_actual" RENAME TO "actual";
CREATE INDEX "actual_fiscalYearId_month_idx" ON "actual"("fiscalYearId", "month");
CREATE UNIQUE INDEX "actual_sectionId_fiscalYearId_month_key" ON "actual"("sectionId", "fiscalYearId", "month");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
