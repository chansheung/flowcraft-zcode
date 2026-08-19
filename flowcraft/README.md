# flowcraft (M1 骨架, v0.7.4)

flowcraft v0.7.2(OpenCode 编程式插件)→ ZCode 声明式插件的迁移产物。迁移蓝图:`Downloads/flowcraft-zcode-migration-blueprint.md`(v1.2)。本包 = 蓝图 **M1 里程碑**精简版:7 个子代理 + 行为规则模板,job_*(M4)已上线。命令、技能、vision 代理按需求裁剪,要恢复时从源材料拷回即可(蓝图 §1.5/§1.6)。

## 包结构

| 路径 | 内容 | 状态 |
|---|---|---|
| `.zcode-plugin/plugin.json` | 插件清单(agents + mcpServers 两组件;**未声明 hooks——M4 前休眠**) | ✅ |
| `agents/` ×7 | planner / coder / reviewer / reviewer2 / writer / analyst / explore(prompt 逐字迁移 + ZCode 工具映射补充段 + injectAgentsMd: false 不注入 AGENTS.md;0.7.2 起 coder frontmatter 加 Skill 工具——子代理可载入技能,AGENTS-zcode.md P1 的 skill 优先条款对 coder 生效,已平台验证) | ✅ |
| `AGENTS-zcode.md` | 工作区指令模板——放入目标仓库 `AGENTS.md`(0.5.0 起新增派发沟通纪律节) | ✅ |
| `.mcp.json` + `mcp/flowcraft-server/` | v0.4.1 服务器(零依赖):配额三件套(read 3/轮、grep 5/轮、glob 免配额、quota_reset);git_read 五 action 只读;git_gate 七 action 提交闸门+防伪造派发账本(0.6.0;0.7.4 push 合并捕获 stderr,"(up to date)" 仅真无输出时出现);principles 三工具(双层存储/按层配额/注入块,全局层 ~/.zcode/flowcraft/ 与 OpenCode 脱钩;0.7.3 起三层结构:全局层 → 项目层 → 插件随附层,同文去重前层优先,插件层只读);restart_zcode 跨平台重启;resume_authorize(0.7.1, M4.5:续接单次授权标记);job_* 四工具(0.7.0, M4:job_start/job_wait/job_status/job_list,仅 coder 可启动);`.mcp.json` 设 timeoutMs: 7500000(2h5min 兜底,> job_wait 内部单次 2h 硬顶,保证内部优雅超时先于客户端超时) | ✅ |
| `hooks/` | 主代理哑墙 v1(执行类拒止 + 读取切配额通道 + 双审派发账本自动记账+真实输出回填,双平台实测生效;0.7.4 起账本写入统一走 hooks/ledger-io.js——目录锁+tmp/rename 原子写,并行双审不丢条目)+ PostToolUse 派发重置+账本回填(已启用)+ job_start 精确拒绝(0.7.0, M4;主代理禁启动后台作业,job_wait/status/list 走前缀放行)+ SendMessage 精确拒绝+单次授权标记放行(0.7.1, M4.5,fail-closed 分支) | ✅ v1+M3b |
| `skills/resume/` | 续接技能(按需载入):SendMessage 单次授权续接流程 | ✅ 0.7.1 |
| `skills/grill-me/` | 用户入口跳板技能:触发 grilling(mattpocock/skills MIT 原版移植) | ✅ 0.7.2 |
| `skills/grilling/` | 决策树分轮质询技能(严苛拷问计划/决策;mattpocock/skills MIT 原版移植) | ✅ 0.7.2 |
| `principles/plugin-principles.json` | 插件随附 principles 层(两条 coder 纪律,三层合并只读) | ✅ 0.7.3 |

## 安装(本地市场)

1. 把整个 `flowcraft-zcode-dist/` 拷到固定位置(本机或 Mac)。
2. ZCode → 设置 → 插件管理 → Discover → `+` → 选择 `flowcraft-zcode-dist` 目录(根有 marketplace.json)。
3. 安装并启用 flowcraft。
4. **重开会话**(代理定义与 MCP 在会话启动时加载)。
5. (可选)把 `AGENTS-zcode.md` 内容放入你常用的目标仓库 `AGENTS.md`。

前置:机器上有 node ≥18(stub 服务器用;M1 功能本身不依赖 MCP 工具)。

## M1 验收清单

- [ ] 插件可从本地市场安装并启用;设置页出现 7 个子代理
- [ ] 设置 → MCP 显示 `flowcraft` 服务器已连接(stub,0 工具)
- [ ] 新会话中主代理能按 description 自动路由派发;`@` 引用子代理可用
- [ ] 工具边界实测:planner 无法 Edit;reviewer 无法 Bash;explore 只有 Read/Glob/Grep/WebFetch;coder 能 Edit+Bash
- [ ] model/thoughtLevel 生效验证(发任务后看日志 modelId;若 `glm-5.3` 不解析,查实际模型 ID 后改 frontmatter)
- [ ] AGENTS-zcode.md 放入测试仓库后,主代理遵守双审暂停点(改代码 → 派双审 → 停下等授权)

## 已知降级(M1 期)

- **job_* 已于 0.7.0(M4)上线**:四工具全量(job_start 仅 coder,主代理被墙拒绝;job_wait 单次最长 2h,可链式续等);**git_gate 已于 0.6.0 上线(唯一 git 写入口)**:7 action 全量(stage/scan/submit/status/reset/commit/push)+派发账本防伪造+真实输出回填。提交走 git_gate 闸门(见 AGENTS-zcode.md 提交流程)。配额三件套(0.2.0)、git_read(0.3.0)、principles(0.4.0)、subagent_type 白名单(0.4.5)、派发沟通纪律(0.5.0)已上线。
- **已接受降级(coder 侧 git 写无硬拦)**:coder 子代理的 Bash 仍可跑 git 写(子代理无 hook 面),靠 coder.md 纪律+审查留痕缓解;git_gate 仅主代理可用(结构性排除:无任何代理 frontmatter 列它)。
- **命令 / 技能 / vision 已裁剪**:需要时从源材料恢复(蓝图 §1.5/§1.6);vision 场景 ZCode 主代理原生覆盖。
- **thoughtLevel 取值**:文档示例只有 high;max 档是否生效待验收确认,不生效就降回 high。turbo 系(review/writer/explore)不设 thoughtLevel(OpenCode 的 thinking 开关无对应字段,接受默认)。

## 迭代

改文件后在市场源面板刷新;发版须同步改 `.zcode-plugin/plugin.json` 与 `marketplace.json`(两处)的 version。

## 路线图

```
M1(本包)     骨架:7 代理 + AGENTS 模板,软约束编排跑通 ✅
M1.5(v0.1.3) 哑墙 v0:主代理禁执行类工具 —— 双平台实测生效 ✅
M2a(0.2.0)   配额三件套 + 墙 v1 + 派发重置 —— 已上线(2026-08-18)
M2b(0.3.0)   git_read 已上线:五 action 只读查询,5 个只读代理白名单已加回 ✅
M2c(0.4.0)   principles 三工具上线:双层存储/配额/注入块(注入为软纪律) ✅
M2c.1(0.4.5) 墙新增 subagent_type 白名单:内置代理不可再派发 ✅
M2d(0.5.0)   AGENTS-zcode.md 新增派发沟通纪律节(CONTEXT not SOLUTION) + coder/planner description 尾句 ✅
M3(阶段二b)  git_gate 已上线(0.6.0):7 action 全量+派发账本防伪造+真实输出回填 ✅
M4(0.7.0)    job_* 四工具上线:job_start 仅 coder(主代理被墙精确拒绝),wait/status/list 主代理可用;job_wait 单次最长 2h 链式续等 ✅(2026-08-19)
M4.5(0.7.1)  SendMessage 单次授权续接(墙精确拒绝+resume_authorize 标记放行一条即焚)+ resume 技能 ✅(2026-08-19)
M4.6(0.7.2)  grill-me/grilling 技能上游移植 + coder frontmatter 加 Skill 工具(子代理技能可用,已平台验证) + Mac 部署测试清单 ✅(2026-08-19)
0.7.3        principles 插件随附层(随插件分发,新机器免手动 declare;三层合并/同文去重) ✅(2026-08-19)
0.7.4        Mac 实测三修复:账本并发竞态(锁+原子写)/tmux 按次探测/git_gate push 输出 ✅(2026-08-19)
```
