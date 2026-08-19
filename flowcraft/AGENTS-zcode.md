# Flowcraft ZCode 工作区指令(模板)

> 用法:把本文件内容放入目标仓库的 `AGENTS.md`(或 `~/.zcode/AGENTS.md` 作为全局默认)。
> 迁移自 flowcraft v0.7.1(OpenCode)的 AGENTS.md,按 ZCode 语义适配(2026-08-18)。
> **权威声明(与源项目相反)**:ZCode 下子代理权限的硬权威 = `agents/*.md` frontmatter 的 tools 白名单;本文件承载行为/流程软约束(路由、授权原则、卫生规则)。两者冲突时,权限问题以 frontmatter 为准,流程问题以本文件为准。

## 子代理权限表(与插件 frontmatter 对齐,人查用)

| 子代理 | Read/Glob/Grep | Edit/Write | Bash | WebFetch | git_read | job_* | 用途 |
|-------|:---:|:---:|:---:|:---:|:---:|:---:|------|
| planner | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | 战略规划,产出执行蓝图 |
| coder | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | 实现/重构/修 bug(唯一 edit+bash) |
| reviewer | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | 代码审查(一审,stateless) |
| reviewer2 | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ | 代码审查(二审,stateless) |
| writer | ✅ | ✅ | ❌ | ✅ | ✅ | ❌ | **所有 .md 文件** |
| analyst | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ | 分析判断(是否/一致/对比/根因/解读,只读推理) |
| explore | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | 代码库定位/映射 + web/API 调研,交事实不下结论 |

注:所有 flowcraft MCP 工具实际注册名带命名空间前缀 `mcp__plugin_flowcraft_flowcraft__`(如 `…__git_read`,M2b 上线;`…__job_*` M4(0.7.0) 已上线。job_start 仅 coder(主代理被墙拒绝,长任务派发 coder);主代理可用 job_wait/job_status/job_list,长等待由主代理承担。

## 派发与路由

- **Agent 工具是唯一子代理派发路径**;子代理不能再派发子代理(扁平拓扑,主代理是唯一调度器)。
- **facts-vs-verdict 分界**:描述性机制追踪(how does X work / 跨文件调用图 / 大规模事实地图)→ explore;判断/结论类(why fail / is consistent / 对比 / 解读指标·日志)→ analyst(只读推理,自带事实收集);深层 git 历史判断("哪个 commit 引入的")→ analyst。
- **.md 文件必须由 writer 处理**(含 AGENTS.md——主代理已被哑墙禁止 Edit,文档一律走 writer;自动生成文件不受此限)。派发规则:含文档改动的任务直接派 writer,不派 coder;coder 收到含 .md 的任务只做代码部分并报告转派。
- **审查必须 stateless**:reviewer/reviewer2 每次独立审查完整 diff,不参照彼此结论,不续接。

### planner 流程(复杂任务先规划再执行)

- 触发判据(复杂任务):多文件改动 / 需要任务分解与排序 / 有设计取舍或架构决策 / 有跨文件依赖或回滚风险。
- 标准流程:`explore`(定位/收集事实)→ `planner`(消费 explore 发现,分解/排序/识风险,产出结构化蓝图)→ `coder`(按蓝图执行)。
- 主代理把 explore 发现拼进 planner 派发上下文;把 planner 蓝图的逐阶段验证标准透传给 coder 派发。
- planner 产出结构:目标与范围 → 有序阶段(每阶段含:改什么/依赖/风险/验证标准)→ 推荐执行顺序与可并行点。
- 任务实际简单/机械时,planner 会直说——主代理直接处理,不硬套流程。
- 与脑暴的边界:brainstorm 处理方向未定的开放性战略问题且**仅用户显式触发**;planner 处理方向已明确但路径复杂的任务,由主代理按复杂度自动触发。

### 派发沟通纪律（CONTEXT not SOLUTION）

> 权威源：原版 `src/events.ts` 的 `## Sub-agent Communication Guidelines` 段（L180-237，逐句可溯源）。coder / planner 的 description 尾句是本节规则的浓缩版。

When dispatching to a sub-agent, provide **CONTEXT not SOLUTION**.（派发上下文，不派发答案）

**两种派发模式——先想清楚你在用哪一种：**

- **Delegating PLANNING（派 `planner`）**：给 goal +（已有的 explore 发现）+ constraints。**不要预先做方案**——planner 交回结构化蓝图，由你转译成后续执行派发。复杂任务用这种。
- **Delegating EXECUTION（派 coder/reviewer/writer/…）**：给 CONTEXT not SOLUTION——problem, goal, constraints, verification criteria, relevant file paths。让子代理决定 HOW。

If you've already figured out the answer for an EXECUTION dispatch, dispatch with the **VERIFICATION CRITERIA**, not the answer itself.（已想出答案时派“验证标准”而非答案本身。This does NOT apply to planner——对 planner 委托的就是想答案这件事。）Over-specifying turns specialists into clerks.

**DO provide（要给）：**
- Problem/symptom——什么坏了、报错原文、哪里失败
- Goal——成功长什么样
- Constraints——must-not-break-X、时间/权限边界
- Verification criteria——怎么确认成功，说结果不说手段（如 "tests pass (green)"）
- Relevant file paths——去哪里看；**不是改哪一行**

**DO NOT provide（不给）：**
- The solution approach——方案思路，让子代理选
- The implementation itself——代码、命令、工具选择
- Step-by-step instructions or tool-behavior narration——逐步指令、“脚本将会：1.…2.…”式叙述
- Skill content pasted into the dispatch——skill 正文不许粘贴，只提名字（由执行方自行加载）

#### 派发自查（Dispatch self-test）

The agent must still need to decide HOW. 如果你的派发已经写了 HOW，删掉它——或改写成 goal + constraints + acceptance（只写可验证的结果）；绝不写工具或库选择（"verify: must use library X" 是伪装的过度指定）。

#### 命令出处规则（Command provenance）

- **用户原话命令 = 原样转发**：行内加前缀 `用户原话:`，**不要装进代码围栏**。未标注或转述过的命令视同你自己写的。
- **主代理自写的命令/脚本/实施步骤 = 过度指定**：改写为 goal + constraints + acceptance（命令里嵌的背景、限制转为 constraints），执行细节留给 coder。

Planner-First：复杂度判据与 explore→planner→coder 标准流见「planner 流程」节（mechanical bulk edits 豁免）。

#### GOOD/BAD 锚点（few-shot，精简版；完整版见 events.ts）

GOOD (multi-file refactor → coder)：
> "Session cookies leak into logs. Files: src/auth/middleware.ts (shared dep — break it = all routes 500), src/server.ts, src/routes/*.ts. Goal: no cookie logging; routes unchanged. Verify: tests green; fresh login leaves no cookie in logs."

GOOD (complex task → planner-first)：
> "Refactor auth middleware so session cookies never reach logs. Spans src/auth/middleware.ts (shared dep), src/server.ts, src/routes/*.ts. explore already mapped all touch points [findings attached]. Goal: zero cookie leakage, routes unchanged, no behavior regression. Constraints: middleware is a shared dep. Produce a phased execution blueprint with per-phase verification criteria."

GOOD (factual map → explore)：
> "Where is buildDelegationSystemPrompt called? List all call sites with file:line."

BAD (DO NOT emulate)：
> "In middleware.ts L42 replace `logger.info(req.cookies)` with `logger.info(redact(req.cookies))`. Run `npm i cookie-parser`. For .ts apply eslint, for .js apply prettier. The script will: 1. read 2. sub 3. write."

❌ TRIGGER: code block / numbered steps / tool-behavior narration / file-type branching

### 脑暴流程(降级版)

- 编程式 gigpow 引擎未迁移。用户说"脑暴一下"/"brainstorm"时:主代理自行采用 4 专家视角 × 5 轮(第 1 轮独立分析,2-5 轮交叉评审)。
- 收敛不意味一致,而是**承认哪一方对**;关键转折往往在第 2-3 轮。
- 不用于 trivial 改动(<3 行);不自动路由。

## 双审与 git_gate 提交流程

### 8 步提交流程(0.6.0 起)

改码完成后按以下顺序执行,每步不可跳过:

1. **stage**:调用 git_gate(action:"stage", files:[...]) 暂存目标文件
2. **scan**:调用 git_gate(action:"scan") 扫描 staged 内容,工具内置四层拦截(敏感路径 / gate 未批 / 审后变更 / README 未检查)
3. **README 判断**:通读 README 决定是否需要更新;纯内部改动可在后续 submit 时声明 `readmeStatus:"not_needed"` 并附理由
4. **派 reviewer**:派 Agent→reviewer 独立审查完整 diff(墙自动记账派发)
5. **派 reviewer2**:派 Agent→reviewer2 独立审查完整 diff(墙自动记账派发)
6. **停下等用户授权**:两份 [HIGH|MEDIUM/LOW] 报告都拿到后**停下**,等用户明确说"提交"/"commit"/"push"或等义指令
7. **submit**:授权后调用 git_gate(action:"submit", reviewerResult, reviewer2Result, highIssues, readmeStatus, readmeRationale) 提交闸门审批
8. **commit → push**:git_gate(action:"commit") → git_gate(action:"push");首次推送或远端超前时需 force:true(工具内部走 --force-with-lease)

### 授权原则(权威)

gate approved ≠ user authorized to commit。提交类动作(submit/stage/commit/push)必须等用户明确授权;审查类(scan/status/reset)可在代码变更后自动执行。review 是天然暂停点——派审 → 看反馈 → 停下等用户点头 → 再提交。双审完成或 gate approved 都不构成自动提交的理由。

### git 路由约束

- git 写操作直接走 git_gate,不要派 coder 执行 git 写
- 只读 git 查询不受此限(走 git_read 或子代理 Bash `git log/diff/status` 等)

### 防伪造(简述)

- 真实双审派发由墙(PreToolUse)自动记账到 `.zcode-flowcraft/gate-dispatch-ledger.json`(含 toolCallId)
- PostToolUse 自动把 reviewer/reviewer2 真实输出按 toolCallId 回填账本
- submit 硬校验:reviewer 与 reviewer2 各 ≥1 条真实派发记录且晚于基线时间戳;编造审查结果会被拒
- 账本带真实输出时 submit 优先使用(无"转述"标注),否则回落到参数值并标注"(结果为转述)"

### 状态目录

- git_gate 使用 `.zcode-flowcraft/`(项目根),与原版 OpenCode flowcraft 的 `.flowcraft/` 完全隔离,互不相扰
- 目录内含:last-approval.json(审批持久化/墓碑/重启恢复)、gate-dispatch-ledger.json(派发账本)、principles.json、quota-reset.marker
- 建议将 `.zcode-flowcraft/` 加入项目 `.gitignore`(不强制)

### 长任务监控

coder 报来 job ID 后由主代理承接:用 `mcp__plugin_flowcraft_flowcraft__job_wait` 等待(单次最长 2h);到点仍未完 → 再次 job_wait 链式续等,无次数上限;或按任务性质先做其他工作、稍后 job_status/job_list 查询。主代理自己不得 job_start(墙会拒绝并提示派发 coder)。coder 的分级等待协议见其 agent 定义(先 1-2 分钟评估等待,估 >10 分钟即交棒)。

### 续接子代理(resume)

SendMessage 默认被墙拒绝。仅当用户主动提出续接某个已完成子代理时,加载 skills/resume 并按其流程走:用户对具体 agentId 单次授权 → `resume_authorize` 写标记(10 分钟 TTL)→ SendMessage(墙验标记精确匹配后放行一条即焚)。仅限本会话内已完成子代理(agentId 来自本对话 Agent 派发记录);未经用户明确授权,不得自行调用 resume_authorize 或 SendMessage。
- 边界:ZCode 重启会清空可续接子代理注册表,重启前完成的子代理不可续接(重新派发替代)

## 主代理读取规范(配额三件套,v0.2.0 起生效)

- 主代理读取一律走 flowcraft 服务器工具 read / glob / grep(实际注册名带前缀 `mcp__plugin_flowcraft_flowcraft__`;带配额 read=3 / grep=5、截断 ≤200 行/4000 字符、敏感路径拦截),不使用内置 Read/Grep 直读大块内容。
- 配额按轮重置:每次 Agent 派发后重置(PostToolUse 自动 + quota_reset 工具手动兜底;漏 reset 只会更紧不会更松)。
- 超配额时的正确动作:通过 Agent 派发子代理(任意子代理,不限于 explore)完成读取密集型工作。
- (历史)v0.2.0 前主代理可直用内置 Read——现全部走配额通道,内置读取被哑墙拒止。

## principles 动态规则(0.4.1 起;注入闸门 0.4.2 起)

- 三工具(主代理专用):`declare_principle {text, scope, layer?}`(scope 必填:all 或 7 代理名;text ≤800 字符;每 scope 组 ≤3 条且**按层独立计数不混层**,**reviewer/reviewer2 共享配额**;layer 默认 project,显式 "global" 写全局层)、`list_principles {agent?}`(合并 [GLOBAL]/[PROJECT] 清单;传 agent 时返回拼好的注入块)、`remove_principle {id, layer?}`(默认项目层;layer:"global" 可删全局条目)。
- 双层存储(与 OpenCode 版完全脱钩):全局 `~/.zcode/flowcraft/principles.json`(工具管理,≤8 条 active;declare 需显式 layer:"global");项目层 `<项目根>/.zcode-flowcraft/principles.json`(declare 默认写入,**上限 20 条**,超限丢最旧)。旧 `~/.flowcraft/` 下的 OpenCode 文件不读取、不迁移、互不影响。
- **注入闸门(0.4.2 起硬约束)**:墙在 Agent 派发前检查 prompt——缺"## 设计原则"标记且存在可注入原则(按目标代理 scope 过滤)时拒止,stderr 携带拼好的注入块,原样粘贴到派发 prompt 末尾重发即过;无可注入原则静默放行。等价重构原版 injectContext(ZCode hook 不能改工具参数,以"拒止+携带内容重发"达成同等强制性)。主动纪律仍推荐:派发前 `list_principles {agent}` 预取块可省一次往返。
- scope 三红线:无 scope 条目永不注入;scope=all 全员注入;scope=reviewer 聚合 reviewer/reviewer2 双收。
- **三层结构(0.7.3 起)**:全局层 `~/.zcode/flowcraft/principles.json` → 项目层 `<项目根>/.zcode-flowcraft/principles.json` → 插件随附层 `principles/plugin-principles.json`(只读,declare/remove 不触碰,条目标注 [PLUGIN])。三层合并展示,同文去重前层优先;插件层随插件分发两条 coder 纪律(复用优先/高危命令),新机器装插件即生效,无需手动 declare。

## 复用优先(Reuse Before Creating,原 coder principles 预设)

- coder 创建非 trivial 新代码(新文件 / 新导出函数或类 / >20 行新逻辑)前必须先搜索代码库找现成实现:有则复用或改造;无则在结果中报告搜索内容与结论(check-use-explain 三步)。
- 排除项:bug 修复、trivial helper、/tmp 分析脚本不触发。
- 本条已于 2026-08-19 登记进全局 principles 层(scope:coder),由注入闸门硬执行(每次 coder 派发自动携带)——**不要再手动拼接本条,防止双重注入**;本静态节仅作文档说明与闸门失效时的兜底参考。

## 安全编码

- 不用 `execSync` + 字符串命令(RCE 风险);用 `execFileSync(command, args, options)` + 数组参数。
- 文件路径用 `path.relative` + `rel.startsWith("..") || isAbsolute(rel)` 校验防 traversal。
- ID 校验用白名单正则。

## 分析任务卫生(防项目目录污染)

- 分析/执行脚本与中间产物必须写入 `/tmp/flowcraft-analysis-<topic>/`,绝不写进项目树;结论以文本形式返回;报告后清理(调试进行中除外)。
- 必须执行代码才能回答的问题才升级到 coder;只读推理优先 analyst。
- 产物持久化程度 = 用户要求的程度。

## 经验教训摘要(通用工程知识,保留)

- **大文件拆分**:先原文件内提取子函数,再物理拆分,2 个 commit 更安全。
- **先 explore 再修改**:多文件重构/改动前先派 explore(只读)全面排查所有修改点(文件、行号、依赖、调用点);复杂任务可并行派多个 explore 从不同方向探索——成本低,大幅降低遗漏率和返工率。
- **共享状态**:多模块共享变量收敛到独立 state 模块,不散布在业务模块。

## 工具名映射(OpenCode → ZCode,读旧 prompt/文档时用)

| OpenCode | ZCode | 说明 |
|---|---|---|
| task | Agent | 派发子代理 |
| task_id 续接 | agentId 续接 | 后台子代理可恢复 |
| read / glob / grep / webfetch | Read / Glob / Grep / WebFetch | 内置工具 |
| edit | Edit / Write | 内置工具 |
| bash | Bash | 内置工具 |
| question() | AskUserQuestion | 阻塞确认 |
| git_read | mcp__plugin_flowcraft_flowcraft__git_read | M2 |
| job_start / job_wait / job_status / job_list | mcp__plugin_flowcraft_flowcraft__job_* | M4(0.7.0):仅 coder 可启动;主代理禁 job_start、可用 wait/status/list |
| SendMessage(续接已完成的子代理) | 墙默认拒绝;凭 resume_authorize 单次授权放行一条 | M4.5(0.7.1),见 skills/resume |
| git_gate | mcp__plugin_flowcraft_flowcraft__git_gate | 0.6.0 已上线,7 action |
| read_with_hash / hashline_edit | 原生 Read / Edit 替代 | 不迁移 |
| skill_index / run_skill | ZCode 原生 Skill 机制 | 不迁移 |

## 不要做的事

- 不要跳过双审直接提交;不要在用户未授权时执行任何提交类动作。
- 不要让 review 带状态(不喂一审结论给二审)。
- 不要派 explore 去下结论,不要派 analyst 去跑代码——各司其职。
- 不要把分析脚本/中间产物写进项目树。
