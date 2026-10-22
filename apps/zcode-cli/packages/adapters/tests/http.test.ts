import http, { type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRootTraceContext, isHttpClientPortError } from "@zcode/contracts";
import { ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY } from "@zcode/shared";
import {
  createNodeHttpClientAdapter,
  createNodeWebFetchHttpClientAdapter,
} from "../src/http/index.js";
import {
  loadTlsCaCertificates,
  resolveProxyForRequest,
  resolveWebFetchProxyForRequest,
  resolveTlsCaCertFile,
} from "../src/network/http-config.js";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";

describe("NodeHttpClientAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("propagates trace ids through a request header", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeHttpClientAdapter();

    const output = await adapter.request({
      url: "https://example.com/page",
      trace: createRootTraceContext({ traceId: "trace-http" as never }),
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(output).toMatchObject({
      bytes: 2,
      status: 200,
      url: "https://example.com/page",
    });
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).get("x-zcode-trace-id")).toBe("trace-http");
  });

  it("forwards POST request bodies", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeHttpClientAdapter();
    const body = new TextEncoder().encode('{"hello":"world"}');

    await adapter.request({
      body,
      headers: { "content-type": "application/json" },
      method: "POST",
      url: "https://example.com/api",
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toEqual(Buffer.from(body));
  });

  it("routes requests through explicit ZCODE_HTTP_PROXY env", async () => {
    const proxyRequests: string[] = [];
    const upstream = http.createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ path: request.url, success: true }));
    });
    const proxy = http.createServer((clientRequest, clientResponse) => {
      proxyRequests.push(clientRequest.url ?? "");
      if (!clientRequest.url) {
        clientResponse.writeHead(400);
        clientResponse.end();
        return;
      }

      const target = new URL(clientRequest.url);
      const upstreamRequest = http.request(
        {
          headers: clientRequest.headers,
          hostname: target.hostname,
          method: clientRequest.method,
          path: `${target.pathname}${target.search}`,
          port: target.port,
        },
        (upstreamResponse) => {
          clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(clientResponse);
        },
      );
      upstreamRequest.once("error", (error) => {
        clientResponse.writeHead(502, { "content-type": "text/plain" });
        clientResponse.end(String(error));
      });
      clientRequest.pipe(upstreamRequest);
    });

    try {
      const upstreamBaseUrl = await listenServer(upstream);
      const proxyBaseUrl = await listenServer(proxy);
      const adapter = createNodeHttpClientAdapter({
        env: {
          ZCODE_HTTP_PROXY: proxyBaseUrl,
        },
      });

      const response = await adapter.request({
        url: `${upstreamBaseUrl}/v1/search?q=test`,
      });

      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
        path: "/v1/search?q=test",
        success: true,
      });
      expect(response.egress).toMatchObject({
        proxied: true,
        proxyHost: new URL(proxyBaseUrl).host,
        proxySource: "env:ZCODE_HTTP_PROXY",
      });
      expect(proxyRequests).toEqual([`${upstreamBaseUrl}/v1/search?q=test`]);
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });

  it("bypasses explicit proxy when configured noProxy matches the target host", async () => {
    const proxyRequests: string[] = [];
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ direct: true, success: true }));
    });
    const proxy = http.createServer((request, response) => {
      proxyRequests.push(request.url ?? "");
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false }));
    });

    try {
      const upstreamBaseUrl = await listenServer(upstream);
      const proxyBaseUrl = await listenServer(proxy);
      const adapter = createNodeHttpClientAdapter({
        env: {
          ZCODE_HTTP_PROXY: proxyBaseUrl,
        },
        noProxy: "127.0.0.1",
      });

      const response = await adapter.request({
        url: `${upstreamBaseUrl}/v1/search?q=test`,
      });

      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
        direct: true,
        success: true,
      });
      expect(response.egress).toMatchObject({
        noProxyMatched: true,
        proxied: false,
      });
      expect(proxyRequests).toEqual([]);
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });

  it("bypasses explicit proxy when ZCODE_NO_PROXY matches the target host", async () => {
    const proxyRequests: string[] = [];
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ direct: true, success: true }));
    });
    const proxy = http.createServer((request, response) => {
      proxyRequests.push(request.url ?? "");
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false }));
    });

    try {
      const upstreamBaseUrl = await listenServer(upstream);
      const proxyBaseUrl = await listenServer(proxy);
      const adapter = createNodeHttpClientAdapter({
        env: {
          ZCODE_HTTP_PROXY: proxyBaseUrl,
          ZCODE_NO_PROXY: "127.0.0.1",
        },
      });

      const response = await adapter.request({
        url: `${upstreamBaseUrl}/v1/search?q=test`,
      });

      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
        direct: true,
        success: true,
      });
      expect(response.egress).toMatchObject({
        noProxyMatched: true,
        proxied: false,
      });
      expect(proxyRequests).toEqual([]);
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });

  it("uses explicit ZCODE_AGENT_CA_CERT for custom CA resolution", () => {
    expect(
      resolveTlsCaCertFile({
        env: {
          NODE_EXTRA_CA_CERTS: "/tmp/ambient-node-extra.pem",
          SSL_CERT_FILE: "/tmp/ambient-ssl-cert-file.pem",
          ZCODE_AGENT_CA_CERT: "/tmp/zcode-agent-ca.pem",
        },
      }),
    ).toBe("/tmp/zcode-agent-ca.pem");
  });

  it("prefers configured CA cert files over TLS env files", () => {
    expect(
      resolveTlsCaCertFile({
        caCertFile: "/tmp/configured-ca.pem",
        env: {
          ZCODE_AGENT_CA_CERT: "/tmp/env-ca.pem",
        },
      }),
    ).toBe("/tmp/configured-ca.pem");
  });

  it("ignores ambient standard proxy and CA env", async () => {
    const proxyRequests: string[] = [];
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ direct: true, success: true }));
    });
    const proxy = http.createServer((request, response) => {
      proxyRequests.push(request.url ?? "");
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false }));
    });

    try {
      const upstreamBaseUrl = await listenServer(upstream);
      const proxyBaseUrl = await listenServer(proxy);
      const adapter = createNodeHttpClientAdapter({
        env: {
          http_proxy: proxyBaseUrl,
          NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem",
        },
      });

      const response = await adapter.request({
        url: `${upstreamBaseUrl}/v1/search?q=test`,
      });

      expect(JSON.parse(new TextDecoder().decode(response.body))).toEqual({
        direct: true,
        success: true,
      });
      expect(response.egress).toMatchObject({
        proxied: false,
      });
      expect(proxyRequests).toEqual([]);
      expect(
        resolveTlsCaCertFile({ env: { NODE_EXTRA_CA_CERTS: "/tmp/ambient-ca.pem" } }),
      ).toBeUndefined();
    } finally {
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });

  it("loads CA certificates from custom TLS env files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-http-ca-"));
    const certPath = join(directory, "ca.pem");
    const pem = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n";

    try {
      await writeFile(certPath, pem, "utf8");

      expect(
        loadTlsCaCertificates({
          env: {
            ZCODE_AGENT_CA_CERT: certPath,
          },
        })?.toString("utf8"),
      ).toBe(pem);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("destroys proxy fetch response streams when aborted after headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-http-abort-"));
    const certPath = join(directory, "ca.pem");
    const serverClosed = deferred();
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: started\n\n");
      response.once("close", () => {
        serverClosed.resolve();
      });
    });

    try {
      await writeFile(certPath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n", "utf8");
      const baseUrl = await listenServer(server);
      const fetch = createNetworkProxyFetch({ caCertFile: certPath });
      const abortController = new AbortController();

      const response = await fetch(`${baseUrl}/stream`, { signal: abortController.signal });
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const firstChunk = await reader?.read();
      expect(new TextDecoder().decode(firstChunk?.value)).toContain("data: started");

      const pendingRead = reader?.read();
      const pendingReadRejected = expect(pendingRead).rejects.toThrow(/test abort|aborted/i);
      abortController.abort(new Error("test abort"));

      await expect(withTimeout(serverClosed.promise, 1_000)).resolves.toBeUndefined();
      await pendingReadRejected;
    } finally {
      await closeServer(server);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("destroys proxy fetch requests when aborted before response headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-http-abort-pending-"));
    const certPath = join(directory, "ca.pem");
    const requestReceived = deferred();
    const serverClosed = deferred();
    const server = http.createServer((request, _response) => {
      requestReceived.resolve();
      request.once("close", () => {
        serverClosed.resolve();
      });
    });

    try {
      await writeFile(certPath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n", "utf8");
      const baseUrl = await listenServer(server);
      const fetch = createNetworkProxyFetch({ caCertFile: certPath });
      const abortController = new AbortController();

      const pendingFetch = fetch(`${baseUrl}/pending`, { signal: abortController.signal });
      const pendingRejected = expect(pendingFetch).rejects.toThrow(/test abort|aborted/i);
      await expect(withTimeout(requestReceived.promise, 1_000)).resolves.toBeUndefined();
      abortController.abort(new Error("test abort"));

      await pendingRejected;
      await expect(withTimeout(serverClosed.promise, 1_000)).resolves.toBeUndefined();
    } finally {
      await closeServer(server);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("replays a request once when the peer closes before sending response headers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-http-replay-epipe-"));
    const certPath = join(directory, "ca.pem");
    let connections = 0;
    const server = http.createServer((_request, response) => {
      response.end("ok");
    });
    // 首次连接在返回响应头之前被销毁：客户端 write 得到 EPIPE/ECONNRESET。
    // 请求体已全量 buffer，adapter 必须在未收到响应时重放一次。
    server.on("connection", (socket) => {
      connections += 1;
      if (connections === 1) {
        socket.destroy();
      }
    });

    try {
      await writeFile(certPath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n", "utf8");
      const baseUrl = await listenServer(server);
      const fetch = createNetworkProxyFetch({ caCertFile: certPath });

      const response = await fetch(`${baseUrl}/replay`, {
        body: JSON.stringify({ prompt: "hello" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(await response.text()).toBe("ok");
      expect(connections).toBe(2);
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reuses one keep-alive connection for sequential direct requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-http-keep-alive-"));
    const certPath = join(directory, "ca.pem");
    let connections = 0;
    const server = http.createServer((_request, response) => {
      response.end("ok");
    });
    server.on("connection", () => {
      connections += 1;
    });

    try {
      await writeFile(certPath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n", "utf8");
      const baseUrl = await listenServer(server);
      const fetch = createNetworkProxyFetch({ caCertFile: certPath });

      expect(await (await fetch(`${baseUrl}/first`)).text()).toBe("ok");
      expect(await (await fetch(`${baseUrl}/second`)).text()).toBe("ok");

      // 同一个 {proxyUrl, caCertFile, protocol} 复用同一个 Agent，第二个请求不重新握手。
      expect(connections).toBe(1);
    } finally {
      server.closeAllConnections();
      await closeServer(server);
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reuses one keep-alive connection through an http proxy and keeps absolute-form request lines", async () => {
    const upstream = http.createServer((_request, response) => response.end("ok"));
    const target = await listenServer(upstream);
    const seenPaths: string[] = [];
    let connections = 0;
    const proxy = http.createServer((request, response) => {
      seenPaths.push(request.url ?? "");
      const outgoing = http.request(
        request.url ?? "",
        { method: request.method },
        (upstreamResponse) => upstreamResponse.pipe(response),
      );
      outgoing.on("error", () => response.destroy());
      request.pipe(outgoing);
    });
    proxy.on("connection", () => {
      connections += 1;
    });
    const proxyUrl = await listenServer(proxy);

    try {
      const fetch = createNetworkProxyFetch({ env: {}, httpProxy: proxyUrl });

      expect(await (await fetch(`${target}/first`)).text()).toBe("ok");
      expect(await (await fetch(`${target}/second`)).text()).toBe("ok");

      // 复用连接时请求行仍必须是 absolute-form，否则代理侧 new URL(req.url) 会抛 Invalid URL。
      expect(seenPaths).toEqual([`${target}/first`, `${target}/second`]);
      expect(connections).toBe(1);
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });

  it("replays a request once when the proxy closes before sending response headers", async () => {
    const upstream = http.createServer((_request, response) => response.end("ok"));
    const target = await listenServer(upstream);
    let connections = 0;
    const proxy = http.createServer((request, response) => {
      const outgoing = http.request(
        request.url ?? "",
        { method: request.method },
        (upstreamResponse) => upstreamResponse.pipe(response),
      );
      outgoing.on("error", () => response.destroy());
      request.pipe(outgoing);
    });
    // 代理在转发前掐断首次连接：客户端 write 得到 EPIPE，正是线上常见的「隧道被中断」。
    proxy.on("connection", (socket) => {
      connections += 1;
      if (connections === 1) {
        socket.destroy();
      }
    });
    const proxyUrl = await listenServer(proxy);

    try {
      const fetch = createNetworkProxyFetch({ env: {}, httpProxy: proxyUrl });

      expect(await (await fetch(`${target}/replay`)).text()).toBe("ok");
      expect(connections).toBe(2);
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await closeServer(proxy);
      await closeServer(upstream);
    }
  });

  it("fails before reading responses that exceed the declared content length budget", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("too large", {
          headers: { "content-length": "9" },
          status: 200,
        }),
      ),
    );
    const adapter = createNodeHttpClientAdapter();

    await expect(
      adapter.request({
        maxResponseBytes: 8,
        url: "https://example.com/large",
      }),
    ).rejects.toMatchObject({
      code: "too_large",
      url: "https://example.com/large",
    });
  });

  it("rejects unsupported protocols without touching fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeHttpClientAdapter();

    await expect(adapter.request({ url: "file:///tmp/demo.txt" })).rejects.toSatisfy(
      isHttpClientPortError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks public egress requests when DNS resolves to a non-public address", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeHttpClientAdapter({
      dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }],
    });

    const request = adapter.request({
      egressPolicy: "public",
      url: "https://metadata.example/latest",
    });

    await expect(request).rejects.toThrow(
      "HTTP public egress blocked metadata.example because it resolved to a non-public address",
    );
    await expect(request).rejects.toMatchObject({
      code: "egress_blocked",
      url: "https://metadata.example/latest",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("applies request timeout while resolving public egress DNS", async () => {
    const adapter = createNodeHttpClientAdapter({
      dnsLookup: async () => new Promise(() => undefined),
    });

    await expect(
      Promise.race([
        adapter.request({
          egressPolicy: "public",
          timeoutMs: 20,
          url: "https://example.com/slow-dns",
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("public egress DNS preflight did not time out")), 200),
        ),
      ]),
    ).rejects.toMatchObject({
      code: "timeout",
      url: "https://example.com/slow-dns",
    });
  });

  it("applies caller abort while resolving public egress DNS", async () => {
    const abortController = new AbortController();
    const adapter = createNodeHttpClientAdapter({
      dnsLookup: async () => new Promise(() => undefined),
    });

    const request = adapter.request(
      {
        egressPolicy: "public",
        timeoutMs: 1_000,
        url: "https://example.com/abort-dns",
      },
      { signal: abortController.signal },
    );
    abortController.abort(new Error("manual abort"));

    await expect(
      Promise.race([
        request,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("public egress DNS preflight ignored abort")), 200),
        ),
      ]),
    ).rejects.toMatchObject({
      code: "cancelled",
      url: "https://example.com/abort-dns",
    });
  });

  it("applies caller abort when it fires during public egress DNS lookup setup", async () => {
    const abortController = new AbortController();
    const adapter = createNodeHttpClientAdapter({
      dnsLookup: async () => {
        abortController.abort(new Error("manual abort during lookup setup"));
        return new Promise(() => undefined);
      },
    });

    await expect(
      Promise.race([
        adapter.request(
          {
            egressPolicy: "public",
            timeoutMs: 1_000,
            url: "https://example.com/abort-dns-setup",
          },
          { signal: abortController.signal },
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("public egress DNS setup abort was missed")), 200),
        ),
      ]),
    ).rejects.toMatchObject({
      code: "cancelled",
      url: "https://example.com/abort-dns-setup",
    });
  });

  it("blocks public egress requests when DNS resolves to IPv4-mapped non-public IPv6", async () => {
    const adapter = createNodeHttpClientAdapter({
      dnsLookup: async () => [{ address: "::ffff:7f00:1", family: 6 }],
    });

    await expect(
      adapter.request({
        egressPolicy: "public",
        timeoutMs: 100,
        url: "https://metadata.example:9/latest",
      }),
    ).rejects.toMatchObject({
      code: "egress_blocked",
      url: "https://metadata.example:9/latest",
    });
  });

  it("blocks public egress requests through ordinary proxies", async () => {
    const dnsLookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
    const adapter = createNodeHttpClientAdapter({
      dnsLookup,
      proxyUrl: "http://127.0.0.1:9",
    });

    await expect(
      adapter.request({
        egressPolicy: "public",
        timeoutMs: 100,
        url: "https://public.example/page",
      }),
    ).rejects.toMatchObject({
      code: "egress_blocked",
      message: expect.stringContaining("proxy"),
      url: "https://public.example/page",
    });
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("blocks public egress requests to literal non-public addresses", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createNodeHttpClientAdapter();

    await expect(
      adapter.request({
        egressPolicy: "public",
        url: "https://127.0.0.1/status",
      }),
    ).rejects.toMatchObject({
      code: "egress_blocked",
      url: "https://127.0.0.1/status",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not use captured user proxy env through the default proxy resolver", () => {
    const resolution = resolveProxyForRequest("http://example.com/page", {
      env: {
        [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
          HTTPS_PROXY: "http://captured-proxy.example:8080",
        }),
      },
    });

    expect(resolution).toEqual({
      noProxyMatched: false,
    });
  });

  it("does not let captured no_proxy bypass explicit proxy in the default resolver", () => {
    expect(
      resolveProxyForRequest("http://api.example.com/page", {
        env: {
          [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
            no_proxy: "example.com",
          }),
        },
        httpProxy: "http://explicit-proxy.example:8080",
      }),
    ).toMatchObject({
      noProxyMatched: false,
      proxySource: "network.httpProxy",
      proxyUrl: "http://explicit-proxy.example:8080/",
    });
  });

  it("routes requests through captured user proxy env", async () => {
    const proxyRequests: string[] = [];
    const proxy = http.createServer((request, response) => {
      proxyRequests.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("captured proxied");
    });

    try {
      const proxyBaseUrl = await listenServer(proxy);
      const adapter = createNodeWebFetchHttpClientAdapter({
        env: {
          [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
            HTTP_PROXY: proxyBaseUrl,
          }),
        },
      });

      const response = await adapter.request({
        timeoutMs: 1_000,
        url: "http://public.example/from-captured-proxy",
      });

      expect(new TextDecoder().decode(response.body)).toBe("captured proxied");
      expect(response.egress).toMatchObject({
        proxied: true,
        proxyHost: new URL(proxyBaseUrl).host,
        proxySource: `env:${ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY}.HTTP_PROXY`,
      });
      expect(proxyRequests).toEqual(["http://public.example/from-captured-proxy"]);
    } finally {
      await closeServer(proxy);
    }
  });

  it("prefers lowercase captured proxy env over uppercase variants", () => {
    expect(
      resolveWebFetchProxyForRequest("http://example.com/page", {
        env: {
          [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
            HTTPS_PROXY: "http://upper-https-proxy.example:8080",
            https_proxy: "http://lower-https-proxy.example:8080",
            HTTP_PROXY: "http://upper-http-proxy.example:8080",
            http_proxy: "http://lower-http-proxy.example:8080",
          }),
        },
      }),
    ).toMatchObject({
      proxySource: `env:${ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY}.https_proxy`,
      proxyUrl: "http://lower-https-proxy.example:8080/",
    });
  });

  it("prefers lowercase captured no_proxy over uppercase variants", () => {
    const resolution = resolveWebFetchProxyForRequest("http://api.example.com/page", {
      env: {
        [ZCODE_TOOL_ENV_PASSTHROUGH_ENV_KEY]: JSON.stringify({
          HTTP_PROXY: "http://proxy.example:8080",
          NO_PROXY: "other.example",
          no_proxy: "example.com",
        }),
      },
    });

    expect(resolution).toMatchObject({
      noProxyMatched: true,
    });
    expect(resolution.proxyUrl).toBeUndefined();
  });
});

async function listenServer(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error("Expected server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolveDeferred: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveDeferred = resolve;
  });
  return {
    promise,
    resolve: resolveDeferred,
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
