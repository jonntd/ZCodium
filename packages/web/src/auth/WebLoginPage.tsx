/**
 * ⚠ 未接线（休眠代码，勿当活代码推理）——2026-10-17 复核，依据
 * `docs/spec/web-remote-ui-parity.md` §8.4/§8.5。
 *
 * 「路线 B（官方中继）」手机页的登录态页，上游同步带入；fork 的 main.tsx 不渲染它
 * （同目录 `WebCallbackPage.tsx` 是活的，勿混）。路线 B 数据面未实现 ⇒ 无使用方。
 */
import { useState } from "react";
import { Button } from "@zcode/ui";
import { getWebAuthCopy } from "./webAuthLocale.js";

interface WebLoginPageProps {
  onLogin: () => void;
}

export function WebLoginPage({ onLogin }: WebLoginPageProps) {
  const copy = getWebAuthCopy();
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-sm rounded-lg border border-card-border bg-card p-5 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-ui-xs font-semibold text-foreground">
            Z
          </div>
          <div className="min-w-0">
            <div className="text-ui-xs font-medium text-foreground">{copy.brand}</div>
            <h1 className="text-ui-lg font-medium text-foreground">{copy.loginTitle}</h1>
          </div>
        </div>
        <p className="mb-5 text-ui-xs leading-6 text-foreground-subtle">{copy.loginDescription}</p>
        <Button
          type="button"
          size="lg"
          className="w-full"
          disabled={isSubmitting}
          onClick={() => {
            setIsSubmitting(true);
            onLogin();
          }}
        >
          {copy.loginAction}
        </Button>
      </section>
    </main>
  );
}
