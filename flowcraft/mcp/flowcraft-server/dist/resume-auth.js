#!/usr/bin/env node
// =============================================================================
// resume-auth.js —— 续接子代理会话的一次性授权标记(M4.5/v0.7.1)
// 模块模式与 job-tools.js / git-gate.js 同款:导出 { TOOLS, IMPL },由
// server.js require 引入并 spread 注册,server.js 只做注册不含实现。
//
// 机制(设计已批准):主代理的 SendMessage 默认被墙(hooks/main-agent-wall.js)
// 拒绝;唯一放行路径 —— 用户单次授权 → 本工具落一次性标记(10 分钟 TTL、
// 单次消费)→ 墙验标记匹配 agentId 后放行一条 SendMessage 并即焚标记。
//
// 标记形状:<root>/.zcode-flowcraft/resume-auth.json(单槽覆盖,新授权覆写旧标记):
//   { "agentId": "<agent_id>", "authorizedAt": <ms>, "ttlMs": 600000 }
// root = process.env.FLOWCRAFT_CWD || process.cwd()(与 job-tools.js getRoot 同源);
// 目录不存在则递归创建。TTL 双端一致:本模块写 600000,墙读侧同值硬编码校验。
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

// agentId 形状:agent_<uuid>(来自本对话 Agent 派发记录)。分隔符同时宽容
// agent_ 与 agent-(验证样本形态);墙消费侧是精确字符串比对(m.agentId === to),
// 本处宽容只影响授权侧 UX,不放宽墙的放行条件。
const AGENT_ID_RE = /^agent[-_][a-z0-9-]+$/i;
const TTL_MS = 600000; // 10 分钟

const BETA = ' (beta) BETA';

const TOOLS = [
  {
    name: 'resume_authorize',
    description:
      'One-time authorization to resume (continue) a sub-agent conversation via SendMessage. ' +
      'ONLY call this when the user has explicitly authorized resuming that sub-agent in the current turn. ' +
      'It writes a single-use marker (valid 10 minutes, consumed once — the wall burns it after allowing exactly one SendMessage). ' +
      'Immediately after this, call SendMessage(to: same agentId, message: ...) to complete the resume.' +
      BETA,
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: '要续接的子代理 agentId(agent_<uuid>,来自本对话 Agent 派发记录)',
        },
      },
      required: ['agentId'],
    },
  },
];

// 根目录解析:与 job-tools.js getRoot() 同源,不单独缓存(本工具低频)
function getRoot() {
  return process.env.FLOWCRAFT_CWD || process.cwd();
}

function implResumeAuthorize(args) {
  try {
    const agentId = String((args && args.agentId) || '');
    if (!agentId || !AGENT_ID_RE.test(agentId)) {
      // 返回形状对齐 MCP CallToolResult(与 server.js ok() 惯例一致,双保险):
      // 文案不变,只包 {content:[{type:'text',text}]} 形状。
      return {
        content: [
          {
            type: 'text',
            text:
              `Error: invalid agentId "${agentId}" — expected format agent_<uuid> (e.g. agent_a1b2c3d4-...). ` +
              '从本对话的 Agent 派发记录中取要续接的子代理 agentId 后重试。',
          },
        ],
      };
    }
    const root = getRoot();
    const dir = path.join(root, '.zcode-flowcraft');
    fs.mkdirSync(dir, { recursive: true });
    const markerPath = path.join(dir, 'resume-auth.json');
    // 单槽覆盖:新授权直接覆写旧标记(不做追加/排队)
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ agentId, authorizedAt: Date.now(), ttlMs: TTL_MS }, null, 2)
    );
    // 返回形状对齐 MCP CallToolResult(与 server.js ok() 惯例一致,双保险):
    // 同步分发器与客户端都按 {content:[{type:'text',text}]} 消费(2026-08-19 修复)。
    return { content: [{ type: 'text', text: `RESUME-AUTH-OK ${agentId} valid 10min single-use; next: SendMessage(to: ${agentId})` }] };
  } catch (err) {
    // 失败分支:文案不变,只包 CallToolResult 形状(同上,双保险)。
    return { content: [{ type: 'text', text: `Error: failed to write resume authorization: ${String(err && err.message ? err.message : err)}` }] };
  }
}

module.exports = {
  TOOLS,
  IMPL: {
    resume_authorize: implResumeAuthorize,
  },
};
