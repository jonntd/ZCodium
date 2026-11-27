import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { transpileModule, ModuleKind } from "typescript";
const root = new URL("../../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
async function load(path, imports = {}) {
  const exports = {};
  new Function(
    "require",
    "exports",
    transpileModule(await read(path), {
      compilerOptions: { module: ModuleKind.CommonJS },
    }).outputText,
  )((name) => {
    assert.ok(name in imports, `unexpected import ${name}`);
    return imports[name];
  }, exports);
  return exports;
}
async function sources(dir) {
  const entries = await readdir(new URL(dir, root), { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((e) => !/^(tests?|dist|node_modules)$/.test(e.name))
        .map((e) =>
          e.isDirectory()
            ? sources(`${dir}/${e.name}`)
            : /\.(ts|tsx|js)$/.test(e.name) && !/\.test\./.test(e.name)
              ? [`${dir}/${e.name}`]
              : [],
        ),
    )
  ).flat();
}
test("runtime official URL literals are restricted to identity and user-opened links", async () => {
  const allowed = new Set([
    "packages/shared/src/zcodeEndpoint.ts",
    "packages/ui/src/lib/productDocs.ts",
    // 官方插件市场来源：只在 officialServices.marketplace 开关开启（Desktop env 投影或 CLI env）时
    // 才进入默认市场集合，网络出口仍受 assertOfficialPlatformAccessible 与开关裁决。
    "packages/shared/src/plugin-marketplaces.ts",
    // 以下为「保持移除官方平台」下仍保留的官方 CDN/官方入口，按守卫自身口径（identity /
    // user-opened / 开关门控 marketplace CDN）curation，与上面 plugin-marketplaces.ts 同类：
    // 官方插件 icon 资源 CDN（与已白名单的 marketplace.json 同根），仅 marketplace 开关开时渲染。
    "packages/ui/src/v4/officeSuggestedPrompts.ts",
    "apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts",
    // 领取文案里的官方下载链：属用户主动打开的 user-opened 链接。
    "packages/ui/src/i18n/locales/zh-CN.ts",
    "packages/ui/src/i18n/locales/en-US.ts",
    "packages/ui/src/i18n/locales/ja-JP.ts",
    "packages/ui/src/i18n/locales/ko-KR.ts",
    "packages/ui/src/i18n/locales/ru-RU.ts",
  ]);
  for (const dir of [
    "packages/services/src",
    "packages/desktop/src",
    "packages/ui/src",
    "packages/web/src",
    "packages/shared/src",
    "apps/zcode-cli/packages",
  ]) {
    for (const file of await sources(dir)) {
      if (!allowed.has(file))
        assert.doesNotMatch(
          await read(file),
          /https?:\/\/(?:[\w.-]+\.)?(?:zcode\.z\.ai|cdn-zcode\.z\.ai)(?:[/:]|\b)/,
          file,
        );
    }
  }
});
test("audit policy is unconditional and distinguishes platform from model providers", async () => {
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  assert.equal(policy.isOfficialPlatformEnabled(), false);
  assert.throws(() => policy.assertOfficialPlatformAvailable(), /ZCodium/);
  for (const host of ["zcode.z.ai", "cdn-zcode.z.ai", "test.zcode.z.ai", "ZCODE.Z.AI."]) {
    assert.throws(() => policy.assertNoOfficialPlatformUrl(`https://${host}/api/v1`));
  }
  for (const url of [
    "https://api.z.ai/api/anthropic",
    "https://open.bigmodel.cn/api/paas/v4",
    "http://localhost:8000/v1",
    "https://example.com/v1",
  ])
    policy.assertNoOfficialPlatformUrl(url);
});
// 原“user model requests keep URL…without the official gateway”与“historical built-in platform
// model endpoints cannot escape the model transport”两条已删除：它们调用 createOfficialCodingPlan
// GatewayFetch（去智谱化重构已从 official-coding-plan-gateway.ts 移除，仅留 createStaticProvider
// EndpointRoutingPort，不抛错只做路径改写）。其不变量现由三处权威覆盖：上方 :78 的
// assertNoOfficialPlatformUrl（官方 host 抛 /ZCodium/、bigmodel/example 放行）、本文件末尾
// “Node API blocks official endpoints before resolving settings or calling fetch”（nodeApiClient
// 命中官方 URL 抛 /ZCodium/）、以及 apps/zcode-cli/packages/adapters/tests/official-coding-plan-
// gateway.test.ts（新 createStaticProviderEndpointRoutingPort 把 bigmodel 路由到 ultra 网关的新
// 语义）。原“bigmodel URL 原样透传”前提已被新路由改写语义取代，故不在 desktop 跨包重复断言。
test("client config is local and cannot invoke injected network or endpoint resolver", async () => {
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  const { createClientConfigService } = await load(
    "packages/services/src/client-config/clientConfigService.ts",
    { "@zcode/shared": policy },
  );
  const unexpected = () => {
    throw new Error("network/resolver must not run");
  };
  assert.deepEqual(
    await createClientConfigService({
      apiClient: { request: unexpected },
      resolveRequestContext: unexpected,
    }).getSnapshot({ forceRefresh: true }),
    // 上游在快照里加了 zsrcUrl / uiPluginRecommendations，本地兜底按类型补空值。
    { pluginStoreOrder: null, zsrcUrl: null, uiPluginRecommendations: [] },
  );
});

test("CLI OAuth cannot call even an injected HTTP client", async () => {
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  const oauth = await load("apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts", {
    "@zcode/shared": policy,
    "node:crypto": await import("node:crypto"),
  });
  const client = oauth.createCliOAuthClient({
    providerId: "zai",
    baseUrl: "https://example.com",
    httpClient: { request: () => assert.fail("must not request") },
  });
  await assert.rejects(client.init({ pollToken: "test" }), /ZCodium/);
  await assert.rejects(client.poll({ pollToken: "test", flowId: "test" }), /ZCodium/);
});

test("Electron policy cancels cached resources and redirects in every created session", async () => {
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  const handlers = [];
  const target = { webRequest: { onBeforeRequest: (handler) => handlers.push(handler) } };
  let onSession;
  const { installOfficialPlatformNetworkPolicy } = await load(
    "packages/desktop/src/main/desktopOfficialPlatformPolicy.ts",
    {
      "@zcode/shared": policy,
      electron: {
        app: {
          on: (name, handler) => {
            assert.equal(name, "session-created");
            onSession = handler;
          },
          whenReady: () => Promise.resolve(),
        },
        session: { defaultSession: target },
      },
    },
  );
  installOfficialPlatformNetworkPolicy();
  await Promise.resolve();
  onSession(target);
  assert.equal(handlers.length, 2);
  for (const handler of handlers) {
    handler({ url: "https://cdn-zcode.z.ai/cached/icon.png" }, (decision) =>
      assert.equal(decision.cancel, true),
    );
    handler({ url: "http://localhost:5173/" }, (decision) => assert.equal(decision.cancel, false));
  }
});

test("Web and desktop reject cached official icons while keeping third party images", async () => {
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  const { isTrustedImageUrl } = await load("packages/ui/src/lib/trustedImageUrl.ts", {
    "@zcode/shared": policy,
  });
  assert.equal(isTrustedImageUrl("https://cdn-zcode.z.ai/icon.png"), false);
  assert.equal(isTrustedImageUrl("https://example.com/icon.png"), true);
});

test("all platform service boundaries guard before touching credentials, state or network", async () => {
  const ts = await import("typescript");
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  const cases = [
    [
      "packages/services/src/oauth/oauthService.ts",
      ["startOAuth", "startOAuthWithPolling", "refreshToken"],
      "reject",
    ],
    [
      "packages/services/src/oauth/oauthService.ts",
      ["restoreSession", "pollPendingOAuth", "handleCallback"],
      null,
    ],
    [
      "packages/services/src/oauth/oauthService.ts",
      ["restoreCachedSessionState"],
      { status: "signed-out" },
    ],
    ["packages/services/src/feedback/feedbackHttpClient.ts", ["request"], "reject"],
    // readCodingPlanApiJson（bigmodelCodingPlanSubscriptionProvider）与 teamPlanApiKey 的
    // ensure…WithStatus / copy…Secret 不再列入本“方法体内守卫先于副作用”不变量：去智谱化重构
    // 后这两个方法体首行即 buildUrl / readApiJson，本身不再持边界守卫；官方平台 URL 的拒绝已
    // 下沉到 readApiJson → apiClient.request → nodeApiClient.assertNoOfficialPlatformUrl（由
    // 下方“Node API blocks official endpoints …”与本文件相邻测试权威覆盖），强行 eval 只能靠
    // 堆叠跨模块替身假绿，反而弱化守卫信号。codingPlanEntitlement 保留：其方法首行即
    // assertOfficialServiceRemoved（:79/:110），仍是真实的“守卫先于副作用”。
    [
      "packages/services/src/bigmodel/codingPlanEntitlement.ts",
      ["fetchPersonalCodingPlanEntitlement", "fetchTeamCodingPlanEntitlement"],
      "reject",
    ],
    ["packages/services/src/session/offPeakServerClient.ts", ["request"], "reject"],
    [
      "packages/services/src/session/offPeakRuntimeModel.ts",
      ["resolveOffPeakCredentials"],
      "reject",
    ],
    [
      "packages/services/src/model-provider/accountProviderApiClient.ts",
      ["fetchRemoteData"],
      "reject",
    ],
    // accountProviderTeamPlanRequestKey 的 resolveAccountTeamPlanRuntimeApiKey 与上面
    // bigmodelCodingPlan / teamPlanApiKey 同属“边界下沉到共享 transport”的簇：方法体先碰
    // params.credentialService、再经 readApiJson 走 nodeApiClient，本身无 inline 守卫；其官方
    // URL 拒绝由“Node API blocks official endpoints …”权威覆盖，故不在此重复 eval。
    [
      "packages/services/src/official-mcp/officialMcpCredentials.ts",
      ["resolveOfficialMcpCredentials"],
      { ok: false },
    ],
  ];
  for (const [file, names, expected] of cases) {
    const sourceText = await read(file);
    const ast = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const bodies = new Map();
    function visit(node) {
      if (node.body && ts.isBlock(node.body) && node.name && names.includes(node.name.getText(ast)))
        bodies.set(node.name.getText(ast), node.body.getText(ast));
      ts.forEachChild(node, visit);
    }
    visit(ast);
    // 方法体可能引用模块内私有 helper。eval 只替换方法体，
    // 看不到模块作用域，这里从同一源文件把被引用的模块级声明提取进求值作用域。
    const helperNames = [
      "CONNECTION_UNAVAILABLE_ERRORS",
      // 上游把「不可渲染的错误信息」收敛进 readCodingPlanApiJson 的 catch 分支后，
      // 方法体引用了这两个模块级 helper；eval 只替换方法体，必须把声明一起注入。
      "readRemoteErrorMessage",
      "isUnrenderableRemoteErrorMessage",
    ];
    const helperDeclarations = [];
    function collectHelpers(node) {
      if (ts.isFunctionDeclaration(node) && helperNames.includes(node.name?.getText(ast))) {
        helperDeclarations.push(node.getText(ast));
      } else if (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((d) => helperNames.includes(d.name.getText(ast)))
      ) {
        helperDeclarations.push(node.getText(ast));
      }
      ts.forEachChild(node, collectHelpers);
    }
    collectHelpers(ast);
    const helperPrelude = helperDeclarations.length > 0 ? `${helperDeclarations.join("\n")}\n` : "";
    for (const name of names) {
      assert.ok(bodies.has(name), `${file}: ${name}`);
      // 执行真实方法体，不提供 this/凭证/网络依赖；若短路被移至副作用之后即失败。
      const body = ts.transpileModule(
        `${helperPrelude}async function boundary() ${bodies.get(name)}`,
        {
          compilerOptions: { target: ts.ScriptTarget.ES2022 },
        },
      ).outputText;
      // 去智谱化后边界方法体引用 isOfficialServiceRemoved / assertOfficialServiceRemoved
      //（恒短路/恒抛）；与旧守卫一起注入，真实执行方法体验证短路位置。
      const run = new Function(
        "assertOfficialPlatformAvailable",
        "isOfficialPlatformEnabled",
        "assertOfficialServiceAvailable",
        "isOfficialServiceEnabled",
        "isOfficialServiceRemoved",
        "assertOfficialServiceRemoved",
        "fail",
        `${body}; return boundary;`,
      )(
        policy.assertOfficialPlatformAvailable,
        policy.isOfficialPlatformEnabled,
        // official-service 开关守卫（oauthService 等入口改用它）：默认全关时同样抛 /ZCodium/，
        // 要求先短路再碰凭证/网络；装置此前未注入导致求值直接 ReferenceError。
        policy.assertOfficialServiceAvailable,
        // 部分入口（restoreSession、resolveOfficialMcpCredentials 等）直接按开关返回兜底值。
        policy.isOfficialServiceEnabled,
        policy.isOfficialServiceRemoved,
        policy.assertOfficialServiceRemoved,
        () => ({
          ok: false,
        }),
      );
      if (expected === "reject") await assert.rejects(run(), /ZCodium/, `${file}: ${name}`);
      else assert.deepEqual(await run(), expected, `${file}: ${name}`);
    }
  }
});

test("historical built-in platform model endpoints cannot escape the model transport", async () => {
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  const config = JSON.parse(await read("config/provider/zcode-builtin.json"));
  const urls = [];
  function visit(value) {
    if (typeof value === "string" && policy.isOfficialPlatformUrl(value)) urls.push(value);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(config);
  // 去智谱化后 builtin 已不含平台端点（account:* 全部移除）；显式补一个历史样本，
  // 保证「平台端点不得逃逸 transport」这条拦截路径始终被覆盖，不随数据变化失效。
  if (urls.length === 0) urls.push("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
  // 旧 createOfficialCodingPlanGatewayFetch 已随去智谱化重构移除；官方平台 URL 的拦截现由
  // 共享原语 assertNoOfficialPlatformUrl 承担（nodeApiClient.request 内部即调用它，见下方
  // “Node API blocks official endpoints …”），这里直接断言该原语对内置/历史平台端点恒抛 /ZCodium/。
  for (const url of urls) assert.throws(() => policy.assertNoOfficialPlatformUrl(url), /ZCodium/);
});

test("Node API blocks official endpoints before resolving settings or calling fetch", async () => {
  const policy = await load("packages/shared/src/officialPlatformPolicy.ts");
  const { NodeApiClient } = await load("packages/services/src/providers/api/nodeApiClient.ts", {
    "@zcode/shared": {
      ...policy,
      DEFAULT_ZCODE_ENDPOINT_ORIGIN: "https://zcode.z.ai",
      ApiError: Error,
    },
    "#src/logger/serviceLogger.js": { createServiceLogger: () => ({}) },
    "../sourceHeaders.js": {},
    "./requestIdHeaders.js": {},
  });
  const unexpected = () => assert.fail("must not resolve or request");
  const client = new NodeApiClient({
    resolveZCodeEndpointOrigin: unexpected,
    fetchImpl: unexpected,
  });
  await assert.rejects(client.request("https://zcode.z.ai/api/v1/client/configs"), /ZCodium/);
});
