'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}
async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}
function emailFrom(value) {
  const text = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : '';
}
function profileEmail(localState, preferences) {
  const info = localState?.profile?.info_cache?.Default || {};
  const accounts = Array.isArray(preferences?.account_info) ? preferences.account_info : [];
  return accounts.map(x => emailFrom(x?.email)).find(Boolean)
    || emailFrom(info.user_name)
    || emailFrom(preferences?.profile?.user_name)
    || '';
}
async function chromeProfileInfo(profileDir) {
  const localState = await readJson(path.join(profileDir, 'Local State'));
  const preferences = await readJson(path.join(profileDir, 'Default', 'Preferences'));
  const info = localState?.profile?.info_cache?.Default || {};
  const cookieFile = path.join(profileDir, 'Default', 'Network', 'Cookies');
  const legacyCookieFile = path.join(profileDir, 'Default', 'Cookies');
  const hasCookies = await exists(cookieFile) || await exists(legacyCookieFile);
  const email = profileEmail(localState, preferences);
  const hasAccount = Boolean(email || info.gaia_id || preferences?.account_info?.length);
  const ready = Boolean(localState || preferences || hasCookies);
  return {
    ready, hasAccount, email,
    profileName: String(info.name || preferences?.profile?.name || 'ImageHarvest Chrome').trim(),
    hasCookies
  };
}
module.exports = { chromeProfileInfo };
