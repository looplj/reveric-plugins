# 小云雀-营销

根据[小云雀 API 体验指南](https://bytedance.larkoffice.com/docx/CQOYdJNLioLz6fxRzKXcCsKLnJh)，围绕商品信息和参考素材生成营销视频。

启用「小云雀-营销」，新增对应供应商实例，填写 Access Key。新建时可检查连接、查询积分，最后统一保存，保存后获取并选择模型。密钥与「小云雀-短片」独立配置，也可手动使用同一个账号的 Key。

- 模型：`seedance2.0_fast_vision`、`seedance2.0_vision`、`Seedance_2.0_mini`、`Seedance_2.0_mini_lite`。
- 支持文生视频和素材参考；不声明首尾帧模式。
- 「营销视频字幕」控制 `show_subtitle`，默认开启，仅存在于本插件。
- 营销成片时长预设 10/15/30/60 秒；参考数量由本插件独立声明和测试。当前 Seedance 2.0 系列为最多 9 张图片、3 个视频、3 个音频，合计 15 个；服务端仍校验模型和账号限制。
- 1080p 仅对 `seedance2.0_vision` 开放。
- 支持上传、连接检查、积分查询、双 ID 任务恢复。多视频结果只取第一条并记录日志。

## 开发与验证

本插件的实现、模型定义、fixture 和测试入口都在本目录，源码和测试不引用其他插件。修改平台协议时，本插件单独验证和发布。

在 `reveric-plugins` 仓库根目录使用 Node.js 22：

```sh
npm ci
npm test --workspace @reveric-plugins/xiaoyunque-marketing
npm run check -- xiaoyunque-marketing
npm run pack --workspace @reveric-plugins/xiaoyunque-marketing
```

`test/run.mjs` 将本目录 TypeScript 测试打包后交给 `node --test`，仅模拟 HTTP 回执，不访问真实服务。`npm run check` 还会执行类型检查和实际 ZIP 打包。单独 `pack` 生成的 ZIP 位于本插件目录，可手动导入客户端。

SDK 固定在仓库根 `vendor/`，由根依赖和 lockfile 管理。SDK 源码位于 `reveric` 仓库的 `plugins/sdk/`，修改后需要重新打包并同步本仓库。完整维护和发布流程见[仓库 README](../../README.md)。协议与模型参数由本插件维护，不依赖客户端 Dart catalog。

真实出片需要配置有效 Access Key 后单独联调。协议测试通过不代表已验证远端模型可用性，也不代表已完成 Windows、macOS、Android 的应用内验收。
