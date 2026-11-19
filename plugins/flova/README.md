# Flova-视频

把 Flova 接成 Reveric 的视频 provider。配置 API Key 后即可在视频模型里选择 Seedance 2.5，参考素材自动上传到 Flova，成片落回素材库。

## 配置

在插件管理中启用「Flova-视频」，新增一个供应商实例：

| 字段       | 必填 | 说明                                                               |
| ---------- | ---- | ------------------------------------------------------------------ |
| API Key    | 是   | Flova CLI 的登录 token，在 `~/.flova/credentials.yaml` 里          |
| API Base   | 否   | 默认 `https://service.flova.ai/api/agent/v3`，只有走代理时才需要改 |
| Project ID | 否   | 不填时首次提交自动建一个项目，并按实例记住                         |

「查询积分」用的是 Flova 的余额接口；生成会使用该账号的额度。

## 能力

只声明 Seedance 2.5，能力边界取自 `flova model list` 的 `video_seedance_2_5` 条目（CLI v0.0.16 实测）：

- 画幅 21:9 / 16:9 / 9:16 / 3:4 / 4:3 / 1:1，没有 adaptive
- 分辨率 480p / 720p / 1080p / 4k，时长 4–30 秒
- 文生、首帧、首尾帧、参考图/视频/音频
- 参考上限：图 30、视频 10、音频 10，合计 50

平台上的其它模型没有声明：每多声明一个就多一份没验证过的边界，需要时按同样的办法从 `flova model list` 补。

## 接口形状

这几处和大多数平台不同，都在 `src/provider.ts` 里消化掉了：

**提交** `POST /chat_with_uploads`，参考素材以 `files` 数组随请求发出：

```json
{
  "content": "...",
  "project_id": "p1",
  "files": [
    { "file_name": "hero.png", "file_type": "image", "upload_token": "..." }
  ]
}
```

三个字段一个都不能少。

**轮询** `POST /run_result`，参数必须放在 body 里；放查询串会 405，空 body 会 422。

**成片判据不能看 `status`。** Flova 在停下来等用户确认时，`status: completed` 和四个完成字段仍然全绿，但一个产物都没有。真正的判据是 `resource_states` 里有没有 video。这种情况会返回 `unknown` 并把 agent 说的话带出来，否则用户只会看到"没出片"。

**上传票据要客户端自己报元数据。** 服务端不量文件，三种媒体的字段名和内容各不相同（2026-11-16 实测）：

| 媒体 | 字段 | 内容 | 缺了会怎样 |
| --- | --- | --- | --- |
| 图片 | `image_metadata` | `{width, height}` | 422 `Missing image metadata` |
| 视频 | `video_metadata` | `{duration, width, height, has_audio}` | 422 `Missing video metadata` |
| 音频 | `audio_metadata` | `{duration}` | 422 `Missing audio metadata` |

字段名不能混用：视频带 `image_metadata` 仍然是上面那条 422。

所以 `uploadReference` 依赖宿主提供的 `mediaInfo`；拿不到就在本地报错，不发一个必被拒的请求。

## 项目号

`/create` 建出来的项目在 Flova 那边删不掉，所以**只在真正提交时建**，并且立刻通过 `state` 交回宿主记住。

查询绝不建项目：拿一个新建的空项目去查旧的 `stream_chat_id` 必然查不到，还会在账号里永久留下一个空项目。因此查询时若用户没配、`state` 里也没有项目号，直接报 `configuration_required`，而不是静默新建。

## 已知边界

- 只做视频，不做图片和声音生成。
- 不支持素材认证（`supportsCertifiedAssets: false`），只走平台上传。
- **不声明首帧 / 首尾帧模式。** 平台自己有 `FirstFrameToVideo` 和 `VideoInterp`，但 `/chat_with_uploads` 的 `files` 每项只有 `{file_name, file_type, upload_token}`，**没有角色字段**：两张图一起发出去，agent 无从知道哪张是首帧、哪张是尾帧，顺序也不保证。声明出来只能靠提示词碰运气，所以干脆不声明——用户选不到，也就不会以为自己在做精确的首尾帧控制。
- 不支持样片：平台上有 `video_seedance_2_5_draft`，但它的行为没有验证过，所以不声明。
- 远端取消没有接入，首版 SDK 也不提供。
- 只声明 Seedance 2.5 一个型号。
- `has_audio` 固定填 `false`：宿主的 `ProviderFileMediaInfo` 没有音轨字段，插件无从得知。服务端不校验这个值（true/false 都能拿到票据），但缺了会被拒，所以字段必须在。

## 验证

```sh
npm test
```

用假 host 覆盖 16 条：模型声明、文生提交、已配置项目号、参考素材编成 `files`、轮询的两种终态、三种媒体各自的上传元数据、缺元数据时本地就报错、查询时不建项目、模式与参考数量不符时拒发、以及 HTTP 200 但 body 里带错误码的情况。

**上传路径对真实 Flova 接口验证过**（2026-11-19，不扣积分）：图片、视频、音频三种 `upload/ticket` 全部通过，`upload/complete` 返回了对应的 `upload_token`。

**真实出片没有验证**，需要花积分。

