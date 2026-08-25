# 开发、测试与发布说明

本文件面向从源码构建和扩展项目的开发者，只维护稳定的环境要求、命令、工程边界和验收方式。Skill 使用者的安装方法见 [`installation.md`](installation.md)。

## 1. 开发环境

项目主体使用 TypeScript、Node.js ESM、Zod 和 Vitest。最低 Node.js 版本由 `package.json` 的 `engines.node` 声明。

```bash
npm ci
```

`package-lock.json` 用于可重复安装。安装过程会通过 `prepare` 生成单文件运行入口 `dist/cli.mjs`。只有主动增删或升级依赖时才使用 `npm install`，并应同时检查锁文件变化。

不要直接运行 `npm audit fix --force`。发现依赖问题时，先区分正式依赖和开发依赖，再评估升级的兼容性风险。

## 2. 常用检查命令

```bash
npm run typecheck
npm test
npm run test:release
```

- `typecheck` 检查 TypeScript 类型；
- `test` 运行固定样例单元测试，默认不访问 B站网络；
- `test:release` 在临时目录生成正式 Skill，并从独立工作目录验证发布入口和必需文件。

真实网络集成测试需要显式开启：

```bash
RUN_BILIBILI_INTEGRATION=1 npm run test:integration
```

可以按需设置：

- `BILIBILI_TEST_VIDEO`：元信息测试视频；
- `BILIBILI_SUBTITLE_VIDEO`：已知有字幕的视频；
- `BILIBILI_NO_SUBTITLE_VIDEO`：已知无字幕的视频；
- `BILIBILI_MULTIPART_SUBTITLE_VIDEO`：可选多P视频；
- `BILIBILI_SEARCH_QUERY`：搜索接口集成测试使用的关键词；
- `BILIBILI_COOKIE`：部分集成测试或直接调用底层函数时可选的登录状态，不得打印或提交。当前正式命令行入口不会自动读取该变量或浏览器 Cookie。

真实网络测试用于发现平台兼容性问题，不能替代固定样例测试，也不能混入普通 `npm test`。

依赖审计使用：

```bash
npm audit
```

测试数量、审计结果和执行日期以实际命令输出为准，不抄写进长期文档。

## 3. 手工调用

修改源码后先执行：

```bash
npm run build
```

常用调用示例：

```bash
node dist/cli.mjs tool metadata '{"video":"BV号或视频链接"}'
node dist/cli.mjs tool search-videos '{"query":"Agent Skill 设计","order":"relevance"}' --compact
node dist/cli.mjs tool popular-videos '{"page":1,"pageSize":20}' --compact
node dist/cli.mjs tool hot-searches '{"limit":10}' --compact
node dist/cli.mjs tool related-videos '{"video":"BV号或视频链接","limit":20}' --compact
node dist/cli.mjs tool subtitle '{"video":"BV号或视频链接"}' --compact
node dist/cli.mjs tool subtitle '{"video":"BV号或视频链接?p=2"}' --compact
node dist/cli.mjs tool subtitle '{"video":"BV号或视频链接","page":2,"language":"zh-CN"}' --compact
```

去掉 `--compact` 可以查看完整 Tool 输出。开发时也可以直接调试 TypeScript 源码：

```bash
npm run tool:dev -- metadata '{"video":"BV号或视频链接"}'
```

环境诊断和准备：

```bash
node dist/cli.mjs doctor --json
node dist/cli.mjs setup media --plan
node dist/cli.mjs setup asr --plan
```

`doctor` 和 `setup --plan` 不修改环境。`setup --apply` 只有在用户明确授权后才能执行。

ffmpeg 自动安装当前支持 macOS 的 Homebrew 和 Ubuntu/Debian 的 apt。其它平台仍可使用核心 Tool；视觉或语音识别任务会返回手工准备提示。

## 4. 当前 Tool 与分析协议

### 数据 Tool

| 命令名 | 主要实现 | Tool 说明 | 职责 |
|---|---|---|---|
| `search-videos` | `scripts/discovery/` | `references/tools/video-search.md` | 按单个搜索词取得一页候选视频 |
| `popular-videos` | `scripts/discovery/` | `references/tools/popular-videos.md` | 获取当前热门视频候选 |
| `hot-searches` | `scripts/discovery/` | `references/tools/hot-searches.md` | 获取当前热搜词 |
| `related-videos` | `scripts/discovery/` | `references/tools/related-videos.md` | 获取指定视频的关联推荐候选 |
| `metadata` | `scripts/metadata/` | `references/tools/metadata.md` | 视频元信息和分P |
| `subtitle` | `scripts/subtitle/` | `references/tools/subtitle.md` | 官方字幕和本地语音转写 |
| `danmaku` | `scripts/danmaku/` | `references/tools/danmaku.md` | 带时间位置的弹幕 |
| `comments` | `scripts/comments/get.ts` | `references/tools/comments.md` | 根评论分页 |
| `comment-replies` | `scripts/comments/get-replies.ts` | `references/tools/comments.md` | 指定根评论的回复线程 |
| `frames` | `scripts/visual/` | `references/tools/frames.md` | 关键帧和视觉变化候选 |

命令行注册表位于 `scripts/cli/commands/tool.ts`。`SKILL.md` 只保存能力地图；参数、输出和失败语义维护在对应 `references/tools/*.md` 中。

### Analysis Protocol（分析协议）

| 任务类型 | 文件 | 主要职责 |
|---|---|---|
| `content_learn` | `references/analysis/content-learn.md` | 知识、观点、教程和定向问答 |
| `visual_decode` | `references/analysis/visual-decode.md` | 画面、演示、节奏和表达作用 |
| `audience_insight` | `references/analysis/audience-insight.md` | 观众关注、态度、分歧和反馈 |
| `market_research` | `references/analysis/market-research.md` | 明确商业目标下的需求和竞品信号 |
| `topic_research` | `references/analysis/topic-research.md` | 候选选择、跨视频共识、分歧和互补观点 |

分析协议指导宿主 Agent 如何阅读、比较和判断证据，不生成固定报告格式，也不在程序中实现需要第二套模型的分析器。

## 5. 测试分层

### 固定样例单元测试

默认执行，目标是稳定、快速、不受网络影响，并覆盖成功、部分成功、缺失和失败等边界。

### 真实网络集成测试

显式开启，用于验证 B站接口仍然兼容。测试视频和平台行为会变化，不能作为唯一正确性来源。

### 路由回归测试

修改 `SKILL.md`、`references/task-routing.md`、`references/data-routing.md` 或任务计划结构时，回归 `tests/routing-cases.json`。

重点检查：

- 任务类型是否反映用户真实目标；
- Focus（关注点）是否捕捉用户真正想观察或判断的内容；
- 是否在必要时澄清；
- 当前 Tool 是否错误地反向修改任务判断；
- 是否遗漏必需数据；
- 是否获取无关的重量级数据；
- 是否误触发市场研究。

Focus 是开放集合，不要求字符串逐字一致。

### Skill 行为评估

需要语义理解的能力不能只靠固定程序输出证明。应让启用了本 Skill 的 Agent 执行代表性任务，检查：

- 是否根据用户目标调用必要 Tool；
- 是否避免获取无关的重量级数据；
- 是否使用宿主 Agent 当前模型完成分析；
- 是否保留重要来源的位置；
- 是否正确处理多P、缺失、部分成功和失败；
- 全片任务是否实际覆盖全片；
- 是否直接回答用户，而不是只输出内部任务计划。

Tool 的确定性测试和 Skill 的真实使用评估互相补充，不能互相替代。详细评估工具见 [`../eval/README.md`](../eval/README.md) 和 [`../tests/README.md`](../tests/README.md)。

## 6. 发布物

生成正式发布物：

```bash
npm run release
```

生成目录：

```text
release/bilibili-video-analysis/
├── SKILL.md
├── VERSION
├── LICENSE
├── references/
├── runtime/
└── dist/
    └── cli.mjs
```

`runtime/` 包含语音识别等可选能力所需的 Python 辅助程序和固定依赖清单，是正式发布物的一部分。发布物不携带 TypeScript 源码、测试、开发依赖或 `node_modules`。

发布前至少执行：

```bash
npm run typecheck
npm test
npm run test:release
```

### GitHub 自动发布

普通提交和合并请求由 `.github/workflows/ci.yml` 执行类型检查、离线单元测试和发布物验收。

推送形如 `vX.Y.Z` 的版本标签后，`.github/workflows/release.yml` 会：

1. 检查标签、`package.json` 和 `VERSION` 中的版本是否一致；
2. 重新执行类型检查、离线单元测试和发布物验收；
3. 生成精简 Skill 发布目录；
4. 生成 ZIP、tar.gz 和 SHA-256 校验文件；
5. 创建 GitHub Release，并上传这些正式发布文件。

发布新版本前先同时更新 `package.json` 与 `VERSION`，提交并推送代码，再创建并推送对应标签：

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

标签触发的发布失败时，不要用同名标签指向另一份代码。修复问题后增加补丁版本并创建新标签，保证已经公开的版本可以稳定回查。

## 7. 扩展 Tool 和分析协议

### 7.1 先判断应该扩展哪一层

用户提出新的分析场景时，不要默认新增 Tool 或任务类型。按下面顺序判断：

1. **只是新的 Focus（关注点）**：现有数据和分析方法已经足够时，不改代码；Focus 本来就是开放集合，Agent 可以直接按用户目标分析。
2. **现有任务需要更专业的方法**：例如增加一种教程、视觉或观众反馈的阅读策略，扩展对应的 `references/analysis/*.md`。
3. **缺少确定性数据能力**：需要新的外部接口、媒体处理、格式转换、分页或来源核对时，新增原子 Tool。
4. **出现稳定且真正不同的认知任务**：现有任务类型无法准确表达，且会改变数据需求和判断方法时，才考虑增加新的任务类型与分析协议。

不要因为某个用户希望不同的输出格式，就创建新的分析协议。最终回答结构本来就应服从用户问题。

### 7.2 新增数据 Tool

新数据 Tool 延续外部协议、适配层和内部模型隔离的方式：

```text
references/tools/example.md

scripts/example/ 或对应能力目录/
  bilibili-adapter.ts
  bilibili-raw-schema.ts
  get-example.ts

scripts/bilibili/
  仅在两个及以上能力需要时新增公共请求、签名、错误或协议代码

scripts/models/
  需要跨能力复用时放稳定内部模型

tests/fixtures/
  example-*

tests/unit/
  example-normalize.test.ts
  get-example.test.ts

tests/integration/
  example.integration.test.ts
```

领域专属的 B站协议代码与 Tool 放在同一能力目录；`scripts/bilibili/` 只保存多个能力共同使用的平台基础代码。目录可以按能力实际需要调整，但必须保持平台原始字段、内部模型和 Tool 输出之间的边界。

建议实施顺序：

1. 明确 Tool 负责取得什么数据，以及哪些语义判断仍由 Agent 完成；
2. 在对应能力目录建立最小原始 Schema、B站适配代码和字段转换；只有出现两个及以上消费者时，才把真正公共的平台代码提取到 `scripts/bilibili/`；
3. 在 `scripts/models/` 或能力目录建立稳定内部模型；
4. 实现无状态 Tool，返回数据、采集状态、失败原因和必要的来源位置；
5. 在 `scripts/cli/commands/tool.ts` 注册公开命令；
6. 新增 `references/tools/<name>.md`，说明输入、输出、分页、完整性和失败语义；
7. 更新 `references/data-routing.md`，说明什么任务下它是必需、可选或默认避免的数据；
8. 如果新增了公开数据能力，同步 `SKILL.md` 的能力表；
9. 增加固定样例、适配测试、失败场景和默认关闭的真实网络测试；
10. 运行类型检查、单元测试和正式发布物验收。

Tool 应保持原子化。不要为了调用方便，把多种数据抓取和语义分析合并成一个全功能分析入口。

### 7.3 扩展现有 Analysis Protocol

当新场景仍属于现有任务类型时，优先修改对应的 `references/analysis/*.md`。有价值的补充通常包括：

- Agent 需要识别哪些语义角色或视觉作用；
- 不同 Focus 应如何改变阅读和取证策略；
- 哪些信息是原始事实、Agent 归纳或进一步推断；
- 什么证据足以支持较强结论；
- 哪些常见误判必须避免；
- 如何检查来源可靠性和数据覆盖范围；
- 什么情况下应该停止、降级或向用户澄清。

不要只增加“先总结、再列要点、最后给建议”一类固定输出模板。协议的价值应体现在更专业的判断方法，而不是统一答案格式。

修改后至少增加或调整代表性的 `tests/skill-cases.json` 和 `tests/routing-cases.json` 案例，并用启用了本 Skill 的 Agent 做真实行为评估。

### 7.4 增加全新任务类型

只有稳定的新场景无法归入现有任务类型时才执行：

1. 在 `references/task-routing.md` 定义它与现有任务的区别和触发条件；
2. 在 `references/data-routing.md` 定义最小证据需求和替代路径；
3. 新增 `references/analysis/<intent>.md`；
4. 更新 `SKILL.md` 的任务类型和分析协议导航；
5. 如果缺少数据能力，再按上一节增加 Tool；
6. 增加正向、模糊、组合、降级和不应触发的行为案例。

不要让当前 Tool 是否已经存在反向决定任务类型。新任务可以先暴露真实能力缺口，再按需求实现数据 Tool。

## 8. 外部接口与登录状态

B站公开网页接口可能出现字段变化、访问限制、登录状态差异或临时失败。因此：

- 原始模型只描述当前真正使用的最小字段；
- 未使用字段不做全量强校验；
- 平台错误转换为结构化内部错误；
- 平台原始字段和错误码不扩散到业务控制流；
- 单个数据源失败时，尽可能返回采集状态，让 Agent 决定是否继续或降级。

评论和回复接口使用 WBI 签名。WBI 密钥可以匿名取得，签名通过也不代表请求拥有登录身份。当前正式命令行入口默认匿名调用，不自动读取浏览器 Cookie，也不把 `BILIBILI_COOKIE` 注入 Tool。

因此开发和测试时要分别覆盖：

- 匿名成功；
- 匿名只返回有限数据或空数据；
- 风控或业务错误；
- 底层函数显式注入登录状态后的行为。

如果后续增加正式登录状态支持，应单独设计安全的输入、存储、日志脱敏和授权方式，不能直接抓取浏览器 Cookie，也不能把 Cookie 放进 Tool JSON、命令行参数、日志或固定样例。

调试数据 Tool 时可以记录输入视频标识、解析后的标识、数据来源、重试路径、获取状态和警告。不要长期打印完整字幕、评论或敏感 Cookie。

## 9. 新增程序能力前的判断

- Agent 能否只靠明确指令可靠完成？如果能，优先写入 `SKILL.md` 或相关分析说明；
- 是否涉及外部接口、媒体处理、确定性清理、范围读取或来源核对？如果是，再考虑脚本或 Tool；
- Tool 是否可以独立调用，而不依赖前一次进程内状态？
- 输入是否是 Agent 自然拥有的数据，而不是内部聚合对象？
- 是否意外引入第二套模型调用、模型配置或固定语义报告结构？

## 10. 数据 Tool 验收清单

- [ ] 输入解析和失败语义清楚；
- [ ] 不依赖前一次 Tool 调用留下的内存对象；
- [ ] 输出只包含本 Tool 职责的数据；
- [ ] 不返回不断扩充的通用聚合对象；
- [ ] 平台原始模型与内部模型边界明确；
- [ ] 输出通过运行时模型校验；
- [ ] 覆盖适用的成功、部分成功、缺失和失败状态；
- [ ] 固定样例覆盖正常和异常输入；
- [ ] 真实网络测试可选且默认关闭；
- [ ] 有必要的命令行或等价手工验证入口；
- [ ] 新增或修改的模型字段有中文注释；
- [ ] 对应 Tool reference 已更新；
- [ ] 类型检查、单元测试和发布物验收通过。
