#!/usr/bin/env node
// ledger-io.js —— 派发账本并发安全读写原语(v0.7.4)。
// 背景:main-agent-wall.js(派发写)与 quota-reset-marker.js(PostToolUse 回填)是
// gate-dispatch-ledger.json 的两个读改写点;并行双审时两个 wall 进程并发读改写
// 会丢条目 + 交错写坏文件(尾部双 ]]),导致 git-gate submit 校验全拒(Mac 实测)。
// 修法:目录锁(mkdir 原子抢锁)串行化读改写 + tmp/rename 原子落盘。
//
// 契约:withLedger(ledgerPath, mutateFn)
//   - mutateFn(entries) 收到当前条目数组(读失败/非数组按 [] 传入,调用方据此
//     自然保留各自语义:wall 空数组照常追加 = 损坏自愈重写;marker 空数组无命中
//     即不写 = 与原"损坏跳过"一致);
//   - 返回数组 → 原子写回(写 <ledgerPath>.<pid>.tmp 后 renameSync 覆盖;Node 的 rename
//     在 Windows 用 MoveFileEx REPLACE_EXISTING,双平台可用);返回其它值(undefined
//     等)→ 不写,直接释放锁(无命中/主动放弃场景);
//   - fail-open 铁律:抢锁超时/任何读写异常一律静默放弃,绝不向调用方抛出——
//     账本写不进不得影响派发/回填(wall 有 3 秒兜底定时器,锁等待上限 1000ms
//     留足余量)。
//
// P1 复用检索结论:全代码库(hooks/ + mcp/flowcraft-server/dist/)无现成锁/
// 原子写/账本工具,本文件为首个实现(main-agent-wall.js 与 quota-reset-marker.js
// 共用,禁止第三份副本)。
'use strict';
const fs = require('fs');

// 锁参数:25ms 重试间隔,总等待上限 1000ms(见上 fail-open 说明);陈旧锁阈值 5s
// (持锁窗口内的读改写远小于 5s,超时即崩溃残留)。
const LOCK_RETRY_MS = 25;
const LOCK_TOTAL_WAIT_MS = 1000;
const STALE_LOCK_MS = 5000;

// 同步睡眠(hook 进程单线程串行推进;Node 主线程允许 Atomics.wait)。
// 兜底忙等仅防御理论上的 Atomics 不可用,不影响语义。
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* busy wait */ }
  }
}

function acquireLock(lockDir) {
  const deadline = Date.now() + LOCK_TOTAL_WAIT_MS;
  while (Date.now() <= deadline) {
    try {
      fs.mkdirSync(lockDir); // 原子抢锁:目录已存在抛 EEXIST
      return true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false; // 权限等其它异常:静默放弃
      // 陈旧锁破解:锁目录 mtime 超 5s 视为崩溃残留,删除后立即重抢(不耗间隔)。
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch { /* stat/rmdir 失败 → 按正常占用走重试 */ }
      sleepMs(LOCK_RETRY_MS);
    }
  }
  return false; // 超时:静默放弃(fail-open)
}

function withLedger(ledgerPath, mutateFn) {
  if (typeof mutateFn !== 'function') return;
  const lockDir = ledgerPath + '.lock';
  // tmp 带 pid 后缀:陈旧锁破解后双持有者并发时各写各的 tmp,消除共写同一 tmp 的截断窗口。
  const tmpPath = ledgerPath + '.' + process.pid + '.tmp';
  if (!acquireLock(lockDir)) return;
  try {
    // 锁内读:容忍损坏(parse 失败/非数组按 [] 传给 mutateFn,语义由调用方定)。
    let entries = [];
    try {
      const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      if (Array.isArray(raw)) entries = raw;
    } catch { /* 损坏/缺失 → [] */ }
    const next = mutateFn(entries);
    if (!Array.isArray(next)) return; // 非数组返回值 = 调用方决定不写
    // 原子写:tmp 落盘后 rename 覆盖(rename 期间读者只会看到旧文件或新文件,
    // 绝无交错半文件)。
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2));
    fs.renameSync(tmpPath, ledgerPath);
  } catch {
    // fail-open:锁内任何读写异常静默放弃;顺手清掉可能残留的 tmp(尽力而为)。
    try { fs.unlinkSync(tmpPath); } catch { /* 已被 rename 走/本就不存在 */ }
  } finally {
    try { fs.rmdirSync(lockDir); } catch { /* 释放失败:留给 5s 陈旧锁破解 */ }
  }
}

module.exports = { withLedger };
