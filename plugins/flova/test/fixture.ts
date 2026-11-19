import type {
  ProviderVideoContext,
  ProviderUploadContext,
  ProviderVideoInput,
  JsonObject,
} from "reveric-plugin-sdk";

/// 一个可编排的假 host：记录每次调用，并按队列返回响应。
export function fixture() {
  const calls: Array<{ name: string; args: any[] }> = [];
  const responses: Array<{ status: number; body: JsonObject }> = [];
  const settings: Record<string, unknown> = {};
  const files = new Map<string, Uint8Array>();

  const next = () => {
    const value = responses.shift();
    if (!value) throw new Error("fixture: unexpected request");
    return {
      status: value.status,
      body: JSON.stringify(value.body),
      headers: {},
    };
  };

  const ctx = {
    plugin: { id: "reveric.flova", version: "1.0.0" },
    provider: { id: "instance" },
    callId: "call",
    taskId: "task",
    settings: { get: async (key: string) => settings[key] ?? null },
    secrets: { get: async () => "secret-key" },
    storage: {} as any,
    log: { info() {}, warn() {}, error() {} },
    http: {
      fetch: async (...args: any[]) => {
        calls.push({ name: "http", args });
        return next();
      },
    },
    files: {
      upload: async (_handle: string, request: any) => {
        calls.push({ name: "upload", args: [request] });
        return next();
      },
    },
    video: {
      request: async (...args: any[]) => {
        calls.push({ name: "video", args });
        return next();
      },
    },
  } as unknown as ProviderVideoContext & ProviderUploadContext;

  const input: ProviderVideoInput = {
    request: {
      modelId: "Flova/Seedance 2.5",
      prompt: "雨夜里女孩回头",
      mode: "text",
      ratio: "16:9",
      resolution: "480p",
      durationSeconds: 5,
      defaults: {},
      referenceSlots: [],
    },
    references: [],
  };

  return {
    ctx,
    calls,
    settings,
    files,
    input,
    queue: (...values: Array<{ status: number; body: JsonObject }>) => {
      responses.push(...values);
    },
    /// 取第 n 个 http 调用解析后的请求体。
    body: (n = 0) => {
      const httpCalls = calls.filter((c) => c.name === "http");
      const args = httpCalls[n]?.args ?? [];
      const init = args[1] ?? {};
      return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    },
    url: (n = 0) => {
      const httpCalls = calls.filter((c) => c.name === "http");
      return String(httpCalls[n]?.args[0] ?? "");
    },
  };
}
