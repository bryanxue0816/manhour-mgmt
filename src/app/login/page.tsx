/**
 * /login - the only screen an unauthenticated visitor can reach besides the dashboard.
 *
 * Public by necessity: this is where a caller becomes an administrator. Everything
 * else about it is deliberately minimal - a Server Component with a plain form posting
 * to a Server Action, no client JavaScript of our own, no autocomplete of the
 * password, and no hint about which half of the credentials was wrong.
 *
 * `force-dynamic` for the same reason as the other routes: prerendering at build time
 * would evaluate this on a machine without the environment configured.
 */
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { login } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "管理员登录 | 工时管理系统",
  description: "计划与主数据维护需要管理员口令",
};

/** Error codes `login()` redirects back with. */
const MESSAGES: Record<string, string> = {
  bad: "口令不正确，请重新输入。",
  unset: "服务端尚未配置管理员口令，请联系系统维护人员设置 ADMIN_PASSWORD。",
  throttled: "尝试次数过多，本机已被暂时限制，请等待 15 分钟后再试。",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; from?: string }>;
}): Promise<ReactElement> {
  const params = await searchParams;
  const errorMessage = params.error === undefined ? null : MESSAGES[params.error];
  const from = typeof params.from === "string" ? params.from : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <h1 className="text-xl font-semibold text-foreground">管理员登录</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            查看看板不需要登录。录入计划、导入数据与维护主数据需要管理员口令。
          </p>
        </div>

        <form action={login} className="space-y-4">
          {/* Carried through so a redirected visitor lands back where they aimed. */}
          <input type="hidden" name="from" value={from} />

          <div className="space-y-2">
            <label htmlFor="password" className="text-sm font-medium text-foreground">
              管理员口令
            </label>
            <Input
              id="password"
              name="password"
              type="password"
              // The browser must not offer to remember this on a shared machine.
              autoComplete="off"
              autoFocus
              required
              aria-invalid={errorMessage !== undefined && errorMessage !== null}
              aria-describedby={errorMessage == null ? undefined : "login-error"}
            />
          </div>

          {errorMessage == null ? null : (
            // role="alert" so the message is announced, not just coloured.
            <p id="login-error" role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}

          <Button type="submit" className="w-full">
            登录
          </Button>
        </form>

        <p className="mt-6 text-xs text-muted-foreground">
          口令为管理员共用，因此操作记录只能追溯到「改了什么」，无法区分具体是哪一位管理员。
        </p>
      </div>
    </div>
  );
}
