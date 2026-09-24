---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-session-format-v5

[English](2026-09-24-session-format-v5.md) | 中文

## 概述

记录 `max-steps` 轮次结束原因对应的 Session V5 头部版本转换，以及此写入方携带的持久化类型。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-session-format-v5
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-16-session-format-v4"
    after: "22c6899a78214dd841c266348ae997027ef391174ddb21127f1b71dc1b362824"
    decision: version-bump
  - root: "event:action/committed"
    previous: null
    after: "08d895c504e1796bea4577b2cfe10c42ca295531b7fa442bb4fe55a657209395"
    decision: version-bump
  - root: "event:action/decided"
    previous: null
    after: "ac2e1e7b6fdca29da06a4b0230fbc37c1f91ebc310e6a49b95714d5e417b6bc1"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-16-session-format-v4"
    after: "39776a128196c7509f8ab932704e410408eae1646ab630a308c3b420fa407a32"
    decision: version-bump
  - root: "event:budget/exceeded"
    previous: null
    after: "126afc36b0158f9df6867df64456aba351851dffb45cc647c934f5088a5f533b"
    decision: version-bump
  - root: "event:checkpoint/created"
    previous: null
    after: "3c5f3e46f62ba61c77e610a22fbcb4b68482fbeca5e65f2735b7b0d0192b60a2"
    decision: version-bump
  - root: "event:checkpoint/resumed"
    previous: null
    after: "1d3846c9fee308677667ca395155354956b0f54dd4477ed00faaae619e7d94b4"
    decision: version-bump
  - root: "event:claim/updated"
    previous: null
    after: "f5d042eb7d11628306134346617f4dc992edc6e6a97cbbbbdd87521cb16702f2"
    decision: version-bump
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "6abc83b9140f3925e2ae6a6e533feae779bdd71e5a22bae6a1cf7ddf09a40c27"
    decision: version-bump
  - root: "event:context/compiled"
    previous: null
    after: "df071df8f4fab579c0a91686c9560a27fa6dda38e1d594c525164d868ff14f79"
    decision: version-bump
  - root: "event:delegation/issued"
    previous: null
    after: "120a02a8a7313c38a0b0bda63276548b8c1fc3afe756a116071eefa848f75dfc"
    decision: version-bump
  - root: "event:delegation/received"
    previous: null
    after: "5186002667d10869f1b5d16b8409ea314f39e1bb4be6211f9d4c38bee694fd14"
    decision: version-bump
  - root: "event:developer/message"
    previous: "2026-09-16-session-format-v4"
    after: "323b4364fa1e174cc346607f6e345c95dc12ef5f8562459c04bd91bf58e8efaf"
    decision: version-bump
  - root: "event:evidence/recorded"
    previous: null
    after: "091b30fac1dbbfd89ca4ca0f05571b91f6e6e8d50a26b3a039752f90641beaf4"
    decision: version-bump
  - root: "event:failure/recorded"
    previous: null
    after: "5b38ecbd24196b3c4b2469f5756c09f761101f19ade7013f581ed1ce74dfd0ad"
    decision: version-bump
  - root: "event:hypothesis/updated"
    previous: null
    after: "25ed756c00e9dbb833f3f41908ec79171f581500d205ccfdf29207d4c7a9800e"
    decision: version-bump
  - root: "event:llm/fallback"
    previous: null
    after: "1de196c2aba6d4bbba982cdb63ffa7f81328c9daca09bdc78fb933135c9317f3"
    decision: version-bump
  - root: "event:recovery/decided"
    previous: null
    after: "0b3422aaa8086c7f01ff5e619e28b95efe6ffec7528ecf3cbdb1cf95e48c9e60"
    decision: version-bump
  - root: "event:recovery/started"
    previous: null
    after: "8f098954477517a8defbbbb818ecb82724e604952d1100d98c5d1df6bb19b208"
    decision: version-bump
  - root: "event:security/scan"
    previous: null
    after: "d7398a9a37b2f88ae82945493ad8b6ebdba6c4fe3fea09044ce1bb2139b7d8f6"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-16-session-format-v4"
    after: "c4907659735b456a834427fd1e3f794f76c02d3c6cb3a19e0e7b6c5258a331bb"
    decision: version-bump
  - root: "event:task/created"
    previous: null
    after: "c2209d455f63782ee3f25e3d1ccfdee93d90faf3a0de93b5db04f94f4c394be7"
    decision: version-bump
  - root: "event:task/plan"
    previous: null
    after: "5fa943ba2fb6e5d8b3f8909d58a8b37458bed859f3533e64ff882739f5b30b63"
    decision: version-bump
  - root: "event:task/transitioned"
    previous: null
    after: "75898e2317836bd990551de2d24451e84007eac5a26335c2e7637df591831040"
    decision: version-bump
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "85f15e198c730df32e4db6e51cae200d86685208b1eaabbf1bf6be555de3a92a"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-16-session-format-v4"
    after: "5b2f42e67ff7a6f45e13141c1383e19b1a9e99bb1545f3ce2da4ff16edccb942"
    decision: version-bump
  - root: "event:verification/requested"
    previous: null
    after: "8b12962106d94de745466a7e5d31fd9c6ebf9232c0cc9d470640dea5aa741295"
    decision: version-bump
  - root: "event:verification/result"
    previous: null
    after: "f514b1a9c3bf4138691e4c77a6932b347579e0c127931266b208246911902356"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

V4 读取器无法解释 `turn/end.reason.kind=max-steps`。V5 将 `SessionHeader.version` 从 4 提升到 5，并加入相邻的 V4 到 V5 迁移边。该迁移边保留 V4 事件和继承截点；V5 编解码器沿用 V4 物理行编码。新增事件根和可选字段本身不要求版本提升。新消息来源种类显式标记为仅归属信息，因此读取器会保留其 JSON 元数据，但不会授予权限或增加来源方专有的回放行为。已提交的前序 generation 保持不变，也不承诺降级路径。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v4-to-v5/tests：3 个测试通过。pnpm exec vitest run packages/session/session-format-catalog/tests：35 个测试通过。pnpm exec vitest run packages/session/session-persistence-jsonl/tests/v3-restart-migration.spec.ts：4 个测试通过。pnpm exec vitest run packages/session/session-persistence-jsonl/tests/catalog-migration.spec.ts：82 个测试通过，1 个跳过。pnpm exec tsc -b packages/session/session-format-v4-to-v5/tsconfig.json packages/session/session-format-catalog/tsconfig.json packages/session/session-persistence-jsonl/tsconfig.json --pretty false：通过。pnpm run verify-persistence-formats：通过。

<a id="dev-note"></a>
## 开发备注

无。
