import {
  TID_LOGIN_TRIGGER,
  TID_OAUTH_CANCEL,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
} from "@zcode/shared";
import { clearAppData, clickTestIdByDom, waitForTestIdByDom } from "./helpers/desktop-app.js";

const CASE_TIMEOUT_MS = 240_000;
// PlatformChannels.OAuthCallback 的 channel 值(main 进程 execute 里无法 import @zcode/shared,
// 与 packages/shared/src/channels.ts 保持一致)
const OAUTH_CALLBACK_CHANNEL = "zcode:oauth-callback";
// state 不匹配的回调:oauthService.handleCallback 在无 pending flow 时会抛
// "OAuth state 不匹配或已过期",复现 OAuth deep link 失败的真实链路。
const TAMPERED_OAUTH_CALLBACK_URL = "zcode://oauth/callback?state=e2e-tampered-state&code=e2e-code";

describe("OAuth 登录失败态的取消交互", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("AUTH-05: 回调失败进入失败态(重新登录+取消),取消后回到渠道列表", async function () {
    this.timeout(CASE_TIMEOUT_MS);

    await ensureLoginPanelOpen();
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON, {
      timeout: 20_000,
      timeoutMsg: "登录面板没有展示渠道按钮",
    });

    await deliverTamperedOAuthCallback();

    await waitForTestIdByDom(TID_OAUTH_ERROR, {
      timeout: 20_000,
      timeoutMsg: "OAuth 回调失败后没有出现错误提示",
    });
    await waitForTestIdByDom(TID_OAUTH_CANCEL, {
      timeout: 20_000,
      timeoutMsg: "登录失败态没有展示取消按钮",
    });
    // Bugfix 回归锚点:失败态整体替换渠道列表,不再与渠道按钮同屏
    expect(await hasChannelButton()).toBe(false);

    await clickTestIdByDom(TID_OAUTH_CANCEL, {
      timeout: 20_000,
      timeoutMsg: "登录失败态的取消按钮不可点击",
    });
    await waitForTestIdByDom(TID_OAUTH_LOGIN_BUTTON, {
      timeout: 20_000,
      timeoutMsg: "失败态取消后没有回到渠道列表",
    });
    expect(await hasOAuthError()).toBe(false);
  });
});

async function ensureLoginPanelOpen(): Promise<void> {
  await browser.waitUntil(async () => (await hasChannelButton()) || (await hasLoginTrigger()), {
    timeout: 60_000,
    timeoutMsg: "启动后没有出现 OAuth 登录面板或工作区侧栏",
  });

  if (await hasChannelButton()) {
    return;
  }

  await openProviderConnectFromCommandPalette();
}

async function openProviderConnectFromCommandPalette(): Promise<void> {
  const opened = await browser.execute(() => {
    const button = Array.from(document.querySelectorAll("button")).find((item) =>
      /^(Search|搜索|جستجو)/.test(item.textContent?.trim() ?? ""),
    );
    button?.click();
    return Boolean(button);
  });
  if (!opened) throw new Error("没有可见的命令面板入口");

  const input = await browser.$('[data-slot="command-input"]');
  await input.waitForDisplayed({ timeout: 20_000 });
  await input.setValue("login");
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll('[data-slot="command-item"]')).some((item) =>
          /connect|连接|اتصال/i.test(item.textContent ?? ""),
        ),
      ),
    { timeout: 20_000, timeoutMsg: "命令面板中没有模型提供商连接入口" },
  );
  const clicked = await browser.execute(() => {
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="command-item"]'),
    ).find((entry) => /connect|连接|اتصال/i.test(entry.textContent ?? ""));
    item?.click();
    return Boolean(item);
  });
  if (!clicked) throw new Error("无法选择模型提供商连接命令");
}

async function deliverTamperedOAuthCallback(): Promise<void> {
  // 坏 state 不在 main 的 oauthStateToWindow 路由表里,走 app.emit("open-url") 会被
  // 当作"未命中窗口"缓存而无法送达 renderer;这里直接向主窗口投递 OAuthCallback IPC,
  // 覆盖 preload → platform.onOAuthCallback → handleCallback 失败 → oauthError 的真实链路。
  const delivered = await browser.electron.execute(
    (electron, channel, url) => {
      const target = electron.BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      if (!target) {
        return false;
      }
      target.webContents.send(channel, url);
      return true;
    },
    OAUTH_CALLBACK_CHANNEL,
    TAMPERED_OAUTH_CALLBACK_URL,
  );
  expect(delivered).toBe(true);
}

async function hasChannelButton(): Promise<boolean> {
  return (await browser.execute((loginButtonId: string) => {
    return Boolean(document.querySelector(`[data-testid="${loginButtonId}"]`));
  }, TID_OAUTH_LOGIN_BUTTON)) as boolean;
}

async function hasOAuthError(): Promise<boolean> {
  return (await browser.execute((errorId: string) => {
    return Boolean(document.querySelector(`[data-testid="${errorId}"]`));
  }, TID_OAUTH_ERROR)) as boolean;
}

async function hasLoginTrigger(): Promise<boolean> {
  return (await browser.execute((loginTriggerId: string) => {
    return Boolean(document.querySelector(`[data-testid="${loginTriggerId}"]`));
  }, TID_LOGIN_TRIGGER)) as boolean;
}
