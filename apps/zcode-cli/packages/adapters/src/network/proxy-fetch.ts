import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import {
  loadTlsCaCertificates,
  resolveProxyUrlForRequest,
  resolveTlsCaCertFile,
} from "./http-config.js";
import { readIncomingResponse, toWebResponse } from "./incoming-response.js";

export type NetworkFetch = typeof globalThis.fetch;

interface NetworkProxyFetchOptions {
  caCertFile?: string;
  env?: Record<string, string | undefined>;
  fetch?: NetworkFetch;
  httpProxy?: string;
  noProxy?: string;
}

interface NormalizedFetchRequest {
  body?: Buffer;
  headers: Headers;
  method: string;
  signal?: AbortSignal | null;
  url: URL;
}

interface RequestAgentOptions {
  ca?: Buffer;
  caKey?: string;
  proxyUrl?: string;
}

// Agent 实例必须复用：否则每个请求都要重新握手，proxy-agent 内部按 proxy URL 维护的 Agent LRU
// 也永远不会命中。键包含 CA 文件路径与目标协议，避免不同信任根共用同一个连接池。
const REQUEST_AGENT_CACHE = new Map<string, http.Agent | https.Agent | ProxyAgent>();

const KEEP_ALIVE_AGENT_OPTIONS = {
  keepAlive: true,
  keepAliveMsecs: 1_000,
  // 比常见服务端/网关的 idle timeout（通常 30-60s）短，缩小「对端已关、客户端仍复用」的窗口。
  // 竞态无法完全消除，残留部分由 fetchWithReplay 的一次性重放兜住。
  keepAliveTimeout: 5_000,
} as const;

// 写方向断管/连接被重置：请求体已全量 buffer，可以在未收到响应前安全重放。
const REPLAYABLE_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  "EPIPE",
  "ECONNRESET",
  "ECONNABORTED",
  "ERR_STREAM_DESTROYED",
]);

export function createNetworkProxyFetch(options: NetworkProxyFetchOptions): NetworkFetch {
  const directFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!hasNetworkFetchPolicy(options)) {
    return directFetch;
  }

  let tlsCaCertificates: Buffer | undefined;
  let tlsCaCertificatesLoaded = false;

  const getTlsCaCertificates = (): Buffer | undefined => {
    if (!tlsCaCertificatesLoaded) {
      tlsCaCertificates = loadTlsCaCertificates(options);
      tlsCaCertificatesLoaded = true;
    }
    return tlsCaCertificates;
  };

  return async (input, init) => {
    const requestUrl = readFetchInputUrl(input);
    if (!requestUrl || (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:")) {
      return directFetch(input, init);
    }

    const proxyUrl = resolveProxyUrlForRequest(requestUrl, options);
    const caCertFile = resolveTlsCaCertFile(options);
    if (!proxyUrl && !caCertFile) {
      return directFetch(input, init);
    }

    const request = await normalizeFetchRequest(input, init);
    return fetchWithReplay(request, {
      ca: caCertFile ? getTlsCaCertificates() : undefined,
      caKey: caCertFile,
      proxyUrl,
    });
  };
}

async function fetchWithReplay(
  request: NormalizedFetchRequest,
  options: RequestAgentOptions,
): Promise<Response> {
  try {
    return await fetchWithAgent(request, options);
  } catch (error) {
    if (!isReplayableTransportFailure(error)) {
      throw error;
    }
    // 请求体在 normalizeFetchRequest 里已全量 buffer，可安全重放一次。
    // fetchWithAgent 只在拿到响应头之前 reject；拿到响应后的 socket 错误走响应体，
    // 不会被这里重放，因此不会重复输出已开始的流。
    return fetchWithAgent(request, options);
  }
}

function isReplayableTransportFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && REPLAYABLE_TRANSPORT_CODES.has(code.toUpperCase());
}

function hasNetworkFetchPolicy(options: NetworkProxyFetchOptions): boolean {
  return Boolean(
    options.caCertFile ||
      options.env ||
      options.httpProxy ||
      options.noProxy,
  );
}

function readFetchInputUrl(input: Parameters<NetworkFetch>[0]): URL | undefined {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return undefined;
  }
}

async function normalizeFetchRequest(
  input: Parameters<NetworkFetch>[0],
  init: Parameters<NetworkFetch>[1],
): Promise<NormalizedFetchRequest> {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const arrayBuffer =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = arrayBuffer && arrayBuffer.byteLength > 0 ? Buffer.from(arrayBuffer) : undefined;

  return {
    body,
    headers: request.headers,
    method,
    signal: request.signal,
    url: new URL(request.url),
  };
}

function fetchWithAgent(
  request: NormalizedFetchRequest,
  options: RequestAgentOptions,
): Promise<Response> {
  const transport = request.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const signal = request.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    let settled = false;
    let responseMessage: http.IncomingMessage | undefined;
    let clientRequest: http.ClientRequest | undefined;

    const cleanupAll = (): void => {
      signal?.removeEventListener("abort", onAbort);
      clientRequest?.off("error", onRequestError);
      clientRequest?.off("close", onRequestClose);
      responseMessage?.off("close", cleanupAll);
      responseMessage?.off("error", onResponseError);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupAll();
      reject(error);
    };
    const onRequestError = (error: Error): void => {
      rejectOnce(error);
    };
    const onRequestClose = (): void => {
      if (!responseMessage && settled) cleanupAll();
    };
    const onResponseError = (): void => {
      // The web Response body receives the stream error through Readable.toWeb;
      // this listener only prevents Node from treating abort destroy as unhandled.
    };
    const onAbort = (): void => {
      const error = abortReason(signal);
      responseMessage?.destroy(error);
      clientRequest?.destroy(error);
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    clientRequest = transport.request(
      {
        agent: resolveRequestAgent(request.url, options),
        headers: headersToOutgoing(request.headers),
        hostname: request.url.hostname,
        method: request.method,
        path: buildRequestPath(request, options.proxyUrl),
        port: request.url.port || undefined,
        protocol: request.url.protocol,
      },
      (message) => {
        responseMessage = message;
        responseMessage.once("close", cleanupAll);
        responseMessage.once("error", onResponseError);
        // 回调里抛出的东西没人接得住、会打死整个 agent 进程（network/incoming-response.ts）：
        // 表示不了的状态码只让这一次请求失败。
        let response: Response;
        try {
          response = toWebResponse(readIncomingResponse(message));
        } catch (error) {
          message.destroy();
          rejectOnce(error);
          return;
        }
        settled = true;
        resolve(response);
      },
    );

    clientRequest.once("error", onRequestError);
    clientRequest.once("close", onRequestClose);
    clientRequest.end(request.body);
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function resolveRequestAgent(
  url: URL,
  options: RequestAgentOptions,
): http.Agent | https.Agent | ProxyAgent {
  const cacheKey = options.proxyUrl
    ? `proxy:${options.proxyUrl}:${options.caKey ?? ""}`
    : `direct:${url.protocol}:${options.caKey ?? ""}`;
  const cached = REQUEST_AGENT_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const agent = options.proxyUrl
    ? (new ProxyAgent({
        ca: options.ca,
        getProxyForUrl: () => options.proxyUrl ?? "",
        // 命中 no-proxy 的请求由 ProxyAgent 内部转给这个直连 agent，同样要复用。
        httpsAgent: new https.Agent({ ca: options.ca, ...KEEP_ALIVE_AGENT_OPTIONS }),
        ...KEEP_ALIVE_AGENT_OPTIONS,
      }) as unknown as http.Agent)
    : url.protocol === "https:"
      ? new https.Agent({ ca: options.ca, ...KEEP_ALIVE_AGENT_OPTIONS })
      : new http.Agent({ ...KEEP_ALIVE_AGENT_OPTIONS });

  // 进程内只会有少量 {proxyUrl, caCertFile} 组合；配置变更需要重启进程，缓存不需要失效机制。
  REQUEST_AGENT_CACHE.set(cacheKey, agent);
  return agent;
}

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return outgoing;
}

/**
 * 走 HTTP 代理的明文请求必须使用 absolute-form 请求行（`GET http://host:port/path HTTP/1.1`）。
 *
 * 以前这一步完全交给 `HttpProxyAgent.addRequest`，它只在**新建连接**时改写 `req.path`；
 * `ProxyAgent` 外层继承 `http.Agent` 的连接池，复用 socket 时不会再次进入内层，第二个请求
 * 就会退化成 origin-form（`/path`），代理侧 `new URL(req.url)` 直接抛 Invalid URL。
 * 请求行由客户端自己写死 absolute-form 后，连接复用与路径改写不再互相依赖。
 *
 * HTTPS 目标走 CONNECT 隧道，隧道内的请求行仍是 origin-form，不能套用该规则。
 */
function buildRequestPath(request: NormalizedFetchRequest, proxyUrl?: string): string {
  if (proxyUrl && request.url.protocol === "http:") {
    return request.url.href;
  }
  return `${request.url.pathname}${request.url.search}`;
}
