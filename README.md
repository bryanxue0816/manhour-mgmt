# 工时管理系统（Man-Hour Management System）

月度工时「计划 / 挑战 / 实绩」可视化管控台。公司内网自部署，v1 免登录。

> 设计文档：[../DESIGN.md](../DESIGN.md) · 决策记录：[../DECISIONS.md](../DECISIONS.md) · 实现计划：[../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)

## 技术栈

- Next.js 14 (App Router) + TypeScript
- shadcn/ui + Tailwind CSS
- Recharts 3
- Prisma 7 + SQLite（dev）/ PostgreSQL（prod，Phase 2 起）
- SheetJS (xlsx)

## 环境要求

- Node.js >= 18.17（本机 v24.15.0）
- npm

## 快速开始

```bash
# 安装依赖
npm install

# 同步数据库（SQLite，首次会创建 dev.db）
npx prisma db push

# 启动开发服务器
npm run dev
```

访问 <http://localhost:3000>

## 目录结构

```text
src/
├── app/              # Next.js App Router（layout / page / globals.css）
├── components/
│   ├── layout/       # AppShell 三栏布局
│   ├── nav/          # Breadcrumb 面包屑
│   ├── tree/         # OrgTree 组织树导航
│   └── ui/           # shadcn/ui 组件
├── generated/prisma/ # Prisma client（生成产物，已 gitignore）
└── lib/
    ├── prisma.ts     # Prisma client 单例
    └── utils.ts      # shadcn 工具函数
prisma/
└── schema.prisma     # 数据模型
```

## 开发阶段

见 [../IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md)：

- Phase 0 脚手架与基础设施（当前）
- Phase 1 v0.1 看板 demo（mock 数据）
- Phase 2 数据层与主数据（切 PostgreSQL + Docker）
- Phase 3 计划工时录入
- Phase 4 考勤抓取与实绩计算
- Phase 5 真实数据接通 + 部署收尾

## 数据库切换（Phase 2）

dev 用 SQLite（零依赖）。Phase 2 切 PostgreSQL：

1. 改 `prisma/schema.prisma` 的 `provider` 为 `postgresql`
2. 改 `.env` 的 `DATABASE_URL` 为 PostgreSQL 连接串
3. `npx prisma db push`
