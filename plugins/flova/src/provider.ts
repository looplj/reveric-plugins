// 职责: Flova 视频 provider——把 host 的提交/查询映射到 Flova 的 HTTP 接口。
// 关联文件:
//   plugins/flova/plugin.json
//   plugins/sdk/index.d.ts
import { PluginError } from "reveric-plugin-sdk";
import type {
  JsonObject,
  ProviderContext,
  ProviderHandlers,
  ProviderModel,
  ProviderQueryInput,
  ProviderQueryResult,
  ProviderUploadContext,
  ProviderVideoContext,
  ProviderVideoInput,
  VideoModelCapabilities,
} from "reveric-plugin-sdk";

const defaultBase = "https://service.flova.ai/api/agent/v3";

/// Flova 的票据接口要求客户端带宽高和时长，缺了直接 422。这不是可选优化：
/// `uploadReference` 拿到的 `mediaInfo` 就是为它准备的。
const uploadTimeoutMs = 300_000;
const requestTimeoutMs = 60_000;

/// 模型能力逐项来自 `flova model list` 的 `video_seedance_2_5` /
/// `MultiModalToVideo` 条目（2026-11-16，CLI v0.0.16）。不是照抄官方 catalog：
/// 平台自己的上限和官方型号并不一致，以平台为准。
///
/// 只声明 Seedance 2.5：平台还有别的型号，但每多声明一个就多一份没验证过的边界。
const modelId = "Flova/Seedance 2.5";

/// 平台给的格式白名单，原样照抄。图片里 tiff/gif/heic/heif 都是平台认的，
/// 少写一个就等于替用户挡掉它其实能用的素材。
const imageFormats = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/bmp",
  "image/tiff",
  "image/gif",
  "image/heic",
  "image/heif",
];
const videoFormats = ["video/mp4", "video/quicktime"];
const audioFormats = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/m4a",
];

const capabilities: VideoModelCapabilities = {
  ratios: ["21:9", "16:9", "9:16", "3:4", "4:3", "1:1"],
  resolutions: ["480p", "720p", "1080p", "4k"],
  durations: Array.from({ length: 27 }, (_, i) => i + 4),
  // 只声明平台给的能力里我们不声明、也不能正确表达的那部分：
  //
  // 平台确实有 FirstFrameToVideo / VideoInterp（首尾帧），但 `/chat_with_uploads`
  // 的 `files` 只有 `{file_name, file_type, upload_token}`——**没有角色字段**。
  // 两张图一起发出去，agent 无从知道哪张是首帧、哪张是尾帧，顺序也不保证。
  // 与其声明出来靠提示词碰运气，不如不声明：用户选不到这个模式，
  // 也就不会以为自己在做精确的首尾帧控制。
  //
  // 文生由参考模式的 min=0 覆盖；参考素材经 `files` 传递，这是唯一能确定的路径。
  modes: ["text", "reference"],
  frameRoles: [],
  maxMiddleFrames: 0,
  // 参考总上限 50：图 30 + 视频 10 + 音频 10。
  maxReferences: 50,
  references: {
    image: {
      maxCount: 30,
      // 31457280 字节 = 30 MB，平台的界是含等于。
      maxSizeMb: 30,
      mimeTypes: imageFormats,
      minDimension: 300,
      maxDimension: 6000,
      minRatio: 0.4,
      maxRatio: 2.5,
    },
    video: {
      maxCount: 10,
      // 209715200 字节 = 200 MB。
      maxSizeMb: 200,
      mimeTypes: videoFormats,
      minDurationMs: 2000,
      maxDurationMs: 30000,
      maxTotalDurationMs: 30000,
    },
    audio: {
      maxCount: 10,
      // 15728640 字节 = 15 MB。
      maxSizeMb: 15,
      mimeTypes: audioFormats,
      minDurationMs: 2000,
      maxDurationMs: 30000,
      maxTotalDurationMs: 30000,
    },
  },
  supportsAudioOnlyReference: false,
  // 平台的画幅列表里没有 adaptive。
  supportsAdaptiveTextRatio: false,
  supportsLastFrameOnly: false,
  framesRequireAdaptiveRatio: false,
  supportsCertifiedAssets: false,
  draft: null,
};

const object = (v: unknown): v is JsonObject =>
  !!v && typeof v === "object" && !Array.isArray(v);

function required(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new PluginError("invalid_response", `Missing ${field}`);
  }
  return v;
}

function base(ctx: ProviderContext): Promise<string> {
  return ctx.settings.get("apiBase").then((value) => {
    const configured =
      typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
    return configured || defaultBase;
  });
}

async function headers(ctx: ProviderContext): Promise<Record<string, string>> {
  const key = (await ctx.secrets.get("apiKey"))?.trim();
  if (!key) {
    throw new PluginError(
      "configuration_required",
      "请配置 Flova API Key / Configure the Flova API key",
    );
  }
  return { Authorization: `Bearer ${key}`, Accept: "application/json" };
}

/// Flova 把失败放在 `code`/`message` 里，而 HTTP 常常仍是 200。
/// 不翻这一层的话，"积分不足"和"被内容策略拦下"都表现成"没出片"。
function decode(status: number, body: unknown): JsonObject {
  let value = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body);
    } catch {
      throw new PluginError(
        status >= 200 && status < 300
          ? "invalid_response"
          : failureCode(status),
        `Flova HTTP ${status}: invalid JSON`,
      );
    }
  }
  if (!object(value)) {
    throw new PluginError("invalid_response", "Invalid Flova response");
  }
  const code = value.code;
  if (status < 200 || status >= 300 || (code !== 0 && code !== undefined)) {
    const message =
      typeof value.message === "string" && value.message.trim()
        ? value.message
        : `Flova HTTP ${status}, code=${String(code)}`;
    throw new PluginError(
      status === 401 || status === 403
        ? "authentication"
        : status === 429
          ? "rate_limited"
          : failureCode(status),
      message,
    );
  }
  return object(value.data) ? value.data : {};
}

function failureCode(status: number): string {
  if (status >= 500) return "unavailable";
  if (status >= 400) return "rejected";
  return "invalid_response";
}

async function post(
  ctx: ProviderContext,
  path: string,
  body: JsonObject,
  timeoutMs = requestTimeoutMs,
): Promise<JsonObject> {
  const result = await ctx.http.fetch(`${await base(ctx)}/${path}`, {
    method: "POST",
    headers: { ...(await headers(ctx)), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs,
  });
  return decode(result.status, result.body);
}

/// 项目号在提交和轮询里都要带。用户没填就建一个，并交给 host 的 task state 记住。
///
/// **`/create` 建出来的项目在 Flova 那边删不掉**，所以只在真正提交时建。
/// 查询绝不能建：拿一个新建的空项目去查旧的 stream_chat_id 必然查不到，
/// 还会在账号里留下一个永久的空项目。
async function ensureProject(
  ctx: ProviderContext,
  state: JsonObject | undefined,
  { create }: { create: boolean },
): Promise<{ projectId: string; state: JsonObject }> {
  const configured = await ctx.settings.get("projectId");
  const configuredId = typeof configured === "string" ? configured.trim() : "";
  if (configuredId) {
    return { projectId: configuredId, state: state ?? {} };
  }
  const remembered =
    state && typeof state.projectId === "string" ? state.projectId : "";
  if (remembered) {
    return { projectId: remembered, state: state ?? {} };
  }
  if (!create) {
    // 查询时没有项目号，说明这次任务不是本插件提交的，或者 state 丢了。
    // 两种情况都不该新建项目，也不该静默返回一个查不到的结果。
    throw new PluginError(
      "configuration_required",
      "这个任务没有记住 Flova 项目号，无法查询；请在供应商设置里填写 Project ID / No Flova project for this task",
    );
  }
  const created = await post(ctx, "create", {
    name: "Reveric",
    description: "",
    project_type: 0,
  });
  const project = object(created.project) ? created.project : created;
  const createdId = required(project.project_id, "project_id");
  return {
    projectId: createdId,
    state: { ...(state ?? {}), projectId: createdId },
  };
}

export function createFlovaProvider(): ProviderHandlers {
  return {
    listModels(): ProviderModel[] {
      return [
        {
          kind: "video",
          id: modelId,
          name: modelId,
          capabilities,
        },
      ];
    },

    async uploadReference(
      { file },
      ctx: ProviderUploadContext,
    ): Promise<{ ref: string }> {
      // 票据接口要求客户端自己报元数据，服务端不量文件。三种媒体的字段名
      // 和内容各不相同，实测（2026-11-16，CLI v0.0.16）：
      //   图片缺 → 422 "Missing image metadata: width, height"
      //   视频缺 → 422 "Missing video metadata: width, height, duration, has_audio"
      //   音频缺 → 422 "Missing audio metadata: duration"
      // 填错字段名一样被拒：视频用 image_metadata 仍是上面那条 422。
      const media = file.mediaInfo;
      const kind = file.mimeType.split("/")[0];
      const body: JsonObject = {
        file_name: file.name,
        file_size: file.size,
        content_type: file.mimeType,
        file_hash: file.sha256,
      };
      if (kind === "image") {
        if (!media?.width || !media?.height) {
          throw new PluginError(
            "invalid_request",
            "Flova 需要图片的宽高，宿主未提供 / Flova needs image dimensions",
          );
        }
        body.image_metadata = { width: media.width, height: media.height };
      } else if (kind === "video") {
        if (!media?.width || !media?.height || !media?.durationMs) {
          throw new PluginError(
            "invalid_request",
            "Flova 需要视频的宽高和时长，宿主未提供 / Flova needs video dimensions and duration",
          );
        }
        body.video_metadata = {
          duration: media.durationMs / 1000,
          width: media.width,
          height: media.height,
          // 字段必须出现，缺了整个视频元数据会被拒（实测 422
          // "Missing video metadata: has_audio"）。值本身服务端不校验：
          // true 和 false 都能拿到票据。
          // 宿主探测得到真实值就照发；拿不到时按无音轨处理。
          has_audio: media.hasAudio ?? false,
        };
      } else if (kind === "audio") {
        if (!media?.durationMs) {
          throw new PluginError(
            "invalid_request",
            "Flova 需要音频的时长，宿主未提供 / Flova needs audio duration",
          );
        }
        body.audio_metadata = { duration: media.durationMs / 1000 };
      } else {
        throw new PluginError(
          "invalid_request",
          `Flova 不接收 ${file.mimeType} 这种参考素材`,
        );
      }
      const ticket = await post(ctx, "upload/ticket", body);
      const uploadUrl = required(ticket.upload_url, "upload_url");
      const gsUri = required(ticket.gs_uri, "gs_uri");

      const put = await ctx.files.upload(file.handle, {
        kind: "raw",
        url: uploadUrl,
        method: "PUT",
        headers: { "Content-Type": file.mimeType },
        timeoutMs: uploadTimeoutMs,
      });
      if (put.status < 200 || put.status >= 300) {
        throw new PluginError(
          "unavailable",
          `Flova upload failed: HTTP ${put.status}`,
        );
      }

      const done = await post(ctx, "upload/complete", {
        ...body,
        gs_uri: gsUri,
      });
      const token = required(done.upload_token, "upload_token");
      const type = required(done.file_type, "file_type");
      // ref 是 host 原样存进任务的字符串，查询/提交时再交回来。
      // 三个字段一起带上，因为提交请求里一项都不能少。
      return { ref: JSON.stringify({ token, type, name: file.name }) };
    },

    video: {
      async submit(input: ProviderVideoInput, ctx: ProviderVideoContext) {
        const { request } = input;
        checkMode(request.mode, input.references.length);
        const project = await ensureProject(ctx, undefined, { create: true });

        const files = input.references.map((reference) => {
          const parts = parseRef(reference.source);
          return {
            file_name: parts.name,
            file_type: parts.type,
            upload_token: parts.token,
          };
        });

        const created = await post(
          ctx,
          "chat_with_uploads",
          {
            content: request.prompt,
            project_id: project.projectId,
            ...(files.length ? { files } : {}),
          } as JsonObject,
          requestTimeoutMs,
        );
        const streamChatId = required(created.stream_chat_id, "stream_chat_id");
        return {
          status: "submitted" as const,
          remoteTaskId: streamChatId,
          state: project.state,
        };
      },

      async query(
        input: ProviderQueryInput,
        ctx: ProviderVideoContext,
      ): Promise<ProviderQueryResult> {
        const project = await ensureProject(ctx, input.state, { create: false });
        const data = await post(ctx, "run_result", {
          project_id: project.projectId,
          stream_chat_id: input.remoteTaskId,
        });

        // `terminal: false` 是唯一可靠的"还在跑"判据。
        if (data.terminal !== true) {
          return { status: "running", state: project.state };
        }
        // 到了终态，只有 resource_states 里真的出现 video 才算成片。
        // Flova 的 `status: completed` 是骗人的：它停下来等用户确认时，
        // 四个完成字段仍然全绿，但 resource_states 是空的。
        const url = videoUrl(data);
        if (url) {
          return { status: "succeeded", outputs: [{ kind: "url", url }] };
        }
        const said = agentMessage(data);
        return {
          status: "unknown",
          reason: said
            ? `Flova 没有出片，它说：${said}`
            : "Flova 到了终态但没有视频资源，去项目里看 / Task ended without a video",
        };
      },
    },
  };
}

/// 上传时编码的 ref；这里只认自己的形状。
function parseRef(source: { kind: string; ref?: string }): {
  token: string;
  type: string;
  name: string;
} {
  if (source.kind !== "uploaded" || !source.ref) {
    throw new PluginError(
      "invalid_request",
      "Flova 的参考素材必须先上传 / Flova references must be uploaded first",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(source.ref);
  } catch {
    throw new PluginError("invalid_response", "Malformed Flova reference");
  }
  // `required` 抛的是带字段名的 PluginError，不能被上面的 catch 一起吞掉，
  // 否则诊断信息只剩"格式不对"。
  if (!object(value)) {
    throw new PluginError("invalid_response", "Malformed Flova reference");
  }
  return {
    token: required(value.token, "token"),
    type: required(value.type, "type"),
    name: required(value.name, "name"),
  };
}

/// 宿主已按声明校验过一遍，但插件不该假设它一定做了：
/// 文生带了参考、或参考模式没带参考，都会让 Flova 那边按错误的方式理解请求。
function checkMode(mode: string, references: number): void {
  if (mode === "text" && references > 0) {
    throw new PluginError(
      "invalid_request",
      "文生模式不能挂参考素材 / Text mode takes no references",
    );
  }
  if (mode === "reference" && references === 0) {
    throw new PluginError(
      "invalid_request",
      "参考模式至少要一个参考素材 / Reference mode needs at least one reference",
    );
  }
}

/// 成片地址两处都可能出现，形状不同：
/// 老路子在 `assistant_messages[].artifacts[]`；带参考视频的那条路
/// `assistant_messages` 是空的，产物只在 `resource_states[]`。
function videoUrl(data: JsonObject): string | null {
  const messages = Array.isArray(data.assistant_messages)
    ? data.assistant_messages
    : [];
  for (const message of messages) {
    if (!object(message)) continue;
    const artifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
    for (const artifact of artifacts) {
      if (
        !object(artifact) ||
        artifact.media_type !== "video" ||
        artifact.status !== "success"
      ) {
        continue;
      }
      const url = artifact.resource_url ?? artifact.url;
      if (typeof url === "string" && url) return url;
    }
  }
  const states = Array.isArray(data.resource_states)
    ? data.resource_states
    : [];
  for (const state of states) {
    if (
      !object(state) ||
      state.media_type !== "video" ||
      state.status !== "success"
    ) {
      continue;
    }
    const playback = object(state.playback) ? state.playback : null;
    const url = playback?.url ?? state.resource_url ?? state.url;
    if (typeof url === "string" && url) return url;
  }
  return null;
}

/// 没出片时唯一能说明原因的东西：agent 会先停下来问用户
/// （"本段缺某人物的身份图，是否允许…"），而状态字段照样报完成。
function agentMessage(data: JsonObject): string | null {
  const chunks: string[] = [];
  for (const key of ["messages", "assistant_messages"]) {
    const list = Array.isArray(data[key]) ? (data[key] as unknown[]) : [];
    for (const message of list) {
      if (!object(message)) continue;
      const role = message.role;
      if (role != null && role !== "assistant") continue;
      const parts = Array.isArray(message.parts) ? message.parts : [];
      for (const part of parts) {
        if (!object(part) || part.kind !== "text") continue;
        const text = part.text;
        // 跳过流式单字片段，只要成段的整话。
        if (typeof text === "string" && text.trim().length > 20) {
          chunks.push(text.trim());
        }
      }
    }
  }
  return chunks.length ? chunks.join("\n") : null;
}
