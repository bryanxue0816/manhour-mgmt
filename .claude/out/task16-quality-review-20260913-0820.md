# Task 16 考勤停摆邮件告警 — 工程/运维行为质量评审

- 日期：2026-09-13 08:20
- 评审范围：Dockerfile（HEAD 408d72e diff）、deploy/cron/check-attendance-alert.sh、deploy/cron/crontab.example、docs/DEPLOY.md :367–432
- 方式：只读静态核对，未 build、未改文件。冻结块逐字内容不做措辞评审；文档承诺与代码矛盾项按「计划勘误」登记。

## Verdict: CHANGES-REQUESTED

无 CRITICAL；2 个 HIGH（1 个镜像运行链确定性缺口、1 个 wrapper 默认路径勘误），2 个 MEDIUM（runbook 两处事实性承诺与代码不符，走计划勘误），其余 LOW。

HIGH-1 已被 Dockerfile 注释显式推迟到 Task 17 实测闭环（注释本身没有过度承诺），但它是**静态可判定**的缺失而非"只能靠实跑发现"，建议 Task 17 直接照单修，不要重新踩坑。HIGH-2 与 MEDIUM-3/4 属冻结文本勘误，需计划方裁决后由对应任务改。

---

## 发现清单

### HIGH-1 ｜ 镜像内 tsx 启动必缺 esbuild（附-1 验收命令在当前镜像上必然失败）

- 位置：Dockerfile:202（COPY tsx，未 COPY esbuild）；受影响验收命令 DEPLOY.md:377-378
- 证据：
  - tsx 4.23.8 的唯一硬依赖是 esbuild：`node_modules/tsx/package.json` dependencies = `{"esbuild":"~0.28.0"}`（fsevents 仅 darwin optional）。
  - tsx 主 bundle 首行静态 import：`node_modules/tsx/dist/index-CVGQLgGk.mjs:1` → `import{version…,transform…,transformSync…}from"esbuild"`。esbuild 缺失时 tsx 在加载阶段即 ERR_MODULE_NOT_FOUND，**横幅与 JSON 都不会出现**，node 退出码为 1（静态 import 在 `main().catch` 注册前失败，scripts/check-attendance-alert.ts:84-96 的 scan-fatal/exit=2 兜底接不住）。
  - `.next/standalone` 实测无 esbuild（`find .next/standalone -name "esbuild*"` 零命中；Next 请求路径不 import tsx，不被 trace）。
  - runner 阶段除 :202 的 tsx 外没有任何 esbuild COPY；builder 层有完整的 `node_modules/esbuild`（0.28.1）。
  - esbuild 0.28 的平台二进制是 optionalDependency 分包：Linux builder 里还需要 `node_modules/@esbuild/linux-x64`（本机 win32 只有 @esbuild/win32-x64 佐证该机制），只 COPY esbuild 本体仍会报 "you installed esbuild for another platform"。
- 缓释事实：Dockerfile:233-235 注释明确写了"运行时解析以 image-test 任务对构建后镜像实测为准，缺什么只在实测证明缺失时补，不做投机 COPY"——注释没有撒谎，故不构成"无法兑现的承诺"。nodemailer 注释（:203-207）经核实也准确：nodemailer 10.0.9 `dependencies` 为空，"one package directory is the whole requirement" 成立。
- 建议（Task 17）：在 runner 阶段补
  `COPY --from=builder /app/node_modules/esbuild ./node_modules/esbuild`
  `COPY --from=builder /app/node_modules/@esbuild/linux-x64 ./node_modules/@esbuild/linux-x64`
  （若规划 arm64 再加 linux-arm64），然后在构建后镜像里原样执行附-1 命令验收。
- 同一实测需顺带确认的其余链路（静态推理均已满足，列给 Task 17 打勾，不需现在改）：
  - 适配器原生 addon：standalone 已 trace 进 `node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3/build/Release/better_sqlite3.node`（本机 win 构建已见该路径结构；Linux 构建内为 linux 二进制，机制相同）；`bindings`/`file-uri-to-path` 等也在 standalone 根 node_modules。
  - Prisma 7 driver-adapter 模式不需 Rust query engine；`@prisma/client/runtime/client` 在 standalone 内；脚本不需 prisma/ schema 目录。
  - tsconfig.json 已 COPY（:237），`@/* → ./src/*` 生效；src/lib（:238）+ src/generated（:239）覆盖脚本全部 import 闭包（alerts/*、attendance/import-staleness、db/date、db/import-log.repo+import-status+types、validation/email、lib/prisma；date.ts 仅 import 本地 type，email.ts 零 import；generated 仅依赖 @prisma/client）。
  - WORKDIR /app（Dockerfile:135）下 `node_modules/tsx/dist/cli.mjs` 与 `scripts/check-attendance-alert.ts` 路径成立。
  - backup-db.mjs 既有运行方式完整保留：整目录 COPY（:236）包含该文件，better-sqlite3 整包 COPY 仍在（:227），cwd=/app 与 `--db data/dev.db` 相对路径均未变，DEPLOY 第 11 步命令不受影响。

### HIGH-2 ｜ 计划勘误：wrapper 默认 cd 目录与全文标准部署布局矛盾，且漏 -f

- 位置：deploy/cron/check-attendance-alert.sh:10-13 vs docs/DEPLOY.md:47/:376/:461
- 事实：
  - DEPLOY 全局口径是「所有命令在 `/opt/manhour-mgmt/app` 执行」（:47,:58,:111）；附-1 手动命令（:376-377）与第 11 步备份 cron（:461）都是 `cd /opt/manhour-mgmt/app` 且显式 `-f docker-compose.prod.yml`。
  - wrapper 样板却是 `cd /opt/manhour-mgmt` + 不带 `-f`。该父目录按 DEPLOY 自己的布局没有任何 compose 文件；且 compose 自动发现文件名只有 compose.yaml/docker-compose.yml 等，**不含** docker-compose.prod.yml。按样板照装，cron 每次必报 "no configuration file provided" 而失败。
  - wrapper 注释 :8-9 自称 "kept identical to the existing fetch wrapper"，VERIFY 锚点 `/opt/manhour-mgmt/scripts/fetch-attendance.sh`：仓内不存在该文件（全仓 find 零命中），且 DEPLOY:354-363 第 10 步明确考勤抓取尚未上线（D-197，脚本不在生产镜像，HR 报表时刻未知）——现网大概率**没有**这个可对照的 wrapper。
  - 附-2 :406 虽然点名了该差异，但只指示"改 wrapper 里的 cd 行"；在标准布局上还**必须同时**加 `-f docker-compose.prod.yml`，文档未明说第二处改动。附-4 :429 的排查行能兜底（cron 毫无记录→查 cd 路径），但属于事后发现。
- 建议裁决（二选一，均需勘误冻结文本）：
  1. wrapper 样板直接对齐第 11 步：`cd /opt/manhour-mgmt/app` + `docker compose -f docker-compose.prod.yml exec -T app …`，注释里的 VERIFY 改为"与备份 cron 同目录"；或
  2. 保留样板但在附-2 显式写：若不存在 fetch wrapper，cd 与 -f **两处**都要按第 11 步改。

### MEDIUM-3 ｜ 计划勘误：附-1 称"从未导入状态有 dry-run 发信行"，代码上首次扫描是 baseline、不发信

- 位置：docs/DEPLOY.md:386
- 代码事实：
  - level="never" 且无状态文件 → 决策 `baseline`（alert-decision.ts:42-44）；dry-run 只对 skip/baseline 以外的决策调 send（alert-service.ts:114-124）。
  - 干跑模式永不创建状态文件（alert-service.ts:114-138，仅当 prev!==null 才 touch），所以默认干跑部署下，从未导入系统**每次**扫描都是 baseline，永远不会出现 `alert-email-dry-run` 行。
  - 实际首跑输出第三种形态：横幅 + `scan-start` + `alert-decision{level:"never",decision:"baseline"}` + `scan-done`，exit=0。runbook 只写了两种形态（停摆/从未导入→有发信行；健康→无行），`baseline` 这个决策值全文未解释；:432 健康行又只举了 `decision:"skip"`。
  - 对照：真正停摆（历史上有成功导入、距今≥3 日历日）且无 state 时才是 send-first→有 dry-run 行（email-sender.ts:51-58，字段 toCount/subject 一致）。
- 影响：现网若上线时还没成功导入过考勤（第 10 步暂缓、走人工上传前的空库），运维照附-1 验收会找不到发信行，文档把该形态误归为"健康"，可能误判。
- 建议裁决：把附-1 验收点 2 改为三态：停摆（stale）→有 dry-run 行；从未导入首扫（never+baseline）→无发信行、决策 baseline；健康（ok+skip）→无发信行。后两者无发信行均正确。

### MEDIUM-4 ｜ 计划勘误：附-4「state-corrupt 已自愈重写」在默认干跑模式下不成立

- 位置：docs/DEPLOY.md:428
- 代码事实：readAlertState 对损坏文件打 `state-corrupt` 后返回 null（alert-state.ts:150-173）。是否重写取决于模式：
  - live：skip/baseline/send 各路径都会 writeState，损坏文件本轮即被覆盖（alert-service.ts:141-170），"自愈重写"成立。
  - dry-run（出厂默认）：prev===null 时**完全不写**（alert-service.ts:125-136 只在 prev!==null 时 touch），损坏文件原样留在卷上，之后每次扫描重复打 state-corrupt、exit 仍为 0。
- 因此"本次已按首扫自愈重写"在干跑下为假；"反复出现说明卷有问题"在干跑下也为假——重复出现是预期行为而非卷故障。exit=0、不算故障、决策按首扫处理这三点是对的。
- 建议裁决：该行按模式拆分或改为"本次按首扫处理、exit=0；live 模式本轮重写文件，dry-run 模式不重写（反复出现属正常，转 live 后自愈）"。

### LOW-5 ｜ wrapper 注释的 "host cron MAIL/log" 与样板 crontab 不一致

- check-attendance-alert.sh:4 说失败由 "host cron MAIL/log" 留痕；crontab.example:2 把 stdout/stderr 全部 `>> log 2>&1`，cron 无输出可投递 MAILTO（文件也没设 MAILTO）。实际留痕靠 log，设计意图（非零退出+有痕）仍满足。仅注释措辞问题，登记即可。

### LOW-6 ｜ crontab 注释的 "after the 09:05 / 15:05 fetches" 锚点尚不存在

- crontab.example:1 假设抓取任务 09:05/15:05 运行，但第 10 步（DEPLOY:354-363）明确抓取未上线、HR 报表生成时刻是待确认信息，仓内也没有 fetch wrapper/排期。功能无影响（告警不依赖抓取存在），但注释可能在未来误导排期决策。

### LOW-7 ｜ 附-3 第 2 步 `up -d` 与文档他处 `--force-recreate` 不统一（非缺陷）

- DEPLOY.md:415 用 `up -d` 让 env_file 生效；Compose v2 会把 env_file 内容纳入服务配置哈希、内容变化即 recreate，说法成立。同文件 :493 改口令用的是 `up -d --force-recreate app`。统一更稳妥，但不构成错误。

### LOW-8 ｜ 附-4「cron 毫无记录」漏了日志文件自身不可写

- `>> /var/log/manhour-attendance-alert.log` 在非 root crontab 下若文件/目录不可写，shell 重定向失败、cron 只能走本地邮件，日志文件反而毫无记录。文档部署口径基本是 root（大量 sudo），可能性低，建议排查行补一句"日志文件权限/属主"。

### LOW-9 ｜ state-write-failed 排查行未覆盖"发信成功后落账失败"子情形

- DEPLOY.md:427「意图未能落盘时本次不发信」与 alert-service.ts:162-170 一致；但同一事件+exit=2 还出现在邮件**已发出后** sentState 落盘失败（:185-196），此时"本次不发信"不成立（信已送达，只是落账失败，意图日期仍抑制同日重发）。概率极低（同一轮 intent rename 成功后 sent rename 才失败，如磁盘中途写满），可加半句限定。

### LOW-10 ｜ 465/SECURE 交叉校验不存在——runbook 是建议不是承诺，措辞可接受

- email-config.ts:115-132 对端口与 secure 无交叉校验；runbook :414「465 端口须把 SMTP_SECURE 改 true」是操作建议（nodemailer 语义 secure=true=隐式 TLS 与代码注释一致）。配错不会 config-error，而会在发送时 alert-email-failed，恰好被附-4 第二行覆盖。无需改，仅记录裁决：不视为矛盾。

---

## A. Shell 正确性 — 小结：通过

- `set -euo pipefail` 逐路径推演：cd 失败（:10）→立即非零退出；docker/compose 不存在→127；容器未运行→`docker compose exec` 返回 1 并向 stderr 打 "not running"；容器内 node 退出 1/2→exec 透传同码。四类失败 wrapper 均非零退出，且 crontab 的 `2>&1` 保证宿主日志留痕——"容器停了就留痕"的设计意图成立。pipefail 在本脚本无 pipe，无害；-u 无未引用变量。
- `-T` 对 cron 必要且充分（compose exec 默认分配 TTY）；:12-13 反斜杠续行正确；全常量无单词展开/注入面；路径无空格场景（/opt/manhour-mgmt）。
- `20 9,15 * * *` 语义确为每天 09:20/15:20，与「09:05/15:05 抓取之后」自洽（锚点存在性见 LOW-6）；`>> file 2>&1` 文件不存在时由 shell 创建；chmod 路径（:396）、crontab 路径（:403）、wrapper 内 cd（:10）三者的不一致仅 HIGH-2 所述一处。
- 时区：cron 按宿主机本地时区解释时刻；业务日计算由 Intl 锁定 Asia/Shanghai（alert-state.ts:39-55），即使宿主机是 UTC 频控日期也不会错，只是扫描墙点漂移；与第 11 步备份 cron 同一假设，不另报。

## B. 镜像 tsx 运行链 — 小结：1 个确定性缺口（HIGH-1），其余静态推理闭合

esbuild（+@esbuild/linux-x64）必缺，附-1 命令在补 COPY 前无法成功；tsx、tsconfig、src/lib、src/generated、nodemailer、适配器嵌套原生 addon、Prisma client runtime、backup 链均已就位或由 standalone trace 覆盖。Dockerfile 注释把缺口诚实推迟给 Task 17，未做"这就是全部"的承诺（:228-235）；nodemailer 零依赖经 package.json 实证为真。

## C. Runbook vs 代码 — 小结：退出码/事件名/字段/配置语义全部对得上，2 处行为描述勘误

逐条核对通过的项（证据从略，均已对照源码）：
- 阈值 3 个自然日（import-staleness.ts:23，日历日投影 :92-94）；每天两次 09:20/15:20；闹钟在容器外的理由与 wrapper 行为一致。
- 横幅确为每次运行第一行（check-attendance-alert.ts:54，import 期无 stdout），字面含 `MODE=DRY-RUN`（:42-44）；事件 scan-start/alert-decision/scan-done/alert-email-dry-run 均真实存在，字段 toCount/subject 一致（email-sender.ts:53-55）；健康系统确无干跑发信行（alert-service.ts:114-124）；exit=0。
- 干跑不创建 alert-state.json（:125-136 仅 prev 存在才 touch）、不推进任何频控日期（touchedState 只动时间戳，alert-state.ts:213-216）；连跑两遍输出一致；prod DATABASE_URL=file:/app/data/dev.db 下 state 落 /app/data/alert-state.json（alert-state.ts:64-88），`ls data/` 指令成立。
- 附-3：env_file 改动经 compose v2 哈希触发 recreate；收件人上限 3（email-config.ts:38,:100-104）；USER/PASS 必须同配同空（:111-113）；默认端口 25/secure false（:37,:126）；ALERT_EMAIL_DRY_RUN=true 最高优先（:68-77）；config-error 绝不静默回退（:134-137）；/admin/alerts 渠道卡、角标（alerts-summary.ts:60，admin/page.tsx:31,218 引用）、「发送测试邮件」按钮（page.tsx:238）与 action（actions.ts，干跑只写日志、不碰频控状态）均如文存在。
- 附-4 码值表：config-error→1（alert-service.ts:51-55,:93-96）；alert-email-failed→1 且 failedState 不挪日期→同日不重试（:202-212 + alert-state.ts:255-258）；db-read-failed→2 且先于任何 state IO 短路（:75-81）；state-write intent 失败→2 且不发信（:162-170）。码值与事件名无张冠李戴。
- 不符项：MEDIUM-3（never+baseline 干跑无发信行）、MEDIUM-4（干跑不自愈重写 corrupt 文件）、LOW-9（post-send 落账失败子情形）。

## D. 其他 — 小结：通过

- 安全：wrapper 无注入面；日志只出现收件人数量与无 PII 的 subject（停摆邮件主题只含天数），邮箱地址不入日志（email-sender.ts:50-57）；SMTP 错误经 sanitizeSmtpError 脱敏后才入 state/日志（:32-42,:85），页面显示"最近错误（已脱敏）"（page.tsx:218）；runbook 示例无真实口令、无真实经理邮箱（通读过 :367-432）；测试 action 重定向只带 outcome 枚举（actions.ts 注释）。
- 可操作性：附-1→附-2→附-3 主路径可无歧义执行，唯 HIGH-2 的 wrapper 落点与两处修改说明会绊倒首次安装者；无死链；引用路径（scripts/、deploy/cron/）真实存在。
- 注释英文、风格与 Dockerfile/wrapper 其余部分一致；DEPLOY 中文正文为既有语言。

## 运行过的命令

1. `git log --oneline -3` + 列目录（src/lib/alerts、deploy/cron、scripts）
2. Read：scripts/check-attendance-alert.ts；deploy/cron/check-attendance-alert.sh；crontab.example；alert-service.ts；alert-decision.ts；alert-state.ts；email-config.ts；email-sender.ts；alert-template.ts；import-staleness.ts；src/lib/prisma.ts；import-log.repo.ts；actions.ts(部分)；docker-compose.prod.yml(30-80)；Dockerfile(100-267)；DEPLOY.md(300-555)；tsconfig.json(头部)
3. `node -e` 读 nodemailer/tsx/esbuild package.json（版本、dependencies、optionalDependencies）
4. `find .next/standalone` 查 esbuild、*.node、@prisma 嵌套 better-sqlite3
5. `grep` tsx/dist bundle 的 esbuild 静态 import
6. `grep` generated client 外部依赖；date.ts/email.ts import
7. `grep` 干跑/测试邮件/lastError 于 admin/alerts 与 admin/page
8. `grep` DEPLOY 全部 /opt/manhour-mgmt 路径
9. `grep` .env.production.example 的 DATABASE_URL 与 SMTP_* 变量名（值未读取）
10. `git show HEAD -- Dockerfile` 确认 diff 范围
