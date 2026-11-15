import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { test } from 'node:test';
const root = new URL('../../../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
test('CLI removes exporter package and bootstrap integration', async () => {
  await assert.rejects(access(new URL('apps/zcode-cli/packages/telemetry/package.json', root)));
  const manifest = JSON.parse(await read('apps/zcode-cli/packages/bootstrap/package.json'));
  assert.equal(manifest.dependencies['@zcode/telemetry'], undefined);
  for (const file of ['app/create-app.ts', 'index.ts', 'zcode-protocol-entrypoint.ts', 'zcode-protocol/runtime-cleanup.ts']) {
    assert.doesNotMatch(await read(`apps/zcode-cli/packages/bootstrap/src/${file}`), /@zcode\/telemetry|prepareZCodeTelemetryEnv|shutdownZCodeTelemetry|createModelTelemetry/);
  }
});
test('Host no longer supplies telemetry identity or OTLP environment', async () => {
  assert.doesNotMatch(await read('packages/services/src/node.ts'), /buildAgentTelemetrySpawnEnv|getCapturedZCodeAgentTelemetryEnv|createTelemetryCore|createTelemetryAuthorizationLoader/);
});
test('legacy telemetry credentials are discarded without retaining a capture API', async () => {
  const runtimeEnv = await import('../../../packages/shared/src/runtimeEnv.ts');
  const source = {
    PATH: '/test/bin',
    ZCODE_HTTP_PROXY: 'http://localhost:8080',
    OTEL_EXPORTER_OTLP_HEADERS: 'synthetic-secret',
    ZCODE_TELEMETRY_DEVICE_MID: 'synthetic-device',
  };
  const cleaned = runtimeEnv.sanitizeZCodeRuntimeEnv(source);
  assert.equal(cleaned.PATH, source.PATH);
  assert.equal(cleaned.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(cleaned.ZCODE_TELEMETRY_DEVICE_MID, undefined);
  assert.equal(runtimeEnv.getCapturedZCodeAgentTelemetryEnv, undefined);
  runtimeEnv.sanitizeZCodeRuntimeEnvInPlace(source);
  assert.equal(source.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.equal(source.PATH, '/test/bin');
});
test('TTFT recorder and standalone protocol notification are removed', async () => {
  await assert.rejects(access(new URL('apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/local-ttft.ts', root)));
  // A2（与 ui 守卫同口径）：fork 在 cb4ba336「阶段 2a 前置扩展」里有意把
  // V4_NOTIFICATIONS.localTtftFacts 这条**协议路径常量**重新并入 shared transport，
  // 用于与上游 v4 通知表保持结构对齐；它是死路径（fork 已在 b9b5ed1b 删掉
  // localTtftFactsEmitter、且全仓无代码读取 V4_NOTIFICATIONS.localTtftFacts，不产生
  // egress），故不再视为违规。真正的“采集/上报入口”由下面两条钉死：recorder 文件必须
  // 保持删除（上面的 ENOENT），v4-gateway 不得出现 LocalTtftRecorder/emitLocalTtftFacts。
  await assert.doesNotMatch(await read('apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts'), /LocalTtftRecorder|emitLocalTtftFacts/);
});
