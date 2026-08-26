#!/usr/bin/env node
// flowcraft-server v0.7.10(VERSION 常量,与 .zcode-plugin/plugin.json 的 version 同步改)
// —— 配额三件套 + quota_reset + git_read + git_gate + principles + job_*(零依赖 stdio MCP 服务器)
// 主代理专用读取通道:read 3 次/轮、grep 5 次/轮;glob 免配额;截断 ≤200 行/4000 字符;
// 敏感路径(.env/密钥/凭据类)直接拒;Agent 派发(touch quota-reset.marker)或 quota_reset 重置。
// M3a:git_gate 落地(实现在 dist/git-gate.js,本文件只做注册);状态目录切到 .zcode-flowcraft。
// M4a:后台作业 job_* 四工具已上线(实现在 dist/job-tools.js,本文件只做 spread 注册;
// tools/call 已 promise 感知 —— job_* 等异步工具经 then 分支回送,现有同步工具零行为变化)。
// M4.5:续接子代理会话 resume_authorize 上线(实现在 dist/resume-auth.js,只做 spread 注册;
// 落一次性标记,墙按标记放行单条 SendMessage)。
// 替换本文件时保持已有工具名不变。
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');
const { spawn: cpSpawn, execSync, execFileSync } = require('child_process');

// 版本单一来源:initialize 的 serverInfo 与本文件头注释都引用它;改版时与
// .zcode-plugin/plugin.json 的 version 保持同步(0.7.0 两侧同步升)。
const VERSION = '0.7.10';

const gitGate = require('./git-gate.js');
// M4a:后台作业四工具(TOOLS/IMPL 导出形状与 git-gate.js 同款注册模式)
const jobTools = require('./job-tools.js');
// M4.5:续接子代理会话一次性授权标记(TOOLS/IMPL 导出形状同款注册模式)
const resumeAuth = require('./resume-auth.js');

const CWD = process.env.FLOWCRAFT_CWD || process.cwd();
const LIMITS = { read: 3, grep: 5 };
const MAX_LINES = 200, MAX_CHARS = 4000, MAX_GLOB = 200, MAX_GREP_RESULTS = 50;
const MAX_GREP_LINE = 200, MAX_FILE_BYTES = 1024 * 1024, MAX_GREP_OUT = MAX_CHARS * 2;
const SENSITIVE = [/^\.env($|\.)/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i, /^id_ecdsa/i, /^credentials?($|\.)/i, /^\.htpasswd$/i, /^\.npmrc$/i, /^\.netrc$/i, /^secrets?($|\.)/i, /\.sqlite3?$/i, /\.db$/i];
// M3a:状态目录 .zcode-flowcraft 上线;旧 .flowcraft(原版 OpenCode 插件)仍跳过不读。
const SKIP_DIRS = new Set(['.git', 'node_modules', '.flowcraft', '.zcode-flowcraft', '__pycache__', '.venv', 'venv', 'dist', 'build', '.next', 'target']);

const counters = { read: 0, grep: 0 };
let markerSeen = markerMtime();
function markerMtime() { try { return fs.statSync(path.join(CWD, '.zcode-flowcraft', 'quota-reset.marker')).mtimeMs; } catch { return 0; } }
function resetIfMarked() { const m = markerMtime(); if (m > markerSeen) { markerSeen = m; counters.read = 0; counters.grep = 0; return true; } return false; }
function isSensitive(p) { const b = path.basename(p); return SENSITIVE.some(re => re.test(b)); }
function resolveUnderCwd(p) { return path.isAbsolute(p) ? path.normalize(p) : path.join(CWD, p); }
function ok(text) { return { content: [{ type: 'text', text }] }; }
function quotaMsg(kind) { return `[配额超限] 本轮 ${kind} 已用 ${LIMITS[kind]}/${LIMITS[kind]}。大规模读取/搜索请通过 Agent 工具派发子代理(explore 定位、analyst 判断);每次 Agent 派发后配额自动重置,或调用 mcp__plugin_flowcraft_flowcraft__quota_reset。`; }
function* walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(p); }
    else if (e.isFile()) yield p;
  }
}
function globToRegex(pat) {
  let re = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') { if (pat[i + 1] === '*') { re += '.*'; i++; if (pat[i + 1] === '/') i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}

function toolRead(args) {
  const p = resolveUnderCwd(String(args.path || ''));
  if (!args.path) return ok('[参数缺失] path 必填');
  if (isSensitive(p)) return ok(`[敏感路径拦截] ${p} 命中敏感文件规则(.env/密钥/凭据类),拒绝读取。`);
  resetIfMarked();
  if (counters.read >= LIMITS.read) return ok(quotaMsg('read'));
  let buf;
  try { buf = fs.readFileSync(p); } catch (e) { return ok(`[读取失败] ${p}: ${e.message}(本次不消耗配额)`); }
  if (buf.includes(0)) return ok(`[二进制文件] ${p} 不是文本文件,拒绝读取。`);
  const lines = buf.toString('utf8').split(/\r?\n/);
  const total = lines.length;
  const offset = Math.max(0, parseInt(args.offset ?? 0, 10) || 0);
  const limit = args.limit == null ? MAX_LINES : Math.max(1, parseInt(args.limit, 10) || 1);
  const picked = lines.slice(offset, offset + limit);
  counters.read++;
  let out = picked.join('\n');
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
  const head = `[read ${counters.read}/${LIMITS.read}] ${path.relative(CWD, p) || p}(全文 ${total} 行,本次第 ${offset + 1}-${offset + picked.length} 行)`;
  if (offset + picked.length < total) out += `\n…[未完:全文 ${total} 行;继续读用 offset=${offset + picked.length};需完整内容请派发子代理]`;
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS) + `…[截断:${MAX_CHARS} 字符上限]`;
  return ok(head + '\n' + out);
}

function toolGlob(args) {
  if (!args.pattern) return ok('[参数缺失] pattern 必填');
  const root = resolveUnderCwd(String(args.path || '.'));
  const re = globToRegex(String(args.pattern));
  const hits = [];
  for (const p of walk(root)) {
    const r = path.relative(root, p).split(path.sep).join('/');
    if (re.test(r) && !isSensitive(p)) { hits.push(r); if (hits.length >= MAX_GLOB) break; }
  }
  hits.sort();
  let out = hits.join('\n') || '(无匹配)';
  const trunc = hits.length >= MAX_GLOB || out.length > MAX_CHARS;
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
  if (trunc) out += `\n…[结果截断,上限 ${MAX_GLOB} 条]`;
  return ok(`[glob 免配额] ${hits.length} 个匹配\n` + out);
}

function toolGrep(args) {
  if (!args.pattern) return ok('[参数缺失] pattern 必填');
  let re; try { re = new RegExp(String(args.pattern), 'i'); } catch (e) { return ok(`[正则无效] ${e.message}`); }
  const root = resolveUnderCwd(String(args.path || '.'));
  resetIfMarked();
  if (counters.grep >= LIMITS.grep) return ok(quotaMsg('grep'));
  const max = Math.min(200, Math.max(1, parseInt(args.maxResults ?? MAX_GREP_RESULTS, 10) || MAX_GREP_RESULTS));
  const hits = []; let files = 0, truncated = false;
  for (const p of walk(root)) {
    if (isSensitive(p)) continue;
    files++;
    let buf; try { const st = fs.statSync(p); if (st.size > MAX_FILE_BYTES) continue; buf = fs.readFileSync(p); } catch { continue; }
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        if (hits.length >= max) { truncated = true; break; }
        hits.push(`${path.relative(CWD, p) || p}:${i + 1}: ${lines[i].slice(0, MAX_GREP_LINE)}`);
      }
    }
    if (truncated) break;
  }
  counters.grep++;
  let out = hits.join('\n') || '(无匹配)';
  if (out.length > MAX_GREP_OUT) { out = out.slice(0, MAX_GREP_OUT); truncated = true; }
  if (truncated) out += `\n…[结果截断,上限 ${max} 条;需全量请派发子代理]`;
  return ok(`[grep ${counters.grep}/${LIMITS.grep}] 扫描 ${files} 文件,命中 ${hits.length}${truncated ? '+' : ''} 条\n` + out);
}

function toolQuotaReset() {
  counters.read = 0; counters.grep = 0; markerSeen = markerMtime();
  return ok(`[quota_reset] 配额已重置。当前额度:read ${LIMITS.read}/轮、grep ${LIMITS.grep}/轮(glob 免配额)。每次 Agent 派发后亦自动重置。`);
}

// =============================================================================
// git_read —— 只读 git 查询工具(5 个 action:diff/log/branch/show/status)
// 忠实移植自 flowcraft 源码 src/tools/git-read.ts + src/pre-push-guard.ts(仓库只读参考)。
// 防线:action 枚举 → 每动作 flag 白名单(default-deny)→ 全局 flag 黑名单
// → 路径校验(穿越/敏感文件/rev:path 冒号语法)→ 密钥扫描 → execFileSync 数组参数。
// 注:源码的 runGitReadOnly 重试层(Bun/Windows ETIMEDOUT 专用)未移植——
// 本服务器跑在 Node 上,直接 execFileSync + 15s 超时;其余逻辑全部保留。
// =============================================================================
const GIT_VALID_ACTIONS = ['diff', 'log', 'branch', 'show', 'status'];
const GIT_GLOBAL_FLAG_DENY = new Set([
  '--exec', '--exec-dir', '--output', '--git-dir', '-C', '-c', '--work-tree',
  '--namespace', '--hard', '--force', '--delete', '-d', '-D',
  '--reedit-message', '--reuse-message',
]);
const GIT_SENSITIVE_PATH = /(?:^|[\/\\])\.ssh[\/\\]config$|(?:^|[\/\\])\.env(?:\.\w+)?$/i;
const GIT_SENSITIVE_FILE_PATTERNS = [
  /^\.env(\.\w+)?$/, /\.credentials$/, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/,
  /^id_ecdsa/, /^credentials\.json$/, /^serviceAccountKey\.json$/, /^.*\.p12$/,
  /^.*\.pfx$/, /^.*\.jks$/, /^.*\.keystore$/, /^\.npmrc$/, /^\.pypirc$/,
  /^\.netrc$/, /^\.dockercfg$/, /^secrets?\.[\w.]+$/, /^vault\.json$/,
  /^\.git-credentials$/, /^terraform\.tfstate(?:\.backup)?$/,
  /^firebase-adminsdk-.*\.json$/, /^credentials$/,
];
const GIT_PEM_KEY_RE = /-----BEGIN (?:PGP PRIVATE KEY BLOCK|(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----/;
const GIT_ACTION_FLAGS = {
  diff: {
    long: new Set(['--stat', '--name-only', '--name-status', '--cached', '--staged', '--numstat', '--shortstat', '--no-color', '--word-diff', '--relative', '--no-renames', '--check', '--quiet', '--exit-code', '--no-prefix', '--ignore-all-space', '--ignore-space-change', '--ignore-space-at-eol', '--diff-filter', '--patch', '--no-patch', '--full-index', '--binary', '--text', '--find-renames', '--find-copies', '--abbrev', '--no-abbrev', '--src-prefix', '--dst-prefix', '--merge-base', '--break-rewrites']),
    short: new Set(['-p', '-s', '-w', '-b', '-z', '-U', '--']),
    valueShort: new Set(['-U']),
  },
  log: {
    long: new Set(['--oneline', '--stat', '--name-only', '--name-status', '--numstat', '--shortstat', '--no-color', '--graph', '--no-merges', '--first-parent', '--reverse', '--all', '--branches', '--tags', '--remotes', '--abbrev-commit', '--no-abbrev-commit', '--relative-date', '--date', '--pretty', '--format', '--since', '--after', '--until', '--before', '--author', '--grep', '--invert-grep', '--regexp-ignore-case', '--extended-regexp', '--basic-regexp', '--fixed-strings', '--boundary', '--source', '--abbrev', '--no-abbrev', '--max-count', '--skip', '--decorate', '--no-decorate', '--merge', '--patch', '--no-patch', '--no-walk', '--diff-merges', '--show-signature']),
    short: new Set(['-p', '-g', '-z', '-n', '--']),
    valueShort: new Set(['-n']),
  },
  branch: {
    long: new Set(['--list', '--all', '--remotes', '--verbose', '--no-color', '--abbrev', '--no-abbrev', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--show-current', '--column', '--no-column']),
    short: new Set(['-l', '-a', '-r', '-v', '--']),
    valueShort: new Set(),
  },
  show: {
    long: new Set(['--stat', '--name-only', '--name-status', '--numstat', '--shortstat', '--no-color', '--abbrev-commit', '--no-abbrev-commit', '--pretty', '--format', '--no-patch', '--patch', '--no-renames', '--full-index', '--binary', '--source', '--abbrev', '--no-abbrev', '--decorate', '--no-decorate', '--diff-merges', '--date', '--relative-date', '--word-diff', '--show-signature']),
    short: new Set(['-s', '-p', '-w', '-b', '-z', '-U', '--']),
    valueShort: new Set(['-U']),
  },
  status: {
    long: new Set(['--short', '--long', '--porcelain', '--branch', '--no-color', '--untracked-files', '--ignored', '--column', '--no-column', '--ignored-submodules', '--find-renames', '--abbrev', '--no-abbrev', '--ahead-behind', '--no-ahead-behind', '--renormalize', '--no-renames']),
    short: new Set(['-s', '-b', '-z', '-u', '--']),
    valueShort: new Set(['-u']),
  },
};

function gitIsAllowedFlag(token, action) {
  if (token === '--') return true;
  let key;
  if (token.startsWith('--')) key = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  else if (token.startsWith('-') && token.length >= 2) key = token.length === 2 ? token : token.slice(0, 2);
  else return false;
  if (GIT_GLOBAL_FLAG_DENY.has(key)) return false;
  const allow = GIT_ACTION_FLAGS[action];
  if (!allow) return false;
  if (token.startsWith('--')) return allow.long.has(key);
  if (token.length === 2) return allow.short.has(key);
  return allow.valueShort.has(key);
}

function gitListAllowedFlags(action) {
  const allow = GIT_ACTION_FLAGS[action];
  if (!allow) return '(no allowlist configured for this action)';
  const parts = [];
  for (const f of allow.long) parts.push(f);
  for (const f of allow.short) parts.push(f);
  for (const f of allow.valueShort) parts.push(`${f}<n>`);
  return parts.join(' ');
}

function gitCheckTraversalAndSensitive(value, displayToken, projectDir) {
  const abs = path.resolve(projectDir, value);
  const rel = path.relative(projectDir, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return `[git_read BLOCKED] Path "${displayToken}" escapes project directory.`;
  }
  if (GIT_SENSITIVE_PATH.test(value)) {
    return `[git_read BLOCKED] "${displayToken}" matches sensitive path pattern.`;
  }
  const basename = value.split(/[/\\]/).pop() || value;
  for (const pat of GIT_SENSITIVE_FILE_PATTERNS) {
    if (pat.test(basename)) {
      return `[git_read BLOCKED] "${displayToken}" matches sensitive file pattern.`;
    }
  }
  return null;
}

function gitValidatePathToken(token, projectDir) {
  const directErr = gitCheckTraversalAndSensitive(token, token, projectDir);
  if (directErr) return directErr;
  const colonIdx = token.lastIndexOf(':');
  if (colonIdx !== -1 && colonIdx < token.length - 1) {
    const suffix = token.slice(colonIdx + 1);
    const suffixErr = gitCheckTraversalAndSensitive(suffix, token, projectDir);
    if (suffixErr) return suffixErr;
  }
  return null;
}

// 引号感知分词(三态有限状态机):引号内空格保留、引号字符剥离、未闭合引号报错。
function gitTokenizeArgs(raw) {
  const tokens = [];
  let current = '';
  let state = 'DEFAULT';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (state === 'DEFAULT') {
      if (ch === '"') state = 'IN_DQ';
      else if (ch === "'") state = 'IN_SQ';
      else if (/\s/.test(ch)) { if (current.length > 0) { tokens.push(current); current = ''; } }
      else current += ch;
    } else if (state === 'IN_DQ') {
      if (ch === '"') state = 'DEFAULT';
      else current += ch;
    } else {
      if (ch === "'") state = 'DEFAULT';
      else current += ch;
    }
  }
  if (state !== 'DEFAULT') {
    return { ok: false, error: '[git_read BLOCKED] Unterminated quote in args' };
  }
  if (current.length > 0) tokens.push(current);
  return { ok: true, tokens };
}

function gitScanCommandForSecrets(command) {
  const kvPattern = /(?:password|secret|token|api[_-]?key|private[_-]?key|credential)\s*[=:]\s*["'][^"']{8,}["']/i;
  const patterns = [
    kvPattern,
    /AKIA[0-9A-Z]{16}/,
    /gh[pousr]_[A-Za-z0-9]{36}/,
    GIT_PEM_KEY_RE,
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

const GIT_OUTPUT_CAP = 4000;

function toolGitRead(args) {
  const action = String(args.action ?? '').trim();
  if (!GIT_VALID_ACTIONS.includes(action)) {
    return ok(`[git_read BLOCKED] Invalid action "${action}". Valid actions: ${GIT_VALID_ACTIONS.join(', ')}.`);
  }
  const rawArgs = String(args.args ?? '').trim();
  if (gitScanCommandForSecrets(`${action} ${rawArgs}`)) {
    return ok('[git_read BLOCKED] Args contain secrets (password/token/key).');
  }
  const tokenizeResult = gitTokenizeArgs(rawArgs);
  if (!tokenizeResult.ok) return ok(tokenizeResult.error);
  const tokens = tokenizeResult.tokens;
  const cwd = args.cwd ? String(args.cwd) : CWD;
  const finalArgs = [action];
  let seenSeparator = false;
  for (const tok of tokens) {
    if (tok === '--') { seenSeparator = true; finalArgs.push(tok); continue; }
    if (!seenSeparator && tok.startsWith('-')) {
      let flagTok = tok;
      if (action === 'log' && /^-\d+$/.test(tok)) flagTok = `--max-count=${tok.slice(1)}`;
      if (!gitIsAllowedFlag(flagTok, action)) {
        return ok(`[git_read BLOCKED] Flag "${tok}" not allowed for action "${action}". Allowed flags: ${gitListAllowedFlags(action)}.`);
      }
      finalArgs.push(flagTok);
    } else {
      if (action === 'branch') {
        return ok("[git_read BLOCKED] git branch <name> creates a branch (write operation). Use 'git branch' or 'git branch --list' to enumerate branches.");
      }
      const pathErr = gitValidatePathToken(tok, cwd);
      if (pathErr) return ok(pathErr);
      finalArgs.push(tok);
    }
  }
  // execFileSync 数组参数——严禁字符串拼接(RCE 纪律);--no-pager 防分页器挂起;
  // GIT_OPTIONAL_LOCKS=0 保证只读动作连索引刷新写都不做。
  let out;
  try {
    out = execFileSync('git', ['--no-pager', ...finalArgs], {
      cwd, timeout: 15000, maxBuffer: 1 << 20,
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', windowsHide: true, killSignal: 'SIGKILL',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch (e) {
    const code = e && e.status !== undefined ? e.status : (e && e.code) || 'unknown';
    if (e && (e.code === 'ETIMEDOUT' || (e.killed && e.status === undefined && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'))) {
      return ok('[git_read error] git command timed out.');
    }
    const stderr = String((e && (e.stderr || e.message)) || '').slice(0, 500);
    return ok(`[git_read error] exit ${code}: ${stderr}`);
  }
  out = String(out);
  if (out.length > GIT_OUTPUT_CAP) out = out.slice(0, GIT_OUTPUT_CAP) + '\n... (output truncated at 4000 chars — use paths/--stat to narrow, or delegate via task)';
  return ok(`[git_read] ${finalArgs.join(' ')}\n` + (out || '(no output)'));
}

function findZcodeExe() {
  if (process.env.ZCODE_RESTART_EXE && fs.existsSync(process.env.ZCODE_RESTART_EXE)) return process.env.ZCODE_RESTART_EXE;
  const cands = [];
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'ZCode.exe'));
    if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'ZCode', 'ZCode.exe'));
    if (process.env['ProgramFiles(x86)']) cands.push(path.join(process.env['ProgramFiles(x86)'], 'ZCode', 'ZCode.exe'));
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/ZCode.app', path.join(os.homedir(), 'Applications', 'ZCode.app'));
  } else {
    cands.push('/opt/ZCode/zcode', '/opt/zcode/zcode', '/usr/bin/zcode', '/usr/local/bin/zcode', path.join(os.homedir(), '.local', 'bin', 'zcode'));
  }
  for (const c of cands) if (fs.existsSync(c)) return c;
  if (process.platform !== 'win32') {
    try { const w = execSync('which zcode 2>/dev/null || which ZCode 2>/dev/null', { encoding: 'utf8' }).trim(); if (w) return w; } catch {}
  }
  return null;
}

function toolRestartZcode(args) {
  if (args.confirm !== 'restart') return ok('[拒绝] restart_zcode 需要显式确认:传 confirm="restart",且仅在用户明确要求重启 ZCode 时调用。');
  const exe = findZcodeExe();
  if (!exe) return ok('[失败] 未找到 ZCode 可执行文件。请在 .mcp.json 的 env 里设 ZCODE_RESTART_EXE 指向它,重开会话再试。');
  const dry = args.dryRun === true;
  const watchdog = path.join(__dirname, 'restart-watchdog.js');
  const child = cpSpawn(process.execPath, [watchdog, exe, '1500', dry ? '--dry-run' : '--go'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  const LOGF = path.join(os.homedir(), '.zcode', 'flowcraft-restart.log');
  return ok(`${dry ? '[dry-run 演练]' : '[重启指令已下达]'} 目标:${exe}
看门狗(PID ${child.pid})3 秒后${dry ? '只记录计划、不执行' : '结束 ZCode 并重新启动'}。日志:${LOGF}
${dry ? '' : '本对话将中断;若重启后未自动恢复本对话,请从会话列表重新打开。'}`);
}

// =============================================================================
// principles —— 设计原则机制(declare/list/remove 三件套)
// 忠实移植自 flowcraft 源码 src/principles.ts + src/tools/query.ts(仓库只读参考)。
// 两层存储:全局层 ~/.zcode/flowcraft/principles.json(layer=global 读写;不迁移旧 ~/.flowcraft 文件);
// 项目层 <CWD>/.zcode-flowcraft/principles.json(默认写入;M3a 起状态目录为 .zcode-flowcraft,不迁移旧 .flowcraft 文件)。
// 常量:TEXT_MAX=800;每 scope 组 3 条(仅计当前层;reviewer/reviewer2 聚合计数,all 独立);
// 全局层最多 8 条 active;项目文件上限 20 条(超出丢最旧);注入块上限 20 条。
// scope 白名单:all + planner/coder/reviewer/reviewer2/writer/analyst/explore。
// v0.4.4 注入块格式与 hooks/principles-gate.js 逐字节一致(格式变更须双侧同步,以闸门为准)。
// v0.7.3 插件随附层 <插件根>/principles/plugin-principles.json(随插件分发的只读底线原则,换机器不丢):
// 仅 list_principles 展示与注入块合并(同文按 text.trim() 去重,全局/项目层优先,插件层副本丢弃);
// declare_principle/remove_principle 不触碰本层(只读)。
// =============================================================================
const PRINCIPLE_TEXT_MAX = 800;
const PRINCIPLES_PER_SCOPE_MAX = 3;
const PRINCIPLES_GLOBAL_MAX = 8;        // 源码 GLOBAL_PRESET_MAX
const PRINCIPLES_MAX_ENTRIES = 20;
const PRINCIPLES_INJECT_MAX = 20;       // 源码 formatPrinciplesBlock maxCount 默认值
const PRINCIPLE_VALID_SCOPES = ['all', 'planner', 'coder', 'reviewer', 'reviewer2', 'writer', 'analyst', 'explore'];
const PRINCIPLE_REVIEWER_SCOPES = new Set(['reviewer', 'reviewer2']); // 共享一个 3 条配额
let principleIdSeq = 0;

function principlesProjectPath() { return path.join(CWD, '.zcode-flowcraft', 'principles.json'); }
function principlesGlobalPath() { return path.join(os.homedir(), '.zcode', 'flowcraft', 'principles.json'); }
// v0.7.3 插件随附层:__dirname=mcp/flowcraft-server/dist,向上三级到插件根 flowcraft/,再进 principles/。
// 按 __dirname 相对定位,不依赖环境变量;文件随插件分发,只读。
function principlesPluginPath() { return path.resolve(__dirname, '..', '..', '..', 'principles', 'plugin-principles.json'); }
function principlesLoad(file, cap) {
  try {
    if (!fs.existsSync(file)) return [];
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return cap ? arr.filter(p => p.active).slice(-cap) : arr;
  } catch { return []; }
}
function loadProjectPrinciples() { return principlesLoad(principlesProjectPath(), 0); }
function loadGlobalPrinciples() { return principlesLoad(principlesGlobalPath(), PRINCIPLES_GLOBAL_MAX); }
// 插件层 cap=0(不去 active 过滤、不截断——条目无 active 字段,缺失视为 active,与闸门 e.active===false 语义一致);
// principlesLoad 自带 existsSync/JSON.parse try/catch,文件缺失或损坏 = 无插件层。
function loadPluginPrinciples() { return principlesLoad(principlesPluginPath(), 0); }
function saveProjectPrinciples(list) {
  const file = principlesProjectPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // v0.7.6 P5:状态目录自忽略 —— 目标仓没配 gitignore 时 `git add .` 不会把
  // 项目层原则误提交。内容一行 `*`;已存在不覆写;与仓库层自有 ignore 共存无害。
  // (全局层 ~/.zcode/flowcraft 在家目录、不在任何仓内,无需处理。)
  try {
    const gi = path.join(path.dirname(file), '.gitignore');
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n', 'utf-8');
  } catch { /* 尽力而为,不影响原则写入 */ }
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf-8');
}
function saveGlobalPrinciples(list) {
  const file = principlesGlobalPath();
  fs.mkdirSync(path.dirname(file), { recursive: true }); // 递归创建 ~/.zcode/flowcraft
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
}
// 配额按层独立计数(不混层):layer 参数决定在哪一层统计。
function principleCountByScope(scope, layer) {
  const targets = PRINCIPLE_REVIEWER_SCOPES.has(scope) ? PRINCIPLE_REVIEWER_SCOPES : new Set([scope]);
  const list = layer === 'global' ? loadGlobalPrinciples() : loadProjectPrinciples();
  return list.filter(p => p.active && p.scope !== undefined && targets.has(p.scope)).length;
}
// 三红线:无 scope 永不注入;scope=all 恒注入;scope=reviewer 聚合 reviewer/reviewer2。
function principleScopeMatches(p, agentName) {
  if (p.scope === undefined) return false;
  if (p.scope === 'all') return true;
  if (agentName === undefined) return false;
  if (p.scope === 'reviewer') return agentName === 'reviewer' || agentName === 'reviewer2';
  return p.scope === agentName;
}

function toolDeclarePrinciple(args) {
  const text = String(args.text ?? '');
  const scope = args.scope === undefined ? undefined : String(args.scope);
  const layer = args.layer === undefined ? 'project' : String(args.layer);
  if (layer !== 'project' && layer !== 'global') {
    return ok(`[拒绝] layer "${layer}" 无效,可选 "project"(默认)或 "global"。`);
  }
  if (!scope) return ok(`[拒绝] scope 必填。有效值:${PRINCIPLE_VALID_SCOPES.join(' | ')}。`);
  if (!PRINCIPLE_VALID_SCOPES.includes(scope)) {
    return ok(`[拒绝] scope "${scope}" 不在白名单。有效值:${PRINCIPLE_VALID_SCOPES.join(' | ')}。`);
  }
  if (text.length > PRINCIPLE_TEXT_MAX) {
    return ok(`[拒绝] 原则文本过长(${text.length} > ${PRINCIPLE_TEXT_MAX} 字符),请精简后重试。`);
  }
  const current = principleCountByScope(scope, layer);
  if (current >= PRINCIPLES_PER_SCOPE_MAX) {
    return ok(`[拒绝] 当前层(scope 组,layer=${layer})scope "${scope}" 已有 ${current} 条(上限 ${PRINCIPLES_PER_SCOPE_MAX},仅计 ${layer === 'global' ? 'GLOBAL' : 'PROJECT'}/当前层,不混层)。请先用 remove_principle(layer=${layer}) 清理旧条目。`);
  }
  let list = layer === 'global' ? loadGlobalPrinciples() : loadProjectPrinciples();
  const entry = {
    id: `p${Date.now()}-${++principleIdSeq}`,
    text, active: true, declaredBy: 'orchestrator',
    createdAt: new Date().toISOString(), scope,
  };
  list.push(entry);
  if (list.length > PRINCIPLES_MAX_ENTRIES) list = list.slice(list.length - PRINCIPLES_MAX_ENTRIES);
  if (layer === 'global') saveGlobalPrinciples(list); else saveProjectPrinciples(list);
  return ok(`[已登记] [${entry.id}] [layer:${layer}] [scope:${entry.scope}] ${entry.text}`);
}

function toolRemovePrinciple(args) {
  const id = String(args.id ?? '');
  const layer = args.layer === undefined ? 'project' : String(args.layer);
  if (layer !== 'project' && layer !== 'global') {
    return ok(`[拒绝] layer "${layer}" 无效,可选 "project"(默认)或 "global"。`);
  }
  const list = layer === 'global' ? loadGlobalPrinciples() : loadProjectPrinciples();
  const filtered = list.filter(p => p.id !== id);
  if (filtered.length === list.length) {
    return ok(`[拒绝] ${layer === 'global' ? '全局层' : '项目层'}未找到 id "${id}"(remove 默认只动项目层,删全局条目需显式传 layer:"global")。用 list_principles 查看有效 id。`);
  }
  if (layer === 'global') saveGlobalPrinciples(filtered); else saveProjectPrinciples(filtered);
  return ok(`[已移除] [layer:${layer}] ${id}`);
}

function toolListPrinciples(args) {
  const globalP = loadGlobalPrinciples();
  const projectP = loadProjectPrinciples().filter(p => p.active);
  // v0.7.3 插件随附层:无 active 字段视为 active(仅显式 false 跳过,与闸门语义一致)。
  const pluginP = loadPluginPrinciples().filter(p => p.active !== false);
  const trim = (t) => String(t || '').trim();
  // 展示去重(按 text.trim() 同文,首个出现者胜):全局/项目层优先,插件层副本丢弃不显示。
  const seenDisplay = new Set(globalP.map(p => trim(p.text)));
  const projectKept = projectP.filter(p => !seenDisplay.has(trim(p.text)));
  const pluginKept = [];
  for (const p of pluginP) {
    const k = trim(p.text);
    if (!k || seenDisplay.has(k)) continue; // 同文:全局/项目优先,插件副本丢弃
    seenDisplay.add(k); // 插件层内部同文同样首条胜
    pluginKept.push(p);
  }
  const all = [...globalP, ...projectKept, ...pluginKept];
  const agent = args.agent === undefined ? undefined : String(args.agent);
  let out = '';
  if (all.length === 0) out = '(无 active 原则)';
  else {
    const globalTexts = new Set(globalP.map(p => trim(p.text)));
    const projectTexts = new Set(projectKept.map(p => trim(p.text)));
    out = all.map((p, i) => {
      const t = trim(p.text);
      const source = globalTexts.has(t) ? 'GLOBAL' : projectTexts.has(t) ? 'PROJECT' : 'PLUGIN';
      const scopeTag = p.scope ? `[scope:${p.scope}]` : '[scope:unset-legacy]';
      const meta = source === 'PLUGIN' ? 'plugin-shipped, read-only' : `by ${p.declaredBy}, ${p.createdAt}`;
      return `[${i + 1}] [${source}] ${scopeTag} ${p.text} (${meta})`;
    }).join('\n');
  }
  if (agent === undefined || agent === '') return ok(out);
  // 注入块:按 scope 过滤(all + agent 本名 + reviewer 聚合双收),插件层同样参与过滤。
  // v0.4.4 与 hooks/principles-gate.js 逐字节对齐(格式变更须双侧同步):
  // 全局在前+项目居中+插件随附殿后按文件顺序单趟遍历、按 text.trim() 去重(首个出现者胜)、
  // 上限 20 条即止、文本原样不截断。
  const pickedTexts = [];
  const seen2 = new Set();
  for (const p of [...globalP, ...projectP, ...pluginP]) {
    if (!principleScopeMatches(p, agent)) continue;
    const k = trim(p.text);
    if (!k) continue; // 空文本守卫,与 principles-gate.js:48 的 !key 语义对齐
    if (seen2.has(k)) continue;
    seen2.add(k);
    pickedTexts.push(p.text);
    if (pickedTexts.length >= PRINCIPLES_INJECT_MAX) break;
  }
  const block = pickedTexts.length === 0
    ? '(该 agent 无匹配原则)'
    : '## 设计原则（必须遵守）\n' + pickedTexts.map((t, i) => `  [P${i + 1}] ${t}`).join('\n');
  return ok(`${out}\n\n----- 注入块(agent=${agent})-----\n${block}\n----- 派发时粘贴到 task prompt 末尾 -----`);
}

const TOOLS = [
  { name: 'read', description: '主代理配额读取:读单个文本文件,截断上限(200 行/4000 字符),敏感路径(.env/密钥类)拒绝,每轮 3 次(Agent 派发后自动重置)。子代理请用内置 Read,不要调用本工具。', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '文件路径(相对项目根或绝对)' }, offset: { type: 'number', description: '起始行号(0 起,可省)' }, limit: { type: 'number', description: '读取行数(默认 200)' } }, required: ['path'] } },
  { name: 'glob', description: '主代理免配额文件定位:glob 模式(* ** ?)列文件,自动跳过 .git/node_modules/dist 等,上限 200 条,敏感文件名过滤。', inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: 'glob 模式,如 **/*.md' }, path: { type: 'string', description: '搜索根目录(默认项目根)' } }, required: ['pattern'] } },
  { name: 'grep', description: '主代理配额搜索:正则搜索文本文件内容,输出 file:line: text,上限 50 条,每轮 5 次(Agent 派发后自动重置)。', inputSchema: { type: 'object', properties: { pattern: { type: 'string', description: '正则表达式(JS 语法,不区分大小写)' }, path: { type: 'string', description: '搜索根目录(默认项目根)' }, maxResults: { type: 'number', description: '最大命中条数(默认 50,上限 200)' } }, required: ['pattern'] } },
  { name: 'quota_reset', description: '手动重置 read/grep 配额(兜底;每次 Agent 派发后会自动重置)。', inputSchema: { type: 'object', properties: {} } },
  { name: 'restart_zcode', description: '重启 ZCode 桌面端(让新插件/配置生效)。仅在用户明确要求重启时调用,必须传 confirm="restart";可先传 dryRun:true 演练(只写日志不执行)。', inputSchema: { type: 'object', properties: { confirm: { type: 'string', description: '固定传 "restart"' }, dryRun: { type: 'boolean', description: 'true=演练模式,只写日志不执行' } }, required: ['confirm'] } },
  { name: 'git_read', description: '只读 git 查询工具。5 个 action:diff(看改动)、log(提交历史)、branch(列分支)、show(看具体提交)、status(改动/暂存/未跟踪文件)。拦截所有写操作(add/commit/push/reset/checkout 等)与危险 flag;log 支持 -N 简写(等价 --max-count=N);含空格的值用引号包裹,如 --format="%h %s"。', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['diff', 'log', 'branch', 'show', 'status'], description: 'diff / log / branch / show / status 之一' }, args: { type: 'string', description: '附加参数(flag + 路径/引用),如 "HEAD" 或 \'--format="%h %s" -5\'' }, cwd: { type: 'string', description: 'git 仓库目录(默认服务器 CWD)' } }, required: ['action'] } },
  { name: 'declare_principle', description: '主代理专用。登记一条设计原则,后续所有子代理任务必须遵守(用户确认核心决策后使用)。scope 必填;每个 scope 组上限 3 条(仅计当前层,不混层;reviewer/reviewer2 共享配额);文本上限 800 字符;项目文件上限 20 条(超出丢最旧)。layer 默认 "project" 写入项目层 .zcode-flowcraft/principles.json;layer="global"(需显式指定)写入全局层 ~/.zcode/flowcraft/principles.json,全局最多 8 条 active。', inputSchema: { type: 'object', properties: { text: { type: 'string', description: '原则文本(≤800 字符)' }, scope: { type: 'string', enum: ['all', 'planner', 'coder', 'reviewer', 'reviewer2', 'writer', 'analyst', 'explore'], description: '"all"=所有代理;"reviewer"=聚合 reviewer/reviewer2(声明一次,两者都收);其余为单代理名' }, layer: { type: 'string', enum: ['project', 'global'], description: '存储层:默认 "project"(项目层 .zcode-flowcraft/principles.json);写全局层需显式传 "global"(~/.zcode/flowcraft/principles.json,配额按全局层独立计数,最多 8 条 active)' } }, required: ['text', 'scope'] } },
  { name: 'list_principles', description: '主代理专用。列出全部设计原则(全局 [GLOBAL] 来自 ~/.zcode/flowcraft/principles.json + 项目 [PROJECT] + 插件随附 [PLUGIN](只读,同文时被全局/项目层覆盖),含 scope 标签)。派发子代理前传 agent 参数,额外返回按 scope 过滤(all + agent 本名 + reviewer 聚合)拼好的注入块,直接粘贴到 task prompt 末尾。', inputSchema: { type: 'object', properties: { agent: { type: 'string', description: '目标代理名(planner/coder/reviewer/reviewer2/writer/analyst/explore);传入则额外返回注入块' } } } },
  { name: 'remove_principle', description: '主代理专用。按 id 移除设计原则(立即生效,无二次确认;误删可重新 declare)。layer 默认 "project" 只动项目层;删全局条目需显式传 layer:"global"。id 从 list_principles 输出获取。', inputSchema: { type: 'object', properties: { id: { type: 'string', description: '原则 id,如 "p1700000000000-1"' }, layer: { type: 'string', enum: ['project', 'global'], description: '存储层:默认 "project";删全局层条目需显式传 "global"' } }, required: ['id'] } },
  // git_gate(M3a)——实现与 description/schema 全在 dist/git-gate.js(参照 restart-watchdog.js
  // 多文件先例),此处只做注册;授权原则权威措辞对齐原版 events.ts L122-128/L153。
  { name: 'git_gate', description: gitGate.DESCRIPTION, inputSchema: gitGate.INPUT_SCHEMA },
  // job_*(M4a)——后台作业四工具,description/schema/实现全在 dist/job-tools.js,
  // 此处只做 spread 注册(同 git-gate 模式)。
  ...jobTools.TOOLS,
  // resume_authorize(M4.5)——续接子代理会话一次性授权,实现全在
  // dist/resume-auth.js,此处只做 spread 注册(同上模式)。
  ...resumeAuth.TOOLS
];
const IMPL = { read: toolRead, glob: toolGlob, grep: toolGrep, quota_reset: toolQuotaReset, restart_zcode: toolRestartZcode, git_read: toolGitRead, declare_principle: toolDeclarePrinciple, list_principles: toolListPrinciples, remove_principle: toolRemovePrinciple, git_gate: gitGate.execute, ...jobTools.IMPL, ...resumeAuth.IMPL };

const rl = readline.createInterface({ input: process.stdin, terminal: false });
function send(o) { process.stdout.write(JSON.stringify(o) + '\n'); }
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined || msg.id === null) return;
  const method = msg.method || '';
  if (method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'flowcraft', version: VERSION } } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const fn = IMPL[name];
    if (!fn) return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } });
    try {
      const r = fn((msg.params && msg.params.arguments) || {});
      // M4a promise 感知:job_* 等异步工具返回纯文本字符串的 Promise —— 包装为
      // MCP result 后异步回送,拒绝映射 isError(文案与下方同步 catch 一致)。
      // 现有 10 个同步工具返回值非 thenable,仍走原同步 send 路径,零行为变化。
      if (r && typeof r.then === 'function') {
        r.then(res => send({ jsonrpc: '2.0', id: msg.id, result: typeof res === 'string' ? { content: [{ type: 'text', text: res }] } : res }))
          .catch(e => send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `[工具错误] ${e && e.message ? e.message : String(e)}` }], isError: true } }));
        return;
      }
      // MCP CallToolResult 形状强制包装:同步 IMPL 返回裸字符串时必须包成
      // {content:[{type:'text',text}]} 再发,否则客户端无法 resolve 挂到超时
      // (2026-08-19 resume_authorize 挂死根因;任何 IMPL 裸字符串在此自动兜住)。
      return send({ jsonrpc: '2.0', id: msg.id, result: typeof r === 'string' ? { content: [{ type: 'text', text: r }] } : r });
    }
    catch (e) { return send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `[工具错误] ${e.message}` }], isError: true } }); }
  }
  if (method === 'resources/list') return send({ jsonrpc: '2.0', id: msg.id, result: { resources: [] } });
  if (method === 'prompts/list') return send({ jsonrpc: '2.0', id: msg.id, result: { prompts: [] } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id: msg.id, result: {} });
  return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${method}` } });
});
