-- D-229: soft supersede for attendance_raw, plus its audit counter on import_log.
--
-- Row-level upsert already handles "duplicate rows are no-ops, the later file wins", but it
-- cannot express a deletion: overwriting only touches keys present in the incoming file, so
-- a row HR dropped between the 09:05 and 15:05 fetches would survive as a ghost and keep
-- feeding the monthly aggregate. These columns mark such a row instead of deleting it,
-- because D-206 is "不做删除、长期保留" and raw detail is not recomputable.
--
-- Deliberately no index on supersededAt: every read already filters a workDate range (served
-- by the existing attendance_raw workDate index) and almost every row is NULL, so an index
-- would add write amplification for no selectivity.

-- AlterTable
ALTER TABLE "attendance_raw" ADD COLUMN "supersededAt" DATETIME;
ALTER TABLE "attendance_raw" ADD COLUMN "supersededBy" TEXT;

-- AlterTable
-- NOT NULL DEFAULT 0 is safe on a populated table: existing rows predate the feature and
-- superseded nothing, which is exactly what 0 means.
ALTER TABLE "import_log" ADD COLUMN "supersededCount" INTEGER NOT NULL DEFAULT 0;
