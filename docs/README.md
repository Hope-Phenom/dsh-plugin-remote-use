# 文档地图

**这个仓库的知识都在 `docs/` 里。** 根 [README](../README.md) 只讲两件事：这个插件是什么，以及怎么用。

## 按目的找

| 你想…… | 打开 | 规模 |
|---|---|---|
| 装它、用它、排障 | [../README.md](../README.md) | 上手 |
| 知道**为什么这么设计**、当时放弃了什么、哪一轮推翻了哪个结论 | [DESIGN.md](DESIGN.md) | ~4000 行，按轮次记录 |
| 避开**已经踩过的坑**（每条都附当时的原始输出与**发现方式**） | [PITFALLS.md](PITFALLS.md) | ~3200 行，A–G 七类 |
| 查**上游契约**：provider 接缝、ACP 用法、`ctx.tools.register` 的真实形状、Cordis 补丁语义 | [INTERFACES.md](INTERFACES.md) | 契约 |
| 跑**测试**：单元 / 冒烟 / 真机，以及每条守卫的理由 | [TESTING.md](TESTING.md) | 操作 |
| 看**当初的调研原文**（结论可能已被后续推翻） | [research/](research/) | 归档 |

## 三份主文档的分工

- **DESIGN** 说"系统**应该**怎样"——架构、协议、裁决与理由。
- **INTERFACES** 说"边界处的**接口长什么样**"——上游 API 与集成事实。
- **PITFALLS** 说"**这样写会怎么坏**，以及怎么知道它坏了"。

三者的关系在 [PITFALLS 开头](PITFALLS.md)也讲了一遍。**先看 PITFALLS 再看 DESIGN 通常更省时间**：
前者是按"坏了什么"组织的，后者是按"应该怎样"组织的。

## 关于 `research/`

`research/` 是**归档**，不是当前事实来源。它们是设计开始之前的源码级调研（子 Agent 接缝、插件与传输、
ACP 可行性、审批模型、API 验证、工作区同步、从机勘察、GUI 机制）以及两轮验证发现。

⚠️ **读它们时请对照 PITFALLS。** 其中最典型的一条：`01-subagent-seam.md` 与 `05-api-verification.md`
支撑了"每台从机在 profile 补丁里写一行工具行"这个结论，而它在 0.2.0 被**推翻** ——
那样的行即使写对也到不了模型（PITFALLS [F11](PITFALLS.md)）。**调研文档保留原样，是为了留下
"当时为什么这么想"的证据，不是因为它现在还对。**
