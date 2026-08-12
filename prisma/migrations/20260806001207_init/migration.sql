-- CreateTable
CREATE TABLE "department" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "managerName" TEXT,
    "managerEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "section" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "departmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "managerName" TEXT,
    "managerEmail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "section_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "department" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "fiscal_year" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sectionId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "plannedHours" REAL NOT NULL,
    "challengeHours" REAL NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    "updatedBy" TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT "plan_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "section" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "plan_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "fiscal_year" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "plan_change_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "beforeValue" REAL NOT NULL,
    "afterValue" REAL NOT NULL,
    "reason" TEXT,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL,
    CONSTRAINT "plan_change_log_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "actual" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sectionId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "personnelHours" REAL NOT NULL DEFAULT 0,
    "overtimeHours" REAL NOT NULL DEFAULT 0,
    "totalHours" REAL NOT NULL DEFAULT 0,
    "sourceFile" TEXT,
    "fetchedAt" DATETIME,
    "lastComputedAt" DATETIME NOT NULL,
    CONSTRAINT "actual_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "section" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "actual_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "fiscal_year" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "config" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "work_calendar" (
    "date" DATETIME NOT NULL PRIMARY KEY,
    "dayType" TEXT NOT NULL,
    "remark" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "job_title_rule" (
    "jobTitle" TEXT NOT NULL PRIMARY KEY,
    "excludePersonnelHours" BOOLEAN NOT NULL DEFAULT false,
    "excludeOvertimeHours" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "department_name_key" ON "department"("name");

-- CreateIndex
CREATE UNIQUE INDEX "department_code_key" ON "department"("code");

-- CreateIndex
CREATE INDEX "department_sortOrder_idx" ON "department"("sortOrder");

-- CreateIndex
CREATE INDEX "section_departmentId_sortOrder_idx" ON "section"("departmentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "section_departmentId_name_key" ON "section"("departmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_year_name_key" ON "fiscal_year"("name");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_year_year_key" ON "fiscal_year"("year");

-- CreateIndex
CREATE INDEX "plan_fiscalYearId_month_idx" ON "plan"("fiscalYearId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "plan_sectionId_fiscalYearId_month_key" ON "plan"("sectionId", "fiscalYearId", "month");

-- CreateIndex
CREATE INDEX "plan_change_log_planId_changedAt_idx" ON "plan_change_log"("planId", "changedAt");

-- CreateIndex
CREATE INDEX "actual_fiscalYearId_month_idx" ON "actual"("fiscalYearId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "actual_sectionId_fiscalYearId_month_key" ON "actual"("sectionId", "fiscalYearId", "month");

-- CreateIndex
CREATE INDEX "work_calendar_dayType_idx" ON "work_calendar"("dayType");
