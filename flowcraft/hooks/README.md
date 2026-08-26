# hooks/ —— 主代理哑墙

## 当前状态:v1 已注册生效(0.2.0,读取已切配额通道)

`hooks.json`(PreToolUse 哑墙 + PostToolUse 配额重置)随插件自动启用(插件贡献 hook 时 runner 自动启用,无需 `hooks.enabled`)。

**v1 范围**(0.2.0 起):
- 拒绝主代理直接执行:Bash / Edit / Write / WebFetch / WebSearch / 计划模式及其他白名单外工具 → 全部经由 Agent 派发子代理(拒绝提示按工具分流)
- **job_start 精确拒绝(0.7.0, M4)**:主代理禁启动后台作业(quota_reset 同构特判,置于前缀放行之前);job_wait/job_status/job_list 走前缀放行
- **SendMessage 精确拒绝(0.7.1, M4.5)**:默认拒绝;凭 MCP resume_authorize 落的单次授权标记(`.zcode-flowcraft/resume-auth.json`,10 分钟 TTL、agentId 精确匹配 toolInput.to)放行一条即焚(unlink);此分支 fail-closed(局部例外,理由见代码注释)
- 读取走配额通道:内置 Read/Glob/Grep 已拒止,改用 flowcraft 服务器工具 read / glob / grep(实际注册名带命名空间前缀 `mcp__plugin_flowcraft_flowcraft__`,0.2.1 起墙按前缀放行本插件全部工具):read 3 次/轮、glob 免配额、grep 5 次/轮;截断(≤200 行/4000 字符)与敏感路径拦截在工具内
- **Read 媒体例外(0.7.10)**:内置 Read 仅当目标为图片/视频扩展名(png/jpg/jpeg/gif/webp/bmp/ico/tif/tiff/avif/mp4/mov/webm)时放行,恢复主代理看图/看视频;无扩展名/未知扩展名/路径取不到一律拒绝,文本读取仍走配额通道,配额治理不受影响;但超大媒体文件(高分辨率图/长视频)的读取不受配额与截断管束,token 成本自行斟酌
- PostToolUse(matcher `^Agent$`)已注册:主代理每次派发后 touch `.zcode-flowcraft/quota-reset.marker`,服务器下次配额调用自动重置;`mcp__plugin_flowcraft_flowcraft__quota_reset` 手动兜底
- **principles 注入闸门(0.4.2,墙内集成)**:Agent 派发 prompt 缺"## 设计原则"块且存在可注入原则时 exit 2 携带现成块拒止,重发即过;无原则静默放行(单一 hook 入口,不依赖多 hook 顺序)
- **subagent_type 白名单(0.4.5,墙扩展)**:Agent 派发时检查目标是否在 agents/ 定义的白名单内,内置代理(planner/coder/reviewer/reviewer2/writer/analyst/explore)以外拒止
- **派发账本(0.6.0,M3b)**:墙 Agent 分支对 reviewer/reviewer2 派发自动写 `.zcode-flowcraft/gate-dispatch-ledger.json`(条目 {agent, ts, promptHash, promptHead, toolCallId},50 条上限,丢最旧);写入独立 try/catch,异常不阻断派发
- **账本并发安全(0.7.4)**:两处账本写入(wall 派发 + marker 回填)统一走 ledger-io.js——目录锁(原子 mkdir 抢锁,1s 等待上限,fail-open 静默放弃) + tmp+rename 原子写;并行双审不再丢条目/写坏文件(Mac 实测曾致尾部双 ]] 且丢 reviewer 条目)
- **状态目录自忽略(0.7.6)**:所有 .zcode-flowcraft 创建点(server 四处+hooks 两处)自动写目录内 .gitignore(内容 *),目标仓库未配 ignore 时 git add . 也不会误提交审批/账本状态
- **reviewer 输出回填(0.6.0,M3b)**:quota-reset-marker(PostToolUse)把 reviewer/reviewer2 真实输出从 toolResponse.content 按 toolCallId 回填账本(≥10 字符);git_gate submit 硬校验消费账本,防编造审查结果;应急开关 HARD_LEDGER(git-gate.js 顶部,改 false 并重启回降级模式)

**平台行为**:
- **Mac**:hook 执行链路已实测通,墙真实生效
- **Windows**(3.7.7.4926):**插件路径 hook 实测同样生效**(2026-08-18 晚,主代理 Bash/Edit 被 exit 2 拒止、stderr 回喂;Read 放行;子代理豁免)——早前"Windows 空转"的判断作废,bug 仅限 config.json 路径的 hook
- **注册快照 vs 脚本热载(2026-08-19 实测)**:hooks.json 注册表是插件加载时的快照,不热载——新增/修改 hook 条目需重启 ZCode;但已注册 hook 的脚本内容每次执行即时重读磁盘——改已注册脚本内容即时生效

## 验收(更新 0.1.3 并重开会话后)

1. 主代理请求内置 Bash → 被拒,stderr 出现"主代理不得直接执行 Bash:操作通过 Agent 工具派发子代理(代码→coder,文档 .md→writer)(见 AGENTS-zcode.md)。"
2. 拒绝提示按工具分流(v0.1.6/0.1.7):WebFetch/WebSearch → 指引派 explore;Bash/Edit/Write → 指引派 coder/writer;EnterPlanMode/ExitPlanMode → 指引派 planner(**计划模式不放行**,2026-08-18 用户定案);其他工具 → 白名单提示+全员路由表
3. 主代理内置 Read → 被拒,指引配额工具;配额 read 连调 4 次第 4 次 [配额超限];Agent 派发后配额自动重置
4. 派发 coder 执行 Bash → 正常(子代理不受墙约束)
4. 配额工具已上线(0.2.0);墙按前缀 mcp__plugin_flowcraft_flowcraft__ 放行本插件全部工具(0.2.1)

## hooks.json 备忘(插件格式)

当前文件只注册 PreToolUse。M2 时在 `hooks` 对象里追加:

```json
"PostToolUse": [
  {
    "matcher": "^Agent$",
    "hooks": [
      {
        "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/quota-reset-marker.js\"",
        "async": false
      }
    ]
  }
]
```

**格式注意**:插件 `hooks/hooks.json` 用 `hooks.<Event>`;config.json 全局 hook 是另一套 schema(`hooks.events.<Event>`),直接写 `hooks.PreToolUse` 会报 `config.file.invalid: Unrecognized key`——两套勿混。

## 补测点(激活后顺手验)

- ~~PreToolUse 对 MCP 工具名是否触发~~ 已实证(2026-08-18,0.2.0 活体:墙曾误拒配额读取调用,0.2.1 前缀修复)
