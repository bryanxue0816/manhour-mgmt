#!/usr/bin/env node
// Periodic auto-commit for this repository (see docs/AUTO_COMMIT.md).
//
// Purpose is narrow: never lose a day's work again. It is NOT a replacement for
// hand-written commits - every commit it makes is prefixed `wip:` and carries an
// `[auto-commit]` trailer so a milestone commit can squash them later.
//
// Policy, chosen deliberately:
//   * A suspected secret ABORTS the run. Nothing is staged, nothing is committed.
//     A bad commit can be amended; a key that reaches history cannot be unpublished.
//   * A failing typecheck or test suite does NOT abort. Half-finished broken code is
//     exactly what most needs a rollback point. The failure is recorded in the commit
//     message as [gate-failed] instead.
//   * A quiet period is required before committing, so a scheduled run does not
//     snapshot a file mid-edit.
//
// The repository has no remote, so this protects against accidental deletion and bad
// edits only - not against disk loss. Add a remote and a push step for that.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_DIR = join(REPO_ROOT, ".autocommit");
const LOCK_FILE = join(STATE_DIR, "lock");
const LOG_FILE = join(STATE_DIR, "log.txt");

/** A file touched more recently than this is assumed to be mid-edit. */
const QUIET_PERIOD_MS = 90_000;
/** A lock older than this belonged to a crashed run. */
const STALE_LOCK_MS = 15 * 60_000;
/** Content scanning skips anything larger; secrets are small, bundles are not. */
const MAX_SCAN_BYTES = 1_000_000;
const GATE_TIMEOUT_MS = 5 * 60_000;

const IS_DRY_RUN = process.argv.includes("--dry-run");

/** Paths that must never enter history, checked by name. */
const SECRET_PATH_PATTERNS = [
  { pattern: /(^|\/)\.env(\.|$)/, reason: "环境变量文件" },
  { pattern: /\.(db|db-journal|sqlite|sqlite3)$/i, reason: "数据库文件" },
  { pattern: /\.(pem|key|p12|pfx|keystore|jks)$/i, reason: "私钥/证书" },
  { pattern: /(^|\/)(backups|dumps)\//i, reason: "备份目录" },
  { pattern: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, reason: "SSH 私钥" },
];

/** Allowed despite matching above - placeholder templates are meant to be tracked. */
const SECRET_PATH_ALLOWLIST = [/\.example$/, /\.sample$/, /\.template$/];

/** Content patterns. Kept specific: a false positive blocks the whole run. */
const SECRET_CONTENT_PATTERNS = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, reason: "PEM 私钥块" },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/, reason: "Anthropic API key" },
  { pattern: /\bsk-[A-Za-z0-9]{32,}/, reason: "OpenAI 风格 API key" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/, reason: "GitHub token" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, reason: "AWS access key id" },
  { pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/"']+:[^\s:@/"']+@/, reason: "含口令的连接串" },
];

/** Values that look like a secret but are the documented placeholders. */
const SECRET_CONTENT_ALLOWLIST = [
  /change[_-]?me/i,
  /your[_-]?(password|token|key)/i,
  /<[^>]*>/,
  /\bxxx+\b/i,
  /replace[_-]?this/i,
];

function git(args, options = {}) {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // Logging must never be the reason a commit is lost.
  }
}

/** Exits the whole run. `code` 0 means "nothing to do", not failure. */
function finish(code, message) {
  log(message);
  releaseLock();
  process.exit(code);
}

function acquireLock() {
  mkdirSync(STATE_DIR, { recursive: true });
  if (existsSync(LOCK_FILE)) {
    const ageMs = Date.now() - statSync(LOCK_FILE).mtimeMs;
    if (ageMs < STALE_LOCK_MS) {
      console.log("[auto-commit] 上一轮仍在运行，跳过。");
      process.exit(0);
    }
    log(`清理过期锁（${Math.round(ageMs / 60_000)} 分钟前）。`);
  }
  writeFileSync(LOCK_FILE, String(process.pid), "utf8");
}

function releaseLock() {
  try {
    rmSync(LOCK_FILE, { force: true });
  } catch {
    // Stale-lock handling above covers this.
  }
}

/**
 * Parses `git status --porcelain -z -uall` into change records.
 *
 * NUL separation rather than line splitting is required, not stylistic: paths with
 * non-ASCII characters come back quoted and escaped in the line-based format, and
 * this repository has Chinese content paths.
 */
function readChanges() {
  const raw = git(["status", "--porcelain", "-z", "--untracked-files=all"]);
  const tokens = raw.split("\0").filter((token) => token !== "");
  const changes = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const status = token.slice(0, 2);
    const path = token.slice(3);
    // A rename/copy entry is followed by its source path as a separate token.
    if (status.startsWith("R") || status.startsWith("C")) {
      i += 1;
    }
    changes.push({ status, path, isDeleted: status.includes("D") });
  }
  return changes;
}

function isAllowlistedPath(path) {
  return SECRET_PATH_ALLOWLIST.some((pattern) => pattern.test(path));
}

function scanPathNames(changes) {
  const findings = [];
  for (const change of changes) {
    if (isAllowlistedPath(change.path)) continue;
    for (const { pattern, reason } of SECRET_PATH_PATTERNS) {
      if (pattern.test(change.path)) {
        findings.push(`${change.path} —— ${reason}`);
        break;
      }
    }
  }
  return findings;
}

function readTextForScan(path) {
  const absolute = join(REPO_ROOT, path);
  if (!existsSync(absolute)) return null;
  const stats = statSync(absolute);
  if (!stats.isFile() || stats.size > MAX_SCAN_BYTES) return null;
  const buffer = readFileSync(absolute);
  if (buffer.includes(0)) return null; // binary
  return buffer.toString("utf8");
}

function scanContents(changes) {
  const findings = [];
  for (const change of changes) {
    if (change.isDeleted) continue;
    const text = readTextForScan(change.path);
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      if (SECRET_CONTENT_ALLOWLIST.some((pattern) => pattern.test(line))) continue;
      const hit = SECRET_CONTENT_PATTERNS.find(({ pattern }) => pattern.test(line));
      if (hit !== undefined) {
        findings.push(`${change.path} —— ${hit.reason}`);
        break;
      }
    }
  }
  return findings;
}

/** True when every changed file has been untouched long enough to look settled. */
function isQuiet(changes) {
  const now = Date.now();
  for (const change of changes) {
    if (change.isDeleted) continue;
    const absolute = join(REPO_ROOT, change.path);
    if (!existsSync(absolute)) continue;
    if (now - statSync(absolute).mtimeMs < QUIET_PERIOD_MS) return false;
  }
  return true;
}

function isMidOperation() {
  const gitDir = git(["rev-parse", "--absolute-git-dir"]).trim();
  return ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "index.lock"].some(
    (entry) => existsSync(join(gitDir, entry)),
  );
}

function runGate(name, args) {
  try {
    execFileSync("npm", ["run", name, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: "pipe",
      timeout: GATE_TIMEOUT_MS,
      shell: process.platform === "win32",
    });
    return { name, passed: true };
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return { name, passed: false, detail: output.split(/\r?\n/).slice(-4).join(" / ") };
  }
}

function buildMessage(changes, gates, stat) {
  const failed = gates.filter((gate) => !gate.passed);
  const marker = failed.length === 0 ? "" : "[gate-failed] ";
  const gateLine =
    gates.length === 0
      ? "闸门: 跳过（无 TypeScript 改动）"
      : `闸门: ${gates.map((g) => `${g.name} ${g.passed ? "✅" : "❌"}`).join(" · ")}`;
  const preview = changes
    .slice(0, 12)
    .map((change) => `  ${change.status.trim() || "??"} ${change.path}`)
    .join("\n");
  const omitted = changes.length > 12 ? `\n  …另有 ${changes.length - 12} 项` : "";
  const failureDetail = failed
    .filter((gate) => gate.detail)
    .map((gate) => `\n${gate.name} 失败尾部输出:\n  ${gate.detail}`)
    .join("");

  // Git splits subject from body at the FIRST blank line, so the blank line after the
  // subject is load-bearing - without it the entire message becomes one subject and
  // `git log --oneline` prints hundreds of characters per commit. An earlier version
  // filtered empty strings out of this array and broke exactly that.
  const parts = [
    `wip: ${marker}自动保存 ${changes.length} 项改动`,
    "",
    `分支 ${git(["branch", "--show-current"]).trim()} · ${new Date().toLocaleString("zh-CN")}`,
    stat,
    gateLine,
    "",
    "变更明细:",
    `${preview}${omitted}`,
  ];
  if (failureDetail !== "") parts.push(failureDetail);
  parts.push("", "[auto-commit] 由 scripts/auto-commit.mjs 自动生成，可在里程碑提交时压扁。");
  return parts.join("\n");
}

function main() {
  acquireLock();

  if (isMidOperation()) finish(0, "仓库正处于 merge/rebase/加锁状态，跳过。");

  const changes = readChanges();
  if (changes.length === 0) finish(0, "无改动，跳过。");

  const secretFindings = [...scanPathNames(changes), ...scanContents(changes)];
  if (secretFindings.length > 0) {
    log("检测到疑似密钥，已中止，未暂存任何文件:");
    for (const finding of secretFindings) log(`  ✗ ${finding}`);
    log("请移出仓库或加入 .gitignore 后重试。误报可在 scripts/auto-commit.mjs 的允许列表中登记。");
    releaseLock();
    process.exit(2);
  }

  if (!isQuiet(changes)) {
    finish(0, `有文件在 ${QUIET_PERIOD_MS / 1000} 秒内被改动（疑似正在编辑），本轮跳过。`);
  }

  const touchesTypeScript = changes.some(
    (change) => !change.isDeleted && /\.(ts|tsx|mts|cts)$/.test(change.path),
  );
  const gates = touchesTypeScript
    ? [runGate("typecheck", []), runGate("test", ["--", "--silent"])]
    : [];

  if (IS_DRY_RUN) {
    log("--dry-run：以下提交不会被创建。");
    console.log("\n----- 提交信息预览 -----");
    console.log(buildMessage(changes, gates, "统计: (dry-run 未暂存，跳过 diff 统计)"));
    console.log("------------------------\n");
    finish(0, `--dry-run 结束：${changes.length} 项改动通过密钥扫描。`);
  }

  git(["add", "-A"]);
  const stagedCount = git(["diff", "--cached", "--name-only"]).split("\n").filter(Boolean).length;
  if (stagedCount === 0) finish(0, "暂存后无内容（改动全部被 .gitignore 排除），跳过。");

  const shortstat = git(["diff", "--cached", "--shortstat"]).trim();
  const message = buildMessage(changes, gates, `统计: ${stagedCount} 文件入库 · ${shortstat}`);

  // Message goes through a file, not stdin. Passing it as `input` to `git commit -F -`
  // collapsed every newline, producing a single-line subject hundreds of characters
  // long that `git log --oneline` rendered unreadably. A temp file preserves the
  // subject/body split that makes the log skimmable.
  const messageFile = join(STATE_DIR, "COMMIT_MSG.txt");
  writeFileSync(messageFile, message, "utf8");
  try {
    git(["commit", "--no-verify", "-F", messageFile]);
  } finally {
    rmSync(messageFile, { force: true });
  }

  const head = git(["rev-parse", "--short", "HEAD"]).trim();
  const failedNames = gates.filter((gate) => !gate.passed).map((gate) => gate.name);
  const suffix = failedNames.length === 0 ? "" : `（闸门失败: ${failedNames.join(", ")}，已标记）`;
  finish(0, `已提交 ${head}：${stagedCount} 文件${suffix}`);
}

try {
  main();
} catch (error) {
  log(`运行失败: ${error.message}`);
  releaseLock();
  process.exit(1);
}
