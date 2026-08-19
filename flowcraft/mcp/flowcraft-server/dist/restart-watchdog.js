#!/usr/bin/env node
// flowcraft 重启看门狗:由 restart_zcode 工具 detached 启动,脱离 ZCode 存活,负责 kill + 重启。
// 用法: node restart-watchdog.js <exePath> <delayMs> <--go|--dry-run>
// 日志: ~/.zcode/flowcraft-restart.log
// v0.3.2:全链路 windowsHide(消控制台窗口);启动改 cmd /c start(shell 方式,等价双击);启动检测 15s 轮询 + 一次重试。
// v0.3.3:taskkill 去掉 /T——看门狗是 ZCode 后代进程,/T 会连看门狗一起杀掉(2026-08-18 实测:日志停在 killApp 之前);
//        纯 /IM 已被证实足够杀净 ZCode 全部映像(第一轮实测)且放过后代看门狗。
// v0.3.4:实测 taskkill 后 tasklist 有 30-50s 幻影匹配(残留映像),不阻塞重启——短轮询(6×700ms)后直接强杀+启动;有效等待压缩为 min(argv,1500)ms。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');

const LOGF = path.join(os.homedir(), '.zcode', 'flowcraft-restart.log');
function log(s) { try { fs.appendFileSync(LOGF, `[${new Date().toISOString()}] ${s}\n`); } catch {} }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const HIDE = process.platform === 'win32' ? { windowsHide: true } : {};

function isRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', { encoding: 'utf8', ...HIDE });
      return /ZCode\.exe/i.test(out);
    }
    execSync('pgrep -f "[Zz][Cc]ode"'); // 括号技巧:避免匹配看门狗自身
    return true;
  } catch { return false; }
}

function killApp() {
  if (process.platform === 'win32') {
    try { execSync('taskkill /IM ZCode.exe /F', { ...HIDE }); log('taskkill /F 已执行'); } catch (e) { log('taskkill 失败/无进程: ' + e.message); }
  } else if (process.platform === 'darwin') {
    try { execSync("osascript -e 'tell application \"ZCode\" to quit'", { ...HIDE }); log('已发送优雅退出(osascript)'); } catch (e) { log('osascript 失败: ' + e.message); }
  } else {
    try { execSync('pkill -f "[Zz][Cc]ode"'); log('pkill 已执行'); } catch (e) { log('pkill 失败/无进程: ' + e.message); }
  }
}

function forceKill() {
  try {
    if (process.platform === 'win32') execSync('taskkill /IM ZCode.exe /F', { ...HIDE });
    else execSync('pkill -9 -f "[Zz][Cc]ode"');
  } catch {}
}

function launch(exe) {
  try {
    if (process.platform === 'win32') {
      // shell 方式启动(等价双击);windowsHide 避免闪控制台
      spawn('cmd', ['/c', 'start', '', exe], { detached: true, stdio: 'ignore', windowsHide: true });
      log(`launch: cmd /c start "" "${exe}"`);
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', exe], { detached: true, stdio: 'ignore' }).unref();
      log(`launch: open -a ${exe}`);
    } else {
      spawn(exe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(exe) }).unref();
      log(`launch: ${exe}`);
    }
  } catch (e) { log('launch 失败: ' + e.message); }
}

(async () => {
  const [exe, delayRaw, mode] = process.argv.slice(2);
  const delay = Math.min(1500, Math.max(0, parseInt(delayRaw, 10) || 0));
  const dry = mode !== '--go';
  log(`启动:exe=${exe} delay=${delay}ms mode=${dry ? 'dry-run' : 'go'} platform=${process.platform}`);
  if (!exe) { log('缺少 exe 参数,退出'); process.exit(1); }
  await sleep(delay);
  if (dry) { log('[dry-run] 计划:kill(/IM) → 短轮询(6×700ms) → 幻影则强杀 → cmd start 启动 → 15s 轮询确认(8s 未现重试一次)。本次不执行。'); process.exit(0); }
  killApp();
  let polls = 0;
  for (; polls < 6; polls++) { await sleep(700); if (!isRunning()) break; }
  if (isRunning()) { log(`${polls} 次轮询后仍有幻影匹配,强杀后照常重启(不阻塞)`); forceKill(); await sleep(1500); }
  else log(`旧进程已结束(轮询 ${polls} 次)`);
  launch(exe);
  let up = false;
  for (let i = 0; i < 15; i++) { await sleep(1000); if (isRunning()) { up = true; log(`启动后 ${(i + 1)}s 检测到 ZCode 进程 ✓`); break; } }
  if (!up) { log('8s+ 未检测到进程,重试启动一次'); launch(exe); for (let i = 0; i < 7; i++) { await sleep(1000); if (isRunning()) { up = true; log(`重试后 ${(i + 1)}s 检测到 ✓`); break; } } }
  if (!up) log('警告:最终未检测到 ZCode 进程,请手动启动并查本日志');
  process.exit(0);
})().catch(e => { log('异常: ' + (e && e.message)); process.exit(1); });
