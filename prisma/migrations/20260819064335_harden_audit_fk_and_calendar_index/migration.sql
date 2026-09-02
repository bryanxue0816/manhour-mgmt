-- DropIndex
DROP INDEX "work_calendar_dayType_idx";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_plan_change_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "beforeValue" REAL NOT NULL,
    "afterValue" REAL NOT NULL,
    "reason" TEXT,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,
    CONSTRAINT "plan_change_log_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_plan_change_log" ("afterValue", "beforeValue", "changedAt", "changedBy", "field", "id", "planId", "reason") SELECT "afterValue", "beforeValue", "changedAt", "changedBy", "field", "id", "planId", "reason" FROM "plan_change_log";
DROP TABLE "plan_change_log";
ALTER TABLE "new_plan_change_log" RENAME TO "plan_change_log";
CREATE INDEX "plan_change_log_planId_changedAt_idx" ON "plan_change_log"("planId", "changedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "work_calendar_dayType_date_idx" ON "work_calendar"("dayType", "date");
