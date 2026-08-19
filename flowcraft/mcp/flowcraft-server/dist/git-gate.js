#!/usr/bin/env node
// =============================================================================
// git-gate.js —— git_gate 提交闸门工具(M3a)
// 忠实移植自 flowcraft 源码 src/tools/git-gate.ts + src/pre-push-guard.ts +
// src/git-exec.ts(仓库只读参考,权威源)。由 server.js require 引入,server.js 只做注册。
//
// 与原版的差异(M3a 移植决定,均有先例/授权):
//   1. 状态目录:<项目根>/.zcode-flowcraft/last-approval.json(原版 .flowcraft,
//      切换原因:避免与原版 OpenCode 插件的状态目录冲突;不迁移旧文件)。
//   2. session 校验省略:原版 execute 开头经 opencode client API 验证
//      sessionData.agent === "orchestrator";ZCode MCP 服务器无此 API,改由工具
//      description 的"主代理专用"标注约束(与 read/grep/declare_principle 同款)。
//   3. task → Agent 措辞适配:NEXT STEPS / BLOCKED 文案里的派发调用改为 ZCode 的
//      Agent 工具(唯一子代理派发路径,参数 prompt/description/subagent_type 同构)。
//   4. verifyReviewDispatches 改为派发账本校验(M3b P3 起硬校验,开关 HARD_LEDGER):
//      原版经事件系统 recordReviewOutput 记录 reviewer 输出;ZCode 侧读
//      .zcode-flowcraft/gate-dispatch-ledger.json(main-agent-wall Pre 记账附 toolCallId,
//      quota-reset-marker Post 从 toolResponse.content 回填真实 output)。
//      硬模式:账本缺失/损坏/无合规条目 → submit BLOCKED;HARD_LEDGER=false 回
//      M3a 降级行为(放行 + 警示行)。
//   5. runGitReadOnly 的重试层照原版移植(attempts=2,ETIMEDOUT 窄谓词)——与
//      server.js git_read 段"不移植重试层"的决定不同,因为这里 merge-base 超时
//      会映射为 check-failed 文案"(retried once)",保留重试才使该文案属实。
//   6. v0.7.4 gitPush 改用 spawnSync 并在成功路径合并 stderr:git push 的 refs
//      变更摘要写 stderr、stdout 恒空,原 execFileSync 只回 stdout 导致 push 恒显
//      "(up to date)"(Mac 实测)。失败路径抛同形状错(status + stderr),
//      [push error] 分支零改动;兜底文案仅在 stdout+stderr 皆空时出现。
//
// KEEP-IN-SYNC(原版 3 层角色分离的移植注记):
//   (1) 工具 description = 选择期行为(前置防误路由);
//   (2) 授权原则权威措辞 = 原版 events.ts L122-128/L153("gate approved ≠ user
//       authorized to commit" / "git writes go to git_gate directly");
//   (3) 提交路径强制 = 本文件 commit/push 分支的 BLOCKED 文案。
//   三层共同强化 "git 写操作 → git_gate,绝不派 coder"。
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const PROCESS_START_MS = Date.now();

// =============================================================================
// M3b P3 派发账本硬校验开关(蓝图 D4/D7):
//   true  —— 硬闸:账本缺失/JSON 损坏/无合规条目 → verifyReviewDispatches ok:false,
//            submit 一律 BLOCKED(区分"账本缺失"与"条目不合规"的细化文案)。
//   false —— 降级模式(M3a 行为):校验未过仍放行(ok:true)+ 输出显式警示行,
//            last-approval.results 记 args 自报值。
// 应急路径:若主代理墙的账本写入机制失效导致 submit 全拒,把本常量改 false 并
// 重启 ZCode 即回降级模式(本文件属 MCP server dist,运行中实例不热载,需重启生效)。
// =============================================================================
const HARD_LEDGER = true;

// =============================================================================
// git exec 基座 —— 移植自原版 src/git-exec.ts(gitArgs/gitOptions/
// isRetryableSpawnFailure/runGitReadOnly)。execFileSync 数组参数(RCE 纪律);
// --no-pager 防分页器挂起;GIT_OPTIONAL_LOCKS=0 连索引刷新写都不做;
// stdin ignore 切断 Windows 管道继承死锁;读操作 killSignal 默认 SIGKILL,
// 写操作(add/commit/fetch/push)显式 SIGTERM(git 信号链释放 index.lock)。
// =============================================================================
function gitArgs(args) { return ['--no-pager', ...args]; }
function gitOptions(overrides) {
  return {
    cwd: overrides.cwd,
    timeout: overrides.timeout,
    maxBuffer: overrides.maxBuffer != null ? overrides.maxBuffer : (1 << 20),
    stdio: overrides.stdio != null ? overrides.stdio : ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    windowsHide: true,
    killSignal: overrides.killSignal != null ? overrides.killSignal : 'SIGKILL',
    env: Object.assign({}, process.env, { GIT_OPTIONAL_LOCKS: '0' }),
  };
}
// 只重试 spawn/管道级超时;干净的非零退出(git 语义错误)与 maxBuffer 溢出绝不重试。
function isRetryableSpawnFailure(err) {
  if (typeof (err && err.status) === 'number') return false;
  if (typeof (err && err.code) === 'number') return false;
  if (typeof (err && err.exitCode) === 'number') return false;
  if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return false;
  if (err && err.code === 'ETIMEDOUT') return true;
  if (err && err.killed === true) return true;
  if (/ETIMEDOUT/i.test(String((err && err.message) || ''))) return true;
  return false;
}
// 判别联合 {ok|timeout|error}:merge-base 的 exit-1 是 error(diverged),管道挂起是
// timeout(check-failed)——两者绝不混淆(这是 isFastForward 四态区分的根基)。
function runGitReadOnly(args, opts) {
  const attempts = 2; // 原版默认:总尝试 2 次(1 次重试)
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const stdout = execFileSync('git', gitArgs(args), gitOptions({ cwd: opts.cwd, timeout: opts.timeout }));
      return { kind: 'ok', stdout };
    } catch (err) {
      lastErr = err;
      if (attempt < attempts && isRetryableSpawnFailure(err)) continue;
      if (err && (err.code === 'ETIMEDOUT' || (err.killed === true && err.status === undefined && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'))) {
        return { kind: 'timeout', error: err };
      }
      return { kind: 'error', error: err };
    }
  }
  return { kind: 'error', error: lastErr };
}

// =============================================================================
// 敏感文件/密钥三层模式库 —— 逐字移植自原版 pre-push-guard.ts
// (文件名层 / 内容层 / 命令层;git_read 的精选子集不用于此处)。
// =============================================================================
const SENSITIVE_FILE_PATTERNS = [
  /^\.env(\.\w+)?$/,
  /^\.env\.\w+$/,
  /\.credentials$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^id_ed25519/,
  /^id_ecdsa/,
  /^credentials\.json$/,
  /^serviceAccountKey\.json$/,
  /^.*\.p12$/,
  /^.*\.pfx$/,
  /^.*\.jks$/,
  /^.*\.keystore$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.netrc$/,
  /^\.dockercfg$/,
  // 原版 DEAD-CODE REMOVED(Phase 5)注记:含 "/" 的路径型模式在 basename 匹配器下
  // 永不命中,已删;`.ssh/config` 由 server.js git_read 的 GIT_SENSITIVE_PATH 保护。
  /^secrets?\.[\w.]+$/,
  /^vault\.json$/,
  /^\.git-credentials$/,
  /^terraform\.tfstate(?:\.backup)?$/,
  /^firebase-adminsdk-.*\.json$/,
  /^credentials$/,
];

// 共享 PEM 私钥头探测器(内容层与命令层共用,防漂移)。覆盖 PKCS#8 裸形 +
// RSA/EC/DSA/OPENSSH/ENCRYPTED 变体,以及真实 RFC 4880 PGP ASCII-armor 头
// (以 `PRIVATE KEY BLOCK` 结尾)。无 /g 标志(状态化 lastIndex 会破坏逐行扫描)。
const PEM_PRIVATE_KEY_RE = /-----BEGIN (?:PGP PRIVATE KEY BLOCK|(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----/;

const SENSITIVE_CONTENT_PATTERNS = [
  /(?:^|["'\s])AKIA[0-9A-Z]{16}(?:["'\s]|$)/,
  /(?:password|passwd|pwd)\s*[=:]\s*["'][^"']{8,}["']/i,
  /(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*["'][^"']{16,}["']/i,
  /(?:secret[_-]?key|private[_-]?key)\s*[=:]\s*["'][^"']{16,}["']/i,
  /(?:Bearer|Authorization)\s*:\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  /(?:github|gitlab|bitbucket)_token\s*[=:]\s*["'][^"']{20,}["']/i,
  /ghp_[A-Za-z0-9]{36,}/,
  /gho_[A-Za-z0-9]{36,}/,
  /ghu_[A-Za-z0-9]{36,}/,
  /ghs_[A-Za-z0-9]{36,}/,
  /ghr_[A-Za-z0-9]{36,}/,
  /glpat-[A-Za-z0-9\-]{20,}/,
  /xox[baprs]-[A-Za-z0-9\-]{10,}/,
  PEM_PRIVATE_KEY_RE,
  /sk-[A-Za-z0-9]{20,}/,
  /sk_live_[A-Za-z0-9]{20,}/,
  /pk_live_[A-Za-z0-9]{20,}/,
  /rk_live_[A-Za-z0-9]{20,}/,
  /f(?:(?:irebase)|ire)[_.]app[_.]\w+[_.]*/,
  /AIza[0-9A-Za-z\-_]{35}/,
  /hooks\.slack\.com\/services\/T[0-9A-Z]{8,}\/B[0-9A-Z]{8,}\/[A-Za-z0-9]{24,}/,
  // Phase 2 增补 —— 高精度、有据可查的内容模式:
  // Discord webhook(完整结构:/api/webhooks/<snowflake 18-19>/<token 60+>)。
  /discord\.com\/api\/webhooks\/[0-9]{18,19}\/[A-Za-z0-9_\-]{60,}/,
  // SendGrid API key(gitleaks 忠实:SG. + 恰 66 个主体字符;短 {20,} 会误报)。
  /\bSG\.[A-Za-z0-9=_\-\.]{66}/,
  // Twilio API key(SK 前缀 + 32+ hex)。\b 强制 —— 缺失会误报 TASK<32hex> 分支名。
  /\bSK[0-9a-fA-F]{32,}\b/,
  // DigitalOcean token(do[opr]_v1_ + 64 个小写 hex;第 2 字符恒为 'o')。
  /do[opr]_v1_[0-9a-f]{64}/,
];

// =============================================================================
// gate FSM —— idle/reviewing/approved/rejected(逐字移植自原版 pre-push-guard.ts)
// 不变量(注册过的设计原则):
//   - resetReviewGate() 永不清 _lastApproval(_gate 才是瞬态)
//   - markReviewStarted() 永不清 _lastApproval
//   - markReviewComplete() 是 _lastApproval 唯一写者:
//       • approved(highIssues===0)→ 持久化完整证据
//       • rejected(highIssues>0) → _lastApproval = null(H2 修复)
//   - canReuseLastApproval() 在 gate 未批准但暂存内容逐字节一致时允许免重审复用
// =============================================================================
const _gate = {
  state: 'idle',
  reviewedFiles: new Map(),
  approvedAt: null,
  reviewerResult: null,
  reviewer2Result: null,
  highIssues: 0,
  reviewerOutputs: new Map(),
  readmeChecked: false,
  readmeStatus: null,
  readmeRationale: null,
  readmeSections: [],
};
let _lastApproval = null; // { files:Map, outputs:Map, results:{reviewer,reviewer2}, readme:{status,rationale,sections}, highIssues, approvedAt }

// --- _lastApproval 磁盘持久化(插件/服务器重启后仍可恢复)---
// 落盘路径:<projectDir>/.zcode-flowcraft/last-approval.json(M3a 目录切换)。
// Maps 经 Object.fromEntries 序列化为普通对象,恢复时 new Map(Object.entries(...))。
function getLastApprovalPath(projectDir) {
  return path.join(projectDir, '.zcode-flowcraft', 'last-approval.json');
}
function serializeLastApproval(app) {
  return {
    files: Object.fromEntries(app.files),
    outputs: Object.fromEntries(app.outputs),
    results: app.results,
    readme: app.readme,
    highIssues: app.highIssues,
    approvedAt: app.approvedAt,
  };
}
function deserializeLastApproval(data) {
  if (!data || !data.files || typeof data.files !== 'object') return null;
  try {
    return {
      files: new Map(Object.entries(data.files)),
      outputs: new Map(Object.entries(data.outputs || {})),
      results: data.results || { reviewer: '', reviewer2: '' },
      readme: data.readme || { status: 'not_needed', rationale: '', sections: [] },
      highIssues: typeof data.highIssues === 'number' ? data.highIssues : 0,
      approvedAt: typeof data.approvedAt === 'number' ? data.approvedAt : 0,
    };
  } catch { return null; }
}
function saveLastApproval(projectDir) {
  if (!_lastApproval) return;
  try {
    const filePath = getLastApprovalPath(projectDir);
    const dir = path.join(filePath, '..');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(serializeLastApproval(_lastApproval), null, 2), 'utf-8');
  } catch { /* 持久化失败静默(原版 log.debug 语义) */ }
}
function clearLastApprovalFile(projectDir) {
  // 墓碑:覆写 "null" 而非 unlink。unlink 在 Windows 可能因文件锁/AV 扫描失败,
  // 留下可被重启后复活的旧批准快照;JSON.parse("null")===null,
  // deserializeLastApproval(null)===null,墓碑文件在下次加载即得 _lastApproval=null。
  // 覆写一个已存在的可写文件几乎不会失败,是更可靠的清除路径。
  try {
    const filePath = getLastApprovalPath(projectDir);
    fs.writeFileSync(filePath, 'null', 'utf-8');
  } catch { /* 同上 */ }
}
function tryLoadLastApprovalFromDisk(projectDir) {
  if (_lastApproval) return;
  try {
    const filePath = getLastApprovalPath(projectDir);
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const restored = deserializeLastApproval(JSON.parse(raw));
    if (restored) _lastApproval = restored;
  } catch { /* 同上 */ }
}

// 把当前批准证据快照持久化进 _lastApproval。仅由 markReviewComplete 的 approved
// 分支调用;rejected 分支设 _lastApproval = null(H2 修复)。
function persistLastApproval(fileHashes, projectDir) {
  _lastApproval = {
    files: new Map(fileHashes),
    outputs: new Map(_gate.reviewerOutputs),
    results: {
      reviewer: _gate.reviewerResult != null ? _gate.reviewerResult : '',
      reviewer2: _gate.reviewer2Result != null ? _gate.reviewer2Result : '',
    },
    readme: {
      status: _gate.readmeStatus != null ? _gate.readmeStatus : 'not_needed',
      rationale: _gate.readmeRationale != null ? _gate.readmeRationale : '',
      sections: [..._gate.readmeSections],
    },
    highIssues: _gate.highIssues,
    approvedAt: Date.now(),
  };
  if (projectDir) saveLastApproval(projectDir);
}

function getReviewGate() {
  return Object.freeze(Object.assign({}, _gate, {
    reviewedFiles: new Map(_gate.reviewedFiles),
    reviewerOutputs: new Map(_gate.reviewerOutputs),
  }));
}
function resetReviewGate() {
  _gate.state = 'idle';
  _gate.reviewedFiles.clear();
  _gate.approvedAt = null;
  _gate.reviewerResult = null;
  _gate.reviewer2Result = null;
  _gate.highIssues = 0;
  _gate.reviewerOutputs.clear();
  _gate.readmeChecked = false;
  _gate.readmeStatus = null;
  _gate.readmeRationale = null;
  _gate.readmeSections = [];
  // 刻意不清 _lastApproval(不变量:reset 永不清 lastApproval)。
}
function markReviewStarted() {
  _gate.state = 'reviewing';
  _gate.reviewerResult = null;
  _gate.reviewer2Result = null;
  _gate.highIssues = 0;
  _gate.reviewerOutputs.clear();
  _gate.readmeChecked = false;
  _gate.readmeStatus = null;
  _gate.readmeRationale = null;
  _gate.readmeSections = [];
}
function markReviewComplete(reviewerResult, reviewer2Result, highIssues, fileHashes, projectDir) {
  _gate.reviewerResult = reviewerResult;
  _gate.reviewer2Result = reviewer2Result;
  _gate.highIssues = highIssues;
  for (const [file, hash] of fileHashes) {
    _gate.reviewedFiles.set(file, hash);
  }
  if (highIssues === 0) {
    _gate.state = 'approved';
    _gate.approvedAt = Date.now();
    // 双写:持久化独立证据快照,gate 被 reset 后若暂存内容未变可免重审复用。
    persistLastApproval(fileHashes, projectDir);
  } else {
    _gate.state = 'rejected';
    _gate.approvedAt = null;
    // H2 修复:被拒的评审绝不可事后复用 —— 清除证据,否则 canReuseLastApproval
    // 会匹配被拒评审的文件哈希而静默绕过拒绝。
    _lastApproval = null;
    if (projectDir) clearLastApprovalFile(projectDir);
  }
}
function markReadmeChecked(status, rationale, sections, projectDir) {
  _gate.readmeChecked = true;
  _gate.readmeStatus = status;
  _gate.readmeRationale = rationale;
  _gate.readmeSections = sections ? [...sections] : [];
  // L1 修复:persistLastApproval 在 markReviewComplete 内(先于本函数)执行,捕获了
  // 过期/空的 readme;此处同步 _lastApproval.readme,renew 周期才能恢复真实 rationale。
  if (_lastApproval) {
    _lastApproval.readme = {
      status: _gate.readmeStatus,
      rationale: _gate.readmeRationale,
      sections: [..._gate.readmeSections],
    };
    if (projectDir) saveLastApproval(projectDir);
  }
}
function isReadmeChecked() { return _gate.readmeChecked; }
function isGateApproved() {
  // 纯查询 —— 无副作用。有效性基于文件内容而非时间:一旦批准,直到 reset/rejected
  // 恒有效。暂存文件是否仍与批准快照一致由 filesNeedReReview 在 commit 路径单独
  // 强制 —— 那才是真正的守卫,不是 TTL。
  return _gate.state === 'approved';
}
function getGateStatusText() {
  const g = _gate;
  switch (g.state) {
    case 'idle':
      // reviewedFiles 有条目 = gate 被 reset 但证据仍被追踪 —— 提示复用路径。
      if (g.reviewedFiles.size > 0) {
        return `REVIEW GATE: idle — gate reset, but ${g.reviewedFiles.size} files from last review still tracked. Re-review may be skipped if staged contents are unchanged.`;
      }
      return 'REVIEW GATE: idle — double review required before git commit/push';
    case 'reviewing':
      return 'REVIEW GATE: review in progress...';
    case 'approved': {
      const readmeLine = g.readmeChecked
        ? `README: ${g.readmeStatus === 'updated' ? '✅updated' : '⏭️not_needed'}`
        : 'README: ❌NOT CHECKED';
      return `REVIEW GATE: approved (valid while files unchanged, ${g.reviewedFiles.size} files reviewed)\n${readmeLine}`;
    }
    case 'rejected':
      return `REVIEW GATE: rejected — ${g.highIssues} HIGH issues found. Fix and re-review.`;
  }
  return '';
}

function hashFileContent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf-8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

// H3/M4 修复版:reviewedFiles 为空(无法信任批准)或 staged 为空(git 读失败或
// 真空提交)恒判需复审 —— 绝不基于"没有文件可比较"静默放行。
function filesNeedReReview(projectDir) {
  try {
    if (_gate.reviewedFiles.size === 0) return true;
    const stagedFiles = getStagedFiles(projectDir);
    if (stagedFiles.length === 0) return true;
    for (const file of stagedFiles) {
      const currentHash = hashFileContent(path.join(projectDir, file));
      const previousHash = _gate.reviewedFiles.get(file);
      // 已删除文件:reviewedFiles 缺席 且 磁盘不存在 —— 视为一致
      if (previousHash === undefined && currentHash === '') continue;
      if (previousHash !== currentHash) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// 当前暂存集能否免重审直接复用 _lastApproval。返回 {reuse:true} 需同时满足:
//   1. _lastApproval 非空且至少记录 1 个文件
//   2. 暂存列表非空(M4:空暂存 = 拦截)
//   3. 每个暂存文件当前哈希与记录哈希一致
//   4. 没有暂存文件缺席于 _lastApproval.files(无新文件)
// H2 安全:rejected 分支已把 _lastApproval 置 null,被拒评审不可复用。
function canReuseLastApproval(projectDir) {
  if (!_lastApproval) tryLoadLastApprovalFromDisk(projectDir);
  if (!_lastApproval || _lastApproval.files.size === 0) {
    return { reuse: false, reason: 'no prior approval record' };
  }
  const staged = getStagedFiles(projectDir);
  if (staged.length === 0) {
    return { reuse: false, reason: 'no staged files (or getStagedFiles failed)' };
  }
  for (const file of staged) {
    const curHash = hashFileContent(path.join(projectDir, file));
    const prevHash = _lastApproval.files.get(file);
    if (prevHash === undefined) {
      return { reuse: false, reason: `new staged file: ${file}` };
    }
    if (prevHash !== curHash) {
      return { reuse: false, reason: `file changed: ${file}` };
    }
  }
  return { reuse: true, reason: 'all staged files match last approval' };
}

// 从 _lastApproval 恢复 _gate 各字段并刷新 approvedAt 为现在。_lastApproval 为
// null 时 no-op(防御性 —— 调用方先查 canReuseLastApproval)。
function renewGateFromLastApproval() {
  if (!_lastApproval) return;
  _gate.state = 'approved';
  _gate.approvedAt = Date.now();
  _gate.reviewerResult = _lastApproval.results.reviewer;
  _gate.reviewer2Result = _lastApproval.results.reviewer2;
  _gate.highIssues = _lastApproval.highIssues;
  // M1 修复:reviewedFiles 也要恢复 —— resetReviewGate 清了它,不恢复则
  // filesNeedReReview 见空 map 每次 commit 都判需复审(恒走 Path 2)。
  _gate.reviewedFiles = new Map(_lastApproval.files);
  _gate.readmeChecked = true;
  _gate.readmeStatus = _lastApproval.readme.status;
  _gate.readmeRationale = _lastApproval.readme.rationale;
  _gate.readmeSections = [..._lastApproval.readme.sections];
}

// 服务器加载时从持久化批准恢复内存 gate(瞬态 _gate 随进程消失,仅 _lastApproval
// 落盘)。仅 init 安全:只在 _gate 仍处初始 "idle" 时 renew,绝不覆盖进行中的
// "reviewing" 或已 "approved" 会话;无持久化批准则 no-op。
// 进程内按目录只跑一次(等价原版"插件加载时"语义 —— 若每次调用都跑,reset 之后
// 会被磁盘快照复活,破坏 reset 语义)。
function restoreGateOnLoad(projectDir) {
  if (_gate.state !== 'idle') return;
  tryLoadLastApprovalFromDisk(projectDir);
  if (_lastApproval) renewGateFromLastApproval();
}
let _restoredForDir = null;
function ensureGateRestored(projectDir) {
  if (_restoredForDir === projectDir) return;
  _restoredForDir = projectDir;
  restoreGateOnLoad(projectDir);
}

// =============================================================================
// 派发账本校验(M3b P3 硬校验,蓝图 D4/D7;开关 HARD_LEDGER 见文件顶部)
// 账本:<root>/.zcode-flowcraft/gate-dispatch-ledger.json,在 [args.cwd,
// FLOWCRAFT_CWD] 两处找,取先命中者。合规条目:reviewer 与 reviewer2 各 ≥1 条、
// ts 晚于 max(last-approval.approvedAt, 进程启动时间);条目带 ≥10 字符 output
// (M3b P3 由 quota-reset-marker.js 从 toolResponse.content 回填)时计入 outputs,
// submit 据此落 last-approval.results(账本值优先于 args 自报值)。
// HARD_LEDGER=true:未过 → ok:false(problem 区分 missing-file/unreadable/no-valid-entries)
// → submit BLOCKED(细化文案见 dispatchBlockedText)。
// HARD_LEDGER=false:M3a 降级行为 —— ok:true + degraded:true + 警示行。
// =============================================================================
function ledgerEntryAgent(e) {
  return String(e.agent != null ? e.agent : (e.agentType != null ? e.agentType : (e.subagentType != null ? e.subagentType : (e.type != null ? e.type : ''))));
}
function ledgerEntryTs(e) {
  const raw = e.ts != null ? e.ts : (e.timestamp != null ? e.timestamp : e.time);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}
function ledgerEntryOutput(e) {
  const out = e.output != null ? e.output : (e.result != null ? e.result : '');
  return typeof out === 'string' ? out.trim() : '';
}
// M3c:状态文件查找根链(先 args.cwd/projectDir,后 FLOWCRAFT_CWD,再退 process.cwd();
// 去重)。findLedgerPath 与 commit 的 quota-reset.marker 检查共用同一回退链。
function stateLookupRoots(projectDir) {
  const roots = [];
  if (projectDir) roots.push(projectDir);
  const envRoot = process.env.FLOWCRAFT_CWD || process.cwd();
  if (envRoot && !roots.includes(envRoot)) roots.push(envRoot);
  return roots;
}
function findLedgerPath(projectDir) {
  for (const r of stateLookupRoots(projectDir)) {
    const p = path.join(r, '.zcode-flowcraft', 'gate-dispatch-ledger.json');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function verifyReviewDispatches(projectDir) {
  const baseline = Math.max(_lastApproval ? _lastApproval.approvedAt : 0, PROCESS_START_MS);
  const ledgerPath = findLedgerPath(projectDir);
  const entries = [];
  let parseFailed = false;
  if (ledgerPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []);
      for (const e of arr) if (e && typeof e === 'object') entries.push(e);
    } catch { parseFailed = true; /* 损坏 JSON 按无合规条目处理 */ }
  }
  const outputs = {};
  const missing = [];
  for (const agent of ['reviewer', 'reviewer2']) {
    const hits = entries
      .filter(e => ledgerEntryAgent(e) === agent && ledgerEntryTs(e) > baseline)
      .sort((a, b) => ledgerEntryTs(a) - ledgerEntryTs(b));
    if (hits.length === 0) { missing.push(agent); continue; }
    const out = ledgerEntryOutput(hits[hits.length - 1]);
    if (out.length >= 10) outputs[agent] = out; // 与原版 recordReviewOutput 的 ≥10 字符门槛对齐
  }
  if (missing.length === 0) {
    return { ok: true, degraded: false, missing: [], outputs, warning: null, ledgerPath, baseline, problem: null };
  }
  // 账本级问题归因(missing-file / unreadable / no-valid-entries),供 BLOCKED 文案区分。
  const problem = !ledgerPath ? 'missing-file' : (parseFailed ? 'unreadable' : 'no-valid-entries');
  if (HARD_LEDGER) {
    // M3b P3 硬校验(蓝图 D4):M3a 的降级放行分支删除,未过一律 ok:false → submit BLOCKED。
    return { ok: false, degraded: false, hard: true, missing, outputs, warning: null, ledgerPath, baseline, problem };
  }
  return {
    ok: true, // 降级模式(HARD_LEDGER=false):M3a 行为 —— 放行 + 显式警示行
    degraded: true,
    missing,
    outputs,
    warning: `⚠️ [DISPATCH LEDGER WARNING] 派发账本校验未通过(${problem === 'missing-file' ? '账本缺失' : problem === 'unreadable' ? '账本 JSON 损坏' : '无合规条目'}:missing ${missing.join(', ')})。降级放行(据 args.reviewerResult/reviewer2Result 记账);硬校验已关闭(HARD_LEDGER=false,恢复:dist/git-gate.js 顶部改 true 并重启 ZCode)。`,
    ledgerPath,
    baseline,
    problem,
  };
}

// submit 的派发硬校验 BLOCKED 文案(蓝图 D4/D7):区分"账本缺失"与"条目不合规",
// 列出账本查找路径、合规定义(含 baseline 换算值)与回降级开关的应急指引。
function dispatchBlockedText(verify, projectDir) {
  const lookupPaths = [];
  if (projectDir) lookupPaths.push(path.join(projectDir, '.zcode-flowcraft', 'gate-dispatch-ledger.json'));
  const envPath = path.join(process.env.FLOWCRAFT_CWD || process.cwd(), '.zcode-flowcraft', 'gate-dispatch-ledger.json');
  if (!lookupPaths.includes(envPath)) lookupPaths.push(envPath);
  const problemText =
    verify.problem === 'missing-file'
      ? `账本缺失(查找路径均未命中:${lookupPaths.join(' ; ')})`
      : verify.problem === 'unreadable'
        ? `账本不可读/JSON 损坏:${verify.ledgerPath}`
        : `条目不合规:${verify.ledgerPath}`;
  return [
    `[REVIEW GATE BLOCKED] Dispatch ledger verification failed — missing: ${verify.missing.join(', ')}. You MUST dispatch Agent() to the actual reviewer/reviewer2 agents before submitting.`,
    `问题:${problemText}`,
    `合规定义:账本内 reviewer 与 reviewer2 各 ≥1 条,且 ts 晚于 max(上次批准 approvedAt, 进程启动时间) = ${new Date(verify.baseline).toISOString()}(${verify.baseline})`,
    '修复:经 Agent 工具真实派发 reviewer 与 reviewer2(主代理墙 PreToolUse 自动记账并附 toolCallId,PostToolUse 自动回填真实 output),完成后重新 submit。',
    '应急:若墙记账机制失效导致全拒,把 dist/git-gate.js 顶部 HARD_LEDGER 改 false 并重启 ZCode,回降级模式(放行+警示行)。',
  ].join('\n');
}

// =============================================================================
// git 命令封装(逐字移植,含超时/信号纪律)
// =============================================================================
function getStagedFiles(projectDir) {
  // RETRY(自 git_gate submit 下沉,所有调用方共享该韧性):此暂存读取被
  // submit/commit/scan/status/filesNeedReReview/canReuseLastApproval 共用。
  // 长时间双审后的冷 git 调用可能超时 → execFileSync 抛异常 → 若被 catch 静默映射
  // 为 [],调用方误判"无暂存文件"而卡死整个流程。重试一次让热缓存的第二把救回
  // 真实列表。重试仅针对抛出的异常:
  //   • 真空暂存 → git 退出码 0、stdout "" → execFileSync 返回 ""(不抛)→
  //     立即返回 [],不重试;
  //   • 超时/非零退出 → 抛异常 → 重试一次。
  // 两连败后仍降级为 [](保留原有优雅降级行为)。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = execFileSync('git', gitArgs(['diff', '--cached', '--name-only']), gitOptions({
        cwd: projectDir, timeout: 15000,
      }));
      return out.trim().split('\n').filter(Boolean);
    } catch {
      // 第一次:落入重试;第二次:出循环 → []
    }
  }
  return [];
}

// 校验所有文件路径都在 projectDir 内(防穿越)。返回非法路径列表。
function validateStagePaths(projectDir, files) {
  const invalid = [];
  for (const f of files) {
    const abs = path.resolve(projectDir, f);
    const rel = path.relative(projectDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) invalid.push(f);
  }
  return invalid;
}

// 当前分支名(如 "main")。detached HEAD 时返回 "HEAD";失败返回 ""。
function getCurrentBranch(projectDir) {
  const r = runGitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectDir, timeout: 5000 });
  return r.kind === 'ok' ? r.stdout.trim() : '';
}

// git add 指定文件。调用前先 validateStagePaths。
function gitStageFiles(projectDir, files) {
  execFileSync('git', gitArgs(['add', ...files]), gitOptions({
    cwd: projectDir, timeout: 10000, killSignal: 'SIGTERM',
  }));
}

// 创建提交。返回 `git log -1 --stat` 输出作确认。
function gitCommit(projectDir, message) {
  execFileSync('git', gitArgs(['commit', '-m', message]), gitOptions({
    cwd: projectDir, timeout: 15000, killSignal: 'SIGTERM',
  }));
  const r = runGitReadOnly(['log', '-1', '--stat'], { cwd: projectDir, timeout: 5000 });
  if (r.kind === 'ok') return r.stdout.trim();
  // timeout → ""(提交已成功;不给误导性的 [commit error])
  if (r.kind === 'timeout') return '';
  // error(maxBuffer、仓库损坏等)—— 提交已落地但日志确认因非超时原因失败,
  // 不作为提交失败呈现。
  return '';
}

// origin/<branch> 是否为 HEAD 的祖先(即本地可 fast-forward push)。先 fetch。
// 四态判别联合:真正分歧 / fetch 失败(网络/SSH,URL 凭据脱敏)/ 检查失败,避免把
// 网络问题误报为 "diverged"。
function isFastForward(projectDir, branch) {
  try {
    execFileSync('git', gitArgs(['fetch', 'origin', branch]), gitOptions({
      cwd: projectDir, timeout: 20000, killSignal: 'SIGTERM',
    }));
  } catch (err) {
    const raw = String(err?.stderr ?? err?.message ?? '');
    const firstLine = raw.split('\n').map(s => s.trim()).filter(Boolean)[0];
    const detail = (firstLine || `exit ${err?.status ?? 'unknown'}`)
      .replace(/:\/\/[^\s/@]+@/, '://***@'); // URL 内嵌凭据脱敏
    return { ok: false, reason: 'fetch-failed', detail };
  }
  const mb = runGitReadOnly(['merge-base', '--is-ancestor', `origin/${branch}`, 'HEAD'], { cwd: projectDir, timeout: 5000 });
  if (mb.kind === 'ok') return { ok: true };
  if (mb.kind === 'error' && (mb.error?.status ?? mb.error?.code ?? mb.error?.exitCode) === 1) return { ok: false, reason: 'diverged' };
  if (mb.kind === 'timeout') return { ok: false, reason: 'check-failed', detail: 'merge-base check timed out (retried once)' };
  const raw = String(mb.error?.stderr ?? mb.error?.message ?? '');
  const firstLine = raw.split('\n').map(s => s.trim()).filter(Boolean)[0];
  return { ok: false, reason: 'check-failed', detail: firstLine || `exit ${mb.error?.status ?? 'unknown'}` };
}

// push 当前分支到 origin。force 时加 --force-with-lease(比 --force 安全)。
// v0.7.4:git push 的 refs 变更摘要("To <remote> ... <branch> -> <branch>")写在
// stderr、stdout 恒空——execFileSync 成功路径只返回 stdout,上层恒显
// "(up to date)"(Mac 实测)。改用 spawnSync(同一 gitOptions:数组参数 RCE 纪律/
// stdio 管道/SIGTERM),成功时合并 stdout+stderr(各自 trim 后以换行拼接;皆空
// 返回空串,由上层兜底文案接管);失败时抛与原 execFileSync 同形状的错
// (status + stderr),上层 [push error] 分支零改动。
function gitPush(projectDir, branch, force) {
  const args = force
    ? ['push', '--force-with-lease', 'origin', branch]
    : ['push', 'origin', branch];
  const r = spawnSync('git', gitArgs(args), gitOptions({
    cwd: projectDir, timeout: 30000, killSignal: 'SIGTERM',
  }));
  if (r.error) throw r.error; // spawn 级失败(超时找不到 git 等):原 execFileSync 同样抛
  if (r.status !== 0) {
    const err = new Error(`git push failed (exit ${r.status})`);
    err.status = r.status;
    err.stderr = typeof r.stderr === 'string' ? r.stderr : '';
    throw err;
  }
  const stdout = typeof r.stdout === 'string' ? r.stdout.trim() : '';
  const stderr = typeof r.stderr === 'string' ? r.stderr.trim() : '';
  return [stdout, stderr].filter(Boolean).join('\n');
}

// `git status --short` 输出。
function getGitStatusShort(projectDir) {
  const r = runGitReadOnly(['status', '--short'], { cwd: projectDir, timeout: 5000 });
  return r.kind === 'ok' ? r.stdout.trim() : '';
}

// =============================================================================
// 敏感扫描(文件名层 + 内容层,单循环一次 getStagedFiles)
// =============================================================================
function scanStagedFiles(projectDir) {
  const violations = [];
  // 单循环,getStagedFiles 只调一次。文件名模式跑全部暂存文件(含 tests/);
  // 内容扫描仅对 tests/ 关闭(测试夹具可能合法持有仿真形状的样本密钥)。
  // 两个分离循环各自重调 getStagedFiles 会双倍 git 延迟,且在两次调用间重新打开
  // 暂存快照竞态。
  const stagedFiles = getStagedFiles(projectDir);

  for (const file of stagedFiles) {
    const fileName = file.split(/[/\\]/).pop() || file;

    for (const pattern of SENSITIVE_FILE_PATTERNS) {
      if (pattern.test(fileName)) {
        violations.push({ file, type: 'filename', pattern: pattern.source });
      }
    }

    // 内容闸:tests/ 文件仅跳过 CONTENT 扫描(上面的文件名检查照跑)。
    if (/^tests?[\/\\]/.test(file)) continue;

    const filePath = path.join(projectDir, file);
    if (!fs.existsSync(filePath)) continue;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of SENSITIVE_CONTENT_PATTERNS) {
          const match = pattern.exec(line);
          if (match) {
            violations.push({
              file,
              type: 'content',
              pattern: pattern.source,
              line: i + 1,
              match: match[0].slice(0, 40),
            });
          }
        }
      }
    } catch { /* 无法读取的暂存文件跳过 */ }
  }

  const blocked = violations.length > 0;
  const summary = blocked
    ? `[SENSITIVE SCAN BLOCKED] ${violations.length} violation(s) in staged files:\n` +
      violations.map(v =>
        `  ${v.type === 'filename' ? '[FILENAME]' : `[CONTENT L${v.line}]`} ${v.file}: ${v.pattern}${v.match ? ` (${v.match})` : ''}`
      ).join('\n') +
      '\n\nRemove sensitive files from staging before commit.\n  git reset HEAD -- <file>'
    : 'No sensitive files detected in staged changes.';

  return { blocked, violations, summary };
}

// 命令层密钥扫描(commit message 等)。高精度裸 token 家族与内容层镜像但有意
// 不做全量合并(kv 带引号/Bearer/firebase/裸 sk- 刻意缺席,避免 commit message 噪音)。
function scanCommandForSecrets(command) {
  const kvPattern = /(?:password|secret|token|api[_-]?key|private[_-]?key|credential)\s*[=:]\s*["'][^"']{8,}["']/i;
  const patterns = [
    kvPattern,
    /AKIA[0-9A-Z]{16}/,
    /gh[pousr]_[A-Za-z0-9]{36}/,
    PEM_PRIVATE_KEY_RE,
    /xox[baprs]-[A-Za-z0-9\-]{10,}/,
    /sk_live_[A-Za-z0-9]{20,}/,
    /pk_live_[A-Za-z0-9]{20,}/,
    /rk_live_[A-Za-z0-9]{20,}/,
    /glpat-[A-Za-z0-9\-]{20,}/,
    /AIza[0-9A-Za-z\-_]{35}/,
    /hooks\.slack\.com\/services\/T[0-9A-Z]{8,}\/B[0-9A-Z]{8,}\/[A-Za-z0-9]{24,}/,
  ];
  return patterns.some(p => p.test(command));
}

// =============================================================================
// 工具 description 与 schema(照原版移植 + "主代理专用"标注 + BETA 后缀)
// KEEP-IN-SYNC:授权原则权威措辞见原版 events.ts L122-128/L153 —— 修改路由措辞
// 时三层(description / 权威句 / 本文件 BLOCKED 文案)必须保持一致。
// =============================================================================
const DESCRIPTION = '主代理专用。Do NOT dispatch coder for stage/commit/push — call this tool directly. Controlled git workflow tool. Actions: scan/submit/status/reset (review gate) + stage/commit/push (git writes). commit requires gate-approved double review; push requires fast-forward. submit/stage/commit/push require explicit USER authorization — gate approved ≠ user authorized to commit. This is the ONLY entry point for orchestrator git write operations. (beta) BETA';
const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', description: "Action to perform: 'scan' (sensitive-file scan + gate status) | 'submit' (open gate after double review) | 'status' (gate report) | 'reset' (clear gate) | 'stage' (git add explicit files) | 'commit' (git commit, requires gate-approved) | 'push' (git push current branch to origin, requires fast-forward)" },
    reviewerResult: { type: 'string', description: "Reviewer's review summary (for 'submit' action)" },
    reviewer2Result: { type: 'string', description: "Reviewer2's review summary (for 'submit' action)" },
    highIssues: { type: 'number', description: 'Number of HIGH issues found (0 = approved, >0 = rejected)' },
    readmeStatus: { type: 'string', description: "README check result: 'updated' | 'not_needed' — REQUIRED for 'submit' action" },
    readmeRationale: { type: 'string', description: 'Rationale for README decision (e.g. "added new flag --foo, updated usage section" or "internal refactor, no user-facing changes") — REQUIRED for \'submit\' action' },
    readmeSections: { type: 'array', items: { type: 'string' }, description: 'List of README sections that were updated (e.g. ["Usage", "Options"]) — optional for \'submit\' action' },
    files: { type: 'array', items: { type: 'string' }, description: "Files to stage (action:'stage'). Explicit array — prevents accidental staging." },
    message: { type: 'string', description: "Commit message (action:'commit'). Generated by orchestrator." },
    force: { type: 'boolean', description: "Allow non-fast-forward push (action:'push', default false). Uses --force-with-lease." },
    cwd: { type: 'string', description: 'git 仓库目录(默认服务器 CWD;状态目录 .zcode-flowcraft 亦在该目录下)' },
  },
};

function ok(text) { return { content: [{ type: 'text', text }] }; }

// =============================================================================
// git_gate 主入口 —— 7 action 分支(逐字移植自原版 src/tools/git-gate.ts)
// 原版开头的 opencode session 校验(orchestrator-only)在 ZCode 移植中省略:
// MCP 服务器无 session API,由 description 的"主代理专用"标注承担同等约束。
// =============================================================================
function executeGitGate(args) {
  const projectDir = args.cwd ? String(args.cwd) : (process.env.FLOWCRAFT_CWD || process.cwd());
  ensureGateRestored(projectDir);
  const action = args.action || 'status';

  if (action === 'scan') {
    const scanResult = scanStagedFiles(projectDir);
    const staged = getStagedFiles(projectDir);
    const lines = [
      '=== PRE-COMMIT SENSITIVE SCAN ===',
      `Staged files: ${staged.length > 0 ? staged.join(', ') : '(none)'}`,
      '',
      scanResult.summary,
      '',
      '=== REVIEW GATE STATUS ===',
      getGateStatusText(),
      '',
    ];
    if (staged.length > 0 && !scanResult.blocked) {
      lines.push('NEXT STEPS:');
      lines.push('  1. Read README.md fully and decide whether it needs updating for the staged changes');
      lines.push('  2. Agent(prompt: "Review all staged changes for quality, security, and correctness. Report HIGH/MEDIUM/LOW issues.", description: "review", subagent_type: "reviewer")');
      lines.push('  3. Agent(prompt: "Same as above — second opinion review of all staged changes.", description: "review2", subagent_type: "reviewer2")');
      lines.push('  4. git_gate(action: "submit", reviewerResult: "...", reviewer2Result: "...", highIssues: 0, readmeStatus: "updated"|"not_needed", readmeRationale: "...")');
    } else if (staged.length === 0) {
      lines.push('NEXT STEPS (no staged files yet — stage FIRST, before dispatching the double review):');
      lines.push('  1. git_gate(action: "stage", files: [...files to stage...])  <- START HERE');
      lines.push('  2. git_gate(action: "scan")');
      lines.push('  3. Read README.md fully and decide whether it needs updating for the staged changes');
      lines.push('  4. Agent(prompt: "Review all staged changes for quality, security, and correctness. Report HIGH/MEDIUM/LOW issues.", description: "review", subagent_type: "reviewer")');
      lines.push('  5. Agent(prompt: "Same as above — second opinion review of all staged changes.", description: "review2", subagent_type: "reviewer2")');
      lines.push('  6. git_gate(action: "submit", reviewerResult: "...", reviewer2Result: "...", highIssues: 0, readmeStatus: "updated"|"not_needed", readmeRationale: "...")');
      lines.push('Note: if files were already staged, this empty result may be a transient git read failure (timeout / wrong CWD / repo lock) — re-run scan and check the last stage output before re-staging.');
    }
    return ok(lines.join('\n'));
  }

  if (action === 'submit') {
    if (!args.reviewerResult || !args.reviewer2Result) {
      return ok("Error: Both reviewer results (reviewerResult, reviewer2Result) are required for 'submit' action.");
    }
    // README 检查校验(纵深防御;含空白检测 —— !x.trim() 拦截纯空格)
    if (!String(args.readmeStatus || '').trim() || !String(args.readmeRationale || '').trim()) {
      return ok('[README GATE BLOCKED] README check missing. You MUST read README.md fully and decide whether it needs updating before submitting.\n  - Read README.md (use read tool)\n  - If updates needed: edit README, then pass readmeStatus: "updated" + readmeRationale: "<which sections>"\n  - If no updates needed: pass readmeStatus: "not_needed" + readmeRationale: "<why not>"\n  - Re-run git_gate(action: "submit", ..., readmeStatus, readmeRationale)');
    }
    // 大小写归一化:"Updated"/"NOT_NEEDED" 等均归一后比较
    const normalizedStatus = String(args.readmeStatus).toLowerCase();
    if (normalizedStatus !== 'updated' && normalizedStatus !== 'not_needed') {
      return ok(`Error: readmeStatus must be 'updated' or 'not_needed' (got "${args.readmeStatus}").`);
    }
    const highIssues = args.highIssues != null ? args.highIssues : 0;
    // getStagedFiles 内部已在抛出的 execFileSync 上重试(长时间双审后的冷 git
    // 超时),此处单次调用已带热缓存恢复。真正的空暂存在第一把(不抛)就返回
    // [] 且不重试 —— 直接落入下方守卫。
    const staged = getStagedFiles(projectDir);
    // 空暂存守卫:无暂存文件时 submit 会制造无效批准(0 个文件哈希),
    // filesNeedReReview() 在 commit 时会拒绝 —— 代理以为 gate 已批准但 git
    // commit/push 会被拦。在此快速失败并指出正确的流程顺序。与 M4 修复一致:
    // 空暂存永远不是有效批准目标(也覆盖 getStagedFiles 失败 —— git 超时/
    // 错误 CWD —— 不得静默通过)。
    if (staged.length === 0) {
      return ok([
        '[STAGED EMPTY BLOCKED] No staged files to review.',
        '',
        'The review gate captures staged-file hashes at submit time. An empty',
        'staged set produces a 0-file approval that filesNeedReReview() will',
        'reject at commit time (gate appears approved but git commit/push fails).',
        'This also covers getStagedFiles failure (git timeout / wrong CWD).',
        '',
        'Correct flow (staged must be non-empty BEFORE submit):',
        '  1. git_gate(action: "stage", files: [...files to stage...])',
        '  2. git_gate(action: "scan")',
        '  3. Agent(... subagent_type: "reviewer" / "reviewer2")',
        '  4. git_gate(action: "submit", ...)  <- you are here, staged empty',
        '  5. git_gate(action: "commit", message: "...") then git_gate(action: "push")',
      ].join('\n'));
    }
    const fileHashes = new Map();
    for (const file of staged) {
      const filePath = file.replace(/\\/g, '/');

      try {
        const fullPath = path.join(projectDir, file);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
          fileHashes.set(filePath, hash);
        } else {
          // 已删除文件记空哈希,让 filesNeedReReview 能匹配它们
          fileHashes.set(filePath, '');
        }
      } catch { /* ignore */ }
    }
    // 哈希捷径:暂存文件自上次批准后未变 → 跳过派发校验直接复用。避免 gate 被
    // reset 但代码未变时强制重审。
    const reuse = canReuseLastApproval(projectDir);
    if (reuse.reuse) {
      renewGateFromLastApproval();
      // 用本次 submit 的参数刷新 README 状态,让审计轨迹反映当前决定
      // (renewGateFromLastApproval 的快照可能携带上一周期的过期值)。
      markReadmeChecked(
        normalizedStatus,
        String(args.readmeRationale),
        args.readmeSections, projectDir);
      return ok([
        '=== REVIEW GATE: REUSED (files unchanged) ===',
        `Reviewed ${fileHashes.size} files — hashes match last approval, skipping re-review.`,
        'Gate approved (valid while files unchanged).',
        `README: ${normalizedStatus === 'updated' ? '✅updated' : '⏭️not_needed'}${args.readmeSections && args.readmeSections.length > 0 ? ` (sections: ${args.readmeSections.join(', ')})` : ''}`,
        getGateStatusText(),
        '',
        'You may now run git commit/push.',
      ].join('\n'));
    }
    const verify = verifyReviewDispatches(projectDir);
    if (!verify.ok) {
      // M3b P3 硬校验(蓝图 D4):细化文案区分"账本缺失"与"条目不合规"。
      return ok(dispatchBlockedText(verify, projectDir));
    }
    markReviewStarted();
    markReviewComplete(
      verify.outputs.reviewer != null ? verify.outputs.reviewer : (args.reviewerResult != null ? args.reviewerResult : ''),
      verify.outputs.reviewer2 != null ? verify.outputs.reviewer2 : (args.reviewer2Result != null ? args.reviewer2Result : ''),
      highIssues, fileHashes, projectDir);
    markReadmeChecked(
      normalizedStatus,
      String(args.readmeRationale),
      args.readmeSections, projectDir);
    const gate = getReviewGate();
    let out;
    if (gate.state === 'approved') {
      out = [
        '=== REVIEW GATE: APPROVED ===',
        `Reviewed ${fileHashes.size} files. Gate: approved`,
        `README: ${normalizedStatus === 'updated' ? '✅updated' : '⏭️not_needed'}${args.readmeSections && args.readmeSections.length > 0 ? ` (sections: ${args.readmeSections.join(', ')})` : ''}`,
        getGateStatusText(),
        '',
        'You may now run git commit/push.',
      ].join('\n');
    } else {
      out = [
        '=== REVIEW GATE: REJECTED ===',
        `HIGH issues found: ${highIssues}`,
        getGateStatusText(),
        '',
        'Fix all HIGH issues, then re-run the double review and submit again.',
      ].join('\n');
    }
    // 降级模式(HARD_LEDGER=false):账本未过 → 放行但追加显式警示行(M3a 行为)。
    if (verify.degraded) out += '\n' + verify.warning;
    // M3b P3 转述标注:条目无合规 output(marker 回填失败/过短)→ markReviewComplete
    // 回落 args 自报值(last-approval.results 仍由上方账本值优先的实参链决定),输出明示。
    const relayed = ['reviewer', 'reviewer2'].filter(a => verify.outputs[a] == null);
    if (relayed.length > 0) {
      out += `\n⚠️ ${relayed.join(', ')} 结果为转述(账本条目无合规 output,采用 submit args 自报值)。`;
    }
    return ok(out);
  }

  if (action === 'status') {
    const gate = getReviewGate();
    const staged = getStagedFiles(projectDir);
    const needReReview = staged.length > 0 ? filesNeedReReview(projectDir) : false;
    const lines = [
      '=== REVIEW GATE STATUS ===',
      `State: ${gate.state}`,
      `Reviewed files: ${gate.reviewedFiles.size}`,
      `Staged files: ${staged.length}`,
      needReReview ? 'Re-review needed: YES (staged files changed since last review)' : 'Re-review needed: NO',
      getGateStatusText(),
      `README check: ${gate.readmeChecked ? (gate.readmeStatus === 'updated' ? '✅updated' : '⏭️not_needed') : '❌NOT CHECKED'}`,
    ];
    if (gate.state === 'approved') {
      lines.push('');
      lines.push('You may now run git commit/push (valid while files unchanged).');
    } else if (gate.state !== 'idle') {
      lines.push('');
      lines.push(`Reviewer result: ${gate.reviewerResult ? String(gate.reviewerResult).slice(0, 200) : '(not yet)'}`);
      lines.push(`Reviewer2 result: ${gate.reviewer2Result ? String(gate.reviewer2Result).slice(0, 200) : '(not yet)'}`);
    }
    return ok(lines.join('\n'));
  }

  if (action === 'reset') {
    resetReviewGate();
    return ok('Review gate reset to idle. Double review must be re-done before next commit/push.');
  }

  if (action === 'stage') {
    const files = args.files;
    if (!Array.isArray(files) || files.length === 0) {
      return ok('[stage BLOCKED] files must be a non-empty array.');
    }
    const invalid = validateStagePaths(projectDir, files);
    if (invalid.length) {
      return ok(`[stage BLOCKED] path traversal detected (outside project dir): ${invalid.join(', ')}`);
    }
    const missing = files.filter(f => !fs.existsSync(path.resolve(projectDir, f)));
    if (missing.length) {
      return ok(`[stage BLOCKED] file not found: ${missing.join(', ')}`);
    }
    try {
      gitStageFiles(projectDir, files);
    } catch (err) {
      const code = err?.status ?? err?.code ?? 'unknown';
      const stderr = String(err?.stderr ?? err?.message ?? '').slice(0, 500);
      return ok(`[stage error] exit ${code}: ${stderr}`);
    }
    return ok(`=== STAGED ${files.length} file(s) ===\n${files.join('\n')}\n\n${getGitStatusShort(projectDir)}`);
  }

  if (action === 'commit') {
    const message = args.message;
    if (typeof message !== 'string' || !message.trim()) {
      return ok('[commit BLOCKED] message is required.');
    }
    if (scanCommandForSecrets(message)) {
      return ok('[commit BLOCKED] secrets detected in commit message.');
    }
    // gate 检查(带复用路径,镜像原版 events.ts hook 逻辑)
    if (!isGateApproved() || filesNeedReReview(projectDir)) {
      const reuse = canReuseLastApproval(projectDir);
      if (reuse.reuse) {
        renewGateFromLastApproval();
        // renewGateFromLastApproval() 已恢复 _gate.readmeChecked=true 与持久化的
        // readme 状态,无需单独 markReadmeChecked()(它要求 commit 路径不携带的
        // status+rationale 参数)。
      } else {
        return ok("[commit BLOCKED] review gate not approved or files changed since review. Run git_gate(action:'scan') → double review → git_gate(action:'submit').");
      }
    }
    const scan = scanStagedFiles(projectDir);
    if (scan.blocked) {
      return ok(`[commit BLOCKED] sensitive files staged:\n${scan.summary}`);
    }
    if (!isReadmeChecked()) {
      return ok("[commit BLOCKED] README check not completed. Run git_gate(action:'submit') with readmeStatus first.");
    }
    let result;
    try {
      result = gitCommit(projectDir, message.trim());
    } catch (err) {
      const code = err?.status ?? err?.code ?? 'unknown';
      const stderr = String(err?.stderr ?? err?.message ?? '').slice(0, 500);
      return ok(`[commit error] exit ${code}: ${stderr}`);
    }
    // M3b P3 marker-mtime 警示行(蓝图 D7,仅提示不阻断):任何 Agent 派发都会 touch
    // quota-reset.marker;mtime 晚于批准时间 = 批准后又有子代理跑过,提示人工确认无
    // 未复审的代码变更。M3c 起 marker 查找与 findLedgerPath 同一回退链
    // stateLookupRoots([args.cwd, FLOWCRAFT_CWD]):任一根下存在 marker 且 mtime 新鲜
    // 即警示;两根均无(或均旧于批准时间)才无警示行。
    let markerNote = '';
    for (const r of stateLookupRoots(projectDir)) {
      try {
        const st = fs.statSync(path.join(r, '.zcode-flowcraft', 'quota-reset.marker'));
        if (_gate.approvedAt && st.mtimeMs > _gate.approvedAt) {
          markerNote = '\n⚠️ 批准后有新的子代理派发(quota-reset.marker mtime 晚于批准时间),请确认无未复审的代码变更。';
          break;
        }
      } catch { /* 该根下无 marker,继续下一根 */ }
    }
    return ok(`=== COMMITTED ===\n${result}${markerNote}`);
  }

  if (action === 'push') {
    const force = Boolean(args.force);
    if (!isGateApproved()) {
      return ok('[push BLOCKED] review gate not approved. Complete scan → double review → submit → commit first.');
    }
    const branch = getCurrentBranch(projectDir);
    if (!branch || branch === 'HEAD') {
      return ok('[push BLOCKED] detached HEAD — cannot determine branch. Branch switching requires a coder sub-agent or manual operation.');
    }
    const ff = isFastForward(projectDir, branch);
    if (!ff.ok && !force) {
      if (ff.reason === 'fetch-failed') {
        if (ff.detail.includes('remote ref')) {
          return ok(`[push BLOCKED] origin/${branch} does not exist on remote (first push?). Detail: ${ff.detail}`);
        }
        return ok(`[push BLOCKED] Could not fetch origin/${branch} — network/SSH error: ${ff.detail}. Check connection (e.g. SSH port blocked?) and retry, or re-run with force:true.`);
      }
      if (ff.reason === 'check-failed') {
        return ok(`[push BLOCKED] Could not verify fast-forward status for origin/${branch} — merge-base check failed (${ff.detail}). This is NOT a divergence: the check timed out or errored. Retry, or re-run with force:true if you are certain the history is safe.`);
      }
      return ok(`[push BLOCKED] origin/${branch} is ahead or diverged. Pull/merge first, or re-run with force:true (uses --force-with-lease).`);
    }
    let result;
    try {
      result = gitPush(projectDir, branch, force);
    } catch (err) {
      const code = err?.status ?? err?.code ?? 'unknown';
      const stderr = String(err?.stderr ?? err?.message ?? '').slice(0, 500);
      return ok(`[push error] exit ${code}: ${stderr}`);
    }
    // v0.7.4:result 已含合并后的 stdout+stderr(refs 变更摘要在 stderr);
    // "(up to date)" 兜底仅在两者皆空时出现。
    return ok(`=== PUSHED ${branch} → origin/${branch}${force ? ' (force-with-lease)' : ''} ===\n${result || '(up to date)'}`);
  }

  return ok(`Unknown action "${action}". Use: 'scan', 'submit', 'status', 'reset', 'stage', 'commit', or 'push'.`);
}

module.exports = {
  DESCRIPTION,
  INPUT_SCHEMA,
  execute: executeGitGate,
  // 以下导出供测试与 M3b 复用
  verifyReviewDispatches,
  scanStagedFiles,
  scanCommandForSecrets,
  getStagedFiles,
  validateStagePaths,
  isFastForward,
  canReuseLastApproval,
  restoreGateOnLoad,
  filesNeedReReview,
};
