# TaskPlan 内部规划与评测结构

该结构用于开发路由规则、记录内部规划和执行回归评测。普通用户要求分析视频时，Agent 应继续完成数据获取和回答，不要默认把 TaskPlan JSON 当作最终结果。

TaskPlan 有两个逻辑阶段：

```text
Task Routing
  → objective / intent / focus / depth / clarification
        ↓
Data Routing
  → required / optional / avoid / fallbacks
```

参考：

- [`task-routing.md`](task-routing.md)
- [`data-routing.md`](data-routing.md)

需要显式评估时可使用：

```json
{
  "objective": "用户当前真正想完成的目标",
  "primary_intent": "content_learn | visual_decode | audience_insight | market_research | overview",
  "secondary_intents": ["可选辅助 Intent"],
  "focus": ["开放式语义标签"],
  "depth": "quick | standard | deep",
  "clarification": {
    "needed": false,
    "question": null,
    "reason": null
  },
  "data_plan": {
    "required": ["transcript"],
    "optional": ["metadata"],
    "avoid_by_default": ["comments", "video"],
    "fallbacks": []
  },
  "routing_notes": ["仅记录不明显的判断"]
}
```

## 评测重点

Task Routing：

- `primary_intent` 是否正确；
- 是否错误增加 Secondary Intent；
- Focus 是否捕捉了真正目标；
- 是否应该澄清；
- Depth 是否明显过重或过轻。

Data Routing：

- Required Data 是否遗漏；
- 是否错误加入无关重型数据；
- fallback 是否只针对真正 Required 的缺失数据；
- 是否违反当前 Skill 能力边界；
- 成本优化是否破坏 Coverage。

Focus 是开放集合，不要求字符串逐字一致。

如果 `clarification.needed = true`：

- 不应启动猜测性的重型数据路径；
- 可以只做不会浪费明显成本的轻量步骤。
