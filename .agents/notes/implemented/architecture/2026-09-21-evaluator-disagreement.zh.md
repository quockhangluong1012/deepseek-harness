# Agent Note: 评估者分歧基座

Status: implemented

[English](2026-09-21-evaluator-disagreement.md) | 中文

## Problem

`specs/evolutionary-harness-v11-deep-research.md` P1 第 16 项要求评估者集成（evaluator ensemble），§58 步骤 4 要求把证据放进决策。评分器的行为门度量的东西各不相同——正文是否可提交、路由是否正确、回放有无退化——但 `evaluateBehavior` 只产出一个批准比特。分歧裁决（路由通过、回放退化）在下游与一致拒绝无法区分：没有任何信号指明是哪些评估者产生了分歧，因此 curator 或未来的集成既不能把分歧当作不确定性，也不能区别对待。

## Decision

由评分器拥有的纯通道裁决归约。`evaluatorDisagreement(channels)`（`packages/evolution/evolution-scorer/src/disagreement.ts`）把每个通道的一份裁决归约为按从廉价到昂贵的标准顺序（`contract`、`routing`、`replay`）排列的批准与反对两份名单，并以 `unanimous` 表示它们是否口径一致。`BehaviorEvaluation` 在 `evaluated` 路径（三通道）与 `gated` 路径（两通道——回放从未运行，因此它不表态）上都携带 `disagreement`。一致包括一致拒绝与一致批准；只有分歧才是 uncertainty 信号。零通道直接抛错，因为那是调用者 bug，不是裁决。类型（`DisagreementChannel`、`ChannelVerdict`、`EvaluatorDisagreement`）放在 `src/types.ts`，遵守包规则中 `types.ts` 只放类型、不放运行时代码的要求。

## Alternatives considered

- **单个布尔分歧标志**——拒绝：它只记录通道分裂了，不指明谁反对，而 curator 或集成要行动恰恰需要后者。
- **现在就做完整集成评判**——拒绝：独立评判需要基准语料来对照（P1 第 17 项），而语料尚不存在；归约是评判未来要喂入的基座，不是评判本身。
- **把路由通道做阈值门以凑出一致**——拒绝：路由裁决已是硬门，为制造一致而软化它属于虚构精度。

## Consequences

- Consolidation 与未来的评判可以把分歧裁决读作「值得调查」，而不是把它与拒绝混为一谈。
- 归约是纯函数，spec 可直接驱动，无需启动进程；评分器保持无状态，不发布 invariant 伴生包。
- `gated` 路径的两通道归约如实面对回放的缺席：一道通过的门伴随一道失败的门仍记为分歧，绝不记为批准。

## Deviations from the plan

- 无：本切片只是 P1-16 的基座——归约加接线，没有评判。

## Testing

- `tests/disagreement.spec.ts`：与输入顺序无关的标准排序、双向一致、空输入抛错、两通道 gated 形状。
- `tests/behavior.spec.ts` 断言 evaluated 与 gated 路径上携带的 disagreement。
- 评分器套件全绿（47 tests）；JSON 覆盖率报告确认 `src/disagreement.ts` 语句/分支/函数 100%。
- 评分器 README 以两种语言记录该字段。

## Left alone

- 集成评判（P1-16 余部）仍需先有基准语料（P1-17）。
- P1-19 shadow/canary、P1-20 自适应路由及 P2/P3 家族仍是未来切片。
