# 小云雀-短片

根据[小云雀 API 体验指南](https://bytedance.larkoffice.com/docx/CQOYdJNLioLz6fxRzKXcCsKLnJh)实现的视频 Provider 插件。

在插件管理中启用「小云雀-短片」，新增对应供应商实例，直接填写在小云雀网站申请的 Access Key，可先检查连接或查询积分，最后统一保存。保存后获取并选择模型。点击“查询积分”可显示当前剩余积分（包括零余额），再次点击可刷新。该操作使用表单中当前填写的 Access Key，无需先保存密钥修改。连接检查仅查询积分余额；生成会使用该账号的额度。密钥属于供应商实例，不在插件全局配置或任务 state 中保存。

- 沉浸式短片：文生视频、首帧、首尾帧、图片/视频/音频参考；接入指南列出的 9 个模型及网页配置中的 `Seedance_2.5_flash`。
- Flash 按提供的 `xyq_models.json` 网页配置声明：480p/720p，图片 10 张、视频 5 个、音频 5 个，总数上限字段为 50。时长取表单范围 4 至 180 秒与单次输出上限 30 秒的交集，即 4 至 30 秒。网页配置不等于 API 实测，远端接口是否接受该型号仍需真实生成验证。
- 素材通过宿主的文件句柄上传，不需要另配 S3；返回的资产 ID 用于任务提交。
- 任务持久化 `run_id` 和 `thread_id`，支持重启后的查询。

## 接入边界

文档没有完整的模型时长与素材数量约束，插件在自己的 `src/provider.ts` 中维护时长和参考数量，并由本插件测试验证。最初参考内置模型的基线，后续以渠道约束为准，不要求与 Dart catalog 同步。Mini lite 按 Mini 家族基线处理。例如 Seedance 2.0 系列为 4 至 15 秒、最多 9 张图片、3 个视频、3 个音频，合计 15 个；不同模型分别设置，模型与账号限制仍由服务端校验。1080p 只对文档指定的 `seedance2.0_vision` 开放。

宿主视频任务只接收一个视频 URL。返回多个视频时，按服务端顺序只取第一个视频，忽略其余视频，并记录 info 日志（任务 ID、会话 ID、返回数量、所选索引）。没有视频或第一个视频链接无效时，插件报告 `unknown`，保留远端任务 ID，需到小云雀查看。伴随视频返回的图片不作为视频产物导入。没有独立生图接口，因此不声明图片模型。不声明素材认证、草稿或远端取消能力。

## 开发与验证

本插件的实现、模型定义、fixture 和测试入口都在本目录，源码和测试不引用其他插件。修改平台协议时，本插件单独验证和发布。

在 `reveric-plugins` 仓库根目录使用 Node.js 22：

```sh
npm ci
npm test --workspace @reveric-plugins/xiaoyunque
npm run check -- xiaoyunque
npm run pack --workspace @reveric-plugins/xiaoyunque
```

`test/run.mjs` 将本目录 TypeScript 测试打包后交给 `node --test`，仅模拟 HTTP 回执，不访问真实服务。`npm run check` 还会执行类型检查和实际 ZIP 打包。单独 `pack` 生成的 ZIP 位于本插件目录，可手动导入客户端。

SDK 固定在仓库根 `vendor/`，由根依赖和 lockfile 管理。SDK 源码位于 `reveric` 仓库的 `plugins/sdk/`，修改后需要重新打包并同步本仓库。完整维护和发布流程见[仓库 README](../../README.md)。协议与模型参数由本插件维护，不依赖客户端 Dart catalog。

真实出片需要配置有效 Access Key 后单独联调。协议测试通过不代表已验证远端模型可用性，也不代表已完成 Windows、macOS、Android 的应用内验收。
