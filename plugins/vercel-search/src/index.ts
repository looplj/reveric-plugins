import type {
  ActionContext,
  ActionResult,
  PluginServices,
  PluginSetup,
  JsonObject,
  HttpResponse,
} from "reveric-plugin-sdk";
import definitions from "./definitions.json";
import manifest from "../plugin.json";

const gateway = "https://ai-gateway.vercel.sh/v1";
const defaultPrompt = manifest.settings.fields.prompt.default;
const defaultModel = manifest.settings.fields.primaryModel.default;
const searchTools = [
  { setting: "searchDeepseek", type: "vercel:deepseek_search", pin: "query" },
  { setting: "searchExa", type: "vercel:exa_search", pin: "query" },
  {
    setting: "searchParallel",
    type: "vercel:parallel_search",
    pin: "objective",
  },
  {
    setting: "searchPerplexity",
    type: "vercel:perplexity_search",
    pin: "query",
  },
  { setting: "searchTako", type: "vercel:tako_search", pin: "query" },
  {
    setting: "searchBrowserbase",
    type: "vercel:browserbase_search",
    pin: "query",
  },
] as const;
const failure = (code: string, error: string): JsonObject => ({
  ok: false,
  error_code: code,
  error,
});
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const textLength = (value: string) => [...value].length;

function redact(value: string, secret: string): string {
  if (!secret) return value;
  const encoded = JSON.stringify(secret).slice(1, -1);
  return value.split(secret).join("***").split(encoded).join("***");
}

function utf8Size(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > 256 * 1024) break;
  }
  return bytes;
}

async function textSetting(
  context: PluginServices,
  key: string,
  fallback: string,
): Promise<string> {
  const value = await context.settings.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

async function enabledTools(
  context: PluginServices,
  query: string,
): Promise<JsonObject[]> {
  const tools: JsonObject[] = [];
  for (const tool of searchTools) {
    if ((await context.settings.get(tool.setting)) === true) {
      tools.push({
        type: tool.type,
        config: { [tool.pin]: query },
      });
    }
  }
  return tools;
}

function messageText(data: JsonObject): string | null {
  const choices = data.choices;
  if (!Array.isArray(choices) || !object(choices[0])) return null;
  const message = choices[0].message;
  if (!object(message)) return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  return content
    .map((part) => (object(part) && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function parsedResults(text: string): JsonObject[] | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const source = (fenced?.[1] ?? text).trim();
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!object(parsed) || !Array.isArray(parsed.results)) return null;
  const results: JsonObject[] = [];
  for (const item of parsed.results) {
    if (
      !object(item) ||
      typeof item.title !== "string" ||
      typeof item.url !== "string"
    )
      return null;
    const result: JsonObject = {
      title: item.title,
      url: item.url,
      snippet: typeof item.snippet === "string" ? item.snippet : "",
    };
    if (typeof item.source === "string") result.source = item.source;
    results.push(result);
  }
  return results;
}

function outcome(text: string): JsonObject {
  const trimmed = text.trim();
  if (!trimmed)
    return failure(
      "invalid_response",
      "AI Gateway returned an empty search answer.",
    );
  const results = parsedResults(trimmed);
  const result: JsonObject = results
    ? { ok: true, results }
    : { ok: true, text: trimmed };
  if (utf8Size(JSON.stringify(result)) > 256 * 1024)
    return failure(
      "result_too_large",
      "Search answer exceeds the 256 KiB tool result limit.",
    );
  return result;
}

async function search(
  context: PluginServices,
  query: string,
): Promise<JsonObject> {
  let apiKey = "";
  let response: HttpResponse | undefined;
  const url = `${gateway}/chat/completions`;
  try {
    apiKey = (await context.secrets.get("apiKey"))?.trim() ?? "";
    if (!apiKey)
      return failure(
        "missing_api_key",
        "Configure the Vercel Search plugin API Key before calling this tool.",
      );
    const model = await textSetting(context, "primaryModel", defaultModel);
    if (!model)
      return failure(
        "missing_model",
        "Configure a primary model in the Vercel Search plugin settings.",
      );
    const tools = await enabledTools(context, query);
    if (!tools.length)
      return failure(
        "no_search_tool",
        "Enable at least one search tool in the Vercel Search plugin settings.",
      );
    const prompt = await textSetting(context, "prompt", defaultPrompt);
    response = await context.http.fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: query },
        ],
        tools,
        tool_choice: "required",
      }),
      timeoutMs: 45000,
    });
    let data: unknown;
    try {
      data = JSON.parse(response.body);
    } catch {
      /* Raw body is retained in the diagnostic below. */
    }
    const diagnostic = (): JsonObject => ({
      url,
      status: response!.status,
      body: redact(response!.body, apiKey).slice(0, 4096),
      body_truncated: response!.body.length > 4096,
    });
    if (response.status !== 200 || !object(data)) {
      const error = object(data) && object(data.error) ? data.error : null;
      const message =
        typeof error?.message === "string"
          ? error.message
          : `AI Gateway returned HTTP ${response.status}`;
      const code = typeof error?.code === "string" ? error.code : "http_error";
      context.log.error("Vercel Search request failed", diagnostic());
      return {
        ...failure(code, redact(message, apiKey)),
        status_code: response.status,
        diagnostic: diagnostic(),
      };
    }
    const text = messageText(data);
    if (text === null) {
      context.log.error("Invalid AI Gateway response", diagnostic());
      return {
        ...failure(
          "invalid_response",
          "AI Gateway response does not include an assistant message.",
        ),
        diagnostic: diagnostic(),
      };
    }
    return outcome(text);
  } catch (error) {
    const message = redact(
      error instanceof Error ? error.message : String(error),
      apiKey,
    );
    const code =
      object(error) && typeof error.code === "string"
        ? error.code
        : "request_failed";
    const diagnostic: JsonObject = {
      url,
      error: message,
      ...(response ? { status: response.status } : {}),
    };
    context.log.error("Vercel Search request failed", diagnostic);
    return { ...failure(code, message), diagnostic };
  }
}

async function verifyApiKey(context: ActionContext): Promise<ActionResult> {
  let apiKey = "";
  try {
    apiKey = (await context.secrets.get("apiKey"))?.trim() ?? "";
    if (!apiKey)
      return {
        ok: false,
        code: "missing_api_key",
        message: "API Key is empty",
      };
    const response = await context.http.fetch(`${gateway}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      timeoutMs: 15000,
    });
    if (response.status === 200) return { ok: true };
    return {
      ok: false,
      code:
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : "http_error",
      message: `AI Gateway returned HTTP ${response.status}: ${redact(
        response.body,
        apiKey,
      ).slice(0, 1024)}`,
    };
  } catch (error) {
    return {
      ok: false,
      code:
        object(error) && typeof error.code === "string"
          ? error.code
          : "request_failed",
      message: redact(
        error instanceof Error ? error.message : String(error),
        apiKey,
      ),
    };
  }
}

export function apply(setup: PluginSetup): void {
  setup.settings.registerAction("verifyApiKey", verifyApiKey);
  setup.tools.register({
    ...definitions.VercelSearch,
    display: { summaryArg: "query", result: "json" },
    handler: async (input, context) => {
      if (
        typeof input.query !== "string" ||
        !input.query.trim() ||
        textLength(input.query) > 128
      )
        return failure(
          "invalid_argument",
          "query must contain 1 to 128 Unicode characters and cannot be blank",
        );
      return search(context, input.query);
    },
  });
}
