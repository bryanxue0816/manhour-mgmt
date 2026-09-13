# Task 17 可携带执行手册：Docker 镜像构建与容器内干跑实测

> 功能：考勤数据停摆管理员邮件告警（第一期 walking skeleton，最后一公里）
> 对应代码：`projects/manhour-mgmt/app` 内层 git 仓 **master 分支 2026-09-13 收尾批次**（含 Erratum T/U；下文不再钉 SHA——SHA 无法稳定指向含修复的最终树，以描述性特征 + 执行者自校验为准）
> 对应计划：`docs/superpowers/plans/2026-09-12-attendance-staleness-email-alert.md` Task 17
> 本手册性质：**一次性验收规程**（不是 DEPLOY.md 的一部分，不随镜像发布）。开发机没有 Docker（无 Docker Desktop、无 WSL2），经用户裁决转移到具备 Docker 的机器执行。
> 执行者可以是工程师或另一个 AI agent；零上下文照做即可。每一步**保存完整原始输出**（建议 `2>&1 | tee stepN.log`），最后按 §9 清单回传。
>
> **收尾批次锚点（拿到代码树后先自校验，三条全中才是对的树）**：
> ```sh
> test -f docs/ops/task17-docker-verification.md && echo HANDBOOK-OK
> npm test 2>&1 | grep -E 'Tests +777 passed'   # 必须有输出（42 个测试文件 / 777 例）
> grep -c -E 'registry\.npmjs\.org|github\.com|cdn\.sheetjs\.com|binaries\.prisma\.sh|deb\.debian\.org' docs/ops/task17-docker-verification.md  # 必须 >= 5（§0 五处出网端点）
> ```
>
> **2026-09-13 勘误 U 升级**：终审交付维用仓外沙箱实证了三组 **100% 首跑阻断**（prisma CLI 缺 38 包闭包、tsx 缺 esbuild、standalone trace 裁掉 adapter 的 CJS 件）。本手册随之从「失败预案」升级为「已实证的确定性首步」：迁移改走 builder target 一次性容器（§5.2/§6.1），§6 三组修法均可照抄，并新增 §7 的 16 项部署窗口预检表。**构建产物等价性（已在收尾工作树亲自核实）**：`git diff b3218e4 -- Dockerfile docker-compose.prod.yml package.json package-lock.json deploy/cron .dockerignore` 输出为空（empty diff）——早期钉板 b3218e4 以来构建相关七路径零变化；本批次只改文档、alert-state 校验及其测试（tests/ 不入镜像），故 §3-§6 针对的镜像产物与钉板完全等价。

---

## 0. 目标机前置条件

| 项 | 要求 | 不满足时 |
|---|---|---|
| 架构 | Linux x86_64（amd64）首选；arm64 可试但 better-sqlite3 v12 的 prebuild 覆盖未验证 | 用 amd64 机 |
| Docker | `docker version` 能同时打印 Client 与 **Server** 版本（守护进程在跑）；Linux 需执行用户在 `docker` 组或用 sudo（下文命令统一用 `docker`，sudo 自行前缀） | 安装/启动 Docker Engine |
| Compose | `docker compose version` 输出版本（v2 插件）；本规程实际**不用** compose，仅作环境完整性确认 | — |
| 出网 | 构建期**五处**外联：① **npm registry**（registry.npmjs.org 或已配置的镜像源）——npm 包本体；② **github.com**（含 objects.githubusercontent.com；嵌套 better-sqlite3 v12 的 prebuild-install 从 GitHub release 拉 linux 二进制，失败退 node-gyp）；③ **cdn.sheetjs.com**（package.json 的 xlsx 指向该 CDN 的 tgz，npm ci 必须能拉到）；④ **binaries.prisma.sh**——`@prisma/engines` 的 postinstall 经 fetch-engine 下载 schema-engine 平台二进制（Linux 件在 deps 阶段落盘）；⑤ **deb.debian.org**——bookworm-slim 用 apt 装 python3/make/g++/ca-certificates（Dockerfile:88-90，node-gyp 兜底依赖） | 配代理/镜像源：①-④ 不通直接卡 `npm ci`；⑤ 不通卡 apt，node-gyp 兜底也会失败 |
| 磁盘 | 预留 ≥ 5 GB（镜像 + builder target + build cache + 体积排查） | 清理空间 |
| 时间 | 首建预算 10–40 分钟（取决于网络；prebuild 与 schema-engine 下载是最大变量） | — |

红线（全程）：

- **永不运行 seed**（`prisma db seed` 一次都不要跑）。
- 不碰任何真实数据库文件（`*.db`）；所有数据只在一次性 named volume 里产生并随卷删除。
- 不 `docker push`、不覆盖 `:latest`（固定用独立 tag `manhour-mgmt:alert-walkthrough`）、不起生产 compose、不连生产机。
- 不给容器注入任何 `SMTP_*`/`ALERT_*` 变量——**必须保持默认干跑**（`SMTP_HOST` 空 → `MODE=DRY-RUN reason=smtp-not-configured`）。
- 不对 Dockerfile/源码做「顺手优化」；允许的修复仅限 §6.1-6.3 已实证三组（照抄修法）与新症状驱动的最小 COPY，且**改动不得自行 commit**（回传后由开发机双评+请批提交）。

---

## 1. 把构建上下文带到目标机

镜像从未被构建过；目标机需要一份 app 源码工作树（不需要 node_modules/.next，镜像内全新安装构建）。二选一。

### 1a. 从 git 取（目标机能访问该仓 remote 时）

> 注意：app 是**内层独立 git 仓**（`projects/manhour-mgmt/app/.git`）。push 需开发机用户显式授权，**不要自行推送**。本规程不钉 SHA：取 master 分支 2026-09-13 收尾批次（含 Erratum T/U）的最新树即可，**不要 checkout 不含本手册的旧提交**——拿到后用头部的三条锚点自校验。

```sh
git clone <app 内层仓 remote> app
cd app
git checkout master
git pull --ff-only         # 确保是含收尾批次的最新 master
# 锚点自校验（见本文件头部，三条必须全中）：
test -f docs/ops/task17-docker-verification.md && echo HANDBOOK-OK
npm test 2>&1 | grep -E 'Tests +777 passed'   # 必须有输出（42 文件 / 777 例）
grep -c -E 'registry\.npmjs\.org|github\.com|cdn\.sheetjs\.com|binaries\.prisma\.sh|deb\.debian\.org' docs/ops/task17-docker-verification.md  # >= 5
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
  -czf manhour-app-alert-closeout-src.tar.gz app
sha256sum manhour-app-alert-closeout-src.tar.gz   # 记录哈希，传输后在目标机复核
```

> 包名用描述性的 `alert-closeout`（master 分支 2026-09-13 收尾批次，含 Erratum T/U），不钉 SHA：从含修复的最终工作树打包即可。

打包后自查（关键！打印结果必须为空——确认没有数据库和密钥混入）：

```sh
tar -tzf manhour-app-alert-closeout-src.tar.gz | grep -E '\.db($|-)|/\.env$|\.env\.production$|node_modules/|\.next/' || echo "CLEAN: no db/env/node_modules/.next in archive"
```

传到目标机后：

```sh
echo "<上面记录的 sha256>  manhour-app-alert-closeout-src.tar.gz" | sha256sum -c -
tar -xzf manhour-app-alert-closeout-src.tar.gz
cd app
ls Dockerfile package.json package-lock.json prisma.config.ts src scripts | head
# 无 .git 无妨；树的对错不靠 SHA，靠头部的三条锚点自校验（HANDBOOK-OK / 777 例 / 五端点）
```

> 本手册版本化于 `app/docs/ops/task17-docker-verification.md`（`.dockerignore` 排除 docs/，不进镜像）；带到目标机时单独复制该文件即可。

---

## 2. 环境验证（计划 Step 0）

```sh
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}'
docker compose version
uname -m   # 必须是 x86_64；arm64 见 §0 与预检表 #16
```

预期：两条 docker 命令都正常打印版本号，`uname -m` 输出 `x86_64`。`docker version` 若只有 Client、报 `cannot connect to the Docker daemon` → 先解决守护进程，**不要绕过**（不要换 podman/远程 socket 凑合）。

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
4. `@prisma/engines` 的 postinstall 从 **binaries.prisma.sh** 拉 schema-engine 失败（`fetch-engine`/`ENOTFOUND` 类报错）→ 出网问题，见 §0④；构建日志里 postinstall 必须 exit 0。
5. `apt-get update/install` 失败 → deb.debian.org 不可达，见 §0⑤。

成功后记录：

```sh
docker images manhour-mgmt:alert-walkthrough
docker history manhour-mgmt:alert-walkthrough --no-trunc | head -30
```

§5.2 还要构建一个 **builder target** 镜像（迁移专用，不出货、不增加 runner 体积），命令在 §5.1。

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
5. `@prisma/` 下能看到 `adapter-better-sqlite3`；嵌套 better-sqlite3 原生件在位（v12 走 prebuild-install，预期路径 `…/better-sqlite3/build/Release/better_sqlite3.node`；若该路径为空，再查 `find node_modules/@prisma -name '*.node'` 并如实记录实际位置）。**首建镜像里该包是 standalone trace 件：`dist/` 下只有 `index.mjs`（CJS 件 `dist/index.js` 被 trace 裁掉，已在开发机 `.next/standalone` 实物核实，见 §6.3）——这是预期的首建形态，不是拷贝损坏。** 按 §6.2/§6.3 补 COPY 重建后必须重跑本核对：届时要同时见到 `dist/index.js` 与嵌套路径下的 Linux `.node`（用 §9 的魔数目检确认是 ELF：前 4 字节 `7f 45 4c 46`，而非 PE 的 `4d 5a`）。
6. tsconfig 打印内容含 `"paths"` 与 `"@/*": ["./src/*"]`（tsx 解析 `@/` 的依据）。

任一条与预期不符：**先不要改东西**，继续 §5 跑一次——运行时实际报错比静态 ls 更能精确定位缺什么，然后按 §6 处置。

---

## 5. Step 3：临时卷 + 空库迁移 + 连跑两遍干跑（核心验收）

一次性 named volume，空库只迁移（**不 seed**），连跑两遍告警脚本。

> **勘误 U 对流程的两处改变**：① 迁移**不再在 runner 容器内执行**——现 Dockerfile 的 runner 缺 38 包 Prisma CLI 闭包，`prisma migrate deploy` 启动即崩（§6.1）；迁移改走 §5.1 构建的 builder target 一次性容器（§5.2）。② 告警脚本首跑**必中** §6.2（esbuild），加 COPY 重建后再跑必中 §6.3（adapter 的 CJS 件）。这两组已由终审交付维在仓外沙箱实证为 100% 阻断，不是环境偶发：先跑、保留每一次报错原文（§9 要求），再照 §6 修，4 条 COPY 加完重建后逐行核对本节预期。

```sh
docker volume create manhour-alert-test
```

### 5.1 构建 builder target（迁移专用镜像）

builder 阶段保留完整 devDependencies，Prisma CLI 闭包完整；该镜像不出货，只用于这一次迁移。

```sh
docker build --target builder -t manhour-mgmt:builder . 2>&1 | tee step1b-builder.log
```

### 5.2 在 builder 一次性容器里迁移（替代旧的「runner 内 migrate deploy」命令）

```sh
docker run --rm -v manhour-alert-test:/app/data \
  -e DATABASE_URL=file:/app/data/test.db \
  --entrypoint sh manhour-mgmt:builder -c '
    set -e
    node node_modules/prisma/build/index.js migrate deploy
    chown -R 1000:1000 /app/data
  ' 2>&1 | tee step3-migrate.log
```

- 预期：空库上干净应用 9 个迁移，最后一行 `All migrations have been successfully applied.`。
- **为什么末尾要 chown**：builder 阶段没有 `USER` 指令、容器以 root 运行，而 runner 在 Dockerfile 末尾切到 `USER node`（uid 1000）。root 迁移在卷里建出的文件属主是 root，不 chown 回 1000，下一步 runner 里的告警脚本会撞数据库写权限（SQLITE_CANTOPEN）。这同时模拟了部署窗口的正确顺序（宿主目录先 chown 1000:1000，迁移后再 chown 一次兜底）。
- 失败：先看 §6.1（builder 内闭包完整，预期不命中阻断组 1）；权限/卷漂移排查见 §6.6。

**部署窗口生产形态**（bind mount + env-file；替代/修正 DEPLOY 第 8-1 步「在 runner 内 migrate」的命令。DEPLOY 正文与「发布新版本」的对应修法留待 R1 随部署形态定稿，本手册只给验证用命令；首次空目录部署同样依赖末尾 chown）：

```sh
docker run --rm -v "$PWD/data:/app/data" --env-file .env.production \
  --entrypoint sh manhour-mgmt:builder -c '
    set -e
    node node_modules/prisma/build/index.js migrate deploy
    chown -R 1000:1000 /app/data
  '
```

### 5.3 两遍干跑（首跑预期失败 → §6.2/§6.3 → 重建 → 重跑）

```sh
docker run --rm -e DATABASE_URL=file:/app/data/test.db \
  -v manhour-alert-test:/app/data \
  --entrypoint sh manhour-mgmt:alert-walkthrough -c '
    set -e
    echo "===== RUN 1 ====="
    node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
    echo "===== RUN 2 ====="
    node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
    echo "===== DATA DIR ====="
    ls -ln data/
  ' 2>&1 | tee step3-dryrun.log
```

修法纪律：一次只动一组（先 §6.2 两条 COPY，重建 runner 镜像 `docker build -t manhour-mgmt:alert-walkthrough .`，重跑；再 §6.3 两条 COPY，重建，重跑）。builder target 不含 runner 阶段，改 runner COPY 不影响它，**不用重建 `manhour-mgmt:builder`。

> **修复前首跑的输出形态（预期，勿当失败扩大化）**：shell 以 `set -e` 启动，tsx 撞 §6.2/§6.3 阻断时 node 非零退出会**直接终止整个容器 shell**——所以 `echo "exit=$?"` 不会打印、RUN 2 不会执行、`===== DATA DIR =====` 也可能没有。修复前日志只出现 `===== RUN 1 =====` + node 报错栈是预期形态；下面「每遍横幅/JSON/exit=0、两遍逐行一致」是四条 COPY 补齐、修复完成后的完整形态。

最终预期（逐行对照；这是 walking skeleton 成立与否的判据）：

1. §5.2 的 `migrate deploy` 在空库上成功建表（9 个迁移）；`ls -ln data/` 中 `test.db` 属主列直接显示 `1000 1000`（chown 交接的证据；`ls -l` 只显示 `node node`，故用 `-n`）。
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

## 6. 三组已实证 100% 首跑阻断 + 失败预案

> 证据来源：2026-09-13 终审交付维在**仓外真实拷贝沙箱**（非 junction）里按 runner COPY 清单组装最小树，用真实缺包循环 + 真实 SQLite 查询实测，终点为告警链探针完整加载并查通空库、`All migrations have been successfully applied.`（9 迁移）。
>
> 纪律：Dockerfile/源码的每一处修改都要记录「症状原文 → 改了哪一行 → 重建后结果」。只允许动 Dockerfile **runner 阶段的 COPY**（照抄 §6.1-6.3）；不改 TS 源码、不升级/降级依赖、不给 package.json 加 `"type": "module"`、不预堆清单外的包。修复产生的 diff **不得在目标机 commit**；把日志和 diff 回传，开发机双评+请批后提交。一次只动一组，改完重建复测。

### 6.1 阻断组 1：`prisma migrate deploy` 无法启动（缺 38 包 CLI 闭包）

- **症状关键字**：`Cannot find module 'effect'`（随后连锁 `@prisma/studio-core/data/bff`、`@prisma/dev/internal/state`、`pathe`、`graphmatch`、jiti/c12 链等）；或 CLI 启动即 exit 1，`migrate deploy` 一行都没跑。
- **根因（本仓实证）**：Prisma 7.9.1 的 CLI bundle 在模块加载期顶层 eager require `@prisma/studio-core/data/bff` 与 `@prisma/dev/internal/state`（`node_modules/prisma/build/cli.js:5534-5535`，已 grep 实证）；`@prisma/config` 加载 TS 形态的 `prisma.config.ts` 还需 effect/c12/jiti 闭包。runner 只 COPY 了 prisma、@prisma/config、@prisma/engines、dotenv（Dockerfile:198-201），闭包合计缺 **38 个包**（顶层 27 + @prisma 8 + @electric-sql 3，完整清单见附录 A）。
- **修法 A（推荐，验证与部署窗口都用它，runner 零增肥）**：不碰 runner，迁移走 §5.1/§5.2 的 builder target 一次性容器。沙箱实证终点：9 个迁移全部应用成功。
- **修法 B（备查，会增大 runner 镜像）**：在 Dockerfile runner 阶段补 38 条整包 COPY（清单与 COPY 模板见附录 A），DEPLOY 第 8-1 步命令即可不动。**注意方案 B 下 `prisma db seed` 还另需 §6.2 的 esbuild 两件**（tsx 转译 seed.ts；seed 其余闭包全在 src/lib + prisma 链内）；Task 17 红线规定验证期间永不 seed，seed 只在正式首署第 8-2 步按授权执行。
- 不要在 runner 容器里反复重试 migrate——旧版手册「在 runner 内 migrate deploy」的命令已废止。

### 6.2 阻断组 2：tsx 启动即崩，找不到 esbuild

- **症状关键字**：RUN 1/2 连横幅都没打印、exit 1：`Cannot find module 'esbuild'` / `ERR_MODULE_NOT_FOUND … esbuild`；只补 esbuild JS 包后再报：`The package "@esbuild/linux-x64" could not be found, and is needed by esbuild.`（沙箱两步均实测复现）。
- **根因（本仓实证）**：tsx 4.23.8 的 `node_modules/tsx/dist/loader.cjs:1` 顶层 `require("esbuild")`；runner 只 COPY 了 tsx 本体（Dockerfile:202）。esbuild 0.28.1 用 optionalDependencies 声明 **26 个平台包**，已全部锁入 package-lock（os/cpu 标记齐全），Linux x64 上 `npm ci` 必装 `@esbuild/linux-x64` 进 builder，无需 `--no-optional` 方面的担心。
- **修法（两条整包 COPY，放在 runner 阶段 tsx/nodemailer COPY 附近，约 :207 后）**：
  ```dockerfile
  COPY --from=builder --chown=node:node /app/node_modules/esbuild ./node_modules/esbuild
  COPY --from=builder --chown=node:node /app/node_modules/@esbuild/linux-x64 ./node_modules/@esbuild/linux-x64
  ```
  重建 runner（§5.3 的命令）复测。若 builder 内 `ls node_modules/@esbuild/` 出现 linux-x64 以外的包（正常 Linux 安装只有它），以实际报错点名为准，不要整目录预堆。

### 6.3 阻断组 3：adapter 的 CJS 件被 standalone trace 裁掉

- **症状关键字**：`Cannot find module '…/@prisma/adapter-better-sqlite3/dist/index.js'`；补后可能再报 `…/@prisma/driver-adapter-utils/dist/index.js'`。
- **根因（本仓实证）**：`.next/standalone/node_modules/@prisma/adapter-better-sqlite3/dist/` 与 `@prisma/driver-adapter-utils/dist/` 实物**只有 `index.mjs`**（ESM 条件件），CJS 条件件 `dist/index.js` 被 Next standalone trace 裁掉。tsx 按最近 package.json 的 `type` 决定 .ts 模块格式：仓库根 `package.json` 与 `.next/standalone/package.json` **都没有 `type` 字段**（已核实），镜像内 `/app/package.json` 同样没有，所以脚本按 CJS 转译，require 条件精确指向被裁的 `.js`。
- **修法（两条整包 COPY 覆盖 trace；同名文件合并新增，`.mjs` 保留不动）**：
  ```dockerfile
  COPY --from=builder --chown=node:node /app/node_modules/@prisma/adapter-better-sqlite3 ./node_modules/@prisma/adapter-better-sqlite3
  COPY --from=builder --chown=node:node /app/node_modules/@prisma/driver-adapter-utils ./node_modules/@prisma/driver-adapter-utils
  ```
  adapter 整包同时保证嵌套 `better-sqlite3@12.11.1` 的目录与 Linux `.node` 随包在场（前提是 deps 阶段 prebuild/node-gyp 成功，见 §6.4）。
- **明确禁止**：不要用给 package.json 加 `"type": "module"` 的方式修——standalone 的 `server.js` 是 CJS，改 type 会波及正式服务启动。

### 6.4 嵌套 better-sqlite3 v12 原生件（构建期：github.com / node-gyp / ELF 目检）

- **症状关键字**：构建期 `prebuild-install` 失败、`ETIMEDOUT github.com`，或落入 `node-gyp rebuild`（python3/make/g++ 调用）；运行期 `invalid ELF header` / `Cannot find module …better_sqlite3.node` / `was compiled against a different Node.js version`。
- **事实**：adapter 实际加载的是嵌套 **v12.11.1**（`node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3`），不是顶层 v13。v12 无自带 prebuild，安装脚本 `prebuild-install || node-gyp rebuild --release`：Linux 件由 prebuild-install 从 GitHub release 按 ABI（Node 24 = ABI 137，资产是否命中未验证）下载；下载失败时 deps 层已装的 python3/make/g++ 兜底（Dockerfile:88-90，出网需 deb.debian.org，见 §0⑤）。
- **修法/核对**：预先放通 github.com（含 objects 域名）；不通则确认 node-gyp 兜底成功。构建后必须亲眼见到嵌套路径下的 linux `.node`（Step 2 第 5 项 + §9 的魔数目检：`head -c 4 <.node> | od -An -tx1` 应为 `7f 45 4c 46`，`4d 5a` 即 MZ/PE），不得是 Windows PE。§6.3 的 adapter 整包 COPY 已把嵌套目录带入 runner；若整包内仍无 `.node`，根因在构建期获取失败（本节），不是 COPY 遗漏。
- 禁止复制 Windows 开发机 node_modules 里的任何 .node（PE 二进制，进 Linux 必报 invalid ELF；`.dockerignore` 已排除整个 node_modules，不要绕过）。

### 6.5 tsx 不解析 `@/` 路径别名（预期不需要的退路）

- **症状**：错误形如 `Cannot find package '@/lib/…'` 或 tsconfig paths 不生效。
- **实证结论**：交付沙箱在补齐 §6.2/§6.3 四条 COPY 后，tsx 下全链 `@/` 解析成功并跑通真实 SQLite 查询（`module:esnext`、`moduleResolution:bundler`）。**本节预期不会用到**；只有实测真报此错时才执行下面的机械退路。
- **退路（仅机械改 import，不动 tsconfig、不装 tsconfig-paths 类插件）**：只改**容器内 tsx 执行链**上的文件——`src/lib/alerts/alert-service.ts` 等被 `scripts/check-attendance-alert.ts` 导入的库文件，把 `@/lib/…` 改为相对路径，以 `scripts/fetch-attendance.ts` 的现网写法为准。**不要改** Next 页面/组件（`src/app/**`，由 Next 编译，`@/` 保留）。改完在开发机（或目标机若有 Node 工具链）跑 `npm run typecheck && npm test`，必须仍为 **42 文件 / 777 例全过**（含勘误 T 的 13 个新增校验用例），再重建复测。

### 6.6 migrate 失败：环境变量 / 权限 / 卷漂移

- 环境变量：walkthrough 的 builder 容器只有 `-e DATABASE_URL=file:/app/data/test.db`，没有其他 env 文件干扰（prisma.config.ts 顶部 `import "dotenv/config"`，镜像内无 `.env` 时只剩 -e 注入；构建上下文里的 `.env.production.example` 不被 dotenv 加载）。
- 权限：named volume 经 §5.2 末尾 chown 后应整体 uid 1000。直接以 uid 1000 验证可写性：
  ```sh
  docker run --rm --user 1000:1000 -v manhour-alert-test:/app/data \
    --entrypoint sh manhour-mgmt:builder -c 'id; ls -ldn /app/data; touch /app/data/.w && echo WRITABLE; rm -f /app/data/.w'
  ```
  必须打印 `WRITABLE`。生产 bind mount 的宿主属主在 DEPLOY 第 3 步处理（`mkdir -p data backups && chown -R 1000:1000`）。
- 迁移历史问题：空卷上 migrate deploy 应干净应用全部迁移；若报「数据库非空/漂移」，说明卷被污染——删卷重建（`docker volume rm manhour-alert-test` 后回到 §5 开头重新 create、迁移）。

### 6.7 结果与预期不符但没报错

- 横幅不是 DRY-RUN/smtp-not-configured：检查是否误注入了 SMTP/ALERT 环境变量；干跑三态判定见 `src/lib/alerts/email-config.ts`。
- 首扫 decision 不是 baseline：确认是空库（migrate 后未 seed、未插数据）；决策矩阵见 `src/lib/alerts/alert-decision.ts`。
- 出现 alert-state.json：干跑全决策域不落盘是硬契约（`src/lib/alerts/alert-service.ts` dry-run 分支）；出现即缺陷，保留全部日志回报，不要手工删文件掩盖。

---

## 7. Linux 首建 / 首跑预检表（部署窗口逐条执行）

> 来自终审交付维 A5（2026-09-13）。从上到下，每命中一个症状按「现场动作」处理，一次只动一处，改完重建复测。标注 **R1** 的行只能在生产宿主机核实。

| # | 概率 | 阶段 | 症状关键字（日志原文特征） | 根因 | 现场动作 |
|---|---|---|---|---|---|
| 1 | **100%** | 首跑·迁移 | `Cannot find module 'effect'`（连锁 `@prisma/studio-core/data/bff`、`@prisma/dev/internal/state`、`pathe`、`graphmatch`、jiti/c12）；或 CLI 启动即 exit 1 | prisma 7.9.1 CLI bundle eager require（cli.js:5534-5535）+ @prisma/config 闭包；runner 缺 38 包 | 方案 A：builder target 一次性容器（§5.2/§6.1，推荐，零镜像改动）；方案 B：runner 补 38 条 COPY（附录 A） |
| 2 | **100%** | 首跑·告警脚本 | 连横幅都没有，exit 1：`Cannot find module 'esbuild'`；补后变 `The package "@esbuild/linux-x64" could not be found` | tsx 4.23.8 顶层 require esbuild；runner 只 COPY tsx | runner 加两条 COPY（§6.2）；lock 已锁 26 平台包，linux npm ci 必装 |
| 3 | **100%** | 首跑·告警脚本 | `Cannot find module '…/adapter-better-sqlite3/dist/index.js'`；补后可能再报 `…/driver-adapter-utils/dist/index.js` | trace 只留 ESM `.mjs`；tsx CJS require 被裁的 `.js` | 两条整包 COPY（§6.3）；**禁止**加 package.json `type:module`（波及 server.js） |
| 4 | 高 | 构建期 deps | `prebuild-install` 失败、`ETIMEDOUT github.com`、或落入 `node-gyp rebuild` | 嵌套 better-sqlite3@12.11.1 无自带 prebuild，从 GitHub release 按 ABI 下载；Node24/ABI137 资产命中未验证 | 放通 github.com（含 objects 域名）；确认 node-gyp 兜底成功（toolchain 已在 deps 层）；构建后亲见嵌套路径 linux `.node`（魔数 `7f 45 4c 46`，§9） |
| 5 | 高（视出网策略） | 构建期 deps | `@prisma/engines` postinstall 报错 / `fetch-engine` 下载失败 / schema-engine 相关 ENOTFOUND | schema-engine linux 二进制构建期从 `binaries.prisma.sh` 拉 | 放通该域；构建日志确认 postinstall exit 0；镜像内 `find node_modules/@prisma/engines -name 'schema-engine-linux-*'` 有结果（§9） |
| 6 | 中 | 构建期 deps | `apt-get update`/`install` 失败，`deb.debian.org` 不可达 | bookworm-slim 装 toolchain/ca-certificates 需要 apt 源 | 放通 deb.debian.org 或构建机配 apt 镜像；离线环境需改 Dockerfile apt 源（另行评审，不临场改） |
| 7 | 中 | 构建期 deps | `npm ci` 拉包失败：registry 报错/超时（绝大多数包来自 registry.npmjs.org 或已配镜像源），或在 xlsx 处失败（tgz 拉取失败） | npm 包本体走 registry（§0 端点①）；package.json 的 xlsx 另指向 cdn.sheetjs.com tarball（§0 端点③） | 放通 registry.npmjs.org（或配镜像源/预置 npm 缓存）；xlsx 另需放通 cdn.sheetjs.com |
| 8 | 中 | 首跑 | 页面 HTTP 200 但显示「演示数据」；告警脚本 exit 2 且 JSON 含 `db-read-failed`/`SQLITE_CANTOPEN` | bind mount 的 `./data`、`./backups` 宿主属主非 uid 1000（容器以 node 用户跑） | **R1**：宿主 `mkdir -p data backups && chown -R 1000:1000 data backups` 后再 `up -d`；用「无演示数据标记」检查验收（DEPLOY 第 9 步），不认 200 |
| 9 | 中 | 首跑 | 日志 P2021、页面演示数据；或告警 state 写到意外位置 | DATABASE_URL 用了相对路径（server.js chdir）；必须绝对路径 | 用 `.env.production` 样板原值 `file:/app/data/dev.db`；alert-state.json 解析在 DB 同目录（/app/data），已核实代码 |
| 10 | 中 | cron 安装 | wrapper 手动执行报 `no configuration file provided`/`cd: … No such file or directory`；容器在跑仍报 `service "app" is not running` | committed wrapper 是 `cd /opt/manhour-mgmt` 且无 `-f`（deploy/cron/check-attendance-alert.sh:10-13）；DEPLOY 标准目录是 `/opt/manhour-mgmt/app`，备份 cron 行也用 app/ + `-f`（DEPLOY:461） | **R1**：先读现网 fetch wrapper（`/opt/manhour-mgmt/scripts/fetch-attendance.sh`，若存在；路径、cd、-f、服务名），照它定稿告警 wrapper 的 cd；**代码在 app/ 子目录时必须显式 `-f docker-compose.prod.yml`**（compose 不自动发现该文件名）；crontab 行的 wrapper 路径与实际放置位置一致；`-T` 保留 |
| 11 | 中 | cron 首夜 | `/var/log/manhour-attendance-alert.log` 无写入；cron 毫无记录 | /var/log 下文件需 root 预建并 chown 给 crontab 属主；cron 服务/可执行位/路径 | **R1**：`touch` + chown 日志文件、`chmod +x` wrapper、确认 crond 运行、`docker compose ps`；容器停时 `exec` 返回非零 + `set -euo pipefail` + 重定向满足「容器外闹钟」留痕 |
| 12 | 低-中 | 运维·长期 | 两个宿主日志持续增长，无任何轮转 | 全仓 grep `logrotate` 零命中；告警日志约 2 条/天（异常堆栈会放大），备份日志 1 条/天 | **R1**：加一条 logrotate（周/月转 + retain 10）覆盖 `/var/log/manhour-{attendance-alert,backup}.log`，或接外部日志收集；至少纳入交接清单 |
| 13 | 低（行为正确，防误判） | 首跑·空数据 | 每次扫描都是 `decision=baseline`、无 `alert-email-dry-run` 行、data/ 无 alert-state.json；页面「从未成功导入」 | 抓取链路（fetch/SMB）未通或未到点；空库冷启动基线，干跑永不落盘 | 不是故障：先通 DEPLOY 第 10 步抓取；切真发当天首封仍会发出（干跑不消耗频控）。真发后停摆判定按连续 3 个**自然日**（勘误 R） |
| 14 | 低（行为正确，防误判） | 首跑 | `docker compose up` 直接报 env file not found | `.env.production` 未就位（这是期望的 fail-closed） | **R1**：从 example 复制并填值；改值后必须 `up -d`（重建容器），`restart` **不**重载 env_file，会静默留在干跑 |
| 15 | 低 | 首跑 | 容器时间/备份文件名时区不符；`date` 显示 UTC | TZ 依赖 slim 内 tzdata（Dockerfile:147 自标 unverified） | **R1**：`docker compose -f docker-compose.prod.yml exec app date` 应为 CST；不符则 runner 加 tzdata 安装行（回传评审，不临场改）。walkthrough 用 §9 的 `date` 目检 |
| 16 | 低 | 构建 | arm64 机上 v12 预编译/引擎行为异常 | 全链路只按 linux-x64 验证 | **R1**：确认目标机 amd64（`uname -m` = `x86_64`） |

---

## 8. 清理

验收完成（无论成败，只要不再复测）：

```sh
docker volume rm manhour-alert-test
docker volume ls | grep manhour-alert-test || echo "volume removed"
# 镜像是否保留：保留有助于出报告时复核；确认不再需要后：
# docker rmi manhour-mgmt:alert-walkthrough
# builder target 只是迁移工具，确认 §9 证据取完后可一并删除：
# docker rmi manhour-mgmt:builder
```

删除/归还 §1b 的源码包与解包树（含目标机上 tee 出的日志先回传再清理）。`manhour-alert-test` 卷内含空库（无业务数据），仍按一次性原则删除。

---

## 9. 回传证据清单（用于开发机出具 Task 17 Step 7 验收报告）

1. `docker version` / `docker compose version` 输出 + 目标机架构（`uname -m` 必须为 `x86_64`，预检 #16）。
2. `step1-build.log`：完整构建日志；明确 better-sqlite3 v12 走的是 prebuild-install 还是 node-gyp（搜日志关键字）；`@prisma/engines` postinstall exit 0；apt（deb.debian.org）步骤正常；总耗时。
3. `step2-image-contents.log`：五项核对实物输出 + nodemailer 版本号。**补二进制魔数目检**（在最终修复后的镜像内执行；bookworm-slim 不含 `file` 命令，用 coreutils 必在的 `head`+`od` 读前 4 字节魔数）：
   ```sh
   docker run --rm --entrypoint sh manhour-mgmt:alert-walkthrough -c '
     head -c 4 node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3/build/Release/better_sqlite3.node | od -An -tx1
     find node_modules/@prisma/engines -name "schema-engine-linux-*"
     date; date +%Z
     uname -m
   '
   ```
   预期：`.node` 打印 **`7f 45 4c 46`**（ELF 魔数 `\x7fELF`，x86-64 Linux 原生件）；若打印 **`4d 5a`**（ASCII `MZ`，PE/Windows 二进制）说明 ABI 资产错误（Windows 件混入或下错 prebuild），停止并回报；find 能列出 `schema-engine-linux-*`；`date` 为 **CST/+0800**（预检 #15，不符需加 tzdata）；`uname -m` 为 `x86_64`。
4. `step1b-builder.log` + `step3-migrate.log`：builder target 构建输出；迁移列出 9 个迁移并以 `All migrations have been successfully applied.` 结束；`ls -ln data/` 中 test.db 属主列显示数字 `1000 1000`（不是 `node node`）。
5. `step3-dryrun.log`：两遍横幅/JSON/exit + data 目录清单，逐行满足 §5.3 预期。
6. **三组阻断的实际命中与采用方案**：逐条「症状原文 → 采用方案 A/B 或哪几条 COPY（完整 Dockerfile diff）→ 重建/复测结果」；最终 Dockerfile/源码 diff 单独成文（预期恰好是 §6.2 + §6.3 共 4 条 COPY，且无其他改动）。
7. 清理证据：`docker volume ls` 无 manhour-alert-test；镜像删除/保留的实际选择。
8. 执行者、日期、目标机环境备注（网络代理/镜像源/apt 镜像若有配置，注明）。

判定标准：§5.3 五条预期全部满足、临时卷已删、未 seed、真实库零接触 → 第一期 walking skeleton 本地/镜像侧全部打通。此后上线动作（部署新镜像、装宿主 cron、配真 SMTP、R1 宿主九核与 logrotate）属 R1 生产发布流程，需逐项另行授权，不在本规程内。

---

## 附录 A：方案 B 的 migrate CLI 完整补包清单（38 个）

终审沙箱按实测报错链汇总：在现有 Dockerfile COPY（prisma、@prisma/config、@prisma/engines、dotenv、tsx）之外，还需 **顶层 27 + @prisma 8 + @electric-sql 3，合计 38 个目录**。每个目录对应一条 runner 阶段 COPY，模板（scoped 包路径照样两级）：

```dockerfile
COPY --from=builder --chown=node:node /app/node_modules/<pkg> ./node_modules/<pkg>
```

- 顶层（27）：`effect`、`fast-check`、`pure-rand`、`@standard-schema/spec`、`c12`、`exsolve`、`jiti`、`rc9`、`destr`、`defu`、`pkg-types`、`confbox`、`perfect-debounce`、`deepmerge-ts`、`pathe`、`find-my-way`、`foreground-child`、`get-port-please`、`proper-lockfile`、`remeda`、`std-env`、`valibot`、`zeptomatch`、`graceful-fs`、`retry`、`graphmatch`、`grammex`
- @prisma（8）：`@prisma/debug`（**整包覆盖 trace 骨架**）、`@prisma/engines-version`、`@prisma/fetch-engine`、`@prisma/studio-core`、`@prisma/dev`、`@prisma/get-platform`、`@prisma/query-plan-executor`、`@prisma/streams-local`
- @electric-sql（3）：`@electric-sql/pglite`、`@electric-sql/pglite-socket`、`@electric-sql/pglite-tools`

实证终点：`All migrations have been successfully applied.`（9 个迁移全部应用）。`@prisma/config` 声明的 `empathic` 未被需要（懒路径），不要顺手加。方案 B 下 `prisma db seed` 额外需要 §6.2 的 esbuild 两件（tsx 转译 seed.ts）；Task 17 验证期间永不 seed。

---

## 附录 B：退出码与事件速查（脚本真实契约）

| 退出码 | 含义 |
|---|---|
| 0 | 扫描完成：健康 skip、冷启动 baseline、干跑，或 live 发送成功 |
| 1 | config-error；或 live 发送失败（alert-email-failed） |
| 2 | 数据库读失败；状态文件写失败；未预期 throw（scan-fatal 兜底） |

事件流：`scan-start` →（可能 `db-read-failed`/`config-error`）→ `alert-decision{level,daysSince,decision}` → 可能 `alert-email-dry-run`/`alert-email-sent`/`alert-email-failed`/`state-write-failed`/`state-corrupt` → `scan-done{exitCode}`。
`level` 三态：`ok` / `stale`（超 3 个**自然日**无成功导入）/ `never`（从未导入）；空库首扫 `never` + `baseline` 宽限。
