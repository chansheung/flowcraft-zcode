#!/usr/bin/env node
// =============================================================================
// job-tools.js —— 后台作业子系统 job_* 四工具(M4a)
// 忠实移植自 flowcraft 源码 src/tools/jobs.ts(消息契约)+ src/job-runner.ts
// (JobRunner 核心)+ src/high-risk.ts(pickHighRiskReason 文案逐字;拦截正则
// 除一处刻意管道形态修复外逐字节,见 pickHighRiskReason 段头注释)+
// src/retry.ts(pollUntil 语义)+ src/constants.ts(JOB_WAIT_INTERVALS 等)。
// 仓库只读参考,权威源。由 server.js require 引入,server.js 只做注册(参照
// git-gate.js 模块模式);IMPL 四函数均为 async (args) => string,server.js
// tools/call 的 promise 分支负责把字符串包装成 MCP result。
//
// 与原版的差异(M4a 移植决定,均有授权):
//   1. 身份检查删除:原版四工具开头的 session.agent 校验(coder/orchestrator)
//      不移植 —— ZCode MCP 看不到调用者;约束改由 description 承担:job_start
//      注明 coder sub-agent only(主代理墙禁 job_start,长任务派 coder),
//      job_wait 注明长等待是主代理职责(单次至多 2h,超时链式续等)。
//   2. 作业目录 <root>/.zcode-flowcraft/jobs(原版 .flowcraft/jobs;切换原因同
//      M3a:避免与原版 OpenCode 插件状态目录冲突;绝不碰 .flowcraft)。
//      root = process.env.FLOWCRAFT_CWD || process.cwd(),模块级 Map 按根缓存
//      runner 惰性构造。
//   3. scanCommandForSecrets 直接复用 dist/git-gate.js 的导出(单一实现,
//      禁止第三份副本;server.js :264-280 的内嵌近似副本不动不复用)。
//   4. cancel/cancelAll 不移植(无对应工具入口);展示层保留 cancelled 的 ⏹
//      图标分支。continuation 字段不移植(原版死代码)。
//   5. job_wait 超时文案选项 (2) 由 coder 视角("report the job ID to the
//      orchestrator if fire-and-forget")改为调用方中立表述;选项 (1) 与其余
//      全部消息文案(📋/✅/⏳/▶️/❌/⏹、[SECURITY BLOCKED] 三行、[HIGH-RISK
//      BLOCKED] 五行、"Already running as background job"、Launched 块)逐字保留。
//   6. id 校验失败返回友好文本(不抛异常);getOutput 的 lines 在工具层钳到
//      [1,1000](内部 assertLines 保留,钳后永不触发)。
//   7. 惰性孤儿清理:job_start/job_list 入口调 maybeCleanupExpiredJobs ——
//      .json 按 14 天(JOBS_TTL_MS)、其余(.log/.sh/.pid)按 7 天
//      (JOBS_LOG_TTL_MS)mtime unlink;模块级 lastCleanupAt 做 30 分钟节流;
//      整体 try/catch,清理异常绝不影响工具返回。
//   8. pollUntil 移植为 async 睡眠轮询(await new Promise(r=>setTimeout(r,ms)),
//      禁止同步忙等);maxAttempts = Math.ceil(cap/4000)+50 公式照原版保留。
//   9. v0.7.4 tmux 按次现探:start() 的 tmux/直接 spawn 分支判定不再用构造时缓存
//      一次的 this.tmuxAvailable,改为每次 job_start 现探(Mac 实测:会话中途
//      brew install tmux 后,缓存值不重启服务器不生效,新作业仍走直接 spawn 分支)。
//      分支选择记入作业记录 tmux 字段;status() 探活按作业记录走——已在跑的作业
//      维持其记录的分支不变;旧记录(无 tmux 字段)回退构造时缓存值,与历史行为一致。
//
// WAIT_SLICE_MAX(Plan-B 降级开关):.mcp.json 已设 flowcraft 服务器
// timeoutMs=7500000(2h5min)> job_wait 内部 2h 硬顶,正常路径内部优雅超时
// 先于客户端超时。若实测 .mcp.json 的 timeoutMs 不被客户端采纳,把本常量改
// 25000 即降级为"短切片链式 job_wait"(每次调用 ≤25s 返回,由调用方续等),
// 其余零改动;当前值 7200000 下它是无操作钳制(第三个 min 参数恒不生效)。
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { platform } = require('os');

// 复用 git-gate.js 的命令层密钥扫描(单一实现;契约三行文案见 implJobStart)
const gitGate = require('./git-gate.js');

// =============================================================================
// 常量 —— 移植自原版 src/constants.ts
// =============================================================================
// job_wait 轮询间隔序列 (ms):渐长间隔,先密后疏,避免长任务(默认 10 分钟,
// hard cap 2 小时)产生过多轮询。序列:4s×2 → 5s×2 → 10s×4 → 20s×4 → 30s×剩余。
const JOB_WAIT_INTERVALS = [4000, 4000, 5000, 5000, 10000, 10000, 10000, 10000, 20000, 20000, 20000, 20000, 30000];
// job_start 命令长度上限 (chars)
const MAX_JOB_COMMAND_LENGTH = 10000;
// 作业 .json 记录保留时长(14 天)
const JOBS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// 作业日志/脚本/pid 文件保留时长(7 天)
const JOBS_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 惰性孤儿清理节流间隔(30 分钟)
const CLEANUP_THROTTLE_MS = 30 * 60 * 1000;
// job_wait 单次切片硬顶(Plan-B 降级开关,见文件头注释;当前 7200000=2h,
// 与内部 2h 硬顶同值 → 无操作钳制;改 25000 即降级为短切片链式等待)
const WAIT_SLICE_MAX = 7200000;

const TMUX_SESSION_RE = /^flowcraft-job-\d+-[a-z0-9]+$/;
const SAFE_ID_RE = /^job-\d+-[a-z0-9]+$/;
const LINES_MIN = 1;
const LINES_MAX = 1000;

function assertTmuxSession(name) {
  if (!TMUX_SESSION_RE.test(name)) {
    throw new Error(`Invalid tmux session name: ${name}`);
  }
}

function assertJobId(id) {
  if (!SAFE_ID_RE.test(id)) {
    throw new Error(`Invalid job id: ${id}`);
  }
}

function assertLines(n) {
  if (!Number.isInteger(n) || n < LINES_MIN || n > LINES_MAX) {
    throw new Error(`Invalid lines value: ${n} (must be integer in [${LINES_MIN}, ${LINES_MAX}])`);
  }
}

function assertPathInside(base, target) {
  const resolved = path.resolve(target);
  const resolvedBase = path.resolve(base);
  const rel = path.relative(resolvedBase, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path traversal detected: ${target} not inside ${base}`);
  }
}

// 工具层 lines 钳制:调用方传垃圾值时优雅收敛到 [1,1000](内部 assertLines
// 保留原版语义,钳后永不触发)。非法数值回落默认 50。
function clampLines(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return 50;
  return Math.min(LINES_MAX, Math.max(LINES_MIN, v));
}

// =============================================================================
// resolveBash —— 逐字移植自原版 src/job-runner.ts
//
// Windows note: spawning "bash" from PATH resolves to System32\bash.exe (WSL),
// which is frequently broken / misconfigured for our use case. We instead prefer
// the git-for-windows bash, derived from `where git`.
//
// Priority:
//   1. FLOWCRAFT_BASH env var (if it points to an existing file)
//   2. "bash" on PATH for non-Windows
//   3. <Git>\bin\bash.exe derived from `where git` (Windows)
//   4. Known git-for-windows install paths (Windows)
//   5. "bash" fallback (with a warning — may hit WSL)
// console.warn 走 stderr,不污染 stdio MCP 的 stdout JSON-RPC 通道。
// =============================================================================
function resolveBash() {
  // 1. env override (highest priority)
  const envBash = process.env.FLOWCRAFT_BASH;
  if (envBash && fs.existsSync(envBash)) return envBash;
  // 2. non-Windows: use PATH bash directly
  if (platform() !== 'win32') return 'bash';
  // 3. Windows: derive <Git>\bin\bash.exe from `where git`.
  //    git typically lives at <Git>\cmd\git.exe or <Git>\bin\git.exe; in both
  //    cases dirname(.., "..") collapses to <Git>, and bash is at <Git>\bin\bash.exe.
  try {
    const out = execFileSync('where', ['git'], { encoding: 'utf-8', timeout: 5000, windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (const gitPath of out) {
      const gitRoot = path.resolve(path.dirname(gitPath), '..');
      const candidate = path.join(gitRoot, 'bin', 'bash.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* git not on PATH — fall through to known-path probe */ }
  // 4. probe known git-for-windows install locations
  const known = [
    path.join('C:', 'Program Files', 'Git', 'bin', 'bash.exe'),
    path.join('C:', 'Program Files', 'Git', 'usr', 'bin', 'bash.exe'),
    path.join('C:', 'Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ];
  for (const p of known) if (fs.existsSync(p)) return p;
  // 5. fallback + warn
  console.warn('flowcraft: could not locate git bash on Windows; falling back to PATH \'bash\' (may hit WSL)');
  return 'bash';
}

// =============================================================================
// pickHighRiskReason —— 移植自原版 src/high-risk.ts(文案零改动;拦截正则见下方
// 拦截判断处的偏离说明)
// =============================================================================
// Returns a structured reason for blocking a high-risk bash command, or null if
// the command is safe. SEPARATION OF CONCERNS:
//  - Interception (block-or-not) is decided by rmRecursive / rmWildcard /
//    otherHighRisk (verbatim from the original) plus pipeHighRisk — the ONE
//    deliberate deviation from the original: the original wrapped the two pipe
//    alternatives in a group-level \b(...)\b, whose leading/trailing boundary
//    necessarily fails in the most common spaced form (e.g. "curl x | bash"),
//    so the original never blocked those (confirmed live 2026-08-19). Fixed
//    here to satisfy the M4a acceptance matrix; the match set is a strict
//    SUPERSET of the original's (adds spaced & unspaced pipe forms), never
//    narrower. See the comment above the regex definitions for details.
//  - Classification (which reason text) uses looser sub-regexes ONLY AFTER
//    interception already matched; they never widen what gets blocked.
// Order = priority (first-match-wins). No /i added (zero case-sensitivity change).
function pickHighRiskReason(cmd) {
  // --- 拦截判断：rmRecursive / rmWildcard 逐字节复刻原版；otherHighRisk 的
  // 七个词形备选项原样保留 \b(...)\b 包裹，仅移除两个管道备选项，拆到
  // pipeHighRisk。刻意偏离原因：原版把管道备选项包在同一组级 \b(...)\b 里，
  // 前导 \b 落在 "|" 前、尾随 \b 落在 "|" 后，而管道符两侧带空格（最常见
  // 形态）时这两个边界必失败，导致 "curl -s x | bash" 不被拦截（2026-08-19
  // 活体实测放行，违反 M4a 验收矩阵）。pipeHighRisk 不加外层锚（管道符两侧
  // 空格有无都命中），末尾 \b 仅防前缀误伤（如 "| sha256sum" 的 "sh" 前缀
  // 不命中）。匹配范围是原版的超集（新增带/不带空格管道形态），绝不收窄。---
  const rmRecursive = /(?:^|[|;&]\s*)rm\s+-[a-zA-Z]*[rR][a-zA-Z]*\b/;
  const rmWildcard = /(?:^|[|;&]\s*)rm\s+[^;&|]*[*?\[\]{}]/;
  const otherHighRisk = /\b(git\s+(push\s+--force|clean\s+-[a-zA-Z]*[fdx]|reset\s+--hard)|chmod\s+-R\s+[0-7]{3,4}\s+\/|dd\s+if=|drop\s+table|truncate\s+table|wget\s+)\b/;
  const pipeHighRisk = /curl\s+.*\||\|\s*(bash|sh)\b/;

  if (rmRecursive.test(cmd)) return {
    tag: 'Recursive deletion (rm -r/-R)',
    why: 'rm -r deletes entire directory trees; a wrong path destroys unrecoverable data.',
    alt: 'List targets (ls -la <path>), remove specific files explicitly. Run manually if truly needed.',
  };
  if (rmWildcard.test(cmd)) return {
    tag: 'Wildcard deletion (rm with * ? [])',
    why: 'Globs expand unexpectedly — rm *.txt may match far more than expected.',
    alt: 'List matches (ls <glob>), then remove files by explicit name.',
  };
  // 管道形态由 pipeHighRisk 单独拦截（见上方偏离说明）
  if (!otherHighRisk.test(cmd) && !pipeHighRisk.test(cmd)) return null;

  // --- 命中 otherHighRisk 后，用子正则选文案（不影响拦截与否）；兜底通用文案 ---
  if (/git\s+push\s+--force/.test(cmd)) return {
    tag: 'git push --force',
    why: 'Rewrites remote history, overwrites others\' commits.',
    alt: 'Rebase locally then normal push, or push to a new branch.',
  };
  if (/git\s+clean\s+-[a-zA-Z]*[fdx]/.test(cmd)) return {
    tag: 'git clean -f/-d/-x',
    why: 'Permanently deletes untracked files (no trash).',
    alt: 'Dry-run first (git clean -n), or move files to a temp dir.',
  };
  if (/git\s+reset\s+--hard/.test(cmd)) return {
    tag: 'git reset --hard',
    why: 'Discards all uncommitted changes irrecoverably.',
    alt: 'Use git stash, or reset specific files (git checkout -- <file>).',
  };
  if (/chmod\s+-R\s+[0-7]{3,4}\s+\//.test(cmd)) return {
    tag: 'Recursive chmod on root path',
    why: 'chmod -R starting at / bricks the OS.',
    alt: 'Scope to a specific directory (chmod -R <mode> <dir>).',
  };
  if (/dd\s+if=/.test(cmd)) return {
    tag: 'dd (raw block write)',
    why: 'Writes raw block data; wrong target destroys disks.',
    alt: 'Run dd manually with triple-checked paths.',
  };
  if (/drop\s+table/.test(cmd) || /truncate\s+table/.test(cmd)) return {
    tag: 'SQL DROP/TRUNCATE TABLE',
    why: 'Destroys table data permanently.',
    alt: 'Backup first, or use DELETE with WHERE in a transaction.',
  };
  if (/curl\s+.*\|/.test(cmd)) return {
    tag: 'curl piped to shell',
    why: 'Piping curl to a shell executes remote code blindly. Also verify the command does not embed tokens/secrets (secret scan is skipped after this block).',
    alt: 'Download to file (curl -o), inspect, then run.',
  };
  // \s*（原版 \s+）：无空格管道形态也选中本文案；子正则只在拦截命中后跑，不扩大拦截范围
  if (/\|\s*(bash|sh)/.test(cmd)) return {
    tag: 'pipe to bash/sh',
    why: 'Piping output to a shell executes arbitrary code. Also verify no embedded tokens/secrets (secret scan is skipped after this block).',
    alt: 'Save to file, review, then execute.',
  };
  if (/wget\s+/.test(cmd)) return {
    tag: 'wget (network fetch)',
    why: 'Automated network fetch may download untrusted content.',
    alt: 'Fetch manually, inspect the result, then proceed.',
  };
  // 兜底：otherHighRisk 命中但无子正则匹配（防御性，正常不应触发）
  return {
    tag: 'High-risk command',
    why: 'This command matched a high-risk pattern.',
    alt: 'Run manually if you understand the risks.',
  };
}

// =============================================================================
// pollUntil —— 移植自原版 src/retry.ts(仅 job_wait 用到的选项:intervals/
// maxAttempts/timeoutMs;signal/onProgress/deadline 系列未用不移植)。
// 语义:先睡 intervals[i] 再查条件;超时/次数用尽返回 false(不抛异常)。
// 睡眠为真异步 setTimeout(禁止同步忙等)。
// =============================================================================
async function pollUntil(condition, options) {
  const intervals = options.intervals;
  const maxAttempts = options.maxAttempts;
  const timeoutMs = options.timeoutMs;
  const startTime = Date.now();

  for (let i = 0; i < maxAttempts; i++) {
    if (Date.now() - startTime > timeoutMs) return false;

    const waitMs = i < intervals.length ? intervals[i] : intervals[intervals.length - 1] ?? 4000;
    await new Promise((resolve) => { setTimeout(resolve, waitMs); });

    if (await condition()) return true;
  }

  return false;
}

// =============================================================================
// JobRunner —— 移植自原版 src/job-runner.ts
// 差异:作业目录 .zcode-flowcraft/jobs(原版 .flowcraft/jobs);cancel/cancelAll
// 不移植;continuation 字段不移植;log.warn → console.warn(stderr,不污染
// stdout JSON-RPC 通道)。
// =============================================================================
class JobRunner {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.jobsDir = path.join(projectRoot, '.zcode-flowcraft', 'jobs');
    // Resolve bash up front so bashBin is always assigned even if the jobsDir
    // mkdir below fails and we bail out early.
    this.bashBin = resolveBash();
    this.tmuxAvailable = false;
    this.enabled = true;
    // Defense in depth: never (re)create a workspace root that doesn't exist on
    // disk. mkdirSync({recursive:true}) would silently recreate a dead/moved
    // project tree. Guard the root BEFORE probing the jobsDir.
    if (!fs.existsSync(projectRoot)) {
      this.enabled = false;
      console.warn(`JobRunner: workspace root does not exist on disk (${projectRoot}) — background jobs disabled for this workspace`);
      return;
    }
    if (!fs.existsSync(this.jobsDir)) {
      try { fs.mkdirSync(this.jobsDir, { recursive: true }); }
      catch (err) {
        this.enabled = false;
        console.warn(`JobRunner: mkdir failed (${this.jobsDir}): ${err instanceof Error ? err.message : String(err)} — background jobs disabled for this workspace`);
        return;
      }
    }
    // v0.7.4:此缓存仅供旧记录(无 tmux 字段)的 status 探活回退;start 的分支
    // 判定已改为每次 job_start 现探(见 start 内注释与文件头差异 9)。
    this.tmuxAvailable = this.detectTmux();
    this.reconcile();
  }

  // tmux does not exist on Windows, so we skip the probe entirely there
  // (avoids a guaranteed miss + a pointless exec). On POSIX resolve via `which tmux`.
  detectTmux() {
    if (platform() === 'win32') return false;
    try {
      execFileSync('which', ['tmux'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  start(command, owner, purpose) {
    const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tmuxSession = `flowcraft-${id}`;
    const logFile = path.join(this.jobsDir, `${id}.log`);
    const now = new Date().toISOString();

    assertPathInside(this.jobsDir, logFile);

    // v0.7.4 按次现探(见文件头差异 9):Mac 实测会话中途安装 tmux 后,构造时缓存
    // 的 this.tmuxAvailable 不重启不生效。win32 恒 false 零开销;POSIX which tmux
    // try/catch 默认 false。分支选择记入作业记录 tmux 字段,status 探活按记录走。
    const useTmux = this.detectTmux();
    const job = {
      id, command, tmuxSession, status: 'running',
      startedAt: now, logFile, owner, purpose, tmux: useTmux,
    };
    this.save(job);

    try {
      const scriptFile = path.join(this.jobsDir, `${id}.sh`);
      assertPathInside(this.jobsDir, scriptFile);
      // trap EXIT writes the exit marker on EVERY termination path — normal
      // completion, SIGTERM, SIGINT — so reconcile/status can never observe a
      // dead pid with no marker (which previously caused false "failed" reports
      // after a restart). SIGKILL is the only uncatchable exception. $? inside
      // the trap is the exit status that triggered it (command's code on normal
      // exit, 128+signal on signal termination). The marker format is unchanged,
      // so status()'s /\[flowcraft:exit:(\d+)\]/ regex still matches.
      fs.writeFileSync(scriptFile, `#!/bin/bash\ntrap 'echo "\\n[flowcraft:exit:$?]"' EXIT\n${command}\n`, { mode: 0o755 });

      if (useTmux) {
        assertTmuxSession(tmuxSession);
        execFileSync('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', this.projectRoot, 'bash', '-c', `bash '${scriptFile}' > '${logFile}' 2>&1`], {
          stdio: 'pipe', timeout: 10000,
        });
      } else {
        // Merge stderr into the stdout fd so getOutput() (which only reads
        // `.log`) surfaces failure diagnostics on Windows. Matches the tmux
        // branch's `2>&1` semantics.
        const out = fs.openSync(logFile, 'w');
        try {
          const child = spawn(this.bashBin, [scriptFile], { detached: true, cwd: this.projectRoot, stdio: ['ignore', out, out] });
          child.unref();
          child.on('error', () => {
            try {
              const current = this.getJob(job.id);
              if (current && current.status !== 'running') return;
              job.status = 'failed';
              job.completedAt = new Date().toISOString();
              this.save(job);
            } catch { /* best-effort: async listener must never crash the host */ }
          });
          // Pid file is `${id}.pid` (NOT `${logFile}.pid`): status() reads
          // `${id}.pid`; the earlier `.log.pid` variant was a pre-existing bug
          // that left the liveness probe unable to find the pid.
          fs.writeFileSync(path.join(this.jobsDir, `${id}.pid`), String(child.pid ?? ''), 'utf-8');
        } finally {
          fs.closeSync(out);
        }
      }
    } catch (err) {
      job.status = 'failed';
      job.completedAt = new Date().toISOString();
      this.save(job);
      throw new Error(`Job failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }

    return job;
  }

  status(id) {
    assertJobId(id);
    const job = this.getJob(id);
    if (!job) return null;
    if (job.status !== 'running') return job;

    // v0.7.4:探活分支按作业记录走(见 start 的按次现探说明)——已在跑的作业维持
    // 其记录的分支不变;旧记录(无 tmux 字段)回退构造时缓存值,与历史行为一致。
    const useTmux = job.tmux === undefined ? this.tmuxAvailable : job.tmux === true;
    let isRunning = false;
    try {
      if (useTmux) {
        assertTmuxSession(job.tmuxSession);
        execFileSync('tmux', ['has-session', '-t', job.tmuxSession], { stdio: 'pipe', timeout: 5000 });
        isRunning = true;
      } else {
        const pidFile = path.join(this.jobsDir, `${id}.pid`);
        if (fs.existsSync(pidFile)) {
          const pid = fs.readFileSync(pidFile, 'utf-8').trim();
          const pidNum = parseInt(pid, 10);
          if (!Number.isInteger(pidNum) || pidNum <= 0) {
            throw new Error(`Invalid pid: ${pid}`);
          }
          // process.kill(pid, 0) is a cross-platform liveness probe: it throws
          // (ESRCH) when the pid no longer exists, succeeds silently otherwise.
          try {
            process.kill(pidNum, 0);
            isRunning = true;
          } catch {
            isRunning = false;
          }
        }
      }
    } catch {
      // job not running anymore — fall through to exit-code harvest below
    }

    if (!isRunning) {
      const tail = this.getOutput(id, 5);
      const exitMatch = tail.match(/\[flowcraft:exit:(\d+)\]/);
      job.exitCode = exitMatch ? parseInt(exitMatch[1], 10) : undefined;
      job.status = (job.exitCode === 0) ? 'completed' : 'failed';
      job.completedAt = new Date().toISOString();
      this.save(job);
    }

    return { ...job };
  }

  getOutput(id, lines = 50) {
    assertJobId(id);
    assertLines(lines);
    const logFile = path.join(this.jobsDir, `${id}.log`);
    assertPathInside(this.jobsDir, logFile);
    if (!fs.existsSync(logFile)) return '(no output yet)';
    try {
      // Pure-Node tail: read the whole file, split on newlines, and keep the
      // last `lines` entries. Avoids shelling out to `tail`, which does not
      // exist on Windows.
      const content = fs.readFileSync(logFile, 'utf-8');
      const all = content.split(/\r?\n/);
      // A trailing newline produces a spurious final "" element; drop it so it
      // doesn't consume part of the requested line budget.
      const trimmed = content.endsWith('\n') ? all.slice(0, -1) : all;
      return trimmed.slice(Math.max(0, trimmed.length - lines)).join('\n');
    } catch (err) {
      console.warn(`Failed to read output: ${err}`);
      return '(error reading output)';
    }
  }

  list() {
    try {
      return fs.readdirSync(this.jobsDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => this.getJob(f.replace('.json', '')))
        .filter(Boolean);
    } catch { return []; }
  }

  // 构造时对每个 running 调 status() 收敛(重启后按 pid 探活 + 收割退出码)
  reconcile() {
    for (const job of this.list()) {
      if (job.status !== 'running') continue;
      this.status(job.id);
    }
  }

  getJob(id) {
    assertJobId(id);
    const p = path.join(this.jobsDir, `${id}.json`);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch { return null; }
  }

  save(job) {
    if (!this.enabled) return;
    fs.writeFileSync(path.join(this.jobsDir, `${job.id}.json`), JSON.stringify(job, null, 2), 'utf-8');
  }
}

// =============================================================================
// runner 缓存与惰性孤儿清理
// =============================================================================
const runnersByRoot = new Map();

function getRoot() { return process.env.FLOWCRAFT_CWD || process.cwd(); }

// 模块级按根惰性构造(同一根复用同一 runner —— reconcile 只在构造时跑一次)
function getRunner(root) {
  let runner = runnersByRoot.get(root);
  if (!runner) {
    runner = new JobRunner(root);
    runnersByRoot.set(root, runner);
  }
  return runner;
}

// 惰性孤儿清理(移植自原版 cleanupExpiredJobs,目录切 .zcode-flowcraft/jobs;
// 调用点:job_start / job_list 入口)。.json 按 14 天、其余(.log/.sh/.pid)按
// 7 天 mtime unlink;30 分钟节流;整体 try/catch —— 清理异常绝不影响工具返回。
let lastCleanupAt = 0;
function maybeCleanupExpiredJobs(root) {
  try {
    const now = Date.now();
    if (now - lastCleanupAt < CLEANUP_THROTTLE_MS) return;
    lastCleanupAt = now;
    const dir = path.join(root, '.zcode-flowcraft', 'jobs');
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, file);
      const ttl = file.endsWith('.json') ? JOBS_TTL_MS : JOBS_LOG_TTL_MS;
      try {
        if (now - fs.statSync(fullPath).mtimeMs > ttl) fs.unlinkSync(fullPath);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// =============================================================================
// 工具 description 与 schema(照原版移植;BETA 后缀 = 原版 shared.ts 的
// " (beta) BETA";权限标注取代被删除的 session.agent 身份检查)
// =============================================================================
const BETA = ' (beta) BETA';

const TOOLS = [
  {
    name: 'job_start',
    description:
      'Start a background job for a long-running command (training, preprocessing, batch jobs, long builds). ' +
      'Runs high-risk checks, dedupes identical running commands, and returns a job ID. ' +
      'Use this INSTEAD OF bash for any command that may run >2min — bash has a 2-minute timeout that SIGTERMs the process. ' +
      'After job_start, control ownership via your next action: report the job ID to the orchestrator and end (fire-and-forget), or call job_wait(id, timeoutMs) to block for the result. ' +
      'coder sub-agent only — the main agent is wall-blocked from job_start; dispatch coder for long tasks.' + BETA,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run in the background' },
        purpose: { type: 'string', description: 'Short human-readable purpose — used for orphan recovery / job_list' },
        owner: { type: 'string', description: "Agent name that owns this job (e.g. 'coder') — used for orphan recovery" },
      },
      required: ['command'],
    },
  },
  {
    name: 'job_wait',
    description:
      'Wait for a background job to complete. Blocks until the job finishes or timeout (default 10 min, hard cap 2 h). Returns final status + output tail. Prefer this over repeated job_status polling. ' +
      'long waits are the main agent\'s duty (up to 2h per call, chain on timeout).' + BETA,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job ID to wait for' },
        timeoutMs: { type: 'number', description: 'Max wait in ms (default 600000 = 10min, hard cap 7200000 = 2h)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'job_status',
    description: 'Check status of a background job. Shows running/completed/failed and tail of output.' + BETA,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job ID (e.g. job-1234567890-abcd)' },
        lines: { type: 'number', description: 'Number of output lines to show (default: 50)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'job_list',
    description: 'List all background jobs (active and completed).' + BETA,
    inputSchema: { type: 'object', properties: {} },
  },
];

// =============================================================================
// IMPL —— 四工具实现(async (args) => string;消息契约逐字移植自原版
// src/tools/jobs.ts,唯二例外:id 校验失败的友好文本、job_wait 超时选项 (2))
// =============================================================================
function invalidIdText(id) {
  return `Error: invalid job id "${id}" — expected format job-<timestamp>-<suffix> (e.g. job-1234567890-abcd). Use job_list to see valid job ids.`;
}

async function implJobStart(args) {
  const root = getRoot();
  maybeCleanupExpiredJobs(root);
  const command = String(args.command ?? '');
  if (!command || !command.trim()) return "Error: 'command' is required";
  if (command.length > MAX_JOB_COMMAND_LENGTH) return `Error: command too long (max ${MAX_JOB_COMMAND_LENGTH} chars)`;
  if (gitGate.scanCommandForSecrets(command)) {
    return [
      `[SECURITY BLOCKED] Command contains hardcoded secrets/passwords/tokens.`,
      `Use environment variables or config files (NOT committed to git) instead.`,
      `Original command was NOT executed.`,
    ].join('\n');
  }
  const highRisk = pickHighRiskReason(command);
  if (highRisk) {
    return [
      `[HIGH-RISK BLOCKED] ${highRisk.tag}`,
      `Original: ${command.slice(0, 120)}`,
      `Why: ${highRisk.why}`,
      `Alternative: ${highRisk.alt}`,
      `Command was NOT executed.`,
    ].join('\n');
  }
  const runner = getRunner(root);
  const existing = runner.list().find((j) => j.status === 'running' && j.command === command);
  if (existing) {
    return [
      `Already running as background job: ${existing.id}`,
      `Command: ${command.slice(0, 120)}`,
      `Status: running`,
      `Use job_status(id:"${existing.id}") or job_wait to monitor. Do NOT start a duplicate.`,
    ].join('\n');
  }
  try {
    const job = runner.start(
      command,
      args.owner === undefined ? undefined : String(args.owner),
      args.purpose === undefined ? undefined : String(args.purpose)
    );
    return [
      `Launched as background job: ${job.id}`,
      `Command: ${command.slice(0, 120)}`,
      `Status: running`,
      ``,
      `Next steps:`,
      `- Report this job ID to the orchestrator and end your task (fire-and-forget), OR`,
      `- job_wait(id:"${job.id}", timeoutMs:N) to block up to N ms for the result.`,
      `Use job_status(id:"${job.id}") for a status check. Do NOT re-run this command.`,
    ].join('\n');
  } catch (err) {
    return `Error: failed to start background job: ${String(err)}`;
  }
}

async function implJobWait(args) {
  const id = String(args.id ?? '');
  if (!id) return "Error: 'id' is required";
  if (!SAFE_ID_RE.test(id)) return invalidIdText(id);
  // WAIT_SLICE_MAX 为 Plan-B 降级开关(见文件头):当前 7200000 下第三个参数是
  // 无操作钳制;若客户端不采纳 .mcp.json 的 timeoutMs,把它改 25000 即降级为
  // 短切片链式等待,其余零改动。
  const cap = Math.max(0, Math.min(args.timeoutMs ?? 600000, 7200000, WAIT_SLICE_MAX));
  const FENCE = '```';
  const runner = getRunner(getRoot());

  const initial = runner.status(id);
  if (!initial) {
    return `Job "${id}" not found. Use job_list to see available jobs.`;
  }
  if (initial.status !== 'running') {
    const tail = runner.getOutput(id, 10);
    return [
      `📋 Job: ${initial.id} (already ${initial.status})`,
      `Exit code: ${initial.exitCode ?? 'N/A'}`,
      ``,
      `Output (tail):`,
      FENCE,
      tail,
      FENCE,
    ].join('\n');
  }

  try {
    await pollUntil(
      async () => {
        const j = runner.status(id);
        return j !== null && j.status !== 'running';
      },
      { intervals: JOB_WAIT_INTERVALS, timeoutMs: cap, maxAttempts: Math.ceil(cap / 4000) + 50 }
    );
  } catch (err) {
    return `Error waiting for job "${id}": ${err instanceof Error ? err.message : String(err)}`;
  }

  const final = runner.status(id);
  if (!final) {
    return `Job "${id}" disappeared during wait.`;
  }
  const tail = runner.getOutput(id, 10);
  return [
    final.status !== 'running'
      ? `✅ Job ${final.status} (exit code: ${final.exitCode ?? 'N/A'})`
      // 唯一契约改动:选项 (2) 由原版 coder 视角 "report the job ID ... to the
      // orchestrator if fire-and-forget" 改为调用方中立表述;选项 (1) 逐字保留。
      : `⏳ Job still running after ${Math.round(cap / 1000)}s — choose: (1) job_wait again with a longer timeoutMs if you need the result, (2) continue other work and check later with job_status (job id: ${id}).`,
    ``,
    `Output (tail):`,
    FENCE,
    tail,
    FENCE,
  ].join('\n');
}

async function implJobStatus(args) {
  const id = String(args.id ?? '');
  if (!id) return "Error: 'id' is required";
  if (!SAFE_ID_RE.test(id)) return invalidIdText(id);
  const runner = getRunner(getRoot());
  const job = runner.status(id);
  if (!job) return `Job "${id}" not found.`;
  const output = runner.getOutput(id, clampLines(args.lines ?? 50));
  return [
    `📋 Job: ${job.id}`,
    `Command: ${job.command}`,
    `Status: ${job.status === 'running' ? '▶️ running' : job.status === 'completed' ? '✅ completed' : job.status === 'failed' ? '❌ failed' : '⏹ cancelled'}`,
    job.completedAt ? `Completed: ${job.completedAt}` : `Started: ${job.startedAt}`,
    ``,
    `Output (tail):`,
    '```',
    output,
    '```',
  ].join('\n');
}

async function implJobList() {
  const root = getRoot();
  maybeCleanupExpiredJobs(root);
  const jobs = getRunner(root).list();
  if (jobs.length === 0) return 'No jobs found.';
  return jobs.map((j) => {
    const icon = j.status === 'running' ? '▶️' : j.status === 'completed' ? '✅' : j.status === 'failed' ? '❌' : '⏹';
    return `  ${icon} ${j.id}: ${j.command.slice(0, 80)} [${j.status}]`;
  }).join('\n');
}

module.exports = {
  TOOLS,
  IMPL: {
    job_start: implJobStart,
    job_wait: implJobWait,
    job_status: implJobStatus,
    job_list: implJobList,
  },
};
