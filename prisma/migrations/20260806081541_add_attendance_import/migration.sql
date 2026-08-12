-- CreateTable
CREATE TABLE "section_alias" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hrDeptName" TEXT NOT NULL,
    "hrSectionName" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "remark" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "section_alias_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "section" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "attendance_raw" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "employeeNo" TEXT NOT NULL,
    "employeeName" TEXT,
    "workDate" DATETIME NOT NULL,
    "hrDeptName" TEXT NOT NULL,
    "hrSectionName" TEXT,
    "jobTitle" TEXT,
    "employeeCategory" TEXT,
    "sectionId" TEXT,
    "leaveHours" REAL NOT NULL DEFAULT 0,
    "workHours" REAL NOT NULL DEFAULT 0,
    "normalOvertime" REAL NOT NULL DEFAULT 0,
    "restDayDouble" REAL NOT NULL DEFAULT 0,
    "holidayOvertime" REAL NOT NULL DEFAULT 0,
    "restDayCompensate" REAL NOT NULL DEFAULT 0,
    "compensatoryLeave" REAL NOT NULL DEFAULT 0,
    "maternityLeave" REAL NOT NULL DEFAULT 0,
    "nursingLeave" REAL NOT NULL DEFAULT 0,
    "miscarriageLeave" REAL NOT NULL DEFAULT 0,
    "personnelHours" REAL NOT NULL DEFAULT 0,
    "overtimeHours" REAL NOT NULL DEFAULT 0,
    "totalHours" REAL NOT NULL DEFAULT 0,
    "excludedPersonnel" BOOLEAN NOT NULL DEFAULT false,
    "excludedOvertime" BOOLEAN NOT NULL DEFAULT false,
    "sourceFile" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "attendance_raw_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "section" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "import_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fileName" TEXT NOT NULL,
    "fileMtime" DATETIME,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "triggeredBy" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "section_alias_sectionId_idx" ON "section_alias"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "section_alias_hrDeptName_hrSectionName_key" ON "section_alias"("hrDeptName", "hrSectionName");

-- CreateIndex
CREATE INDEX "attendance_raw_workDate_idx" ON "attendance_raw"("workDate");

-- CreateIndex
CREATE INDEX "attendance_raw_sectionId_workDate_idx" ON "attendance_raw"("sectionId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_raw_employeeNo_workDate_key" ON "attendance_raw"("employeeNo", "workDate");

-- CreateIndex
CREATE INDEX "import_log_importedAt_idx" ON "import_log"("importedAt");

-- CreateIndex
CREATE INDEX "import_log_status_importedAt_idx" ON "import_log"("status", "importedAt");
