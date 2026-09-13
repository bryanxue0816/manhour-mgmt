# Task 17 可携带执行手册：Docker 镜像构建与容器内干跑实测

> 功能：考勤数据停摆管理员邮件告警（第一期 walking skeleton，最后一公里）
> 对应代码：`projects/manhour-mgmt/app` 内层 git 仓 **master @ `b3218e4`**（2026-09-13）
> 对应计划：`docs/superpowers/plans/2026-09-12-attendance-staleness-email-alert.md` Task 17
> 本手册性质：**一次性验收规程**（不是 DEPLOY.md 的一部分，不随镜像发布）。开发机没有 Docker（无 Docker Desktop、无 WSL2），经用户裁决转移到具备 Docker 的机器执行。
> 执行者可以是工程师或另一个 AI agent；零上下文照做即可。每一步**保存完整原始输出**（建议 `2>&1 | tee stepN.log`），最后按 §8 清单回传。

---

## 0. 目标机前置条件

| 项 | 要求 | 不满足时 |
|---|---|---|
| 架构 | Linux x86_64（amd64）首选；arm64 可试但 better-sqlite3 v12 的 prebuild 覆盖未验证 | 用 amd64 机 |
| Docker | `docker version` 能同时打印 Client 与 **Server** 版本（守护进程在跑）；Linux 需执行用户在 `docker` 组或用 sudo（下文命令统一用 `docker`，sudo 自行前缀） | 安装/启动 Docker Engine |
| Compose | `docker compose version` 输出版本（v2 插件）；本规程实际**不用** compose，仅作环境完整性确认 | — |
| 出网 | 构建期三处外联：① npm registry（registry.npmjs.org 或已配置的镜像源）；② **github.com**（better-sqlite3 v12 的 prebuild-install 从 GitHub release 下二进制）；③ **cdn.sheetjs.com**（package.json 的 xlsx 指向该 CDN 的 tgz，npm ci 必须能拉到） | 配代理/镜像源；三者缺一构建大概率失败 |
| 磁盘 | 预留 ≥ 5 GB（镜像 + build cache + 体积排查） | 清理空间 |
| 时间 | 首建预算 10–40 分钟（取决于网络；prebuild 下载是最大变量） | — |

红线（全程）：

- **永不运行 seed**（`prisma db seed` 一次都不要跑）。
- 不碰任何真实数据库文件（`*.db`）；所有数据只在一次性 named volume 里产生并随卷删除。
- 不 `docker push`、不覆盖 `:latest`（固定用独立 tag `manhour-mgmt:alert-walkthrough`）、不起生产 compose、不连生产机。
- 不给容器注入任何 `SMTP_*`/`ALERT_*` 变量——**必须保持默认干跑**（`SMTP_HOST` 空 → `MODE=DRY-RUN reason=smtp-not-configured`）。
- 不对 Dockerfile/源码做「顺手优化」；任何修复只允许按 §6 的症状驱动，且**改动不得自行 commit**（回传后由开发机会谈提交）。

---

## 1. 把构建上下文带到目标机

镜像从未被构建过；目标机需要一份 app 源码工作树（不需要 node_modules/.next，镜像内全新安装构建）。二选一。

### 1a. 从 git 取（目标机能访问该仓 remote 时）

> 注意：app 是**内层独立 git 仓**（`projects/manhour-mgmt/app/.git`）。截至本手册写就，push 从未授权；若 remote 上还没有 `b3218e4`，必须先由开发机用户显式授权 push，**不要自行推送**。

```sh
git clone <app 内层仓 remote> app
cd app
git checkout b3218e4        # 固定到验收的提交
git rev-parse --short HEAD  # 必须打印 b3218e4
```

### 1b. 打包携带（无 remote 或不便 push 时，推荐）

在**开发机（Windows，Git Bash）**上，于 `projects/manhour-mgmt/` 目录执行。排除项的核心是：依赖与构建产物（镜像内重建）、**真实数据库 dev.db（含考勤数据，绝不出机）**、密钥环境文件、git 历史。

```sh
cd /d/ClaudeCode/projects/manhour-mgmt
tar \
  --exclude='app/node_modules' \
  --exclude='app/.next' \
  --exclude='app/.git' \
  --exclude='app/data' \
  --exclude='app/backups' \
  --exclude='app/*.db' \
  --exclude='app/*.db-journal' \
  --exclude='app/*.db-wal' \
  --exclude='app/*.db-shm' \
  --exclude='app/.env' \
  --exclude='app/.env.local' \
  --exclude='app/.env.*.local' \
  --exclude='app/.env.production' \
  --exclude='app/.claude' \
  -czf manhour-app-b3218e4-src.tar.gz app
sha256sum manhour-app-b3218e4-src.tar.gz   # 记录哈希，传输后在目标机复核
```

打包后自查（关键！打印结果必须为空——确认没有数据库和密钥混入）：

```sh
tar -tzf manhour-app-b3218e4-src.tar.gz | grep -E '\.db($|-)|/\.env$|\.env\.production$|node_modules/|\.next/' || echo "CLEAN: no db/env/node_modules/.next in archive"
```

传到目标机后：

```sh
echo "<上面记录的 sha256>  manhour-app-b3218e4-src.tar.gz" | sha256sum -c -
tar -xzf manhour-app-b3218e4-src.tar.gz
cd app
git rev-parse --short HEAD 2>/dev/null || true   # 无 .git 无妨；以包名 b3218e4 为准
ls Dockerfile package.json package-lock.json prisma.config.ts src scripts | head
```

> 本手册本身位于开发机 `app/.claude/out/task17-docker-runbook-20260913.md`，被打包排除；如需在目标机对照，请单独复制该文件。

---

## 2. 环境验证（计划 Step 0）

```sh
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}'
docker compose version
```

预期：两条都正常打印版本号。`docker version` 若只有 Client、报 `cannot connect to the Docker daemon` → 先解决守护进程，**不要绕过**（不要换 podman/远程 socket 凑合）。

---

## 3. Step 1：构建镜像（独立 tag）

```sh
docker build -t manhour-mgmt:alert-walkthrough . 2>&1 | tee step1-build.log
```

预期：三阶段 `deps` → `builder` → `runner` 全部成功。构建期不提供 DATABASE_URL（设计如此：prisma generate 与 next build 都不需要数据库）。

重点盯的失败点（按概率）：

1. **头号风险——嵌套 better-sqlite3 v12 的 prebuild**：`@prisma/adapter-better-sqlite3@7.9.1` 声明 `better-sqlite3: ^12.6.0`（与顶层 v13 冲突，npm 把 **v12.11.1 嵌套安装**在 `node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3`）。v12 没有 prebuilds 目录，安装脚本是 `prebuild-install || node-gyp rebuild --release`：
   - 顺利路径：prebuild-install 从 GitHub release 拉到 linux-x64 预编译产物（需要 github.com 可达）。
   - 失败路径：退回 node-gyp（镜像 deps 阶段已装 python3/make/g++ 作为保险）。若 node-gyp 也失败，构建中止——**保留完整错误日志**，按 Error Recovery 纪律：同一类修复最多试两次，仍失败就停下回报，不要自行升级/降级任何依赖版本。
2. `npm ci` 拉不到 cdn.sheetjs.com 的 xlsx tgz 或 npm 包 → 网络/镜像源问题，不是代码问题。
3. `next build` 阶段报错 → 保留日志；这一步在开发机（Windows/Node 24.15.0）已通过，Linux 首建若失败多半也是环境（内存/文件系统大小写敏感）。

成功后记录：

```sh
docker images manhour-mgmt:alert-walkthrough
docker history manhour-mgmt:alert-walkthrough --no-trunc | head -30
```

---

## 4. Step 2：镜像内容五项核对

```sh
docker run --rm --entrypoint sh manhour-mgmt:alert-walkthrough -c '
  set -e
  echo "== scripts =="; ls scripts/
  echo "== alerts lib =="; ls src/lib/alerts/
  echo "== generated client =="; ls src/generated/prisma/ | head
  echo "== nodemailer =="; ls node_modules/nodemailer/package.json && node -e "console.log(require(\"/app/node_modules/nodemailer/package.json\").version)"
  echo "== prisma adapter =="; ls node_modules/@prisma/ ; ls node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3/build/Release/ 2>/dev/null || true
  echo "== tsconfig =="; cat tsconfig.json | head -5
' 2>&1 | tee step2-image-contents.log
```

逐条预期：

1. `scripts/` 含 `backup-db.mjs`、`fetch-attendance.ts`、**`check-attendance-alert.ts`**（以及 auto-commit 等）。
2. `src/lib/alerts/` 恰含本期六模块：`alert-decision.ts`、`alert-service.ts`、`alert-state.ts`、`alert-template.ts`、`email-config.ts`、`email-sender.ts`。
3. `src/generated/prisma/` 有 Prisma client 生成产物（`prisma generate` 在 builder 阶段生成）。
4. nodemailer `package.json` 在位，版本打印 **`10.x`**（锁定 10.0.9）；`node_modules/nodemailer/node_modules` 不存在或为空（零传递依赖的实物证据）。
5. `@prisma/` 下能看到 `adapter-better-sqlite3`；嵌套 better-sqlite3 原生件在位（v12 走 prebuild-install，预期路径 `…/better-sqlite3/build/Release/better_sqlite3.node`；若该路径为空，再查 `find node_modules/@prisma -name '*.node'` 并如实记录实际位置）。
6. tsconfig 打印内容含 `"paths"` 与 `"@/*": ["./src/*"]`（tsx 解析 `@/` 的依据）。

任一条缺失：**先不要改东西**，继续 §5 跑一次——运行时实际报错比静态 ls 更能精确定位缺什么，然后按 §6 处置。

---

## 5. Step 3：临时卷 + 空库迁移 + 连跑两遍干跑（核心验收）

一次性 named volume，空库只迁移（**不 seed**），连跑两遍告警脚本：

```sh
docker volume create manhour-alert-test

docker run --rm -e DATABASE_URL=file:/app/data/test.db \
  -v manhour-alert-test:/app/data \
  --entrypoint sh manhour-mgmt:alert-walkthrough -c '
    set -e
    node node_modules/prisma/build/index.js migrate deploy
    echo "===== RUN 1 ====="
    node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
    echo "===== RUN 2 ====="
    node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
    echo "===== DATA DIR ====="
    ls -la data/
  ' 2>&1 | tee step3-dryrun.log
```

预期（逐行对照；这是 walking skeleton 成立与否的判据）：

1. `migrate deploy` 在空库上成功建表（9 个迁移）；这同时实测 runner 内 Prisma 适配器/引擎链完整。
2. **每遍**运行顺序为：
   - 第一行横幅逐字：`[attendance-alert] MODE=DRY-RUN reason=smtp-not-configured recipients=0`
   - `{"evt":"scan-start"}`
   - 决策行：`{"evt":"alert-decision","level":"never","daysSince":null,"decision":"baseline"}`（空库无成功导入记录；字段顺序以实际 JSON 为准，值必须如此）
   - `{"evt":"scan-done","exitCode":0}`，随后 `exit=0`。
3. **没有** `alert-email-dry-run` 行——空数据卷首扫是冷启动基线（`baseline` 决策不发信），且干跑永不写状态文件，所以第二遍仍是 baseline。这是正确行为（勘误 S：早期 runbook 草稿误以为「从未导入」也必有发信行）。
4. `data/` 只有 `test.db` 及其 SQLite 伴随文件（`-journal`/`-wal`/`-shm`，按实际），**没有 `alert-state.json`**。
5. 两遍输出逐行一致（无日期戳推进；脚本内时间仅用于判断，横幅不含时间）。能走到 DB 查询即证明 tsx 已成功解析 alerts 链路全部 `@/` import 与 Prisma client。

任何与上述不符：保留日志，对照 §6。

### 可选 Step 4（默认跳过；需用户另行批准）

想看真实 `alert-email-dry-run` 日志行（证明 stale 分支模板组装在容器内通），需在第二个临时卷里迁移后手工构造**一条**古老的成功导入记录（只在临时卷内、随卷删除）。该分支已被 15 个单测钉死，跳过不影响 walking skeleton 成立。**未获明确批准前不要做任何数据构造。**

---

## 6. 失败预案（症状驱动；一次只动一处；每次改完重建复测）

> 纪律：Dockerfile/源码的每一处修改都要记录「症状原文 → 改了哪一行 → 重建后结果」。**不要预先把候选包全 COPY 进去**（不预堆是本 Dockerfile 的既定原则）。修复产生的 diff 不得在目标机 commit；把日志和 diff 回传，开发机会谈提交（拟用 `fix: add missing runtime copy for alert script in Dockerfile` 之类信息，需用户批准）。

### 6.1 头号预判：tsx 启动即崩，找不到 esbuild

- **症状**：RUN 1/2 连横幅都没打印，node 在 import 期退出 1，错误形如 `Cannot find package 'esbuild'` / `ERR_MODULE_NOT_FOUND … esbuild`。
- **事实**：tsx 4.23.8 硬依赖 `esbuild ~0.28.0`（本机 0.28.1）；runner 阶段只 COPY 了 tsx 本体。esbuild 在 Linux 上还需要平台二进制包 `@esbuild/linux-x64`（npm ci 作为 optional dependency 装在 builder 里）。
- **修法（按报错驱动，预期连续两步）**：在 Dockerfile runner 阶段 tsx/nodemailer COPY 附近（约 :207 后）逐条加，每加一条重建复测、记录报错：
  1. 首报点名 `esbuild`，加：
     ```dockerfile
     COPY --from=builder --chown=node:node /app/node_modules/esbuild ./node_modules/esbuild
     ```
  2. 重建后预期再报点名 `@esbuild/linux-x64`（esbuild 的 JS 包按平台 require 这个二进制包），再加：
     ```dockerfile
     COPY --from=builder --chown=node:node /app/node_modules/@esbuild/linux-x64 ./node_modules/@esbuild/linux-x64
     ```
  重建命令同 §3。两条 COPY 加完后重跑 §4 与 §5。若 builder 内 `node_modules/@esbuild/` 下还有别的平台包（`ls node_modules/@esbuild/` 核对，正常 Linux 安装只有 linux-x64），以实际报错点名为准，不要整目录预堆。

### 6.2 Prisma 相关 ERR_MODULE_NOT_FOUND 或原生件加载失败

- **症状**：`Cannot find package '@prisma/adapter-better-sqlite3'`（或 `@prisma/client`）；或运行时 `invalid ELF header` / `Cannot find module …better_sqlite3.node` / `was compiled against a different Node.js version`。
- **事实**：Next standalone trace 大概率已含请求路径用的 @prisma/client 与 adapter（页面运行时也走它们），但 tsx 脚本链在 trace 之外，需实测确认；adapter 实际加载的是**嵌套 v12**的 .node（不是顶层 better-sqlite3 v13）。
- **修法**：按报错点名的包逐个从 builder 补 COPY（风格同既有行），一次一个：
  ```dockerfile
  COPY --from=builder --chown=node:node /app/node_modules/@prisma/adapter-better-sqlite3 ./node_modules/@prisma/adapter-better-sqlite3
  ```
  若嵌套 v12 的 .node 缺失（Step 2 第 5 项为空），把嵌套整包补入：
  ```dockerfile
  COPY --from=builder --chown=node:node /app/node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3 \
    ./node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3
  ```
  禁止复制 Windows 开发机 node_modules 里的任何 .node（PE 二进制，进 Linux 必报 invalid ELF）。

### 6.3 tsx 不解析 `@/` 路径别名

- **症状**：错误形如 `Cannot find package '@/lib/…'` 或 tsconfig paths 不生效（预期上 tsx 自动读 /app/tsconfig.json，不应发生；以实测为准）。
- **修法（仅机械改 import，不动 tsconfig、不装 tsconfig-paths 类插件）**：只改**容器内 tsx 执行链**上的文件——`src/lib/alerts/alert-service.ts` 等被 `scripts/check-attendance-alert.ts` 导入的库文件，把 `@/lib/…` 改为相对路径，以 `scripts/fetch-attendance.ts` 的现网写法为准。**不要改** Next 页面/组件（`src/app/**`，由 Next 编译，`@/` 保留）。改完在开发机（或目标机若有 Node 工具链）跑 `npm run typecheck && npm test`，必须仍为 **42 文件 / 764 例全过**，再重建复测。

### 6.4 migrate 失败

- 环境变量确认：容器内只有 `-e DATABASE_URL=file:/app/data/test.db`，没有其他 env 文件干扰（prisma.config.ts 顶部 `import "dotenv/config"`，容器内无 .env 文件时只剩 -e 注入）。
- 权限：`data/` 不可写（named volume 首次挂载应继承镜像内 /app/data 的 uid 1000 属主；若目标机 Docker 版本行为不同）→ `docker run --rm -v manhour-alert-test:/app/data --entrypoint sh manhour-mgmt:alert-walkthrough -c 'id; ls -ld /app/data; touch /app/data/.w && echo WRITABLE'` 诊断。
- 迁移历史问题：空卷上 migrate deploy 应干净应用全部迁移；若报「数据库非空/漂移」，说明卷被污染——删卷重建（`docker volume rm manhour-alert-test` 后重新 create）。

### 6.5 结果与预期不符但没报错

- 横幅不是 DRY-RUN/smtp-not-configured：检查是否误注入了 SMTP/ALERT 环境变量；干跑三态判定见 `src/lib/alerts/email-config.ts`。
- 首扫 decision 不是 baseline：确认是空库（migrate 后未 seed、未插数据）；决策矩阵见 `src/lib/alerts/alert-decision.ts`。
- 出现 alert-state.json：干跑全决策域不落盘是硬契约（`src/lib/alerts/alert-service.ts` dry-run 分支）；出现即缺陷，保留全部日志回报，不要手工删文件掩盖。

---

## 7. 清理

验收完成（无论成败，只要不再复测）：

```sh
docker volume rm manhour-alert-test
docker volume ls | grep manhour-alert-test || echo "volume removed"
# 镜像是否保留：保留有助于出报告时复核；确认不再需要后：
# docker rmi manhour-mgmt:alert-walkthrough
```

删除/归还 §1b 的源码包与解包树（含目标机上 tee 出的日志先回传再清理）。`manhour-alert-test` 卷内含空库（无业务数据），仍按一次性原则删除。

---

## 8. 回传证据清单（用于开发机出具 Task 17 Step 7 验收报告）

1. `docker version` / `docker compose version` 输出 + 目标机架构（`uname -m`、Docker 版本）。
2. `step1-build.log`：完整构建日志；明确 better-sqlite3 v12 走的是 prebuild-install 还是 node-gyp（搜日志关键字）；总耗时。
3. `step2-image-contents.log`：五项核对实物输出 + nodemailer 版本号。
4. `step3-dryrun.log`：migrate 输出 + 两遍横幅/JSON/exit + data 目录清单。
5. 是否动用 §6 预案：逐条「症状原文 → 修改（Dockerfile 行或 import 行的完整 diff）→ 重建/复测结果」；最终 Dockerfile/源码 diff 单独成文。
6. 清理证据：`docker volume ls` 无 manhour-alert-test。
7. 执行者、日期、目标机环境备注（网络代理/镜像源若有配置，注明）。

判定标准：§5 五条预期全部满足、临时卷已删、未 seed、真实库零接触 → 第一期 walking skeleton 本地/镜像侧全部打通。此后上线动作（部署新镜像、装宿主 cron、配真 SMTP）属 R1 生产发布流程，需逐项另行授权，不在本规程内。

---

## 附：退出码与事件速查（脚本真实契约）

| 退出码 | 含义 |
|---|---|
| 0 | 扫描完成：健康 skip、冷启动 baseline、干跑，或 live 发送成功 |
| 1 | config-error；或 live 发送失败（alert-email-failed） |
| 2 | 数据库读失败；状态文件写失败；未预期 throw（scan-fatal 兜底） |

事件流：`scan-start` →（可能 `db-read-failed`/`config-error`）→ `alert-decision{level,daysSince,decision}` → 可能 `alert-email-dry-run`/`alert-email-sent`/`alert-email-failed`/`state-write-failed`/`state-corrupt` → `scan-done{exitCode}`。
`level` 三态：`ok` / `stale`（超 3 个**自然日**无成功导入）/ `never`（从未导入）；空库首扫 `never` + `baseline` 宽限。
