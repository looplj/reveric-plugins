// 职责: 用假 host 验证 Flova 插件的提交、查询与上传契约。
// 关联文件:
//   plugins/flova/src/provider.ts
//   plugins/flova/test/fixture.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createFlovaProvider } from "../src/provider";
import { fixture } from "./fixture";

const provider = createFlovaProvider();

test("declares only capabilities the platform actually offers", () => {
  const models = provider.listModels(undefined as any);
  assert.equal(models.length, 1);
  const model = models[0];
  assert.equal(model.kind, "video");
  const caps = (model as any).capabilities;
  // `flova model list` 里没有 adaptive；尺寸档位到 4k。
  assert.ok(!caps.ratios.includes("adaptive"));
  assert.deepEqual(caps.resolutions, ["480p", "720p", "1080p", "4k"]);
  // 平台有首尾帧能力，但 chat 的 files 没有角色字段，表达不了，
  // 所以不声明——声明了用户会以为能做精确首尾帧控制。
  assert.deepEqual(caps.modes, ["text", "reference"]);
  assert.deepEqual(caps.frameRoles, []);
  assert.equal(caps.framesRequireAdaptiveRatio, false);
});

test("text submission returns the stream id and remembers the project", async () => {
  const f = fixture();
  f.queue(
    // create
    { status: 200, body: { code: 0, data: { project: { project_id: "p1" } } } },
    // chat_with_uploads
    { status: 200, body: { code: 0, data: { stream_chat_id: "chat-1" } } },
  );
  const result = await provider.video!.submit(f.input, f.ctx);
  assert.deepEqual(result, {
    status: "submitted",
    remoteTaskId: "chat-1",
    state: { projectId: "p1" },
  });
  // 建项目的项目号必须回传给 host，否则每轮都会再建一个。
  assert.deepEqual(f.body(1), {
    content: "雨夜里女孩回头",
    project_id: "p1",
  });
});

test("a configured project id skips creation", async () => {
  const f = fixture();
  f.settings.projectId = "fixed";
  f.queue({
    status: 200,
    body: { code: 0, data: { stream_chat_id: "chat-2" } },
  });
  await provider.video!.submit(f.input, f.ctx);
  assert.equal(f.url(0).endsWith("/chat_with_uploads"), true);
  assert.equal(f.body(0).project_id, "fixed");
});

test("uploaded references become files entries", async () => {
  const f = fixture();
  f.settings.projectId = "p1";
  f.queue({
    status: 200,
    body: { code: 0, data: { stream_chat_id: "chat-3" } },
  });
  const input = {
    ...f.input,
    request: { ...f.input.request, mode: "reference" as const },
    references: [
      {
        assetId: "a1",
        role: "reference_image" as const,
        mimeType: "image/png",
        fileSize: 10,
        mediaInfo: { width: 1280, height: 720 },
        source: {
          kind: "uploaded" as const,
          ref: JSON.stringify({
            token: "tok-1",
            type: "image",
            name: "hero.png",
          }),
        },
      },
    ],
  };
  await provider.video!.submit(input, f.ctx);
  // 真实报文里 files 每项要三个字段，缺一不可。
  assert.deepEqual(f.body(0).files, [
    { file_name: "hero.png", file_type: "image", upload_token: "tok-1" },
  ]);
});

test("query maps terminal and non-terminal states", async () => {
  const f = fixture();
  f.settings.projectId = "p1";
  // 还在跑：terminal 为 false 是唯一可靠判据。
  f.queue({ status: 200, body: { code: 0, data: { terminal: false } } });
  const running = await provider.video!.query(
    { remoteTaskId: "chat-1" },
    f.ctx,
  );
  assert.equal(running.status, "running");
  assert.equal(f.url(0).endsWith("/run_result"), true);
});

test("a completed run with a video resource succeeds", async () => {
  const f = fixture();
  f.settings.projectId = "p1";
  f.queue({
    status: 200,
    body: {
      code: 0,
      data: {
        terminal: true,
        status: "completed",
        resource_states: [
          {
            media_type: "video",
            status: "success",
            playback: { url: "https://cdn.example/movie.mp4" },
          },
        ],
      },
    },
  });
  const result = await provider.video!.query({ remoteTaskId: "chat-1" }, f.ctx);
  assert.equal(result.status, "succeeded");
  assert.deepEqual((result as any).outputs, [
    { kind: "url", url: "https://cdn.example/movie.mp4" },
  ]);
});

test("completed without a video is unknown, carrying what the agent said", async () => {
  const f = fixture();
  f.settings.projectId = "p1";
  f.queue({
    status: 200,
    body: {
      code: 0,
      data: {
        terminal: true,
        status: "completed",
        resource_states: [],
        assistant_messages: [
          {
            role: "assistant",
            parts: [
              {
                kind: "text",
                text: "本段有警员甲出镜，但参考素材里没有他的身份图，请确认是否允许额外使用项目已有素材。",
              },
            ],
          },
        ],
      },
    },
  });
  const result = await provider.video!.query({ remoteTaskId: "chat-1" }, f.ctx);
  // "完成"不等于成功，这种形态必须报 unknown 并保留原因。
  assert.equal(result.status, "unknown");
  assert.match((result as any).reason, /身份图/);
});

test("upload sends image metadata for images", async () => {
  const f = fixture();
  f.queue(
    {
      status: 200,
      body: {
        code: 0,
        data: {
          upload_url: "https://upload.example/signed",
          gs_uri: "gs://x/1.png",
        },
      },
    },
    { status: 200, body: {} },
    {
      status: 200,
      body: {
        code: 0,
        data: { upload_token: "tok-1", file_type: "image" },
      },
    },
  );
  const result = await provider.uploadReference!(
    {
      file: {
        handle: "h1",
        name: "hero.png",
        mimeType: "image/png",
        size: 42,
        sha256: "abc",
        mediaInfo: { width: 1280, height: 720 },
      },
    },
    f.ctx,
  );
  // 没有元数据时票据接口直接 422，所以这里必须有。
  assert.deepEqual(f.body(0).image_metadata, { width: 1280, height: 720 });
  assert.equal("video_metadata" in f.body(0), false);
  assert.deepEqual(JSON.parse(result.ref), {
    token: "tok-1",
    type: "image",
    name: "hero.png",
  });
});

test("upload sends video metadata for videos", async () => {
  // 实测：视频缺 video_metadata 会 422 "Missing video metadata"，
  // 用 image_metadata 也一样被拒，所以字段名不能混。
  const f = fixture();
  f.queue(
    {
      status: 200,
      body: {
        code: 0,
        data: {
          upload_url: "https://upload.example/signed",
          gs_uri: "gs://x/1.mp4",
        },
      },
    },
    { status: 200, body: {} },
    {
      status: 200,
      body: { code: 0, data: { upload_token: "tok-2", file_type: "video" } },
    },
  );
  await provider.uploadReference!(
    {
      file: {
        handle: "h2",
        name: "cam.mp4",
        mimeType: "video/mp4",
        size: 100,
        sha256: "def",
        mediaInfo: { width: 480, height: 854, durationMs: 2000 },
      },
    },
    f.ctx,
  );
  assert.deepEqual(f.body(0).video_metadata, {
    duration: 2,
    width: 480,
    height: 854,
    has_audio: false,
  });
  assert.equal("image_metadata" in f.body(0), false);
});

test("upload sends audio metadata for audio", async () => {
  const f = fixture();
  f.queue(
    {
      status: 200,
      body: {
        code: 0,
        data: {
          upload_url: "https://upload.example/signed",
          gs_uri: "gs://x/1.mp3",
        },
      },
    },
    { status: 200, body: {} },
    {
      status: 200,
      body: { code: 0, data: { upload_token: "tok-3", file_type: "audio" } },
    },
  );
  await provider.uploadReference!(
    {
      file: {
        handle: "h3",
        name: "voice.mp3",
        mimeType: "audio/mpeg",
        size: 100,
        sha256: "ghi",
        mediaInfo: { durationMs: 2500 },
      },
    },
    f.ctx,
  );
  assert.deepEqual(f.body(0).audio_metadata, { duration: 2.5 });
});

test("a video without a duration fails locally instead of a server 422", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      provider.uploadReference!(
        {
          file: {
            handle: "h2",
            name: "cam.mp4",
            mimeType: "video/mp4",
            size: 100,
            sha256: "def",
            mediaInfo: { width: 480, height: 854 },
          },
        },
        f.ctx,
      ),
    (error: any) => error.code === "invalid_request",
  );
  assert.equal(f.calls.length, 0);
});

test("query refuses to invent a project when state has none", async () => {
  // 建出来的项目在 Flova 那边删不掉；拿新项目查旧任务也必然查不到。
  const f = fixture();
  await assert.rejects(
    () => provider.video!.query({ remoteTaskId: "chat-1" }, f.ctx),
    (error: any) => error.code === "configuration_required",
  );
  assert.equal(f.calls.length, 0);
});

test("text mode with references is rejected before submitting", async () => {
  const f = fixture();
  f.settings.projectId = "p1";
  await assert.rejects(
    () =>
      provider.video!.submit(
        {
          ...f.input,
          references: [
            {
              assetId: "a1",
              role: "reference_image",
              mimeType: "image/png",
              fileSize: 10,
              mediaInfo: { width: 1, height: 1 },
              source: {
                kind: "uploaded",
                ref: JSON.stringify({ token: "t", type: "image", name: "n" }),
              },
            },
          ],
        } as any,
        f.ctx,
      ),
    (error: any) => error.code === "invalid_request",
  );
  assert.equal(f.calls.length, 0);
});

test("reference mode without references is rejected before submitting", async () => {
  const f = fixture();
  f.settings.projectId = "p1";
  await assert.rejects(
    () =>
      provider.video!.submit(
        {
          ...f.input,
          request: { ...f.input.request, mode: "reference" as const },
          references: [],
        },
        f.ctx,
      ),
    (error: any) => error.code === "invalid_request",
  );
  assert.equal(f.calls.length, 0);
});

test("video metadata carries the probed audio flag", async () => {
  // 字段必须在（缺了 422），值服务端不校验；能拿到真值就照发。
  const f = fixture();
  f.queue(
    {
      status: 200,
      body: {
        code: 0,
        data: {
          upload_url: "https://upload.example/signed",
          gs_uri: "gs://x/1.mp4",
        },
      },
    },
    { status: 200, body: {} },
    {
      status: 200,
      body: { code: 0, data: { upload_token: "tok", file_type: "video" } },
    },
  );
  await provider.uploadReference!(
    {
      file: {
        handle: "h",
        name: "voiceover.mp4",
        mimeType: "video/mp4",
        size: 100,
        sha256: "x",
        mediaInfo: { width: 480, height: 854, durationMs: 2000, hasAudio: true },
      },
    },
    f.ctx,
  );
  assert.equal(f.body(0).video_metadata.has_audio, true);
});

test("video without a probed audio flag falls back to false", async () => {
  const f = fixture();
  f.queue(
    {
      status: 200,
      body: {
        code: 0,
        data: {
          upload_url: "https://upload.example/signed",
          gs_uri: "gs://x/2.mp4",
        },
      },
    },
    { status: 200, body: {} },
    {
      status: 200,
      body: { code: 0, data: { upload_token: "tok", file_type: "video" } },
    },
  );
  await provider.uploadReference!(
    {
      file: {
        handle: "h",
        name: "mute.mp4",
        mimeType: "video/mp4",
        size: 100,
        sha256: "y",
        mediaInfo: { width: 480, height: 854, durationMs: 2000 },
      },
    },
    f.ctx,
  );
  // 字段仍然要在，否则整个视频元数据被拒。
  assert.equal(f.body(0).video_metadata.has_audio, false);
});

test("upload without metadata fails before touching the network", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      provider.uploadReference!(
        {
          file: {
            handle: "h1",
            name: "hero.png",
            mimeType: "image/png",
            size: 42,
            sha256: "abc",
          },
        },
        f.ctx,
      ),
    (error: any) => error.code === "invalid_request",
  );
  assert.equal(f.calls.length, 0);
});

test("a platform error inside a 200 body is not swallowed", async () => {
  const f = fixture();
  f.settings.projectId = "p1";
  f.queue({
    status: 200,
    body: { code: 40301, message: "积分不足" },
  });
  await assert.rejects(
    () => provider.video!.query({ remoteTaskId: "chat-1" }, f.ctx),
    (error: any) => {
      assert.match(error.message, /积分不足/);
      return true;
    },
  );
});
