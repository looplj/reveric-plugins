import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginSetup, ProviderVideoInput } from "reveric-plugin-sdk";
import { provider, apply } from "../src/index";
import { fixture } from "./fixture";

test("marketing maps ratio enums, exact duration and instance subtitle setting", async () => {
  const f = fixture();
  await provider.video!.submit(f.input, f.ctx);
  assert.match(f.calls[0][0], /agent\/submit_marketing_run$/);
  assert.equal(f.calls[0][1].timeoutMs, 300000);
  assert.deepEqual(f.calls[0][1].body.value.general_agent_settings, {
    ratio: 2,
    video_model: "Seedance_2.0_mini",
    duration_start: 10,
    duration_end: 10,
    video_resolution: "480p",
    show_subtitle: false,
  });
});

test("registers four marketing models with plain model IDs", async () => {
  let registered;
  apply({
    provider: {
      register(p) {
        registered = p;
      },
    },
  } as PluginSetup);
  assert.equal(registered, provider);
  const models = await provider.listModels(fixture().ctx);
  assert.deepEqual(
    models.map((m) => m.id),
    [
      "seedance2.0_fast_vision",
      "seedance2.0_vision",
      "Seedance_2.0_mini",
      "Seedance_2.0_mini_lite",
    ],
  );
  for (const model of models) {
    assert.equal(model.name, model.id);
    assert.ok(model.kind === "video");
    assert.deepEqual(model.capabilities.modes, ["text", "reference"]);
    assert.deepEqual(model.capabilities.durations, [10, 15, 30, 60]);
    assert.equal(model.capabilities.maxReferences, 15);
    assert.deepEqual(model.capabilities.references, {
      image: { maxCount: 9 },
      video: { maxCount: 3 },
      audio: { maxCount: 3 },
    });
  }
});
test("marketing rejects short-film-only models and frame modes", async () => {
  const f = fixture();
  f.input.request.modelId = "Seedance_2.5";
  await assert.rejects(provider.video!.submit(f.input, f.ctx), /parameters/);
  f.input.request.modelId = "Seedance_2.0_mini";
  f.input.request.mode = "first_frame";
  await assert.rejects(provider.video!.submit(f.input, f.ctx), /parameters/);
  assert.equal(f.calls.length, 0);
});
test("marketing applies subtitles and 60-second preference", async () => {
  const f = fixture();
  f.ctx.settings.get = async () => true;
  f.input.request.durationSeconds = 60;
  f.input.request.ratio = "9:16";
  await provider.video!.submit(f.input, f.ctx);
  const body = f.calls[0][1].body.value;
  assert.equal(body.general_agent_settings.show_subtitle, true);
  assert.equal(body.general_agent_settings.duration_start, 60);
  assert.equal(body.general_agent_settings.duration_end, 60);
  assert.equal(body.general_agent_settings.ratio, 3);
  assert.equal(body.video_part_tool_param, undefined);
});
function imageReferences(count: number): ProviderVideoInput["references"] {
  return Array.from({ length: count }, (_, index) => ({
    assetId: `image-${index}`,
    role: "reference_image",
    mimeType: "image/png",
    fileSize: 1,
    mediaInfo: {},
    source: { kind: "uploaded", ref: `uploaded-${index}` },
  }));
}
for (const count of [5, 9]) {
  test(`marketing submits ${count} mini reference images without dropping any`, async () => {
    const f = fixture();
    f.input.request.mode = "reference";
    f.input.references = imageReferences(count);
    await provider.video!.submit(f.input, f.ctx);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(
      f.calls[0][1].body.value.asset_ids,
      f.input.references.map(
        (ref) => ref.source.kind === "uploaded" && ref.source.ref,
      ),
    );
  });
}
test(`marketing rejects 10 mini reference images before network`, async () => {
  const f = fixture();
  f.input.request.mode = "reference";
  f.input.references = imageReferences(10);
  await assert.rejects(provider.video!.submit(f.input, f.ctx), /reference/i);
  assert.equal(f.calls.length, 0);
});

const queryInput = { remoteTaskId: "run", state: { threadId: "thread" } };
test("uploads through host file handle and returns remote asset identity", async () => {
  const f = fixture({ pippit_asset_id: "asset" });
  assert.deepEqual(
    await provider.uploadReference!(
      {
        file: {
          handle: "opaque",
          name: "x.png",
          mimeType: "image/png",
          size: 1,
          sha256: "hash",
        },
      },
      f.ctx,
    ),
    { ref: "asset" },
  );
  assert.equal(f.calls[0][0], "opaque");
  assert.equal(f.calls[0][1].fileField, "file");
  assert.equal(f.calls[0][1].headers["Content-Type"], undefined);
});
test("connection checks zero balance as valid without a generation request", async () => {
  const f = fixture({ total_remain_amount: "0" });
  assert.equal(
    (await provider.checkConnection!(f.ctx)).accountLabel,
    "小云雀 / Xiaoyunque",
  );
  assert.match(f.calls[0][0], /get_credit_balance$/);
});
for (const balance of ["0", "123", "9223372036854775807"]) {
  test(`credit query preserves exact balance ${balance}`, async () => {
    const f = fixture({ total_remain_amount: balance });
    assert.deepEqual(await provider.actions!.queryCredits(f.ctx), {
      ok: true,
      text: {
        "zh-CN": `剩余积分：${balance}`,
        en: `Credits remaining: ${balance}`,
      },
    });
    assert.equal(f.calls[0][1].body, "{}");
    assert.equal(f.calls[0][1].headers.Authorization, "Bearer key");
  });
}
for (const balance of [null, "", "NaN", "1.5", 123]) {
  test(`credit query rejects malformed balance ${balance}`, async () => {
    const f = fixture({ total_remain_amount: balance });
    await assert.rejects(
      async () => provider.actions!.queryCredits(f.ctx),
      /balance|amount/,
    );
  });
}
test("credit query preserves service failures", async () => {
  const f = fixture();
  f.respond({ status: 401, body: { ret: "401", errmsg: "Access Key 已失效" } });
  await assert.rejects(
    async () => provider.actions!.queryCredits(f.ctx),
    /Access Key 已失效/,
  );
});
for (const [state, status] of [
  [1, "queued"],
  ["2", "running"],
  [4, "failed"],
  [5, "cancelled"],
  [99, "unknown"],
]) {
  test(`maps state ${state} to ${status} after restart`, async () => {
    const f = fixture({
      run_id: "run",
      thread_id: "thread",
      run_state: state,
      fail_reason: { code: 42, message: "余额不足" },
    });
    const result = await provider.video!.query(
      JSON.parse(JSON.stringify(queryInput)),
      f.ctx,
    );
    assert.equal(result.status, status);
    assert.equal(f.calls[0][1].timeoutMs, 300000);
    if (result.status === "failed")
      assert.equal(result.error.message, "余额不足");
    assert.deepEqual(f.calls[0][1].body.value, {
      run_id: "run",
      thread_id: "thread",
    });
  });
}
test("successful query returns video only, not auxiliary images", async () => {
  const f = fixture({
    run_id: "run",
    thread_id: "thread",
    run_state: "3",
    video_urls: ["https://example.com/v.mp4"],
    image_urls: ["https://example.com/i.png"],
  });
  assert.deepEqual(await provider.video!.query(queryInput, f.ctx), {
    status: "succeeded",
    outputs: [{ kind: "url", url: "https://example.com/v.mp4" }],
  });
  assert.deepEqual(f.logs, []);
});
test("multiple video outputs return only the first video", async () => {
  const f = fixture({
    run_id: "run",
    thread_id: "thread",
    run_state: 3,
    video_urls: [
      "https://example.com/first.mp4",
      "https://example.com/second.mp4",
    ],
  });
  assert.deepEqual(await provider.video!.query(queryInput, f.ctx), {
    status: "succeeded",
    outputs: [{ kind: "url", url: "https://example.com/first.mp4" }],
  });
  assert.deepEqual(f.logs, [
    {
      message: "Xiaoyunque returned multiple videos; using only the first",
      data: {
        remoteTaskId: "run",
        threadId: "thread",
        outputCount: 2,
        selectedIndex: 0,
      },
    },
  ]);
});
for (const urls of [
  [],
  ["file:///private/x", "https://example.com/2"],
  ["file:///private/x"],
]) {
  test(`does not silently accept unsupported outputs ${urls.length}`, async () => {
    const f = fixture({
      run_id: "run",
      thread_id: "thread",
      run_state: 3,
      video_urls: urls,
    });
    assert.equal(
      (await provider.video!.query(queryInput, f.ctx)).status,
      "unknown",
    );
  });
}
test("rejects missing state, mismatched identities and malformed receipts", async () => {
  const f = fixture();
  await assert.rejects(
    provider.video!.query({ remoteTaskId: "run" }, f.ctx),
    /thread_id/,
  );
  assert.equal(f.calls.length, 0);
  await assert.rejects(provider.video!.query(queryInput, f.ctx), /identity/);
  f.respond({
    status: 200,
    body: { ret: 0, data: { run: { run_id: "run" } } },
  });
  await assert.rejects(provider.video!.submit(f.input, f.ctx), /thread_id/);
});
test("rejects unuploaded references and unsupported resolutions before network", async () => {
  const f = fixture();
  f.input.request.resolution = "1080p";
  await assert.rejects(provider.video!.submit(f.input, f.ctx), /parameters/);
  f.input.request.resolution = "480p";
  f.input.request.mode = "reference";
  f.input.references = [
    {
      assetId: "a",
      role: "reference_image",
      mimeType: "image/png",
      fileSize: 1,
      mediaInfo: {},
      source: { kind: "url", url: "https://example.com/x" },
    },
  ];
  await assert.rejects(provider.video!.submit(f.input, f.ctx), /uploaded/);
  assert.equal(f.calls.length, 0);
});
test("preserves service errors and rejects missing key and non-JSON responses", async () => {
  const f = fixture();
  f.respond({ status: 200, body: { ret: "42", errmsg: "余额不足" } });
  await assert.rejects(provider.video!.submit(f.input, f.ctx), {
    code: "rejected",
    message: "余额不足",
  });
  f.respond({ status: 401, body: { ret: "401", errmsg: "无效 Access Key" } });
  await assert.rejects(provider.video!.submit(f.input, f.ctx), {
    code: "authentication",
    message: "无效 Access Key",
  });
  f.respond({ status: 429, body: { ret: "429", errmsg: "请求过于频繁" } });
  await assert.rejects(provider.video!.submit(f.input, f.ctx), {
    code: "rate_limited",
    message: "请求过于频繁",
  });
  f.respond({ status: 404, body: { ret: "404", errmsg: "任务不存在" } });
  await assert.rejects(provider.video!.query(queryInput, f.ctx), {
    code: "not_found",
    message: "任务不存在",
  });
  f.respond({ status: 502, body: "<html>bad gateway</html>" });
  await assert.rejects(provider.video!.submit(f.input, f.ctx), {
    code: "unavailable",
    message: /invalid JSON/,
  });
  f.respond({ status: 200, body: "<html>unexpected</html>" });
  await assert.rejects(provider.video!.submit(f.input, f.ctx), {
    code: "invalid_response",
    message: /invalid JSON/,
  });
  f.ctx.secrets.get = async () => null;
  await assert.rejects(provider.video!.submit(f.input, f.ctx), {
    code: "configuration_required",
    message: /Access Key/,
  });
});
