# 部署手册 — 工时管理系统（SQLite 版）

> **适用范围**：内网自部署（D-007），免登录 + IP 白名单（D-008），SQLite 单文件数据库。
> PostgreSQL 迁移属于后续批次 5B，本文档不涉及。

---

## ⚠️ 本文档的验证状态（先读这一段）

| 内容 | 验证状态 |
| --- | --- |
| `next build` → `node server.js` → 7 路由 200 | ✅ 本机实跑通过 |
| `scripts/backup-db.mjs` 备份 + 完整性校验 + 恢复演练 | ✅ 真库实跑通过（9 项） |
| `prisma migrate deploy`（已有库 / 空库）、`prisma db seed` | ✅ 隔离包集下实跑 EXIT=0 |
| `Dockerfile` 镜像构建 | ❌ **从未构建过** |
| `docker-compose.prod.yml` | ⚠️ 仅 YAML 解析通过，从未 `up` 过 |
| `nginx.conf` | ❌ **从未被 nginx 加载过**，`nginx -t` 未跑 |

**原因**：编写本系统的机器上没有安装 Docker，也没有 nginx。容器相关文件的每一条指令都有实测依据（见文件内注释），但整体从未跑通。**首次部署请预留调试时间，不要安排在业务窗口内。**

首次部署建议按顺序单独验证，而不是一次 `up -d`：

```bash
docker compose -f docker-compose.prod.yml config    # 只解析，不启动
docker compose -f docker-compose.prod.yml build     # 只构建 app 镜像
docker run --rm -v "$PWD/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine nginx -t
```

---

## 1. 三个致命陷阱

这三条是本项目特有的失败模式，**每一条都表现为「系统看起来完全正常」**。放在最前面，因为它们比任何部署步骤都重要。

### 陷阱 1：数据库连不上时，页面返回 HTTP 200 并展示假数据

`src/lib/org-source.ts` 会把数据库异常归类为「基础设施故障」，然后降级到 Phase 1 的内存演示数据。**页面正常渲染、状态码 200、图表有数字** —— 唯一的线索是首页财年标签后面多了 `· 演示数据`（`src/app/page.tsx:62`）。

因此：

- **任何只看状态码的健康检查都会把坏掉的部署判定为正常。** 这也是 `Dockerfile` 和 compose 文件里刻意**不写 HEALTHCHECK** 的原因 —— 一个必然报绿的检查比没有检查更有害。
- 正确的检查方式见 [§6 健康检查](#6-健康检查必须做)。

### 陷阱 2：`DATABASE_URL` 用相对路径 → 静默创建空库 → 触发陷阱 1

standalone 的 `server.js` 启动时执行 `process.chdir(__dirname)`。相对路径 `file:./dev.db` 会相对于 server 目录解析，better-sqlite3 **不会报错，而是新建一个 0 字节文件**，Prisma 随后抛 `P2021`（表不存在），然后进入陷阱 1。

**`DATABASE_URL` 必须是绝对路径。** 容器内固定为 `file:/app/data/dev.db`。

### 陷阱 3：bind mount 权限不对 → 写入失败 → 触发陷阱 1

容器以 uid 1000（`node` 用户）运行。宿主机的 `./data` 目录若不可被 uid 1000 写入，SQLite 打开写事务失败，再次落入陷阱 1。

bind mount 会**覆盖**镜像里的目录并沿用宿主机的属主，所以 `Dockerfile` 里的 `chown` 在这种情况下不起作用 —— **必须在宿主机上处理**：

```bash
mkdir -p data backups
sudo chown -R 1000:1000 data backups
```

---

## 2. 部署产物清单

全部位于 `app/` 目录（同时也是 git 仓库根和 Docker 构建上下文根）：

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 三阶段构建（deps / builder / runner），Node 24.15.0 + bookworm-slim |
| `.dockerignore` | 排除 `node_modules`、`*.db`、`.env` 等；**必需**，见 §3 |
| `docker-compose.prod.yml` | app + nginx 两个服务 |
| `nginx.conf` | 反向代理 + D-008 IP 白名单 |
| `.env.production.example` | 环境变量模板（需复制为 `.env.production`） |
| `scripts/backup-db.mjs` | SQLite 备份（`VACUUM INTO` + 完整性校验 + 行数比对 + 保留策略） |

---

## 3. 为什么 `.dockerignore` 是必需的，而不是优化项

两个实测理由：

1. **体积**：`node_modules` 是 929.5 MB / 50,991 个文件。不排除的话每次 `docker build` 都要把它们打包上传给 daemon。
2. **正确性（更要紧）**：宿主机上的 `.node` 原生模块是 **Windows PE 格式**（`better_sqlite3.node`、`sharp-win32-x64-0.35.3.node`，magic `4d5a9000`）。一旦泄漏进构建上下文，会覆盖镜像里正确的 Linux ELF 二进制，运行时报 `invalid ELF header` —— 这个报错看起来像镜像损坏，极难定位真因。

另外注意：`.dockerignore` 的匹配使用 Go 的 `filepath.Match`，**只匹配单层路径**。写 `*.db` 只能匹配根目录，`prisma/dev.db` 会照样被打包进去（真实的考勤数据泄漏进镜像层）。所有数据类模式都必须写成 `**/` 形式。

---

## 4. 首次部署

### 4.1 宿主机准备

```bash
cd /opt/manhour-mgmt/app          # 代码所在目录，路径按实际调整

mkdir -p data backups
sudo chown -R 1000:1000 data backups     # 陷阱 3
```

### 4.2 配置环境变量

```bash
cp .env.production.example .env.production
```

`.env.production` 里只有两个变量需要确认（代码实际读取的环境变量只有 `DATABASE_URL`、`ORG_DATA_SOURCE`、`NODE_ENV` 三个，`NODE_ENV` 和 `TZ` 由 compose 注入）：

```
DATABASE_URL="file:/app/data/dev.db"     # 绝对路径，通常无需修改
ORG_DATA_SOURCE=db                       # 生产必须是 db，不能是 mock
```

`.env.production` 已在 `.gitignore` 中，不会被提交。

### 4.3 ⚠️ 修改 IP 白名单（这是本系统唯一的访问控制，且漏改不会报错）

**这一步没有任何自动保护。** 提交进仓库的默认值是刻意保持「放通」的（D-171 已确认此选择），所以漏改 allow 段的表现是**系统完全正常运行、没有报错、没有提示、健康检查也报绿** —— 唯一的后果是访问范围远大于预期。本节是该风险的全部缓解措施，请勿跳过。

`nginx.conf` 里的 allow 段目前是 **RFC 1918 占位值**，不是目标网段：

```nginx
allow 127.0.0.1;
allow 10.0.0.0/8;
allow 172.16.0.0/12;
allow 192.168.0.0/16;
deny  all;
```

**原样部署等于放通几乎所有私有网段。** 系统没有登录，任何通过白名单的人都能读取并**修改**全部考勤与计划数据，包括 `/admin` 页面。请替换为实际办公网段，例如：

```nginx
allow 127.0.0.1;
allow 10.20.30.0/24;
deny  all;
```

`deny all` 必须放最后 —— nginx 自上而下匹配，命中即停止。

**改完必须实测，不能只靠肉眼核对配置。** 网段写错一位（`/24` 写成 `/16`、网段号打错）在配置文件里看不出来，`nginx -t` 也照样通过 —— 它只校验语法，不校验你写的网段是不是你想要的那个。

```bash
# ① 在白名单内的机器上执行 —— 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://<服务器IP>/

# ② 在白名单外的机器上执行 —— 期望 403
#    没有第二台机器时，用手机热点或任意非办公网段的设备验证。
#    这一步不能省：只测到 200 只证明「能进」，不证明「别人进不来」。
curl -s -o /dev/null -w '%{http_code}\n' http://<服务器IP>/
```

② 若返回 200 而非 403，说明白名单没有生效，可能原因有两个，都要查：**allow 段仍是占位值或网段写宽了**；或 **app 服务被加了 `ports:` 映射**（见第 8 节，这会让请求绕过 nginx，白名单形同虚设）。

### 4.4 构建并启动

```bash
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

**首次构建最可能失败的位置**：`better-sqlite3` 原生模块编译。原因是版本错位 —— `package.json` 要求 `^13.0.2`，但 `@prisma/adapter-better-sqlite3@7.9.1` 声明依赖 `better-sqlite3: ^12.6.0`，npm 因此嵌套安装了第二份 **12.11.1**，而**适配器实际加载的是这份嵌套的 v12**。v13 自带 8 个平台的 `prebuilds/`（linux-x64 是 2.12MB 的 ELF），无需编译；但 v12.11.1 **没有 `prebuilds/`**，其 install 脚本是 `prebuild-install || node-gyp rebuild --release`，需要能访问 github.com 下载预编译产物，否则回退到本地编译。

`Dockerfile` 的 deps 阶段因此安装了 `python3 make g++` 作为兜底，并选用 Debian（bookworm-slim）而非 Alpine（musl 环境下预编译产物匹配更易出问题）。若构建卡在此处，检查构建机的出网能力。

### 4.5 初始化数据库

**镜像构建过程不需要数据库**（已实测三种情况：`DATABASE_URL` 未设置、指向不存在的路径、正常路径，`next build` 均 EXIT=0 且输出 7 条路由）。因此迁移是**独立的发布步骤**，不在构建期执行。

`prisma/` 目录不会被 `output: "standalone"` 的依赖追踪收集，`Dockerfile` 通过显式 `COPY` 放进镜像，就是为了让这一步能在容器里跑：

```bash
# 建表（空库会依次应用两个迁移）
docker compose -f docker-compose.prod.yml exec app \
  node node_modules/prisma/build/index.js migrate deploy

# 灌入基础数据：7 部门 / 24 课 / FY2026 / 7 条职务规则 / 288 条计划
docker compose -f docker-compose.prod.yml exec app \
  node node_modules/prisma/build/index.js db seed
```

已实测结果：

- 空库执行 `migrate deploy` → EXIT=0，应用 `20260806001207_init` 与 `20260806081541_add_attendance_import`，生成 13 张业务表 + `_prisma_migrations`
- 已有数据的库执行 `migrate deploy` → EXIT=0，`No pending migrations to apply`
- `db seed` → EXIT=0，seed 脚本是幂等的（全部 upsert），重复执行安全

### 4.6 验证部署（不要跳过）

见 [§6 健康检查](#6-健康检查必须做)。**只确认页面能打开是不够的** —— 陷阱 1 会让坏掉的部署看起来完全正常。

---

## 5. 日常运维

### 5.1 备份

```bash
docker compose -f docker-compose.prod.yml exec app \
  node scripts/backup-db.mjs --db data/dev.db --out backups --keep 30
```

**`--db data/dev.db` 必须显式传。** 脚本默认值是 `dev.db`，会解析到 `/app/dev.db`，而数据库实际挂载在 `/app/data/dev.db`。

脚本行为（均已实测）：

- 使用 `VACUUM INTO` 而不是 `cp`。数据库运行在 `journal_mode=delete`（非 WAL），写事务期间直接复制文件可能得到不一致的副本。
- 备份后自动执行 `PRAGMA integrity_check` 并逐表比对行数，任一项不符即报错退出。
- `--keep N` 保留最新 N 份，其余删除。
- 输出文件名 `manhour-<本地时间戳>.db`。这也是 compose 里设置 `TZ=Asia/Shanghai` 的原因 —— UTC 容器会把凌晨 4 点的备份命名成 20:00。

建议在宿主机 crontab 里安排（避开业务时段）：

```cron
17 4 * * * cd /opt/manhour-mgmt/app && docker compose -f docker-compose.prod.yml exec -T app node scripts/backup-db.mjs --db data/dev.db --out backups --keep 30 >> /var/log/manhour-backup.log 2>&1
```

注意 `exec -T`：非交互环境下不加会因为无法分配 TTY 而失败。

### 5.2 恢复

```bash
docker compose -f docker-compose.prod.yml stop app     # 必须先停，避免写入竞争
cp backups/manhour-20260812-041700.db data/dev.db
sudo chown 1000:1000 data/dev.db                        # 陷阱 3
docker compose -f docker-compose.prod.yml start app
```

恢复后**必须**执行 §6 的健康检查确认读到的是真实数据。

### 5.3 发布新版本

```bash
git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml exec app \
  node node_modules/prisma/build/index.js migrate deploy   # 有新迁移时才需要
```

**发布前先备份**（§5.1）。数据库是 bind mount，不受镜像重建影响，但迁移可能不可逆。

### 5.4 查看日志

```bash
docker compose -f docker-compose.prod.yml logs -f app
docker compose -f docker-compose.prod.yml logs -f nginx
```

容器日志是本系统唯一的诊断记录（没有日志聚合）。compose 里限制为单文件 10MB × 3 份，避免崩溃循环写满磁盘。

---

## 6. 健康检查（必须做）

**不要用 `curl -f http://localhost/`。** 陷阱 1 决定了它必然返回 200，无论数据库是否可用。

正确的检查是断言 `演示数据` 标记**不存在**：

```bash
#!/bin/sh
# 部署后 / 恢复后 / 定时巡检
BODY=$(curl -s --max-time 10 http://localhost/)

if [ -z "$BODY" ]; then
  echo "FAIL: 无响应"; exit 1
fi

if echo "$BODY" | grep -q "演示数据"; then
  echo "FAIL: 正在展示演示数据 —— 数据库不可用或 ORG_DATA_SOURCE 不是 db"
  exit 1
fi

echo "OK"
```

失败时的排查顺序：

1. `ORG_DATA_SOURCE` 是否为 `db`（陷阱 1 的最常见原因，也是最容易查的）
2. `DATABASE_URL` 是否为绝对路径 `file:/app/data/dev.db`（陷阱 2）
3. `data/dev.db` 的属主是否为 uid 1000 且文件大小非 0（陷阱 3）
4. 是否忘记执行 `migrate deploy`（表不存在同样触发降级）

补充核对（有真实数据时）：首页数字应带千分位分隔符，例如人员工时 `4,304`、总工时 `4,631.5`。

**上面的脚本查不出白名单配错。** 它从服务器本机发起请求，而 `127.0.0.1` 在任何配置下都是放通的，所以它永远报绿。访问范围是否正确，只能按 §4.3 ② 从白名单外的机器验证一次 —— 这项检查在每次改动 `nginx.conf` 的 allow 段后都要重做。

---

## 7. 上传体积上限的对齐关系

nginx 的 `client_max_body_size` 设为 **14m**，这个值是刻意夹在应用自身的两个限制之间的：

| 层 | 上限 | 位置 |
| --- | --- | --- |
| 单文件 | 4 MB | `src/lib/attendance/upload-guard.ts:23` |
| 单批次（最多 10 个文件） | 12 MB | `src/lib/attendance/upload-guard.ts:29` |
| 计划导入单文件 | 2 MB | `src/app/plans/import/actions.ts:54` |
| **nginx** | **14 MB** | `nginx.conf` |
| Server Action | 16 MB | `next.config.mjs` |

顺序是关键：超限批次由 `upload-guard.ts` 拒绝，返回指明具体文件与限额的**中文提示**。如果 nginx 设成 12m 或更小，请求会先被 nginx 截断，运维只能看到一个不含任何上下文的英文 413 页面 —— 甚至可能是浏览器层面的连接错误（nginx 可能在上传中途关闭连接）。

改动任一层的限额时，必须保持这个顺序不变。

---

## 8. 已知约束

- **SQLite 只能单副本。** compose 中 `replicas: 1` 是硬约束：SQLite 是单文件、`journal_mode=delete`，两个副本并发写会产生 `SQLITE_BUSY`。横向扩容需要先完成 PostgreSQL 迁移（批次 5B），提高副本数不解决问题。
- **HTTP 明文。** D-007 限定内网、无公网暴露，v1 不引入证书。**一旦需要跨出内网，HTTPS 不再是可选项** —— 免登录（D-008）+ 明文 + 可路由网络的组合无法接受。
- **app 服务不映射端口。** 这是 D-008 的另一半：app 只能从 compose 网络内访问，无法绕过 nginx 白名单。给 app 加 `ports:` 会彻底废掉访问控制。
- **业务日期与容器时区无关。** `src/lib/db/date.ts:50` 固定 `BUSINESS_TIME_ZONE = "Asia/Shanghai"`，通过 `Intl.DateTimeFormat` 计算业务日。`TZ` 只影响日志时间戳和备份文件名。
- **`.next/static` 需要单独 COPY。** `output: "standalone"` 不会复制 `.next/static/`，也不会复制 `public/`（本项目没有 `public/`）。漏掉这一步的表现是页面能打开但没有样式。
- **没有配置 CSP。** Next 为水合和流式渲染注入内联脚本，有效的 CSP 需要在应用层打通 per-request nonce。手写一份要么把页面弄坏，要么退化成 `'unsafe-inline'` 而毫无实际防护。列为 v2 事项，不作为装饰性配置发布。

---

## 9. 相关决策

| 编号 | 内容 |
| --- | --- |
| D-006 | 技术栈：Next.js + Prisma + shadcn/ui + Recharts，全栈单体内网 Docker 部署 |
| D-007 | 部署方式：内网自部署，不上公有云 |
| D-008 | v1 免登录 —— 内网 IP 白名单即可 |
| D-171 | 本批部署产物与 SQLite 直上路线（详见 `DECISIONS.md`） |
