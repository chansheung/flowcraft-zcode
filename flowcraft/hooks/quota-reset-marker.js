#!/usr/bin/env node
// 主代理每次 Agent 派发后 touch <项目根>/.zcode-flowcraft/quota-reset.marker(mtime 即信号)。
// M3a 状态目录切换:marker 落新目录 .zcode-flowcraft(server.js 的 markerMtime 同步改读新路径)。
// 项目根优先取 stdin JSON 的 cwd(hook 输入含 cwd 字段),回退 FLOWCRAFT_CWD / 进程 cwd。
// M3b P3(转正,蓝图 D5/D6):reviewer/reviewer2 派发完成后,从 toolResponse.content 提取
// 子代理真实输出(spike 活体实测:PostToolUse(Agent) stdin 含 toolCallId(与 Pre 同值)+
// toolResponse/tool_response → content:[{type:"text",text:<最终报告>}]),回填派发账本条目
// 的 output 字段——按 toolCallId 精确匹配;匹配不到回退:同 agent 名、尚无 output、
// ts 晚于(当前时间-10分钟)的最新条目。拼接文本 <10 字符不回填(与原版 recordReviewOutput
// 门槛对齐);status 非 completed 也照录文本。回填独立 try/catch 全包 fail-open,
// 任何异常不影响 marker 触写与 exit code。
// v0.7.4 并发安全:回填的账本读改写改走 ledger-io.js 的 withLedger(目录锁串行化 +
// tmp/rename 原子落盘)——与 main-agent-wall.js 的派发写并发时原实现会丢条目/写坏
// 文件致 submit 全拒(Mac 实测);无命中时 mutateFn 不返回数组即不写,与原
// "无账本/损坏/无命中即跳过"语义一致,fail-open 不变。
const fs = require('fs');
const path = require('path');

function entryTs(e) {
  const t = e && e.ts;
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

// reviewer 真实输出回填(M3b P3)。input 为已解析的 stdin JSON;根解析链与 marker 相同:
// stdin cwd → FLOWCRAFT_CWD,均无则跳过(刻意不回退 process.cwd,防误写他处账本)。
function backfillReviewerOutput(input) {
  const ti = input.toolInput || input.tool_input || {};
  const rawType = ti.subagent_type || ti.subagentType || ti.agent_type || '';
  const bare = String(rawType).startsWith('flowcraft:')
    ? String(rawType).slice('flowcraft:'.length)
    : String(rawType);
  if (bare !== 'reviewer' && bare !== 'reviewer2') return;
  const resp = input.toolResponse || input.tool_response || null;
  const content = resp && Array.isArray(resp.content) ? resp.content : [];
  const text = content
    .filter(b => b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();
  if (text.length < 10) return; // 缺失/过短不回填
  const root = input.cwd || process.env.FLOWCRAFT_CWD || '';
  if (!root) return;
  const ledgerPath = path.join(root, '.zcode-flowcraft', 'gate-dispatch-ledger.json');
  // v0.7.4 并发安全:读改写走 withLedger(目录锁 + 原子写,见 ledger-io.js)。
  // 读失败/非数组按 [] 传入 → 无命中即不写,与原"无账本/损坏 JSON:跳过"语义一致。
  // 惰性 require:ledger-io.js 缺失时被调用点外层 try/catch 兜住,fail-open 不变。
  const { withLedger } = require('./ledger-io.js');
  withLedger(ledgerPath, (entries) => {
    const toolCallId = input.toolCallId || input.tool_use_id || '';
    let hit = null;
    if (toolCallId) {
      hit = entries.find(e => e && typeof e === 'object' && e.toolCallId === toolCallId) || null;
    }
    if (!hit) {
      // 回退:同 agent 名、尚无 output、ts 晚于(当前时间-10分钟)的最新条目
      const cutoff = Date.now() - 10 * 60 * 1000;
      hit = entries
        .filter(e =>
          e && typeof e === 'object' &&
          String(e.agent) === bare &&
          !(typeof e.output === 'string' && e.output.trim().length > 0) &&
          entryTs(e) > cutoff)
        .sort((a, b) => entryTs(b) - entryTs(a))[0] || null;
    }
    if (!hit) return; // 无命中:不返回数组 → withLedger 不写,直接释放锁
    hit.output = text;
    return entries; // 返回数组 → withLedger 原子写回(顺序不变)
  });
}

let d = '';
process.stdin.on('data', c => (d += c));
process.stdin.on('end', () => {
  let input = null;
  try { input = JSON.parse(d); } catch {}
  const cwd = input ? (input.cwd || '') : '';
  const root = cwd || process.env.FLOWCRAFT_CWD || process.cwd();
  try {
    const dir = path.join(root, '.zcode-flowcraft');
    fs.mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, 'quota-reset.marker');
    const now = new Date();
    try { fs.utimesSync(marker, now, now); } catch { fs.writeFileSync(marker, String(now.getTime()) + '\n'); }
  } catch {}
  // M3b P3 回填:在 marker 触写之后、exit 之前;独立 try/catch fail-open。
  try { if (input) backfillReviewerOutput(input); } catch {}
  process.exit(0);
});
setTimeout(() => process.exit(0), 3000);
