// SQLite backup for the on-premises deployment (D-007).
//
// Run from the app directory on the production box:
//   node scripts/backup-db.mjs
//   node scripts/backup-db.mjs --db /data/dev.db --out /backup --keep 30
//
// Plain `.mjs` executed by plain `node`, deliberately: `scripts/fetch-attendance.ts`
// runs under tsx, but tsx is a devDependency and a production install
// (`npm ci --omit=dev`) does not have it. A backup script that only works where the
// dev toolchain is installed is a backup script that is missing on the one machine
// that needs it. The only runtime dependency here is better-sqlite3, which is a
// production dependency because the app itself needs it.
//
// WHY `VACUUM INTO` AND NOT `cp`:
//
// The database runs in journal_mode=delete (verified, not assumed - `pragma
// journal_mode` on the live file returns 'delete', not 'wal'). In that mode a write
// transaction lives in a separate `-journal` sidecar file, and the main file is
// transiently inconsistent while it exists. `cp dev.db backup.db` during that window
// copies a torn page image plus none of the journal needed to repair it: the copy
// opens fine, passes a casual smoke test, and fails later on whichever page was
// mid-write. VACUUM INTO instead runs inside a read transaction and writes a freshly
// packed, guaranteed-consistent image - the documented way to hot-copy SQLite without
// stopping the writer.
//
// It is also NOT `.backup`/the online backup API: that one restarts on concurrent
// writes and can livelock under a steady writer. This app's writes are bursty
// human-triggered imports, so either would do, but VACUUM INTO cannot livelock.
//
// VERIFY, DO NOT ASSUME: every backup is opened, `pragma integrity_check`ed, and
// row-counted against the source before it is accepted. An unverified backup is
// indistinguishable from no backup until the restore, which is the worst possible
// moment to find out.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import Database from "better-sqlite3";

/** Tables whose row counts are compared source-vs-copy. */
const VERIFIED_TABLES = [
  "attendance_raw",
  "import_log",
  "plan",
  "actual",
  "department",
  "section",
  "fiscal_year",
];

const DEFAULTS = {
  db: "dev.db",
  out: "backups",
  keep: 30,
};

/**
 * Parses `--flag value` pairs.
 *
 * Unknown flags are a hard error rather than being ignored: a typo like `--keeps 7`
 * would otherwise silently fall back to the default retention and quietly delete
 * more history than the operator asked for.
 */
function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`missing value for ${flag}`);
    }
    switch (flag) {
      case "--db":
        opts.db = value;
        break;
      case "--out":
        opts.out = value;
        break;
      case "--keep": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) {
          throw new Error(`--keep must be a positive integer, got ${value}`);
        }
        opts.keep = n;
        break;
      }
      default:
        throw new Error(`unknown flag ${flag}`);
    }
  }
  return opts;
}

/**
 * `YYYYMMDD-HHMMSS` in local time.
 *
 * Local rather than UTC because the operator reading the filename thinks in the
 * factory's clock, and a backup named 20:00 that actually ran at 05:00 the next
 * morning is a filename that lies during an incident.
 */
function stamp(now) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/** Reads the row counts used to compare source and copy. */
function rowCounts(db) {
  const counts = {};
  for (const table of VERIFIED_TABLES) {
    const row = db.prepare(`SELECT count(*) AS c FROM "${table}"`).get();
    counts[table] = row.c;
  }
  return counts;
}

/**
 * Opens the backup and proves it is usable.
 *
 * Three checks, each catching a different failure:
 *   1. integrity_check  - structural corruption inside the copy
 *   2. row counts       - a consistent but WRONG snapshot (e.g. pointed at a stale
 *                         or half-seeded file), which integrity_check calls healthy
 *   3. a real query     - the schema is not just present but queryable
 */
function verifyBackup(backupPath, expectedCounts) {
  const copy = new Database(backupPath, { readonly: true });
  try {
    const integrity = copy.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`integrity_check failed: ${integrity}`);
    }

    const actual = rowCounts(copy);
    const drift = VERIFIED_TABLES.filter((t) => actual[t] !== expectedCounts[t]).map(
      (t) => `${t} ${expectedCounts[t]}->${actual[t]}`,
    );
    if (drift.length > 0) {
      // A live import committing between the two reads is a legitimate cause, but it
      // is still not a backup anyone should trust silently: the operator must decide.
      throw new Error(`row counts differ from source: ${drift.join(", ")}`);
    }

    // Cheap end-to-end proof that the schema is queryable, not merely intact.
    copy.prepare("SELECT id, year FROM fiscal_year ORDER BY year LIMIT 1").get();

    return actual;
  } finally {
    copy.close();
  }
}

/**
 * Deletes all but the newest `keep` backups.
 *
 * Sorted by filename, which is safe only because the stamp is fixed-width and
 * zero-padded - it sorts identically to chronological order. Deliberately not sorted
 * by mtime: copying a backup directory to another host rewrites mtimes and would
 * reorder history, making the pruner delete the wrong files.
 */
function prune(outDir, keep) {
  const files = readdirSync(outDir)
    .filter((f) => /^manhour-\d{8}-\d{6}\.db$/.test(f))
    .sort();
  const doomed = files.slice(0, Math.max(0, files.length - keep));
  for (const f of doomed) {
    unlinkSync(path.join(outDir, f));
  }
  return { kept: files.length - doomed.length, deleted: doomed.length };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const dbPath = path.resolve(opts.db);
  if (!existsSync(dbPath)) {
    throw new Error(`database not found: ${dbPath}`);
  }

  const outDir = path.resolve(opts.out);
  mkdirSync(outDir, { recursive: true });

  const backupPath = path.join(outDir, `manhour-${stamp(new Date())}.db`);
  if (existsSync(backupPath)) {
    // Two runs inside the same second. Refuse rather than overwrite: the existing
    // file is a verified backup and this one is not yet.
    throw new Error(`backup already exists: ${backupPath}`);
  }

  const source = new Database(dbPath, { readonly: true });
  let expected;
  try {
    expected = rowCounts(source);
    // Bound parameters are not allowed in VACUUM INTO, so the path is interpolated.
    // It comes from argv on an operator's own command line, never from user input,
    // and single quotes are doubled per SQL string-literal escaping.
    source.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }

  const verified = verifyBackup(backupPath, expected);
  const bytes = statSync(backupPath).size;
  const { kept, deleted } = prune(outDir, opts.keep);

  const summary = VERIFIED_TABLES.map((t) => `${t}=${verified[t]}`).join(" ");
  console.log(`OK  ${backupPath}`);
  console.log(`    ${(bytes / 1024).toFixed(1)} KB  integrity=ok  ${summary}`);
  console.log(`    retention: ${kept} kept, ${deleted} pruned (--keep ${opts.keep})`);
}

try {
  main();
} catch (error) {
  // Non-zero exit so a cron/Task Scheduler wrapper can detect the failure. A backup
  // job that fails silently is worse than one that never ran, because it is believed.
  console.error(`BACKUP FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
