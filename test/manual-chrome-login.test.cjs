'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loginArgs } = require('../src/manual-chrome-login.cjs');

test('manual Chrome login uses a dedicated profile without automation/debugging flags', () => {
  const args = loginArgs('C:\\ImageHarvest\\chrome-profile');
  assert.ok(args.some(x => x.startsWith('--user-data-dir=')));
  assert.ok(args.includes('--new-window'));
  assert.ok(args.includes('https://accounts.google.com/'));
  const joined = args.join(' ');
  assert.doesNotMatch(joined, /remote-debugging|enable-automation|headless|webdriver/i);
});
