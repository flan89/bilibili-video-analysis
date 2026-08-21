# Skill 行为评估工具

`eval/` 保存 Skill 行为评估所需的数据模型、结构化规则、验证流程和命令行入口。

它和 `tests/` 的职责不同：

- `tests/` 保存测试代码、行为案例、固定样例和 Agent 运行结果；
- `eval/` 定义如何校验、记录和评估这些结果。

## 1. 目录职责

### 数据模型

- `schema.ts`：`AgentRun` 运行记录模型；
- `verification.ts`：必须调用、禁止调用、最大调用次数、来源位置和能力缺口等结构化规则；
- `semantic-judge.ts`：语义评分维度和提示生成；
- `semantic-completeness.ts`：行为案例的语义评估字段完整性检查。

### 评估流程

- `verify.ts`：读取 Agent 运行结果并执行确定性规则；
- `dump.ts`：校验并保存新的 Agent 运行结果；
- `verify-helper.ts`：加载和校验行为案例；
- `index.ts`：统一导出公开模块。

### 命令行入口

- `cli/verify-agent-runs.ts`：执行结构化验证；
- `cli/run-semantic-judge.ts`：列出案例或生成语义评分提示；
- `cli/dump-agent-run.ts`：保存 Agent 运行记录。

## 2. 结构化验证

执行：

```bash
npm run agent-run:verify
```

验证流程会：

1. 扫描 `tests/agent-runs/*.json`；
2. 使用 `AgentRunSchema` 检查数据是否合法；
3. 与 `tests/skill-cases.json` 中的案例对应；
4. 检查必需 Tool、禁止 Tool、最大调用次数、来源位置、能力缺口和回答模式；
5. 输出通过、失败、缺失和待进行语义评估的案例。

结构化验证只检查可由程序确定的行为，不证明最终回答的内容质量。

## 3. 语义评估

行为案例可以通过 `semantic_criteria` 描述需要语义判断的维度，例如结论是否准确、来源是否真正支持结论，以及回答是否满足用户目标。

当前命令可以列出案例并生成评估提示：

```bash
npm run agent-run:judge -- --list
npm run agent-run:judge -- --case <caseId>
npm run agent-run:judge -- --all
```

`runSemanticJudgeWithLLM` 通过调用方注入的函数使用外部评估模型，项目本身不绑定模型厂商，也不会让 Tool 在运行时调用第二套模型。

语义评分具有主观性，应与结构化验证、真实使用测试和人工复核结合，不能作为唯一正确性来源。

## 4. 保存 Agent 运行结果

```bash
npm run agent-run:dump -- --from /path/to/agent-run.json
```

写入前会执行数据模型校验。默认保存位置为 `tests/agent-runs/`，该目录中的真实运行结果默认不提交到仓库。

运行记录至少应包含：

- 对应案例编号；
- Tool 调用轨迹；
- 最终回答；
- 记录时间；
- 可选的结构化和语义评估结果。

不要把 Cookie、令牌或其它敏感信息写入运行记录。

## 5. 依赖方向

```text
tests/skill-cases.json
          ↓
eval/ 读取案例并验证 AgentRun
          ↓
tests/agent-runs/*.json
```

测试代码可以引用 `eval/` 的模型和规则。正式 Skill 发布物不包含 `eval/`、测试代码或 Agent 运行记录。

## 6. 评估边界

- 程序规则适合检查是否调用了必要 Tool、是否超过次数和是否包含来源位置；
- 语义评估适合判断证据是否真正支持结论、回答是否准确和是否满足目标；
- Tool 单元测试证明确定性能力，不能代替真实 Agent 行为评估；
- 行为案例是代表性回归样本，不是限制 Agent 表达方式的固定答案；
- 如果一个案例暴露了问题，应先判断是个别差异还是重复出现的系统性错误。

相关文档：

- [`../tests/README.md`](../tests/README.md)：测试数据和行为案例说明；
- [`../docs/development-guide.md`](../docs/development-guide.md)：构建、测试和发布命令；
- [`../SKILL.md`](../SKILL.md)：Skill 运行时主流程。
