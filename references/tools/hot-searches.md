# 当前热搜词条

用于获取B站搜索热搜栏当前展示的词条快照。这是 `topic_research` 的发现来源之一，回答"平台用户当前在搜索什么词"。

Tool 只负责采集和确定性清理（图标 URL 规范化、热度值类型转换）；是否展开某个词条去搜索、选择哪个词深入、何时停止由宿主 Agent 按发现策略决定。

**来源机制边界**：结果是平台热搜栏的当前快照，反映的是**搜索关注度**，不是事件背景，也不是需求强度排名。回答时必须表述这一点：

- 禁止把热搜词写成"当前最大的社会事件"或"需求最强的方向"；
- 禁止根据词面自行编造事件背景、原因或趋势（heatScore 只描述本次快照，不做跨时间比较）；
- 词条**不是视频**：要研究某个词对应的内容，必须显式走第二步调用 `search-videos`。

## 1. `hot-searches`

### 输入

```json
{
  "limit": 10
}
```

- `limit`：最终保留的词条数量，默认 10，上限 10；平台来源不接收该参数，Tool 在单次响应后本地截取。

不提供分类、地区和历史时间参数：这些不是当前热搜接口的真实能力。不接受 Cookie，不承诺个性化内容。

### 调用

```bash
node <skill-root>/dist/cli.mjs tool hot-searches '{"limit":10}' --compact
```

Agent 默认使用 `--compact`。热搜词条本身全部保留，同时保留平台时间、报告总数、采集状态和全部 `warnings`；仅省略采集记录中面向程序核查的扩展字段。不要只为改变展示格式重复请求同一快照。

### 关键输出

```text
success
topics[]
  keyword              # 实际可交给 search-videos 的搜索词
  displayName?         # 平台展示名称; 与 keyword 可能不同 (例如赛事条目带"vs"包装)
  position             # 当前热搜列表中的原始位置 (从 1 开始), 便于回查
  heatScore?           # 平台本次快照报告的热度值, 只描述本次快照
  heatLevel?           # 平台热度层级标签
  isCommercial?        # 平台明确返回的商业/投放标记; 缺失表示平台未声明
  iconUrl?             # 平台展示图标地址
observedAt             # 本次观察时间
platformObservedAt?    # 平台报告的观察时间
reportedTotal?         # 平台报告的词条总数
acquisition            # dataKind=hot_search_topics
error?
```

注意：

- `keyword` 才是可执行的搜索词；`displayName` 仅供展示，不要拿它当搜索输入；
- `position` 是**当前热搜列表内**的位置，不是全站需求强度排名；
- `isCommercial` 缺失只表示平台未声明，**不等于自然热度**；平台返回商业标记时必须如实展示给用户，不能隐藏；
- `heatScore` 只属于本次快照，禁止与其它时间的快照比较或换算成"上升/下降趋势"。

## 2. 空结果、部分结果与失败

| 场景 | 表达 |
|---|---|
| 请求成功但列表为空 | `success=true`，`acquisition.status=missing` |
| 有条词但个别条目被跳过 | `success=true`，`acquisition.status=partial`，看 `warnings` |
| 网络 / 结构 / 业务错误 / 风控 | `success=false`，`acquisition.status=failed`，看 `error` |

## 3. 失败与风控

热搜接口匿名调用，无需 WBI 签名，但必须携带普通浏览器请求头（Tool 已内置）。可能遇到：

- **HTTP 412 或业务 -352/-412**：`error.code=hot_search_risk_control`，`retryable=true`。表示稍后重试可能有意义，但**不应立即连续重试**；
- 其它业务错误：`hot_search_api_error`；
- 响应结构变化：`hot_search_invalid_response`（不可重试）；
- 网络异常：`hot_search_network_error`（可重试）。

用户明确要求当前热搜而热搜接口失败时：**公开失败，不用热门视频标题猜热搜词**。

## 4. 深挖与停止

Tool 返回词条后即停止，**不自动把词条提交给搜索**。后续动作由宿主 Agent 决定：

- `quick` 看热搜：取得词条列表后即停止，如实列出词条与商业标记，不做事件解释；
- 用户要求研究某个词时：只展开**一个**与用户目标直接相关的词，用它的 `keyword` 调用 [`search-videos`](video-search.md) 进入视频搜索流程，再按发现策略选择少量候选深入；
- 用户**自带热搜词**进来而当前会话没有近期热搜快照时：先调用本 Tool 核对该词是否在榜并取得其位置、热度与商业标记，再进入搜索；接口失败或词条不在榜时如实说明；会话内已有刚取得的快照则直接复用，不重复请求；
- 不要批量展开多个热词，也不要因为"在热搜上"就扩大搜索范围；
- 停止与来源组合规则见 [`references/discovery-strategy.md`](../discovery-strategy.md)。

不要把一次热搜快照写成"持续上升趋势"；不要把热搜词条与热门视频或其它来源合并后按位置或热度排序。
