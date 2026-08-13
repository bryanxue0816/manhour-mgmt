# 自动提交（auto-commit）

每 20 分钟把工作区的改动自动存成一条 `wip:` 提交，目的只有一个：**再也不要出现「三周工作没有回滚点」**（见 `IMPLEMENTATION_PLAN.md` 曾经的第 187 行警告）。

## 它不是什么

- **不替代手写提交。** 自动生成的信息写不出「相对 `DATABASE_URL` + standalone 的 chdir 会生成 0 字节 db → P2021 → 回落 demo 数据却仍返回 HTTP 200」这种东西。里程碑仍然要手写提交。
- **不是备份。** 本仓库**没有远端**（`git remote -v` 为空），所以它只防误删和改坏，**不防硬盘损坏**。真要防丢，加远端 + push，或用 `npm run db:backup`。

## 组成

| 文件 | 作用 |
|---|---|
| `scripts/auto-commit.mjs` | 全部逻辑 |
| `scripts/auto-commit.cmd` | 任务计划用的包装器（固定工作目录 + 写日志） |
| `.autocommit/` | 锁与日志，**已 gitignore** |

任务计划项名：`ManhourAutoCommit`，每 20 分钟，`MultipleInstances = IgnoreNew`。

## 命令

```bash
npm run save        # 立刻存一次
npm run save:dry    # 空跑：只看会提交什么，不真提交
```

## 闸门策略

这是本设计里唯一需要理解的取舍：

| 情况 | 行为 | 为什么 |
|---|---|---|
| 疑似密钥 | **中止，不暂存任何文件**，退出码 2 | 坏提交能 amend，进了历史的密钥洗不掉 |
| typecheck / 单测失败 | **照常提交**，标题加 `[gate-failed]`，信息里附失败尾部输出 | 改到一半的坏代码正是最需要回滚点的时候 |
| 无改动 | 跳过，不产生空提交 | |
| 有文件在 90 秒内被改过 | 整轮跳过 | 避免定时任务在你打字打到一半时快照中间态 |
| 正在 merge / rebase / 有 index.lock | 跳过 | 不干扰进行中的 git 操作 |

只有改动包含 `.ts/.tsx` 时才跑 typecheck 和单测；只改文档不会白等几分钟。

## 密钥扫描误报了怎么办

误报的后果不是烦人，是**自动提交长期静默失效**——每轮都中止，你却以为在存。所以发现误报要马上处理：

1. 看 `.autocommit/task.log` 里的 `✗` 行，它会指出文件和命中原因。
2. 如果那文件本来就不该进仓库 → 加进 `.gitignore`。
3. 如果是占位符模板被误判 → 在 `scripts/auto-commit.mjs` 的 `SECRET_CONTENT_ALLOWLIST` 或 `SECRET_PATH_ALLOWLIST` 里登记。已支持的占位符写法：`change_me` / `your_password` / `<...>` / `xxx` / `replace_this`，以及 `.example` / `.sample` / `.template` 结尾的文件。

## 把一串 wip 压成一条正经提交

```bash
git log --oneline            # 找到最后一条非 wip 提交
git reset --soft <那条的 hash>
git commit                   # 手写一条真正的提交信息
```

`--soft` 只挪 HEAD，改动全部留在暂存区，不会丢东西。

## 维护

```powershell
# 查看状态
Get-ScheduledTaskInfo -TaskName 'ManhourAutoCommit'
# 暂停 / 恢复
Disable-ScheduledTask -TaskName 'ManhourAutoCommit'
Enable-ScheduledTask  -TaskName 'ManhourAutoCommit'
# 卸载
Unregister-ScheduledTask -TaskName 'ManhourAutoCommit' -Confirm:$false
```

日志无限增长时直接删 `.autocommit/task.log` 即可，脚本会重建。

## 已知坑（都已在实现里处理，改动脚本时别踩回去）

1. **`.autocommit/` 必须保持 ignored。** 否则它自己的日志会让工作区永远处于「刚被改过」，静默期永不满足，自动提交**一次都不会触发**。
2. **提交信息标题后的空行是功能性的。** Git 靠第一个空行分隔标题与正文；早期版本用 `.filter(part => part !== "")` 把它过滤掉了，结果 `git log --oneline` 每条打印几百字符。
3. **信息经临时文件传给 `-F`，不用 stdin。** `execFileSync` 的 `input` 配 `git commit -F -` 会把换行压平。
4. **`.cmd` 里的 `mkdir` 不能删。** cmd 在 node 启动**前**求值重定向，目录不存在时首次运行直接失败，永远跑不到创建目录的代码。
5. **状态解析用 `--porcelain -z -uall`。** 本项目有中文路径，行分隔格式会把它们转义引号化。
