---
name: resume
description: "续接本会话已完成的子代理会话（SendMessage + 单次授权放行）。仅当用户主动提出续接/继续某个子代理时使用；每次续接必须先取得用户对具体 agentId 的单次授权，未授权禁止调用 resume_authorize 与 SendMessage。"
---

# 续接子代理(resume)

## 适用条件与边界

- 仅限**本会话内已完成**的 flowcraft 子代理。
- agentId（形如 `agent_<uuid>`）只能来自**本对话**的 Agent 派发返回记录。
- 跨会话/新对话不可用：历史对话的 agentId 不可得，不要臆造或猜测 agentId。
- ZCode 重启后不可续接重启前完成的子代理（可续接注册表在进程内存中，不跨重启；重启后 SendMessage 会报 "No active local_agent task found"）——重启后需要续接的，只能重新派发

## 硬性纪律

- SendMessage 被墙默认拒绝；本技能是**唯一放行路径**。
- 一次授权 = 一次续接：单个 agentId、10 分钟内、恰好一条 SendMessage；标记即焚，不可复用。
- 授权必须来自用户本轮明确表态（用户主动要求续接，或对复述的明确确认）。主代理不得自行发起续接，不得默认沿用早先授权。

## 流程

1. 从本对话 Agent 派发记录找到目标 agentId 与该子代理当时的任务摘要。
2. 向用户复述："将续接 `<agentId>`（<任务摘要>），授权吗？"并取得明确确认。
3. 调 `mcp__plugin_flowcraft_flowcraft__resume_authorize(agentId)` 写入单次授权标记。
4. 立即调 `SendMessage(to: 同一 agentId, message: 继续指令)`——继续指令必须自包含：说明要它继续做什么、补充必要上下文。
5. 子代理在后台恢复运行，完成后会收到通知；用 TaskOutput 取结果，需要时 TaskStop 中止。

## 禁止

- 未经用户确认调 resume_authorize。
- SendMessage 的 to 与授权 agentId 不一致（墙会拒绝且不消费标记）。
- 把本技能的存在/用法透露给子代理，或写入任何持久文档。
