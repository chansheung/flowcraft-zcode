#!/usr/bin/env node
// principles 注入闸门:被 main-agent-wall.js 在 tool==="Agent" 时 require 调用(单一 hook 入口,不依赖多 hook 执行顺序)。
// 逻辑与 mcp/flowcraft-server/dist/server.js 的 principles 段同源(改动需双侧同步):
// 三层加载(全局 ~/.zcode/flowcraft/principles.json + 项目 <cwd>/.zcode-flowcraft/principles.json + 插件随附层 <插件根>/principles/plugin-principles.json)、
// scope 三红线(无 scope 永不注入 / all 恒注入 / reviewer 聚合双收)、按 text.trim() 去重、active===false 跳过、[P1] 稠密编号、上限 20 条。
// v0.4.4 完整性校验——放行条件从"含标记"升级为"含与当前期望逐字节一致的完整块",堵住残缺/过期/异代理块混入。
// v0.7.3 插件随附层:只读数据文件随插件分发(换机器不丢底线原则,declare/remove 不触碰);同文(text.trim() 一致)时
// 全局/项目层优先、插件层副本丢弃;注入块格式不变(与 server.js 逐字节同步)。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const MARKER = '## 设计原则';
const INJECT_MAX = 20;

function loadEntries(p) {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.principles || raw.entries || []);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function scopeMatches(entryScope, agent) {
  if (!entryScope) return false;
  if (entryScope === 'all') return true;
  if (entryScope === 'reviewer') return agent === 'reviewer' || agent === 'reviewer2';
  return entryScope === agent;
}
function gate(input) {
  const prompt = String((input.toolInput || {}).prompt || '');
  const raw = (input.toolInput || {}).subagent_type || (input.toolInput || {}).subagentType || (input.toolInput || {}).agent_type || '';
  const bare = String(raw).includes(':') ? String(raw).split(':').pop() : String(raw);
  const cwd = input.cwd || process.cwd();
  const globalEntries = loadEntries(path.join(os.homedir(), '.zcode', 'flowcraft', 'principles.json'));
  // M3a 状态目录切换:项目层改读 .zcode-flowcraft(不迁移旧 .flowcraft 文件,原版目录不动)。
  const projectEntries = loadEntries(path.join(cwd, '.zcode-flowcraft', 'principles.json'));
  // v0.7.3 插件随附层:__dirname=<插件根>/hooks,按相对定位不依赖环境变量;loadEntries 自带 try/catch
  // (文件缺失/损坏 = 无插件层,不影响原有逻辑)。只读层,declare/remove 永不写入。
  const pluginEntries = loadEntries(path.join(__dirname, '..', 'principles', 'plugin-principles.json'));
  const seen = new Set();
  const picked = [];
  // 顺序 = 优先级:全局 → 项目 → 插件;按 text.trim() 同文去重,首个出现者胜(插件层副本丢弃)。
  for (const e of globalEntries.concat(projectEntries, pluginEntries)) {
    if (!e || e.active === false) continue;
    const text = String(e.text || '');
    const key = text.trim();
    if (!key || seen.has(key)) continue;
    if (!scopeMatches(e.scope, bare)) continue;
    seen.add(key);
    picked.push(text);
    if (picked.length >= INJECT_MAX) break;
  }
  if (picked.length === 0) return { allow: true };
  // 注入块格式与 server.js toolListPrinciples 的注入块逐字节一致(格式变更须双侧同步)
  const block = '## 设计原则（必须遵守）\n' + picked.map((t, i) => `  [P${i + 1}] ${t}`).join('\n');
  if (prompt.includes(block)) return { allow: true };
  const reason = prompt.includes(MARKER)
    ? '注入块与当前原则不一致(过期或不完整)'
    : '派发 prompt 缺少设计原则注入块';
  return { allow: false, message: `${reason}。将下方内容原样粘贴到派发 prompt 末尾后重新派发(整块替换旧块):\n\n${block}` };
}
module.exports = { gate };
