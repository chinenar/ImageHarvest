'use strict';
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { findChrome } = require('./chrome-minimal.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function loginArgs(profileDir, url = 'https://accounts.google.com/') {
  return [
    `--user-data-dir=${profileDir}`,
    '--new-window',
    url
  ];
}

class ManualChromeLogin {
  constructor(profileDir) {
    this.profileDir = profileDir;
    this.child = null;
  }
  alive() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }
  async open(url) {
    if (this.alive()) return true;
    await fs.mkdir(this.profileDir, { recursive: true });
    const executable = await findChrome();
    const child = spawn(executable, loginArgs(this.profileDir, url), {
      stdio: 'ignore',
      windowsHide: false
    });
    this.child = child;
    child.once('exit', () => { if (this.child === child) this.child = null; });
    let launchError;
    child.once('error', error => { launchError = error; });
    await sleep(700);
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error('Chrome ปิดตัวลงก่อนเปิดหน้าล็อกอิน');
    return true;
  }
  async close() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.killed) { this.child = null; return true; }
    await new Promise(resolve => execFile('taskkill.exe', ['/PID', String(child.pid), '/T'], {
      windowsHide: true, timeout: 5000
    }, () => resolve()));
    for (let i = 0; i < 40 && child.exitCode === null && !child.killed; i++) await sleep(100);
    if (child.exitCode === null && !child.killed) {
      throw new Error('กรุณาปิดหน้าต่าง Chrome สำหรับล็อกอินก่อน แล้วกด “ใช้บัญชีนี้เลย” อีกครั้ง');
    }
    if (this.child === child) this.child = null;
    return true;
  }
}

module.exports = { ManualChromeLogin, loginArgs };
