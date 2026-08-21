# 可选：Agent 行为评测提示词

本文件包含路由回归和内容学习闭环两类语义评测。确定性 Tool 正确性仍由单元测试和集成测试负责。

## 1. 路由行为

你正在评测一个会根据用户目标选择原子 Tool 的 B站视频分析 Skill。

输入：
1. `routing-cases.json` 中的一条测试案例；
2. Agent 实际采用的数据计划、Tool 选择或澄清问题。

请重点判断：

- Primary Intent 的语义是否正确；
- 是否应该澄清；
- 是否漏掉关键 Required Data；
- 是否错误加入 `must_not_default` 中的重量级数据；
- 是否违反 Skill 边界。

不要因为 Agent 没有向用户展示 `TaskPlan` JSON 而判错；普通任务中内部完成规划并继续执行才是正确行为。

不要要求 Focus 标签逐字一致，只要语义等价即可。

返回：

```json
{
  "result": "PASS | PASS_WITH_MINOR_DIFF | FAIL_INTENT | FAIL_CLARIFICATION | FAIL_DATA_RECALL | FAIL_OVERFETCH | FAIL_BOUNDARY",
  "reasons": ["原因"],
  "suggest_rule_change": false
}
```

只有当错误很可能在多个案例中重复出现、属于系统性路由问题时，才设置：

`suggest_rule_change=true`

## 2. 内容学习闭环

你正在评测一个启用了 B站视频分析 Skill 的 Agent 是否完成了真实内容学习任务。

输入：

1. `skill-cases.json` 中的一条案例；
2. 本次官方字幕 Tool 的结构化结果；
3. Agent 的可观察 Tool 调用过程；
4. Agent 最终回复。

请结合字幕原文判断，不使用案例名称猜答案。重点检查：

- Agent 是否保留了用户真正的问题；
- 是否调用了必要的字幕 Tool，且没有默认获取无关数据；
- 是否正确处理 `success / selection_required / missing / failed`；
- `partial` 或 `Transcript.complete=false` 时是否说明限制；
- 最终回答是否直接解决用户问题，而不是只展示 Tool JSON 或内部计划；
- 核心观点、关键步骤和直接引用是否能够回到字幕时间范围；
- 是否区分作者表达和 Agent 推断；
- 是否存在字幕中没有依据的具体观点、步骤、案例或引语；
- 是否出现案例中列出的禁止行为。

不要要求回答采用固定模板。只要结构适合用户目标、内容有字幕依据，就允许不同的组织方式和概括粒度。

返回：

```json
{
  "result": "PASS | PASS_WITH_MINOR_DIFF | FAIL_TOOL_SELECTION | FAIL_STATUS_HANDLING | FAIL_TASK_FULFILLMENT | FAIL_SOURCE_TRACEABILITY | FAIL_BOUNDARY | FAIL_FABRICATION",
  "reasons": ["原因"],
  "suggest_skill_change": false,
  "suggest_tool_change": false
}
```

只有错误来自可重复的 Agent 工作指令缺口时，才设置 `suggest_skill_change=true`。只有结构化 Tool 结果本身不足、错误或难以使用时，才设置 `suggest_tool_change=true`。
