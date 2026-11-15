import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ActionContext,
  ActionResult,
  PluginServices,
  PluginSetup,
  ToolContext,
  HttpRequest,
  Json,
  JsonObject,
  ToolRegistration,
} from "reveric-plugin-sdk";
import { apply } from "../src/index";
import manifest from "../plugin.json";

const answer = {
  results: [
    {
      source: "deepseek_search",
      title: "Title",
      url: "https://example.com",
      snippet: "Snippet",
    },
  ],
};
const gatewayReply = (content: string) => ({
  choices: [{ message: { role: "assistant", content } }],
});
function harness(
  body: unknown = gatewayReply(JSON.stringify(answer)),
  status = 200,
  key: string | null = "test-key",
  settings: Record<string, Json> = {},
  thrown?: Error,
) {
  const tools = new Map<string, ToolRegistration>();
  const actions = new Map<string, () => Promise<ActionResult>>();
  const requests: { url: string; init?: HttpRequest }[] = [];
  const logs: unknown[] = [];
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected host API");
  };
  const plugin = { id: "reveric.vercel-search", version: "1.0.0" };
  const services: PluginServices = {
    plugin,
    sqlite: {
      query: unavailable,
      execute: unavailable,
      transaction: unavailable,
    },
    ai: { listModels: unavailable, generateText: unavailable },
    http: {
      fetch: async (url, init) => {
        requests.push({ url, init });
        if (thrown) throw thrown;
        return {
          status,
          url,
          headers: {},
          body: typeof body === "string" ? body : JSON.stringify(body),
        };
      },
    },
    log: {
      info: (...args) => {
        logs.push(args);
      },
      warn: (...args) => {
        logs.push(args);
      },
      error: (...args) => {
        logs.push(args);
      },
    },
    secrets: {
      get: async (name) => {
        assert.equal(name, "apiKey");
        return key;
      },
    },
    settings: {
      get: async (name) => settings[name] ?? null,
    },
    storage: { get: unavailable, set: unavailable, remove: unavailable },
  };
  const unexpected = () => {
    throw new Error("Unexpected registration");
  };
  const setup: PluginSetup = {
    provider: {
      register: () => {
        throw new Error("Unexpected provider registration");
      },
    },
    plugin,
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool);
      },
    },
    prompts: { context: unexpected, system: unexpected },
    tasks: { register: unexpected },
    pages: { registerAction: unexpected },
    settings: {
      registerAction: (name, handler) => {
        const context: ActionContext = { ...services, callId: "test" };
        actions.set(name, () => handler(context));
      },
    },
  };
  apply(setup);
  const context: ToolContext = {
    ...services,
    callId: "test",
    request: {
      requestId: "test",
      sessionId: "test",
      workId: null,
      agentId: "test",
      mode: "chat",
    },
    chapters: { list: unavailable, get: unavailable, update: unavailable },
    characters: { list: unavailable, get: unavailable, update: unavailable },
  };
  return {
    tools,
    actions,
    requests,
    logs,
    run: (input: JsonObject) =>
      tools.get("VercelSearch")!.handler(input, context),
  };
}

const enabled = {
  primaryModel: "zai/glm-5.3-flash",
  prompt: "只返回 JSON",
  searchDeepseek: true,
  searchExa: true,
  searchParallel: true,
};

test("registers the search tool without reading credentials during apply", () => {
  const h = harness();
  assert.deepEqual([...h.tools.keys()], ["VercelSearch"]);
  assert.deepEqual([...h.actions.keys()], ["verifyApiKey"]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.tools.get("VercelSearch")!.display?.summaryArg, "query");
});

test("verifyApiKey reads the model list", async () => {
  const h = harness({ data: [] });
  assert.deepEqual(await h.actions.get("verifyApiKey")!(), { ok: true });
  assert.equal(h.requests[0].url, "https://ai-gateway.vercel.sh/v1/models");
  assert.equal(h.requests[0].init?.method, "GET");
  assert.equal(h.requests[0].init?.headers?.Authorization, "Bearer test-key");
});

for (const [status, code] of [
  [401, "unauthorized"],
  [403, "unauthorized"],
  [429, "http_error"],
  [500, "http_error"],
] as const) {
  test(`verifyApiKey maps HTTP ${status} to ${code} and redacts the key`, async () => {
    const h = harness({ error: { message: "Bad test-key" } }, status);
    const result = await h.actions.get("verifyApiKey")!();
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.match(String(result.message), new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(String(result.message), /test-key/);
  });
}

test("verifyApiKey keeps host network and timeout codes", async () => {
  for (const code of ["network", "timeout"]) {
    const h = harness(
      {},
      200,
      "test-key",
      {},
      Object.assign(new Error("Failure test-key"), { code }),
    );
    assert.deepEqual(await h.actions.get("verifyApiKey")!(), {
      ok: false,
      code,
      message: "Failure ***",
    });
  }
});

test("verifyApiKey without a key fails without HTTP", async () => {
  const h = harness({}, 200, "  ");
  assert.equal(
    (await h.actions.get("verifyApiKey")!()).code,
    "missing_api_key",
  );
  assert.equal(h.requests.length, 0);
});

test("search pins the keyword on every selected tool and uses the custom prompt", async () => {
  const h = harness(undefined, 200, "test-key", enabled);
  assert.deepEqual(await h.run({ query: "Vercel AI Gateway" }), {
    ok: true,
    results: answer.results,
  });
  assert.equal(
    h.requests[0].url,
    "https://ai-gateway.vercel.sh/v1/chat/completions",
  );
  assert.equal(h.requests[0].init?.headers?.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(h.requests[0].init!.body!), {
    model: "zai/glm-5.3-flash",
    messages: [
      { role: "system", content: "只返回 JSON" },
      { role: "user", content: "Vercel AI Gateway" },
    ],
    tools: [
      {
        type: "vercel:deepseek_search",
        config: { query: "Vercel AI Gateway" },
      },
      { type: "vercel:exa_search", config: { query: "Vercel AI Gateway" } },
      {
        type: "vercel:parallel_search",
        config: { objective: "Vercel AI Gateway" },
      },
    ],
    tool_choice: "required",
  });
});

test("a blank prompt and model fall back to the manifest defaults", async () => {
  const h = harness(undefined, 200, "test-key", {
    primaryModel: "  ",
    prompt: "",
    searchPerplexity: true,
  });
  assert.equal((await h.run({ query: "关键字" })).ok, true);
  const body = JSON.parse(h.requests[0].init!.body!);
  assert.equal(body.model, manifest.settings.fields.primaryModel.default);
  assert.equal(body.messages[0].content, manifest.settings.fields.prompt.default);
  assert.deepEqual(body.tools, [
    { type: "vercel:perplexity_search", config: { query: "关键字" } },
  ]);
});

test("markdown-wrapped JSON still becomes result items", async () => {
  const h = harness(
    gatewayReply("```json\n" + JSON.stringify(answer) + "\n```"),
    200,
    "test-key",
    enabled,
  );
  assert.deepEqual(await h.run({ query: "x" }), {
    ok: true,
    results: answer.results,
  });
});

test("a non-JSON answer is returned as text", async () => {
  const h = harness(
    gatewayReply("这里是一段说明，不是 JSON"),
    200,
    "test-key",
    enabled,
  );
  assert.deepEqual(await h.run({ query: "x" }), {
    ok: true,
    text: "这里是一段说明，不是 JSON",
  });
});

test("content parts are joined before parsing", async () => {
  const h = harness(
    {
      choices: [
        {
          message: {
            content: [
              { type: "text", text: JSON.stringify({ results: [] }) },
              { type: "text", text: "" },
            ],
          },
        },
      ],
    },
    200,
    "test-key",
    enabled,
  );
  assert.deepEqual(await h.run({ query: "x" }), { ok: true, results: [] });
});

test("missing credentials, model, and tools fail before HTTP", async () => {
  assert.equal(
    (await harness(undefined, 200, null, enabled).run({ query: "x" }))
      .error_code,
    "missing_api_key",
  );
  assert.equal(
    (
      await harness(undefined, 200, "test-key", {
        ...enabled,
        primaryModel: "",
        searchDeepseek: false,
        searchExa: false,
        searchParallel: false,
      }).run({ query: "x" })
    ).error_code,
    "no_search_tool",
  );
  for (const query of [" ", "😀".repeat(129), 1]) {
    const h = harness(undefined, 200, "test-key", enabled);
    assert.equal(
      (await h.run({ query: query as Json })).error_code,
      "invalid_argument",
    );
    assert.equal(h.requests.length, 0);
  }
});

test("HTTP errors retain diagnostics and redact the API key", async () => {
  const h = harness(
    { error: { code: "upstream_error", message: "Rejected test-key" } },
    401,
    "test-key",
    enabled,
  );
  const result = await h.run({ query: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.status_code, 401);
  assert.equal(result.error_code, "upstream_error");
  assert.doesNotMatch(JSON.stringify([result, h.logs]), /test-key/);
});

test("a response without an assistant message fails explicitly", async () => {
  const h = harness({ choices: [] }, 200, "test-key", enabled);
  assert.equal((await h.run({ query: "x" })).error_code, "invalid_response");
});

test("network failures keep the host code", async () => {
  const h = harness(
    {},
    200,
    "test-key",
    enabled,
    Object.assign(new Error("Failure test-key"), { code: "timeout" }),
  );
  const result = await h.run({ query: "x" });
  assert.equal(result.error_code, "timeout");
  assert.equal(result.error, "Failure ***");
});

test("oversized answers fail instead of being truncated", async () => {
  const h = harness(
    gatewayReply(JSON.stringify({ results: [{ title: "中".repeat(90000), url: "https://example.com", snippet: "" }] })),
    200,
    "test-key",
    enabled,
  );
  assert.equal((await h.run({ query: "x" })).error_code, "result_too_large");
});
