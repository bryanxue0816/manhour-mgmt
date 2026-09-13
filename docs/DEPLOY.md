# 部署手册 — 工时管理系统

> **怎么用这份文档**：从上往下，一步一步做。每步都有「**做什么**（可直接复制的命令）→ **应该看到什么** → **如果不对怎么办**」。
> **不要跳步**，尤其是第 4 步（口令）、第 5 步（网段）、第 9 步（验证）——这三步做错都**不会报错**，系统看起来完全正常。
>
> 还没拿到服务器？先看 [`SERVER_REQUIREMENTS.md`](SERVER_REQUIREMENTS.md)（申请服务器要写什么、需要 IT 回填的 14 项）。

---

## 第 0 步：先知道三件事（2 分钟，别跳）

### ① 这套东西从没在真机上跑过

| 内容 | 状态 |
| --- | --- |
| 应用本体（构建、7 个页面、备份与恢复、自动化测试） | ✅ 开发机实跑通过 |
| 数据库迁移与初始数据 | ✅ 实跑通过 |
| **Docker 镜像构建** | ❌ **一次都没构建过** |
| **docker-compose 启动** | ⚠️ 只检查过格式，从没启动过 |
| **nginx 配置** | ❌ **从没被 nginx 加载过** |

原因很简单：写这套系统的电脑上没装 Docker，也没装 nginx。文件里每条指令都有依据，但整体没跑通过。

> **所以：首次部署请预留半天，不要安排在业务时间。** 别指望一次成功。

### ② 这个系统坏掉的时候，看起来是好的

这是本项目**最重要的一句话**。数据库连不上时，页面**照常打开、状态码 200、图表上有数字**——只不过那些数字是假的演示数据。

唯一的破绽：首页财年标签后面会多出 `· 演示数据` 四个字。

> 因此**「网页能打开」不等于部署成功**。第 9 步的验证不能省。也因此本项目**故意没写 Docker 健康检查**——一个必然报绿的检查比没有检查更糟。

### ③ 需要的命令基础

如果你不熟 Docker，只需要认识这几个词：

| 词 | 大白话 |
| --- | --- |
| 镜像（image） | 打包好的程序，像一张安装盘 |
| 容器（container） | 镜像跑起来之后的进程，像装好并运行中的软件 |
| `build` | 造安装盘 |
| `up -d` | 后台启动 |
| `exec app <命令>` | 钻进正在运行的容器里执行一条命令 |
| bind mount | 把服务器上的一个真实文件夹「借」给容器用；容器删了，文件还在 |

本文所有命令都在 `/opt/manhour-mgmt/app` 这个目录下执行（路径按你的实际情况替换）。

---

## 部署前：把这张表填好

从 IT 那里拿到的信息先填在这里，后面几步会反复用到：

| 项 | 值 | 用在 |
| --- | --- | --- |
| 服务器内网 IP | `_______________` | 第 5、9 步 |
| 代码存放路径 | `/opt/manhour-mgmt/app` | 全部步骤 |
| 允许访问的办公网段 | `_______________`（如 `10.20.30.0/24`） | 第 5 步 |
| 协议是 HTTP 还是 HTTPS | ☐ HTTP ☐ HTTPS | 第 4 步 |
| HR 共享目录 UNC 路径 | `_______________` | 第 10 步 |

---

## 第 1 步：把代码放到服务器上

**做什么**

```bash
# 方式一：服务器能连内网 git 仓库
sudo mkdir -p /opt/manhour-mgmt
cd /opt/manhour-mgmt
git clone <仓库地址> app
cd app

# 方式二：服务器连不了仓库，用压缩包拷进去
# 在开发机打包（排除大文件），再上传解压到 /opt/manhour-mgmt/app
```

**应该看到**：`ls` 能看到 `Dockerfile`、`docker-compose.prod.yml`、`nginx.conf`、`package.json`、`prisma/`。

**如果不对**：确认解压层级，别多套一层目录（`app/app/Dockerfile` 是错的）。

---

## 第 2 步：确认 Docker 装好了

**做什么**

```bash
docker --version
docker compose version
```

**应该看到**：Docker 版本 ≥ 24；第二条能打印出 `Docker Compose version v2.x`。

**如果不对**

- `docker compose version` 报「不是 docker 命令」→ 装的是老版 `docker-compose`（v1）。本项目的编排文件按 v2 写的，请让 IT 装 v2 插件。
- 提示权限不足 → 你的账号不在 `docker` 组：`sudo usermod -aG docker $USER`，然后**重新登录 SSH**（不重登不生效）。

---

## 第 3 步：建两个文件夹，并改属主

**为什么**：容器内部是用 uid 1000 这个普通用户跑的。如果文件夹属主不对，数据库写不进去 → 直接触发第 0 步②那个「假数据」问题。

**做什么**

```bash
cd /opt/manhour-mgmt/app
mkdir -p data backups
sudo chown -R 1000:1000 data backups
ls -ln | grep -E 'data|backups'
```

**应该看到**：两行的属主都是 `1000 1000`。

```
drwxr-xr-x 2 1000 1000 4096 ... backups
drwxr-xr-x 2 1000 1000 4096 ... data
```

**如果不对**：显示 `root root` 就是 `chown` 没生效，重新执行。**这一步不能靠 Dockerfile 解决**——bind mount 会覆盖镜像里的目录并沿用服务器上的属主。

---

## 第 4 步：填配置文件（含口令）

**做什么**

```bash
cp .env.production.example .env.production
vi .env.production
```

一共只有 **5 个**要确认（其他都是注释）：

| 变量 | 填什么 | 填错的后果 |
| --- | --- | --- |
| `DATABASE_URL` | `file:/app/data/dev.db` | **必须是这个绝对路径**，改成相对路径会静默新建空库 → 假数据 |
| `ORG_DATA_SOURCE` | `db` | 填成 `mock` → 永远显示演示数据 |
| `ADMIN_PASSWORD` | 你自己想一个，**手工敲进去** | 留空 → 管理员进不去（不是谁都能进，方向是安全的） |
| `SESSION_SECRET` | 一串 ≥32 位的随机字符 | 太短或留空 → **所有人**都登不进去 |
| `COOKIE_SECURE` | HTTP 填 `false`；HTTPS 填 `true` | **HTTP 却填 true → 口令输对了却一直跳回登录页，且日志里毫无报错** |

生成一个随机 `SESSION_SECRET`：

```bash
openssl rand -base64 48
```

**应该看到**：只核对长度，**不要把口令 echo 出来**：

```bash
awk -F= '/^ADMIN_PASSWORD=/{print "ADMIN_PASSWORD 长度:", length($2)}' .env.production
awk -F= '/^SESSION_SECRET=/{print "SESSION_SECRET 长度:", length($2)}' .env.production
```

`SESSION_SECRET` 长度必须 ≥32。

> **口令只存在于服务器上的这个文件里。** 不要写进任何会提交到仓库的文件、不要贴进工单或邮件、不要 echo 到终端历史里。`.env.production` 已在 `.gitignore` 中。
> **忘了口令没有找回途径，只能改**（改法见「日常操作 · 换口令」）。能登服务器读这个文件的人 = 知道口令的人，口令的安全上限就是服务器的 SSH 权限。

---

## 第 5 步：改访问网段（漏改不会报错）

**为什么**：仓库里 `nginx.conf` 的默认值是**放通几乎所有私有网段**的占位值。漏改的表现是：系统完全正常、没有任何报错、健康检查报绿——只是谁都能看到全公司的工时数据。**本步是这个风险的唯一防线。**

**做什么**

```bash
vi nginx.conf
```

找到这几行（默认值，是占位值不是目标值）：

```nginx
allow 127.0.0.1;
allow 10.0.0.0/8;
allow 172.16.0.0/12;
allow 192.168.0.0/16;
deny  all;
```

改成你实际的办公网段：

```nginx
allow 127.0.0.1;
allow 10.20.30.0/24;      # ← 换成 IT 给你的网段
deny  all;
```

`deny all` **必须在最后一行**——nginx 从上往下匹配，命中就停。

**应该看到**：这一步没法立刻验证，要等第 9 步用两台机器实测。

**如果不对**：网段写宽一位（`/24` 写成 `/16`）在文件里根本看不出来，`nginx -t` 也照样通过——它只检查语法，不检查你写的网段对不对。**只能靠第 9 步实测。**

> 如果贵司明确决定「不做 IP 限制、放通全私有网段」，那就保留默认值，但**请不要对使用方说「已按 IP 限制访问」**。这种情况下真正的防线只有口令（看板页是公开只读的）。

---

## 第 6 步：分三次验证，不要一把启动

**为什么**：容器和 nginx 这一层从没跑过（第 0 步①）。一把 `up -d` 出错时，你分不清是哪一层的问题。

**做什么**（一条一条来，每条成功再走下一条）

```bash
# 6-1 只解析配置，不启动任何东西
docker compose -f docker-compose.prod.yml config > /dev/null && echo "配置 OK"

# 6-2 只检查 nginx 配置语法（借一个临时容器来检查）
docker run --rm -v "$PWD/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine nginx -t

# 6-3 只构建镜像（这一步最慢，也最可能失败）
docker compose -f docker-compose.prod.yml build
```

**应该看到**

- 6-1 打印 `配置 OK`
- 6-2 打印 `syntax is ok` 和 `test is successful`
- 6-3 最后打印 `Successfully built` 之类的成功信息

**如果 6-3 失败了（最可能的一步）**

大概率卡在 `better-sqlite3` 这个原生模块上，报错里会出现 `prebuild-install`、`node-gyp` 或 `ETIMEDOUT`。原因见[附录 A-3](#a-3-为什么构建最可能死在-better-sqlite3)。处理办法：

1. 确认服务器**能访问外网 HTTPS**（`github.com`、`registry.npmjs.org`、Docker Hub、`deb.debian.org`）：
   ```bash
   curl -sI https://github.com | head -1
   curl -sI https://registry.npmjs.org | head -1
   ```
2. 如果不能访问外网 → **这台机器造不出镜像**。改成在一台能上网的机器上构建，然后拷过来：
   ```bash
   # 联网机器上
   docker compose -f docker-compose.prod.yml build
   docker save <镜像名> | gzip > manhour.tar.gz
   # 拷到服务器后
   gunzip -c manhour.tar.gz | docker load
   ```

---

## 第 7 步：启动

**做什么**

```bash
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

**应该看到**：两个服务（`app` 和 `nginx`）状态都是 `Up` / `running`。

**如果不对**：看日志，报错原文通常直接说明原因。

```bash
docker compose -f docker-compose.prod.yml logs --tail 50 app
docker compose -f docker-compose.prod.yml logs --tail 50 nginx
```

---

## 第 8 步：建表 + 灌入基础数据

**为什么**：镜像里只有程序，没有数据。数据库是空的，需要先建表再灌初始数据。

**做什么**（两条命令，必须按顺序）

```bash
# 8-1 建表
docker compose -f docker-compose.prod.yml exec app \
  node node_modules/prisma/build/index.js migrate deploy

# 8-2 灌入基础数据：7 个部 / 24 个课 / FY2026 财年 / 7 条职务规则 / 288 条计划
docker compose -f docker-compose.prod.yml exec app \
  node node_modules/prisma/build/index.js db seed
```

**应该看到**

- 8-1：列出应用了哪几个迁移，最后 `All migrations have been successfully applied`
- 8-2：seed 脚本打印各表写入条数，无报错退出

**如果不对**

- 报「数据库文件打不开 / 权限不足」→ 回第 3 步查属主
- 报 `P2021` 表不存在 → 8-1 没成功，别急着跑 8-2
- 8-2 重复执行是**安全的**（全是 upsert，幂等）

---

## 第 9 步：验证部署（最容易被跳过，也最不能跳过）

**为什么**：见第 0 步②。「页面能打开」证明不了任何事。

### 9-1 验证数据是真的

在服务器上执行：

```bash
curl -s --max-time 10 http://localhost/ | grep -q "演示数据" \
  && echo "❌ 失败：正在显示演示数据，数据库没连上" \
  || echo "✅ 通过：读到的是真实数据"
```

**应该看到**：`✅ 通过`。

**如果显示 ❌**，按这个顺序查（从最常见的开始）：

| 顺序 | 查什么 | 命令 |
| --- | --- | --- |
| 1 | `ORG_DATA_SOURCE` 是不是 `db` | `grep ORG_DATA_SOURCE .env.production` |
| 2 | `DATABASE_URL` 是不是绝对路径 | `grep DATABASE_URL .env.production` |
| 3 | 数据库文件属主是 1000、大小不是 0 | `ls -ln data/` |
| 4 | 第 8 步是不是漏了 | 重跑 8-1 |

### 9-2 验证访问范围（必须两台机器）

```bash
# ① 在办公网内的电脑上执行 —— 期望 200
curl -s -o /dev/null -w '%{http_code}\n' http://<服务器IP>/

# ② 在网段外的设备上执行 —— 期望 403
#    没有第二台机器？用手机开热点、笔记本连热点来测。
curl -s -o /dev/null -w '%{http_code}\n' http://<服务器IP>/
```

**应该看到**：① 是 `200`，② 是 `403`。

> **只测到 ① 的 200 毫无意义**——那只证明「能进」，不证明「别人进不来」。9-1 那个脚本也查不出网段问题，因为它从本机发请求，而 `127.0.0.1` 在任何配置下都放通。

**如果 ② 返回 200 而不是 403**，两个原因都要查：

1. 第 5 步的网段没改，或写宽了
2. `docker-compose.prod.yml` 里给 `app` 服务加了 `ports:` 映射 → 请求绕过了 nginx，白名单形同虚设（**别加**）

### 9-3 逐页点一遍

浏览器打开 `http://<服务器IP>/`，确认：

- [ ] 首页图表有数据，财年标签后面**没有** `· 演示数据`
- [ ] 数字带千分位，如 `4,304`、`4,631.5`
- [ ] 点进 `/plans`、`/admin` 会要求输入口令
- [ ] 用第 4 步设的口令能登进去
- [ ] 登进去后能看到计划录入页和管理页

---

## 第 10 步（暂缓）：考勤自动抓取

> [!IMPORTANT]
> **这一步现在还做不了，先跳过。** 系统设计上考勤是每天自动从 HR 共享目录抓取的，但抓取脚本目前**不在生产镜像里**，需要先补一个编排层改动（详见项目 `DECISIONS.md` 的 D-197）。
>
> **在此之前，考勤走人工上传**：管理员登录后在导入页手动上传 HR 的考勤 Excel，功能完整可用。
>
> 另外还缺两项 IT/HR 信息才能配置自动抓取：共享目录的完整 UNC 路径、HR 报表每天几点生成完（决定定时任务的时刻）。

这样安排是有意的：先让系统跑起来，共享目录的权限、字符集问题单独排查，不阻塞上线。

---

## 第 10 步附：考勤停摆邮件告警

考勤数据如果连续 3 个自然日没有成功导入，系统会给管理员发邮件提醒（Erratum R：阈值按日历日，不是工作日）。扫描脚本随镜像自带，由**宿主机的定时任务**每天 09:20、15:20 在容器内执行两次（闹钟放在容器外：容器停了 cron 反而会留痕，这是有意设计）。

**默认是干跑模式，不会真的发信**：`.env.production` 里 `SMTP_HOST` 留空时，扫描照常运行、状态照常判断，"本应发出的邮件"只在容器日志里打一行 `alert-email-dry-run`，且不会创建任何状态文件。这不是配置错误，是安全默认值。

### 附-1 先手动干跑一次（不装 cron 也能验收）

```bash
cd /opt/manhour-mgmt/app
docker compose -f docker-compose.prod.yml exec -T app \
  node node_modules/tsx/dist/cli.mjs scripts/check-attendance-alert.ts; echo "exit=$?"
```

应该看到：第一行横幅 `[attendance-alert] MODE=DRY-RUN …`，随后若干单行 JSON 日志（`scan-start`、`alert-decision`、`scan-done`），最后 `exit=0`。

干跑验收三明治，三处缺一不可：

1. **横幅**：每次运行第一行明确印 `MODE=DRY-RUN`。
2. **日志（Erratum S：三种正确形态，看决策行 `alert-decision` 的 `decision` 字段区分）**：决策为 `send-first`/`send-repeat`/`send-recovery`（正在停摆）时，日志里有一行 `{"evt":"alert-email-dry-run","toCount":…,"subject":…}`；决策为 `skip`（健康）或 `baseline`（从未成功导入的冷启动基线）时，只有决策行、没有发信行。空数据卷首扫必然是 `baseline` 且无发信行——干跑永不写状态文件，未导入系统在整个干跑期每次扫描都停留在 baseline，这不是漏发。
3. **状态与页面**：干跑不在数据卷创建 `alert-state.json`（`docker compose -f docker-compose.prod.yml exec app ls data/` 看不到它）；浏览器登录后 `/admin` 主页角标与 `/admin/alerts` 子页都显示「干跑中」。

连跑两遍结果应完全一致（干跑不推进任何频控日期），这能证明切真发当天仍会发出首封提醒而不是被干跑历史"吃掉"。

### 附-2 安装宿主机定时任务

镜像里的脚本路径是 `scripts/check-attendance-alert.ts`；仓库 `deploy/cron/` 提供了版本化 wrapper 与 crontab 样板。把 wrapper 放到部署目录后（路径与 crontab 行保持一致）：

```bash
chmod +x /opt/manhour-mgmt/deploy/cron/check-attendance-alert.sh
crontab -e
```

加入（样板来自 `deploy/cron/crontab.example`）：

```cron
20 9,15 * * * /opt/manhour-mgmt/deploy/cron/check-attendance-alert.sh >> /var/log/manhour-attendance-alert.log 2>&1
```

> **路径必须和现网对齐**：wrapper 里的 `cd` 行样板写的是 `/opt/manhour-mgmt`，本文件第 11 步备份任务用的是 `/opt/manhour-mgmt/app` 且显式带 `-f docker-compose.prod.yml`。装之前对照服务器上既有的考勤抓取 wrapper（`/opt/manhour-mgmt/scripts/fetch-attendance.sh`，若存在）确认 compose 项目目录，以现网为准改 wrapper 里的 `cd` 行。`exec` 的 `-T` 不能省（cron 没有 TTY）。另外（Erratum S）：若按现网把 `cd` 改到 `app/` 子目录，还必须像附-1 的命令那样显式加 `-f docker-compose.prod.yml`——compose 不会自动发现这个文件名；wrapper 到底需不需要 `-f`，同样以现网 fetch wrapper 的实际写法为准。

第二天确认 `/var/log/manhour-attendance-alert.log` 有两条横幅 + JSON 记录、无报错。

> 镜像首次构建与空卷验证的逐步手册见 [ops/task17-docker-verification.md](ops/task17-docker-verification.md)：生产部署窗口照该手册做镜像五项核对与空卷两遍干跑（含三处已实证首跑阻断的照抄修法）。

### 附-3 从干运转真发（检查清单）

按顺序做，不要跳：

1. 编辑 `.env.production`：`SMTP_HOST` 填内网中继、`SMTP_FROM` 填发件地址、`ALERT_ADMIN_EMAIL` 填管理员邮箱（逗号分隔，最多 3 个）；端口/加密/认证按中继要求配（`SMTP_PORT=25`、`SMTP_SECURE=false` 是无认证内网中继的默认；465 端口须把 `SMTP_SECURE` 改 true；`SMTP_USER`/`SMTP_PASS` 必须同时留空或同时填写）。口令只在服务器上填，不进仓库、不进聊天记录。
2. `docker compose -f docker-compose.prod.yml up -d` 重启 app 容器让环境变量生效。
3. 登录 `/admin/alerts`，确认渠道卡不再显示「干跑中」、收件人数量正确、无配置错误条目；点「发送测试邮件」。
4. **确认管理员信箱真的收到测试邮件后**，再信任定时通道；随后观察下一个 09:20/15:20 的日志为 `alert-email-sent` 或（正常时）无发信行。
5. 需要临时停发（如中继迁移）时不必清空配置：把 `ALERT_EMAIL_DRY_RUN=true` 重启即强制干跑，优先级最高。

### 附-4 排查表

| 现象 | 含义与处理 |
|---|---|
| cron 跑了但脚本 `exit=1`，横幅 `MODE=CONFIG-ERROR` | 配置不合法。进 `/admin/alerts` 看渠道卡逐条错误（半配认证、端口非数字、邮箱格式错、超 3 个收件人等），改 `.env.production` 后重启。**配置错误绝不静默回退干跑。** |
| `exit=1`，日志 `alert-email-failed` | 配置通过但 SMTP 连接/认证失败（中继不可达、口令错），页面频控卡显示最近错误。按邮件类型区分（Erratum T）：**首警/重复警**发送失败后同日另一个扫描点仍判 skip（同日频控，不重试）；**下一个日历日**若仍停摆才发重复警。**恢复通知发送失败不补发**——恢复意图落盘时状态已转为正常，后续扫描恒为 skip，只能人工看容器日志与页面频控卡的最近错误。 |
| `exit=2`，日志 `db-read-failed` | 数据库打不开/查询失败。先按第 9 步与 A-1/A-2 排查数据卷属主与 DATABASE_URL；告警此时不读不写状态、不发信。 |
| `exit=2`，日志 `state-write-failed` | 频控状态 JSON 落盘失败，查 data 卷属主与磁盘。按出现位置区分（Erratum S）：发信**意图**落盘失败时本次不发信（防重复打扰）；若该行出现在 `alert-email-sent` **之后**，说明邮件已经发出、只是发信后的落账失败，请勿据此重发。 |
| 日志有 `state-corrupt` 但 `exit=0` | 状态文件损坏，本次已按「无历史文件」（首扫）处理。**真发模式**下本次扫描会重写文件、完成自愈；**干跑模式不写任何状态文件**（Erratum S），损坏文件原样保留、每次扫描重复出现这行——删掉该文件或切到真发后的首扫即可消除，这种重复不代表卷有问题。 |
| cron 毫无记录 | 查 cron 服务、wrapper 的 `cd` 路径与可执行位、`-T` 参数，以及 `/var/log/manhour-attendance-alert.log` 对 crontab 属主是否可写（在 /var/log 下通常需 root 预先创建并 chown）；`docker compose ps` 确认容器在跑。 |
| 页面显示「从未成功导入」 | 说明考勤抓取链路本身没通（第 10 步/SMB 挂载问题），告警是如实反映；告警通道与抓取共享 SMB 与否无关，先恢复数据导入。 |

正常健康运行时：每次扫描只有横幅 + `scan-start` + `alert-decision{decision:"skip"}` + `scan-done`，不发信、不打扰。

---

## 第 11 步：配置每日自动备份

**做什么**

先手动跑一次，确认能备出来：

```bash
docker compose -f docker-compose.prod.yml exec app \
  node scripts/backup-db.mjs --db data/dev.db --out backups --keep 30
ls -lh backups/
```

**应该看到**：`backups/` 下出现 `manhour-<时间戳>.db`，且命令没有报错。

> **`--db data/dev.db` 必须显式写出来。** 不写的话脚本会去找 `/app/dev.db`（不存在），而数据库实际在 `/app/data/dev.db`。

成功后加进服务器的定时任务：

```bash
crontab -e
```

加一行（凌晨 4:17，避开业务时段）：

```cron
17 4 * * * cd /opt/manhour-mgmt/app && docker compose -f docker-compose.prod.yml exec -T app node scripts/backup-db.mjs --db data/dev.db --out backups --keep 30 >> /var/log/manhour-backup.log 2>&1
```

> `exec` 后面的 **`-T` 不能省**：定时任务没有终端，不加会因为分配不到 TTY 而失败。

**第二天记得确认一下** `backups/` 里有没有新文件、`/var/log/manhour-backup.log` 有没有报错。

---

## 第 12 步：收尾登记

- [ ] 把服务器 IP、访问地址告知使用方
- [ ] 口令交给需要录入的管理员（**口头或线下，别用邮件/群聊**）
- [ ] 告知 IT 把 `/opt/manhour-mgmt/app/backups` 纳入公司备份体系
- [ ] 记录本次部署日期与版本（`git rev-parse --short HEAD`）

**到这里部署完成。** 下面是以后会用到的操作。

---

# 日常操作速查

## 换口令

```bash
# 1. 改值（只改 ADMIN_PASSWORD 那一行）
vi .env.production

# 2. 只核对长度，别 echo 值
awk -F= '/^ADMIN_PASSWORD=/{print length($2)}' .env.production

# 3. 必须重启，否则不生效
docker compose -f docker-compose.prod.yml up -d --force-recreate app
```

**漏了第 3 步的表现是「改了口令但旧口令还能进」**，不报错，容易误判成改失败。原因：Node 启动时把环境变量快照了，运行中不会重读。

### ⚠️ 改口令挡不住已经登录的人

会话 cookie 有效期 **30 天**，它由 `SESSION_SECRET` 签名，跟口令无关：

| 场景 | 只改 `ADMIN_PASSWORD` | 两个都改 |
| --- | --- | --- |
| 新的登录尝试 | 旧口令失效 ✅ | 旧口令失效 ✅ |
| 已经登录的浏览器 | **还能继续用，最长 30 天** ❌ | 立刻失效 ✅ |

**口令疑似泄露时必须两个一起换**。换 `SESSION_SECRET` 会踢掉所有人**包括你自己**，换完要重新登录。

## 恢复数据

```bash
docker compose -f docker-compose.prod.yml stop app     # 必须先停，否则会写冲突
cp backups/manhour-20260812-041700.db data/dev.db
sudo chown 1000:1000 data/dev.db
docker compose -f docker-compose.prod.yml start app
```

**恢复后必须重跑第 9-1 步**确认读到的是真实数据。

## 发布新版本

```bash
# 0. 先备份！
docker compose -f docker-compose.prod.yml exec app \
  node scripts/backup-db.mjs --db data/dev.db --out backups --keep 30

git pull
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

# 有新的数据库变更时才需要这条
docker compose -f docker-compose.prod.yml exec app \
  node node_modules/prisma/build/index.js migrate deploy
```

数据库在 bind mount 里，重建镜像不会动它。但**迁移可能不可逆，所以先备份**。

## 看日志

```bash
docker compose -f docker-compose.prod.yml logs -f app      # 应用
docker compose -f docker-compose.prod.yml logs -f nginx    # 反向代理
```

容器日志是本系统**唯一**的诊断记录（没有日志聚合系统）。日志限制为单文件 10MB × 3 份，防止崩溃循环写满磁盘。

## 重启 / 停止

```bash
docker compose -f docker-compose.prod.yml restart app
docker compose -f docker-compose.prod.yml down          # 停止并删除容器（数据不丢）
docker compose -f docker-compose.prod.yml up -d         # 再启动
```

---

# 出问题了看这里

| 症状 | 最可能的原因 | 怎么办 |
| --- | --- | --- |
| 页面能开，但图表数字看着不对，标签后有 `· 演示数据` | 数据库没连上 | 按第 9-1 步的四项排查表逐条查 |
| 口令输对了，一直跳回登录页，日志无报错 | `COOKIE_SECURE=true` 但实际是 HTTP | 改成 `false`，然后 `up -d --force-recreate app` |
| 登录页提示「服务端尚未配置管理员口令」 | `ADMIN_PASSWORD` 空 | 第 4 步 |
| 所有人都登不进去，包括口令没错的 | `SESSION_SECRET` 缺失或不足 32 位 | 第 4 步 |
| 改了口令，旧口令还能用 | 没重启容器 | `up -d --force-recreate app` |
| 页面能打开但完全没有样式 | 静态资源没进镜像 | 重新 `build`；见[附录 B](#附录-b已知约束) |
| 上传考勤文件报英文 413 或上传中途断开 | nginx 的体积上限被改小了 | 见[附录 A-4](#a-4-上传体积上限为什么是-14mb) |
| 构建卡住或超时，报错含 `node-gyp` / `prebuild-install` | 服务器上不了外网 | 见第 6 步的处理办法 |
| 网段外的机器也能访问 | 网段没改，或 app 被加了 `ports:` | 第 5 步 + 第 9-2 步 |
| 备份定时任务不执行 | cron 里漏了 `exec -T` | 第 11 步 |

---

# 附录 A：为什么这样做（出问题时再看）

## A-1 为什么「数据库坏了却返回 200」

`src/lib/org-source.ts` 把数据库异常归类为「基础设施故障」，然后降级到内存里的演示数据。页面正常渲染、状态码 200、图表有数字，唯一线索是首页那个 `· 演示数据` 标记（`src/app/page.tsx:62`）。

这是**故意的设计**（演示阶段的遗留能力），但它让所有「只看状态码」的监控失效。所以：

- `Dockerfile` 和 compose 里**故意不写 HEALTHCHECK**
- 正确的检查必须断言 `演示数据` 这四个字**不存在**（第 9-1 步）
- 如果要接公司监控 Agent，也必须按内容断言，不能只看 HTTP 200

## A-2 两个会触发「假数据」的配置错误

**① `DATABASE_URL` 写相对路径。** standalone 的 `server.js` 启动时会执行 `process.chdir(__dirname)`，相对路径 `file:./dev.db` 会相对于 server 目录解析，better-sqlite3 **不报错，而是新建一个 0 字节文件**，Prisma 随后抛 `P2021`（表不存在）→ 降级成假数据。**这是实测复现的，不是推测。**

**② bind mount 属主不对。** 容器以 uid 1000 运行，`./data` 若不可被 uid 1000 写入，SQLite 打开写事务失败 → 同样降级。数据库跑在 `journal_mode=delete` 模式，写入时需要在同目录创建 `-journal` 临时文件，所以**光有文件写权限不够，目录也要可写**。

bind mount 会**覆盖**镜像里的目录并沿用宿主机属主，所以 `Dockerfile` 里的 `chown` 对它无效——只能在服务器上 `chown`（第 3 步）。

## A-3 为什么构建最可能死在 better-sqlite3

版本错位：`package.json` 要求 `better-sqlite3 ^13.0.2`，但 `@prisma/adapter-better-sqlite3@7.9.1` 声明依赖 `^12.6.0`，于是 npm **嵌套装了第二份 12.11.1**，而**适配器实际加载的是这份嵌套的 v12**。

关键差异：v13 自带 8 个平台的 `prebuilds/`（linux-x64 是 2.12MB 的 ELF），开箱即用；**v12.11.1 没有 `prebuilds/`**，它的 install 脚本是 `prebuild-install || node-gyp rebuild --release`——先尝试从 **GitHub Release** 下载预编译包，下不到就本地编译。

所以构建需要的出网目标不止 npm：Docker Hub、`deb.debian.org`（镜像内 apt 装 `python3 make g++`）、`registry.npmjs.org`、**以及 `github.com` / `objects.githubusercontent.com`**。

`Dockerfile` 的 deps 阶段预装了 `python3 make g++` 作为编译兜底，并选 Debian（bookworm-slim）而非 Alpine——musl 环境下预编译产物匹配更容易出问题。

## A-4 上传体积上限为什么是 14MB

nginx 的 `client_max_body_size 14m` 是**刻意夹在应用自身的两个限制之间**的：

| 层 | 上限 | 位置 |
| --- | --- | --- |
| 单个文件 | 4 MB | `src/lib/attendance/upload-guard.ts:23` |
| 一批（最多 10 个文件） | 12 MB | `src/lib/attendance/upload-guard.ts:29` |
| 计划导入单文件 | 2 MB | `src/app/plans/import/actions.ts:54` |
| **nginx** | **14 MB** | `nginx.conf` |
| Next Server Action | 16 MB | `next.config.mjs` |

顺序是关键：超限的批次由应用拒绝，返回**指名具体文件和限额的中文提示**。如果把 nginx 改成 12m 或更小，请求会先被 nginx 掐断，操作者只能看到一个不含任何上下文的英文 413 页面，甚至是浏览器层面的连接中断。**改任何一层限额时都要保持这个大小顺序。**

## A-5 为什么 `.dockerignore` 是必需的，不是优化项

1. **体积**：`node_modules` 是 929.5 MB / 50,991 个文件，不排除的话每次构建都要打包上传给 Docker daemon。
2. **正确性（更要紧）**：开发机上的 `.node` 原生模块是 **Windows PE 格式**（magic `4d5a9000`）。一旦混进构建上下文，会覆盖镜像里正确的 Linux ELF 二进制，运行时报 `invalid ELF header`——这个报错看起来像镜像损坏，极难定位真因。

另注意：`.dockerignore` 用 Go 的 `filepath.Match`，**只匹配单层路径**。写 `*.db` 只能匹配根目录，`prisma/dev.db` 照样会被打包进镜像层（真实考勤数据泄漏）。所有数据类模式都必须写成 `**/` 形式。

## A-6 共享口令能追到什么、追不到什么

所有管理员用同一个口令，`MasterDataChangeLog.changedBy` 是固定字面量 `"admin"`。

> **口令给了几个人，`/admin/audit` 就只能追到「某个管理员」，追不到「谁」。**

留痕能证明「改了什么、什么时候改的」，**不能证明「谁改的」**。对外说明审计能力时不要越过这条线。

口令也**不会过期**，没有到期提醒、不会强制更换（这是明确决定，不是漏做）。口令以明文存在环境变量里、与提交值做常量时间比对，**没有做 hash**——因此：**能登服务器读 `.env.production` 的人 = 知道口令的人。**

## A-7 会话为什么是 30 天而不是更短

月度重新登录是使用者能容忍的摩擦；每日登录会把人逼到「把口令写在便利贴上」，那比长 cookie 更糟。理由写在 `src/lib/session-cookie.ts` 的注释里，想改短之前先读它。

---

# 附录 B：已知约束

- **SQLite 只能单副本。** compose 里的 `replicas: 1` 是硬约束，不是保守设置：SQLite 是单文件、`journal_mode=delete`，两个副本并发写会报 `SQLITE_BUSY`。**加副本不能提高性能，只会出错。** 横向扩容需要先迁移到 PostgreSQL（后续独立批次）。
- **数据库文件不能放在网络存储上**（NFS/CIFS/NAS）。SQLite 在网络文件系统上的锁语义不可靠。共享目录只用来**读**考勤 Excel。
- **HTTP 明文传输。** v1 限定内网、不暴露公网。**一旦需要跨出内网，HTTPS 就不再是可选项。**
- **app 服务不映射端口。** app 只能从 compose 内网访问，无法绕过 nginx。**给 app 加 `ports:` 会彻底废掉访问控制。**
- **业务日期与容器时区无关。** `src/lib/db/date.ts:50` 固定 `BUSINESS_TIME_ZONE = "Asia/Shanghai"`。`TZ` 只影响日志时间戳和备份文件名——这也是 compose 里设 `TZ=Asia/Shanghai` 的原因，否则 UTC 容器会把凌晨 4 点的备份命名成前一天 20:00。
- **`.next/static` 需要单独 COPY。** `output: "standalone"` 不会复制 `.next/static/`。漏掉的表现是**页面能打开但完全没有样式**。
- **没有配置 CSP。** Next 为水合和流式渲染注入内联脚本，有效的 CSP 需要应用层打通 per-request nonce。手写一份要么把页面弄坏，要么退化成 `'unsafe-inline'` 而毫无防护。列为 v2 事项，不作为装饰性配置发布。
- **备份脚本用 `VACUUM INTO` 而不是 `cp`。** 数据库跑在 `journal_mode=delete`（非 WAL），写事务期间直接复制文件可能得到不一致的副本。备份后会自动执行 `PRAGMA integrity_check` 并逐表比对行数，任一项不符即报错退出。

---

# 附录 C：部署产物清单与相关决策

全部位于 `app/` 目录（同时是 git 仓库根和 Docker 构建上下文根）：

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 三阶段构建（deps / builder / runner），Node 24.15.0 + bookworm-slim |
| `.dockerignore` | 排除 `node_modules`、`*.db`、`.env` 等；**必需**，见附录 A-5 |
| `docker-compose.prod.yml` | app + nginx 两个服务 |
| `nginx.conf` | 反向代理 + IP 允许列表 |
| `.env.production.example` | 配置模板（复制为 `.env.production`） |
| `scripts/backup-db.mjs` | 备份（`VACUUM INTO` + 完整性校验 + 行数比对 + 保留策略） |

| 决策编号 | 内容 |
| --- | --- |
| D-006 | 技术栈：Next.js + Prisma + shadcn/ui + Recharts，全栈单体内网 Docker 部署 |
| D-007 | 内网自部署，不上公有云 |
| D-008 | v1 原定免登录（写入部分已被 D-180 推翻） |
| D-171 | 部署产物与 SQLite 直上路线 |
| D-180 | 写入面口令闸门（共享口令） |
| D-181 | 登录限速 |
| D-188 | `DATABASE_URL` 必须绝对路径 |
| D-194 | 口令永久有效、无过期机制；会话 30 天 |
| D-196 | 服务器规格基线（见 `SERVER_REQUIREMENTS.md`） |
| D-197 | 考勤自动抓取为主 + 人工上传兜底（第 10 步暂缓的原因） |

完整推理过程见项目根目录的 `DECISIONS.md`。
