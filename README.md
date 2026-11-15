# Reveric 插件库

每个 `plugins/<目录名>/` 是一个独立插件。PR 合并到 `main` 后，流水线识别尚未发布的改动，测试、打包、自动创建 tag 和 GitHub Release，再将市场索引部署到 GitHub Pages。

已迁入小云雀短片和营销两个独立插件，尚未发布。SDK 使用 `vendor/reveric-plugin-sdk-0.1.1.tgz`，无需从 npm registry 发布或下载本项目 SDK。

## 本地使用

使用 Node.js 22（见 `.nvmrc`）：

```sh
npm ci
npm test
npm run check
npm run plan -- --offline
```

`npm test` 验证发布机制，包含临时插件的真实 SDK 打包和模拟 GitHub 发布；不会操作真实 GitHub Release。`npm run check` 检查所有插件，空仓库也能通过。`--offline` 把所有插件视为尚未发布，仅展示计划。

连接真实仓库后，设置 `GITHUB_REPOSITORY=owner/repository` 可运行 `npm run plan` 查询发布计划、`npm run index` 在 `site/index.json` 生成索引。这两条命令仅读取 GitHub；未登录时受匿名 API 速率限制。

## 目录

| 路径 | 用途 |
| --- | --- |
| `plugins/<slug>/` | 插件清单、源码、测试和开发说明 |
| `shared/` | 插件共用的源码；打包时内联，不产生额外安装依赖 |
| `scripts/catalog.mjs` | 插件发现、改动检测、版本计划、索引生成 |
| `scripts/publisher.mjs` | 执行测试、SDK 打包、发布与失败恢复 |
| `scripts/github.mjs` | GitHub API 与发布元数据校验 |
| `.github/workflows/check.yml` | PR 检查及动态插件 matrix |
| `.github/workflows/release.yml` | 合并后自动发布和部署索引 |

新增插件不需要新增或修改 workflow。不要在插件之间直接引用源码；共享实现放入 `shared/`，当前按共享代码变化影响全部插件处理。共享代码不得从插件目录反向导入。

## 插件目录契约

每个插件目录必须包含：

- `plugin.json`：唯一插件 ID、名称、稳定版本、`pluginApiVersion`、`main: "dist/index.js"`，可选平台列表。
- `package.json`：`private: true`、唯一 workspace 名称、`scripts.test`；依赖写在所属插件的 package 中。
- `tsconfig.json`：继承 `reveric-plugin-sdk/tsconfig.base.json`，纳入 `src/`。
- `src/index.ts`：SDK 入口。
- `test/`：插件自己的行为测试，由 `npm test` 执行。

目录名使用小写字母、数字和连字符。清单 ID 使用 `vendor.name` 格式。已发布插件的目录名、ID 不可直接改名；需要新身份时新增插件。

根目录使用 npm workspace 和一份 `package-lock.json`。新增依赖后在根目录运行 `npm install` 并提交 lockfile。根依赖固定为 `file:vendor/reveric-plugin-sdk-0.1.1.tgz`，更新方式见下节。升级 SDK 后全部插件重新检查和发布。插件运行测试时不应访问真实付费服务。

打包复用 SDK 的 `packPlugin`，不要求每个插件配置 build/pack 脚本。ZIP 内含清单和编译后的产物，用户不需要安装 Node.js。测试、README 和源码不会作为市场安装包整体上传。

## 维护入口

本仓库名为 `reveric-plugins`；客户端和 SDK 源码在另一个仓库 `reveric`。路径均相对各自仓库根目录：

| 仓库 | 路径 | 修改内容 |
| --- | --- | --- |
| `reveric-plugins` | `plugins/xiaoyunque/` | 短片接口、模型约束、协议测试 |
| `reveric-plugins` | `plugins/xiaoyunque-marketing/` | 营销接口、模型约束、协议测试 |
| `reveric-plugins` | `vendor/` | 从 SDK 源码打出的固定版本安装包 |
| `reveric` | `plugins/sdk/` | SDK 源码与开发文档 |
| `reveric` | `lib/shared/services/plugins/` | 宿主实现 |

两个小云雀插件不共享业务实现或 fixture，不放入 `shared/`，不互相引用。修改某个插件后，在本仓库根目录执行：

```sh
npm ci
npm test --workspace @reveric-plugins/xiaoyunque
npm run check -- xiaoyunque
npm run plan -- --offline
```

营销插件将名称替换为 `xiaoyunque-marketing`；同时修改两者时执行 `npm run check`。普通修复不用手改版本，合并到 `main` 后自动发版；minor/major 通过提高清单版本下限指定。

## 更新 SDK

SDK 源码在 `reveric/plugins/sdk/`，本仓库只消费 `.tgz`。SDK 内容改变时先分配新版本并更新 `reveric/plugins/package-lock.json`，运行源码仓库的插件和 SDK 测试。兼容扩展可升 patch，0.x 阶段的不兼容 SDK 改动升 minor。下面的命令从两仓库的共同父目录开始，使用 Node.js 22：

```sh
cd reveric/plugins/sdk
npm pack --dry-run
npm pack --pack-destination ../../../reveric-plugins/vendor
cd ../../../reveric-plugins
npm install -D --save-exact ./vendor/reveric-plugin-sdk-<version>.tgz
npm ci
npm test
npm run check
npm run plan -- --offline
```

将 `<version>` 替换成实际新版本。两个仓库放置不同可调整相对路径，不能提交本机绝对路径。必须同时提交新 SDK 包、根 `package.json` 和 lockfile；不能只更新 `reveric` 的 SDK 源码，不能直接修改 `node_modules`，不能覆盖已分发的同版本包。SDK 不需要发布到 npm registry；MIT 许可证包含在包内。`vendor/` 内容参与检查范围和发布指纹，SDK 更新会重新检查和发布全部插件。

新增宿主能力时，先发布支持它的客户端，再发布使用该能力的插件；记录实际验收的客户端版本。模型参数、上游接口映射等只使用既有 API 的修改，通常只需发布插件。

发布前运行 `npm run check`，它会执行两个插件各自的测试和实际 SDK 打包。跨平台安装、生成和恢复需在 Windows、macOS、Android 验收，真实出片和线上发布不由模拟测试替代。客户端市场尚未接入时手动导入 ZIP。迁出不含旧内置安装兼容，ZIP 不能直接覆盖已有 `bundled` 来源；测试使用全新应用配置，不删除业务数据来模拟升级。

## 自动检查与发版

PR 检查通过 Git diff 动态选取插件。源码、测试或说明变更会检查对应插件；共享代码、SDK 包、工具链、流水线或发布机制测试变化会检查全部插件。分支保护统一要求 `checks` 状态，避免动态 matrix 的检查名称变化。

正式发布不只比较当前 PR 的 diff，而是计算每个插件的构建输入 SHA-256，与该插件最新正式 Release 中的 `release.json` 比较。输入包括：

- 当前插件文件，排除 `test/`、`tests/`、`__tests__/`、`docs/`、README、CHANGELOG、`*.test.*`、`*.spec.*` 和构建输出。
- `shared/` 和 `vendor/` 中的发布输入。
- 根 `package.json`、lockfile、`.nvmrc`、`scripts/` 和 workflows。

因此只修改测试或说明会检查但不发布；修改插件 A 不会发布 B；修改公共构建输入会发布全部插件。资源必须放在 SDK 支持的位置，不得把运行时依赖放进排除目录、隐藏文件或从其他插件目录导入。

每次发布固定 checkout 时的 `main` commit，并在 Release 中记录该 commit 和输入 hash。发布与 Pages 部署串行运行，不取消进行中的发布。GitHub 可能合并连续的等待任务：下一次执行会重新核对当前 `main` 的全部插件，发布累积变化，不保证每个 PR 都单独产生一个版本。失败或等待任务被合并后，改动仍会在下一次运行中被发现。

## 版本规则

`plugin.json.version` 是首次版本和人工指定的版本下限：

| 清单版本 | 最近正式发布 | 下次有改动时 |
| --- | --- | --- |
| `1.0.0` | 无 | `1.0.0` |
| `1.0.0` | `1.0.6` | `1.0.7` |
| `1.1.0` | `1.0.6` | `1.1.0` |
| `1.1.0` | `1.1.0` | `1.1.1` |
| `2.0.0` | `1.1.3` | `2.0.0` |

普通修改无需手改版本；需要 minor/major 时，在 PR 中提高版本下限。预发布版本暂不支持。正式版本在打包期间写入清单，随后恢复源码文件，不产生机器人版本提交。

正式 tag 为 `<slug>/v<version>`，ZIP 为 `<plugin-id>-<version>.zip`。tag 由流水线自动创建，不会再次触发 tag 发布流程。GitHub Release 附件与 Cloudflare R2（`https://downloads.reveric.app/plugins/<slug>/v<version>/<plugin-id>-<version>.zip`）均固定到该版本，不使用仓库级 `latest`。

## 发布顺序与失败恢复

每个插件依次执行：测试 → 类型检查和打包 → 创建草稿 Release → 上传 ZIP → 上传 `release.json` → 正式发布。所有插件处理结束后重新读取已正式发布的元数据，先将缺失的插件 ZIP 校验并同步至 Cloudflare R2（`reveric-releases/plugins/<slug>/v<version>/`），全部上传成功后再更新 `reveric-releases/plugins/index.json`。

- 测试或打包失败，不创建 Release。
- 上传或正式发布失败，保留草稿；相同输入重跑复用草稿和版本，可以替换未发布附件。
- 草稿对应的源码已变化，为新输入分配更高版本，旧草稿不自动删除或改指向。版本号可能出现间隔。
- 部分插件失败，其他插件继续；成功版本仍进入索引，workflow 最后报告失败。
- 发布成功但索引/R2 同步失败，重新运行会跳过已发布输入；也可手动触发 `Release plugins`，勾选 `index_only`。
- 已正式发布的版本永不覆盖；修复通过新版本发布。推荐在 GitHub 仓库开启 immutable releases。
- 删除源码目录不会删除历史 Release，也不会自动下架索引记录；本期没有下架功能。

未托管草稿对应的已有 tag 会阻止发版，避免把新包错误关联到旧提交。历史版本保持可下载；不自动降级用户已经安装的插件，也不执行插件业务数据库回滚。

## 索引契约

Cloudflare R2 对外提供 `https://downloads.reveric.app/plugins/index.json`，内容只来自 GitHub 正式 Release 的 `release.json`。不会将主分支上尚未发布的版本放入索引，也不依赖上一份索引。索引版本为 `schemaVersion: 1`。

`plugins` 数组按 ID 排序。每项包含 `id`、`name`、`description`、`author`、`repository`、`versions`；版本按语义版本倒序排列，保留所有正式版本。

每个版本包含 `version`、`pluginApiVersion`、`platforms`、`url`（CDN 主地址）、`fallbackUrl`（GitHub Release 备用地址）、`size`、`sha256`、`releaseUrl`、`sourceCommit`。展示字段采用最高版本的信息。客户端应选择兼容宿主 API 和平台的最高版本，下载后核对大小、hash 和包内 ID/版本，再进入权限确认及安装流程。

生成时验证元数据和 Release 附件的一致性，包括固定下载地址、大小、SHA-256（GitHub 提供 digest 时）和版本。损坏记录会使索引生成失败，保留线上旧索引，不静默隐藏错误。客户端仍须验证实际下载字节，hash 不替代用户的权限授权。

## 首次接入 GitHub 与 Cloudflare R2

本目录只完成本地搭建，不会自动创建远端仓库、提交或推送。

1. 建立公开 GitHub 仓库，默认分支使用 `main`，提交并推送本目录。
2. 在 GitHub 仓库 Secrets 中配置与主仓库一致的 `CLOUDFLARE_R2_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`（写入 `reveric-releases` R2 bucket）。
3. 允许 workflow 使用 `contents: write`。GitHub Release 发布使用仓库自带 `GITHUB_TOKEN`，无需个人访问令牌或 npm 发布凭据。
4. 推荐启用 immutable releases，并要求 PR 的 `checks` 通过后才能合并。
5. 从 Actions 手动运行一次 `Release plugins`，选择 `index_only`。即使插件目录为空，也应部署 `{"schemaVersion":1,"plugins":[]}` 至 `https://downloads.reveric.app/plugins/index.json`。
6. 客户端从 `https://downloads.reveric.app/plugins/index.json` 读取市场索引；ZIP 优先从 `downloads.reveric.app` 下载，失败时可回退至 `fallbackUrl`（GitHub Release 附件，无需 GitHub 登录）。已安装插件不依赖索引在线。
