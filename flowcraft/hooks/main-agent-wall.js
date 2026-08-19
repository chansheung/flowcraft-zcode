#!/usr/bin/env node
// 主代理哑墙 v0(已注册生效,经插件 hooks 组件)。
// v0.1.6/0.1.7:拒绝提示按工具分流(执行类→coder/writer,web→explore,规划→planner,读取→M2 配额通道预留);计划模式不放行(2026-08-18 用户定案)。
// v1(0.2.0):内置 Read/Glob/Grep 已从白名单移除,读取走 mcp__flowcraft__read/glob/grep 配额通道,
// 拒止时落入分流文案的配额指引分支。
// v0.4.2:Agent 派发过 principles 闸门(principles-gate.js)——prompt 缺"## 设计原则"块且存在可注入原则时
// exit 2 携带现成注入块拒止,重发即过;等价重构原版 injectContext 硬注入(单一 hook 入口,无多 hook 顺序假设)。
// config/plugin hook 只覆盖主代理调用(Mac 3.x 实测,2026-08-18),子代理结构性绕过。Windows 亦活体回证(2026-08-19 探针实验:子代理 Read/Glob/Grep 零触发,仅主会话条目)。
// 平台:插件路径 hook 双平台实测生效(2026-08-18);config 路径的 bug 不影响本墙。
// v0.4.5:Agent 分支前置 subagent_type 白名单——只放行本插件 7 个分工子代理(封堵分工逃逸:
// 内置 general-purpose(Tools: *)等未纳入体系的类型可绕过整个分工体系跑 bash/改文件,2026-08-19 实测确认)。
// M3b P2(0.3.5,蓝图 D2/D3):reviewer/reviewer2 派发过闸后写墙写派发账本
// <root>/.zcode-flowcraft/gate-dispatch-ledger.json(裸 JSON 数组,按 ts 降序留最新 50 条),
// 供 git-gate.js submit 校验(读取器 ledgerEntryAgent/ledgerEntryTs 逐字段对齐:agent 字符串 + ts 数值,
// 对未知字段宽容——新增 toolCallId 字段无需改读取器)。
// 账本写入独立 try/catch 全包,任何异常不得阻断派发(fail-open 铁律)。
// M3b P3:记账条目附 toolCallId(stdin 自带;Pre 与 Post 同值,2026-08-19 spike 活体实测),
// quota-reset-marker.js 在 Post 侧按此精确匹配回填 reviewer 真实 output;取不到则省略该字段。
// M4/v0.7.0 — job_start precise denial (main agent), job_wait/status/list pass via prefix allow
// M4.5/v0.7.1 — SendMessage precise denial with single-use resume_authorize marker (fail-closed branch)
// v0.7.4 并发安全:派发账本读改写改走 ledger-io.js 的 withLedger(目录锁串行化 +
// tmp/rename 原子落盘)——并行双审时多 wall 进程并发写会丢条目/写坏文件致 submit 全拒(Mac 实测),
// fail-open 语义不变(锁超时/异常静默放弃,绝不阻断派发)。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ALLOW = new Set([
  // 派发与交互(绝对下限:Agent 是唯一派发通道,禁它即死锁)
  'Agent', 'TaskOutput', 'TaskStop', 'AskUserQuestion', 'TodoWrite', 'Skill',
]);
// flowcraft MCP 工具按前缀放行:插件服务器实际注册名带命名空间前缀
// mcp__plugin_flowcraft_flowcraft__<tool>(2026-08-18 活体实测,简写 mcp__flowcraft__* 匹配不上),
// 前缀放行同时覆盖未来的 git_read/git_gate/job_*。
const FLOWCRAFT_MCP_PREFIX = 'mcp__plugin_flowcraft_flowcraft__';
// Agent 派发的 subagent_type 白名单:与 agents/ 目录 7 个代理一一对应(2026-08-19 核对)。
// 带命名空间(flowcraft:coder)与短名(coder)均可;字段取法与 principles-gate.js 完全同源
// (toolInput/tool_input 双容器 + subagent_type/subagentType/agent_type 变体)。
const SUBAGENT_TYPES = new Set([
  'planner', 'coder', 'reviewer', 'reviewer2', 'writer', 'analyst', 'explore',
]);
const SUBAGENT_NS = 'flowcraft:';

let d = '';
process.stdin.on('data', c => (d += c));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(d); } catch { process.exit(0); }

  // 防御性断言:子代理会话直接放行。
  // Mac 与 Windows 均实测 hook 看不到子代理调用,此分支正常为死代码;
  // 保留是为防御未来行为变化。
  const sid = input.sessionId || input.session_id || '';
  if (typeof sid === 'string' && sid.startsWith('sess_subagent_')) process.exit(0);

  const tool = input.toolName || input.tool_name || '';

  // 拒止主代理自助重置配额(治理后门,2026-08-19 封堵):
  // 必须在前缀放行之前判断,否则会被 FLOWCRAFT_MCP_PREFIX 吞掉。
  if (tool === 'mcp__plugin_flowcraft_flowcraft__quota_reset') {
    process.stderr.write(
      '主代理不得调用 quota_reset 自助重置配额:' +
      '配额随每次 Agent 派发自动重置(PostToolUse 触 marker),' +
      '大规模读取/搜索应派 explore,判断/结论类应派 analyst——这正是配额的设计意图(见 AGENTS-zcode.md)。'
    );
    process.exit(2);
  }

  // M4b(0.7.0):拒止主代理启动后台作业(job_start 仅限 coder)。
  // 必须在前缀放行之前判断,否则会被 FLOWCRAFT_MCP_PREFIX 吞掉(同 quota_reset 位置约束)。
  if (tool === FLOWCRAFT_MCP_PREFIX + 'job_start') {
    process.stderr.write(
      '主代理不得调用 job_start 启动后台作业:' +
      'job_start 仅限 coder——长任务派发 coder(子代理),coder 会 fire-and-forget 把 job ID 报回来;' +
      '等待由主代理承接:mcp__plugin_flowcraft_flowcraft__job_wait(单次最长 2h,超时可再次调用链式续等)' +
      '或 job_status/job_list 查询(见 AGENTS-zcode.md)。'
    );
    process.exit(2);
  }

  // M4.5(0.7.1):拒止主代理直接调用 SendMessage;唯一放行路径是用户单次授权后的
  // resume_authorize 一次性标记(10 分钟 TTL、单次消费)。必须在前缀放行判断之前
  // (SendMessage 不带前缀,但与 quota_reset/job_start 同位置约束,保持特判块连续)。
  // 【重要】此分支刻意 fail-closed(标记读取异常时拒绝而非放行)——是对 wall
  // fail-open 铁律的局部例外,理由:exit 2 拒绝不破坏会话(代理重走授权流程即可),
  // 而误放行违背"未经授权不得续接"的硬要求;其余分支 fail-open 不变。
  if (tool === 'SendMessage') {
    const root = input.cwd || process.env.FLOWCRAFT_CWD || '';
    const to = String((input.toolInput && input.toolInput.to) || (input.tool_input && input.tool_input.to) || '');
    let allowed = false;
    if (root) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(root, '.zcode-flowcraft', 'resume-auth.json'), 'utf-8'));
        allowed = m.agentId === to && Date.now() - Number(m.authorizedAt || 0) < 600000;
      } catch { /* 标记缺失/损坏/读取异常 → 不放行(fail-closed,见上注释) */ }
    }
    if (allowed) {
      // 消费即焚:放行这一条 SendMessage 的同时删除标记(单次消费语义)。
      // unlink 失败(如 Windows 文件锁)同样拒绝——此时标记仍在,重试即可;
      // 若放行则标记可被复用,破坏"仅限一条"硬约束(fail-closed 同上)。
      try {
        fs.unlinkSync(path.join(root, '.zcode-flowcraft', 'resume-auth.json'));
        process.exit(0);
      } catch { /* 落入下方拒绝,标记保留可重试 */ }
    }
    process.stderr.write(
      '主代理不得直接调用 SendMessage 续接子代理:' +
      '续接须走 resume 技能流程——用户主动提出并单次授权后,' +
      '调 mcp__plugin_flowcraft_flowcraft__resume_authorize(agentId) 落标记,' +
      '再发 SendMessage(墙验标记放行一条即焚);详见 skills/resume(见 AGENTS-zcode.md)。'
    );
    process.exit(2);
  }

  if (ALLOW.has(tool) || tool.startsWith(FLOWCRAFT_MCP_PREFIX)) {
    if (tool === 'Agent') {
      try {
        // 分工逃逸封堵(v0.4.5):先验 subagent_type 再过 principles 闸门。
        // 只剥 flowcraft: 前缀(不能像 principles-gate 那样剥任意命名空间——
        // 否则 otherplugin:coder 之类外部代理会被误放行)。
        const ti = input.toolInput || input.tool_input || {};
        const raw = ti.subagent_type || ti.subagentType || ti.agent_type || '';
        const bare = String(raw).startsWith(SUBAGENT_NS) ? String(raw).slice(SUBAGENT_NS.length) : String(raw);
        if (!SUBAGENT_TYPES.has(bare)) {
          process.stderr.write(
            `[flowcraft 墙] 该子代理类型未纳入分工体系,不允许派发: ${String(raw)}\n` +
            '可派发目标(带命名空间或短名均可): flowcraft:planner / flowcraft:coder / flowcraft:reviewer / flowcraft:reviewer2 / flowcraft:writer / flowcraft:analyst / flowcraft:explore\n' +
            '路由: 代码实现→coder;.md 文档→writer;定位事实→explore;分析判断→analyst;蓝图规划→planner;代码审查→reviewer/reviewer2'
          );
          process.exit(2);
        }
        const { gate } = require('./principles-gate.js');
        const g = gate(input);
        if (!g.allow) { process.stderr.write(g.message); process.exit(2); }
        // M3b P2 墙写派发账本:仅记 reviewer/reviewer2,闸门通过后、exit(0) 前。
        // 项目根:stdin cwd → FLOWCRAFT_CWD → 均无则静默跳过(不回退 process.cwd,防止误写)。
        if (bare === 'reviewer' || bare === 'reviewer2') {
          try {
            const prompt = String(ti.prompt || '');
            const root = input.cwd || process.env.FLOWCRAFT_CWD || '';
            if (root) {
              const dir = path.join(root, '.zcode-flowcraft');
              fs.mkdirSync(dir, { recursive: true });
              // v0.7.6 P5:状态目录自忽略 —— 目标仓没配 gitignore 时 `git add .` 不会把
              // 派发账本误提交。内容一行 `*`;已存在不覆写;与仓库层自有 ignore 共存无害。
              try {
                const gi = path.join(dir, '.gitignore');
                if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n', 'utf-8');
              } catch { /* 尽力而为,不影响账本写入 */ }
              const ledgerPath = path.join(dir, 'gate-dispatch-ledger.json');
              // v0.7.4 并发安全:读改写走 withLedger(目录锁 + 原子写,见 ledger-io.js);
              // 读失败/非数组按 [] 传入 → 追加后照常写回 = 原有"损坏时自愈重写"语义不变。
              // 惰性 require:ledger-io.js 缺失时被本层 try/catch 兜住,fail-open 不变。
              const { withLedger } = require('./ledger-io.js');
              withLedger(ledgerPath, (entries) => {
                // M3b P3:附 toolCallId(camelCase 优先,snake 别名兜底;spike 实测两命名并存)。
                // 展开写法使取不到时整个字段缺席(JSON.stringify 不会留下 undefined 键)。
                const toolCallId = input.toolCallId || input.tool_use_id || '';
                entries.push({
                  agent: bare,
                  ts: Date.now(),
                  ...(toolCallId ? { toolCallId } : {}),
                  promptHash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16),
                  promptHead: prompt.replace(/\s+/g, ' ').trim().slice(0, 80),
                });
                entries.sort((a, b) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0));
                return entries.slice(0, 50); // 返回数组 → withLedger 原子写回
              });
            }
          } catch { /* fail-open:账本异常不得阻断派发 */ }
        }
      } catch {}
    }
    process.exit(0);
  }

  const guide =
    tool === 'Read' || tool === 'Glob' || tool === 'Grep'
      ? '读取走配额通道:用 flowcraft 服务器工具(本会话名 mcp__plugin_flowcraft_flowcraft__read / __glob / __grep;超配额时通过 Agent 派发子代理)'
      : tool === 'WebFetch' || tool === 'WebSearch'
        ? 'web/API 调研通过 Agent 工具派发 explore'
        : tool === 'Bash' || tool === 'Edit' || tool === 'Write'
          ? '操作通过 Agent 工具派发子代理(代码→coder,文档 .md→writer)'
          : tool === 'EnterPlanMode' || tool === 'ExitPlanMode'
            ? '规划任务通过 Agent 工具派发 planner(产出执行蓝图)'
            : '该工具不在主代理白名单;操作类需求派发子代理(代码→coder,文档→writer,web 调研→explore,分析判断→analyst)';
  process.stderr.write(`主代理不得直接执行 ${tool}:${guide}(见 AGENTS-zcode.md)。`);
  process.exit(2);
});
// 兜底:3 秒内 stdin 未结束也放行,避免挂死阻塞会话
setTimeout(() => process.exit(0), 3000);
