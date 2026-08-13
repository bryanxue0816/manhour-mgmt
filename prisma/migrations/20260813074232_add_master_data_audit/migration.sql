-- CreateTable
CREATE TABLE "master_data_change_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "snapshot" TEXT NOT NULL,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changedBy" TEXT NOT NULL DEFAULT 'admin'
);

-- CreateIndex
CREATE INDEX "master_data_change_log_entity_changedAt_idx" ON "master_data_change_log"("entity", "changedAt");
