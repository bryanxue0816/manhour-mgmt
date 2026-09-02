# 工时管理系统（Man-Hour Management System）

月度工时「计划 / 挑战 / 实绩」可视化管控台。公司内网自部署。

**访问控制**：看板（`/`）匿名可读；`/plans`、`/admin`、导入页需管理员口令（D-180 已推翻 D-008 的「v1 免登录」写入部分），并带登录限速（D-181）。

> 设计文档：[../DESIGN.md](../DESIGN.md) · 决策记录：[../DECISIONS.md](../DECISIONS.md) · 实现计划：[../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) · **部署手册：[docs/DEPLOY.md](docs/DEPLOY.md)**

## 技术栈

- Next.js 16（App Router）+ React 18 + TypeScript 5
- shadcn/ui + Tailwind CSS 4
- Recharts 3
- Prisma 7（driver-adapter 模式）+ **SQLite**
- SheetJS (xlsx) · Vitest

精确版本以 `package.json` / `package-lock.json` 为准。

> **数据库就是 SQLite，dev 和 prod 都是**（D-171「SQLite 直上」）。PostgreSQL 迁移是独立批次 5B，**尚未启动**——`schema.prisma` 里的 `[PG]` 注释标出了届时每处要换的类型。不要照着旧文档去切 provider。

## 环境要求

- **Node.js >= 24**（`package.json` 的 `engines` 下限；Next 16 自身要求 >= 20.9）
- npm

> 内网服务器按 Node 18 装会直接起不来。这一条以前写错过。

## 环境变量

复制 `.env.example` 为 `.env` 后逐项填写（**口令与密钥的值只手工填入，不要提交、不要打印**）：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLite 路径。**standalone 部署必须用绝对路径**，否则会在 `.next/standalone/` 内静默新建一个空库（D-188，已实测） |
| `ADMIN_PASSWORD` | 管理员口令，写入面闸门（D-180） |
| `SESSION_SECRET` | 会话 cookie 签名密钥 |
| `COOKIE_SECURE` | 纯 HTTP 内网部署置 `false`，走 HTTPS 时置 `true` |
| `ORG_DATA_SOURCE` | 组织数据来源开关 |

## 快速开始

```bash
npm install
npm run db:migrate      # 建表（应用 prisma/migrations 下的全部迁移）
npm run db:seed         # 灌入 7 部 / 24 课 / FY2026 / 职务规则 / 计划基线
npm run dev
```

访问 <http://localhost:3000>

## 常用命令

| 命令 | 用途 |
|------|------|
| `npm run dev` | 开发服务器 |
| `npm run build` | 生产构建（输出 standalone 产物） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest 全量 |
| `npm run lint` | ESLint |
| `npm run db:studio` | Prisma Studio |
| `npm run db:backup` | 备份 SQLite（须显式传 `--db` 与 `--keep`，见 D-182） |

## 目录结构

```text
src/
├── app/                # App Router：/ 看板、/plans、/actuals、/admin、/login、/api
│   └── admin/audit/    # 审计查看页（计划变更 / 组织变更两条线）
├── components/         # chart / kpi / layout / nav / tree / ui
├── lib/
│   ├── db/             # 仓储层 + adapter（唯一接触 Prisma 的地方）
│   ├── attendance/     # 考勤解析、导入校验、实绩视图
│   ├── plans/          # 计划编辑逻辑
│   ├── auth.ts         # 口令校验 / 会话
│   ├── login-throttle.ts
│   └── calc.ts         # 工时计算规则（D-104/D-105）
├── proxy.ts            # 路由闸门（D-185：原 middleware.ts）
├── generated/prisma/   # Prisma client 生成产物（已 gitignore）
└── types/
prisma/
├── schema.prisma
├── migrations/
└── seed.ts
tests/                  # 按被测目录镜像：db / attendance / calc / plans / admin / security
docs/DEPLOY.md          # 部署手册（含三个致命陷阱，部署前必读）
nginx.conf              # 反向代理 + IP 白名单模板
```

## 当前进度

Phase 0~4 已完成，**Phase 5（真实数据接通 + 部署收尾）进行中**。阶段划分与逐项状态见 [../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)；所有已锁定的技术与业务决策见 [../DECISIONS.md](../DECISIONS.md)。

唯一的非开发阻塞项是内网 Linux 服务器就位。
