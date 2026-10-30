'use strict';
const { Menu, safeStorage } = require('electron');
const { randomUUID } = require('node:crypto');

function createCredentials({ storage: storageService, tabs: tabsService, host: hostService }) {
  function encryptHarvestSecret(value) {
    if (!safeStorage.isEncryptionAvailable())
      throw new Error('Windows ยังไม่พร้อมเข้ารหัส Password Vault');
    return safeStorage.encryptString(String(value || '')).toString('base64');
  }

  function decryptHarvestSecret(value) {
    try {
      if (!value || !safeStorage.isEncryptionAvailable()) return '';
      return safeStorage.decryptString(Buffer.from(String(value), 'base64'));
    } catch {
      return '';
    }
  }

  async function harvestTsPasswordData() {
    const data = await storageService.readHarvestJson(storageService.harvestTsPasswordFile, {
      version: 1,
      items: [],
    });
    return { version: 1, items: Array.isArray(data.items) ? data.items : [] };
  }

  async function harvestTsPasswordList() {
    const data = await harvestTsPasswordData();
    return data.items
      .map((x) => ({
        id: x.id,
        origin: x.origin,
        url: x.url,
        username: decryptHarvestSecret(x.username),
        updatedAt: x.updatedAt || x.createdAt || 0,
      }))
      .filter((x) => x.id && x.origin);
  }

  async function harvestPasswordAccountsForOrigin(origin) {
    const data = await harvestTsPasswordData();
    return data.items
      .filter((x) => x.origin === origin)
      .map((x) => ({
        id: x.id,
        origin: x.origin,
        url: x.url,
        username: decryptHarvestSecret(x.username),
        updatedAt: x.updatedAt || x.createdAt || 0,
      }))
      .filter((x) => x.id);
  }

  async function emitHarvestPasswordHint(tab, originOverride = '') {
    if (!tab || tab.view.webContents.isDestroyed()) return null;
    let origin = originOverride;
    if (!origin) {
      try {
        origin = new URL(tab.view.webContents.getURL() || tab.url || '').origin;
      } catch {}
    }
    if (!/^https?:\/\//i.test(origin || '')) return null;
    const accounts = await harvestPasswordAccountsForOrigin(origin);
    const candidate =
      tab.passwordCandidate && tab.passwordCandidate.origin === origin
        ? tab.passwordCandidate
        : null;
    const hint = {
      tabId: tab.id,
      origin,
      accounts: accounts.map((x) => ({
        id: x.id,
        username: x.username,
        updatedAt: x.updatedAt,
      })),
      canSave: Boolean(candidate?.password),
      candidateUsername: candidate?.username || '',
      candidateToken: candidate
        ? String(candidate.createdAt || '') + ':' + String(candidate.username || '')
        : '',
    };
    hostService.emit('harvestts-password-hint', hint);
    return hint;
  }

  async function saveHarvestPasswordCandidate(tab) {
    const candidate = tab?.passwordCandidate;
    if (!candidate?.password) throw new Error('ยังไม่มีรหัสผ่านที่รอบันทึก');
    const data = await harvestTsPasswordData(),
      now = Date.now();
    let entry = data.items.find(
      (x) =>
        x.origin === candidate.origin && decryptHarvestSecret(x.username) === candidate.username,
    );
    if (!entry) {
      entry = {
        id: randomUUID(),
        origin: candidate.origin,
        url: candidate.url,
        createdAt: now,
      };
      data.items.unshift(entry);
    }
    entry.url = candidate.url;
    entry.username = encryptHarvestSecret(candidate.username || '');
    entry.password = encryptHarvestSecret(candidate.password);
    entry.updatedAt = now;
    await storageService.writeHarvestJson(storageService.harvestTsPasswordFile, data);
    tab.passwordCandidate = null;
    await emitHarvestPasswordHint(tab, candidate.origin);
    return {
      saved: true,
      item: {
        id: entry.id,
        origin: entry.origin,
        url: entry.url,
        username: candidate.username || '',
        updatedAt: now,
      },
    };
  }

  async function credentialById(id) {
    const data = await harvestTsPasswordData(),
      item = data.items.find((x) => x.id === String(id || ''));
    if (!item) return null;
    const username = decryptHarvestSecret(item.username),
      password = decryptHarvestSecret(item.password);
    if (!password) return null;
    return {
      id: item.id,
      origin: item.origin,
      url: item.url,
      username,
      password,
    };
  }

  async function fillHarvestCredentialById(tab, id) {
    if (!tab || tab.view.webContents.isDestroyed()) return { filled: false };
    const credential = await credentialById(id);
    if (!credential) return { filled: false };
    let currentOrigin = '';
    try {
      currentOrigin = new URL(tab.view.webContents.getURL() || tab.url || '').origin;
    } catch {}
    if (currentOrigin !== credential.origin)
      throw new Error('บัญชีนี้ไม่ได้บันทึกไว้สำหรับเว็บไซต์นี้');
    const payload = JSON.stringify({
      username: credential.username,
      password: credential.password,
    });
    const filled = await tab.view.webContents
      .executeJavaScript(
        `(() => {
    const data=${payload};
    const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'};
    const set=(el,value)=>{if(!el)return false;const p=Object.getPrototypeOf(el),setter=Object.getOwnPropertyDescriptor(p,'value')?.set;if(setter)setter.call(el,value);else el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true};
    const pass=[...document.querySelectorAll('input[type="password"]')].find(visible);if(!pass)return false;
    const scope=pass.form||document;
    const users=[...scope.querySelectorAll('input')].filter(x=>x!==pass&&visible(x)&&!x.disabled&&['text','email','tel'].includes((x.type||'text').toLowerCase()));
    const user=users.find(x=>/user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||'')))||users[0];
    const a=set(user,data.username),b=set(pass,data.password);pass.focus();return a||b;
  })()`,
        true,
      )
      .catch(() => false);
    return {
      filled: Boolean(filled),
      origin: credential.origin,
      username: credential.username,
    };
  }

  async function harvestTsPasswordStatus(input = {}) {
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    if (!tab || tab.kind !== 'web' || tab.view.webContents.isDestroyed())
      return { eligible: false, accounts: [], canSave: false };
    let origin = '';
    try {
      origin = new URL(tab.view.webContents.getURL() || tab.url || '').origin;
    } catch {}
    if (!/^https?:\/\//i.test(origin)) return { eligible: false, accounts: [], canSave: false };
    const accounts = await harvestPasswordAccountsForOrigin(origin);
    const candidate = tab.passwordCandidate?.origin === origin ? tab.passwordCandidate : null;
    return {
      eligible: true,
      origin,
      accounts: accounts.map((x) => ({
        id: x.id,
        username: x.username,
        updatedAt: x.updatedAt,
      })),
      canSave: Boolean(candidate?.password),
      candidateUsername: candidate?.username || '',
      candidateToken: candidate
        ? String(candidate.createdAt || '') + ':' + String(candidate.username || '')
        : '',
    };
  }

  async function harvestTsPasswordFillById(input = {}) {
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    const result = await fillHarvestCredentialById(tab, input.credentialId);
    if (!result.filled) throw new Error('ไม่พบฟอร์มล็อกอินที่กรอกได้');
    return result;
  }

  async function harvestTsPasswordSaveCandidate(input = {}) {
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    if (!tab) throw new Error('ไม่พบแท็บ HarvestTS');
    return saveHarvestPasswordCandidate(tab);
  }

  async function harvestTsPasswordDismissCandidate(input = {}) {
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    if (!tab) return { dismissed: false };
    const origin = tab.passwordCandidate?.origin || '';
    tab.passwordCandidate = null;
    if (origin) await emitHarvestPasswordHint(tab, origin).catch(() => {});
    return { dismissed: true };
  }

  async function harvestTsPasswordSavePrompt(input = {}) {
    if (!hostService.mainWindow || hostService.mainWindow.isDestroyed())
      throw new Error('หน้าต่างหลักไม่พร้อม');
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    if (!tab || tab.kind !== 'web') throw new Error('แท็บนี้ไม่มีฟอร์มรหัสผ่าน');
    const state = await harvestTsPasswordStatus({ id: tab.id });
    if (!state.canSave) return { ...state, shown: false };
    const exists = state.accounts.some(
      (x) => String(x.username || '') === String(state.candidateUsername || ''),
    );
    const originLabel = (() => {
      try {
        return new URL(state.origin).hostname;
      } catch {
        return state.origin;
      }
    })();
    const menu = Menu.buildFromTemplate([
      {
        label: exists ? 'อัปเดตรหัสผ่านไหม?' : 'บันทึกรหัสผ่านไหม?',
        enabled: false,
      },
      {
        label: state.candidateUsername || '(ไม่มีชื่อบัญชี)',
        sublabel: originLabel,
        enabled: false,
      },
      { type: 'separator' },
      {
        label: exists ? 'อัปเดต' : 'บันทึก',
        click: () => {
          saveHarvestPasswordCandidate(tab)
            .then((result) => {
              hostService.emit('harvestts-password-message', {
                tabId: tab.id,
                message: exists ? 'อัปเดตรหัสผ่านแล้ว' : 'บันทึกรหัสผ่านแล้ว',
                saved: true,
                item: result.item,
              });
            })
            .catch((error) =>
              hostService.emit('harvestts-password-message', {
                tabId: tab.id,
                error: error.message,
              }),
            );
        },
      },
      {
        label: 'ไม่ใช่ตอนนี้',
        click: () => {
          harvestTsPasswordDismissCandidate({ id: tab.id })
            .then(() =>
              hostService.emit('harvestts-password-message', {
                tabId: tab.id,
                message: 'ยังไม่บันทึกรหัสผ่าน',
              }),
            )
            .catch(() => {});
        },
      },
      { type: 'separator' },
      {
        label: 'จัดการรหัสผ่าน…',
        click: () => hostService.emit('harvestts-menu-action', { action: 'password' }),
      },
    ]);
    const area = hostService.mainWindow.getContentBounds();
    const x = Math.max(
      0,
      Math.min(area.width - 20, Math.round(Number(input.x) || area.width - 280)),
    );
    const y = Math.max(0, Math.min(area.height - 20, Math.round(Number(input.y) || 90)));
    menu.popup({ window: hostService.mainWindow, x, y });
    if (hostService.testMode)
      setTimeout(
        () => menu.closePopup(hostService.mainWindow),
        Math.min(2000, Number(input.autoCloseMs) || 300),
      );
    return { ...state, shown: true, update: exists };
  }

  async function harvestTsPasswordPopupMenu(input = {}) {
    if (!hostService.mainWindow || hostService.mainWindow.isDestroyed())
      throw new Error('หน้าต่างหลักไม่พร้อม');
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    if (!tab || tab.kind !== 'web') throw new Error('แท็บนี้ไม่มีฟอร์มรหัสผ่าน');
    const state = await harvestTsPasswordStatus({ id: tab.id });
    const template = [];
    if (state.accounts.length) {
      template.push({ label: 'ใช้บัญชีที่บันทึกไว้', enabled: false });
      for (const account of state.accounts) {
        template.push({
          label: account.username || '(ไม่มีชื่อบัญชี)',
          click: () => {
            fillHarvestCredentialById(tab, account.id)
              .then(() => emitHarvestPasswordHint(tab, state.origin))
              .catch(() => {});
          },
        });
      }
      template.push({ type: 'separator' });
    } else
      template.push({
        label: 'ยังไม่มีบัญชีที่บันทึกสำหรับเว็บนี้',
        enabled: false,
      });
    if (state.canSave) {
      template.push({
        label: state.candidateUsername
          ? `บันทึก/อัปเดตรหัสของ ${state.candidateUsername}`
          : 'บันทึกรหัสที่เพิ่งกรอก',
        click: () => {
          saveHarvestPasswordCandidate(tab).catch(() => {});
        },
      });
    } else {
      template.push({
        label: 'บันทึกรหัสที่กำลังกรอก',
        click: () => {
          harvestTsPasswordSaveCurrent({ id: tab.id })
            .then(() => emitHarvestPasswordHint(tab, state.origin))
            .catch((error) =>
              hostService.emit('harvestts-password-message', {
                tabId: tab.id,
                error: error.message,
              }),
            );
        },
      });
    }
    template.push({ type: 'separator' });
    template.push({
      label: 'จัดการรหัสผ่าน…',
      click: () => hostService.emit('harvestts-menu-action', { action: 'password' }),
    });
    const menu = Menu.buildFromTemplate(template);
    const area = hostService.mainWindow.getContentBounds();
    const x = Math.max(
      0,
      Math.min(area.width - 20, Math.round(Number(input.x) || area.width - 250)),
    );
    const y = Math.max(0, Math.min(area.height - 20, Math.round(Number(input.y) || 90)));
    menu.popup({ window: hostService.mainWindow, x, y });
    if (hostService.testMode && Number(input.autoCloseMs) > 0)
      setTimeout(
        () => menu.closePopup(hostService.mainWindow),
        Math.min(2000, Number(input.autoCloseMs)),
      );
    return state;
  }

  function harvestPasswordProbeScript() {
    return `(() => {
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const passwords = [...document.querySelectorAll('input[type="password"]')].filter(visible);
    const password = passwords.find(x => x.value) || passwords[0];
    if (!password || !password.value) return null;
    const scope = password.form || document;
    const candidates = [...scope.querySelectorAll('input')].filter(x => {
      if (x === password || !visible(x) || x.disabled) return false;
      const type = (x.type || 'text').toLowerCase();
      return ['text','email','tel'].includes(type);
    });
    const username = candidates.find(x => /user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||'')) && x.value)
      || candidates.find(x => x.value) || candidates[0];
    return { url:location.href, origin:location.origin, username:username?.value || '', password:password.value };
  })()`;
  }

  async function harvestTsPasswordSaveCurrent(input = {}) {
    const page = tabsService.harvestTsPageInfo(
      tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId)),
    );
    const captured = await page.wc.executeJavaScript(harvestPasswordProbeScript(), true);
    if (!captured?.password) throw new Error('ไม่พบช่องรหัสผ่านที่กรอกอยู่ในหน้านี้');
    if (!/^https?:\/\//i.test(captured.url || '') || !captured.origin)
      throw new Error('ไม่สามารถระบุเว็บไซต์ของรหัสผ่านนี้');
    const data = await harvestTsPasswordData();
    const now = Date.now();
    let entry = data.items.find(
      (x) =>
        x.origin === captured.origin &&
        decryptHarvestSecret(x.username) === String(captured.username || ''),
    );
    if (!entry) {
      entry = {
        id: randomUUID(),
        origin: captured.origin,
        url: captured.url,
        createdAt: now,
      };
      data.items.unshift(entry);
    }
    entry.url = captured.url;
    entry.username = encryptHarvestSecret(captured.username || '');
    entry.password = encryptHarvestSecret(captured.password);
    entry.updatedAt = now;
    await storageService.writeHarvestJson(storageService.harvestTsPasswordFile, data);
    page.tab.passwordCandidate = null;
    await emitHarvestPasswordHint(page.tab, captured.origin).catch(() => {});
    return {
      saved: true,
      item: {
        id: entry.id,
        origin: entry.origin,
        url: entry.url,
        username: captured.username || '',
        updatedAt: now,
      },
    };
  }

  async function harvestTsPasswordRemove(input = {}) {
    const data = await harvestTsPasswordData(),
      id = String(input.id || '');
    data.items = data.items.filter((x) => x.id !== id);
    await storageService.writeHarvestJson(storageService.harvestTsPasswordFile, data);
    return { items: await harvestTsPasswordList() };
  }

  async function credentialForURL(url) {
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    const data = await harvestTsPasswordData();
    const item = data.items.find((x) => x.origin === origin);
    if (!item) return null;
    const username = decryptHarvestSecret(item.username),
      password = decryptHarvestSecret(item.password);
    if (!password) return null;
    return { username, password };
  }

  async function fillHarvestCredential(tab = tabsService.activeHarvestTsTab()) {
    if (!tab || tab.view.webContents.isDestroyed()) return { filled: false };
    const wc = tab.view.webContents,
      url = wc.getURL() || tab.url || '';
    const credential = await credentialForURL(url);
    if (!credential) return { filled: false };
    const payload = JSON.stringify(credential);
    const result = await wc
      .executeJavaScript(
        `(() => {
    const data = ${payload};
    const visible = el => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const set = (el, value) => {
      if (!el || !value || el.value) return false;
      const proto = Object.getPrototypeOf(el), setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    };
    const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
    if (!password) return false;
    const scope = password.form || document;
    const users = [...scope.querySelectorAll('input')].filter(x => x !== password && visible(x) && !x.disabled && ['text','email','tel'].includes((x.type||'text').toLowerCase()));
    const username = users.find(x => /user|email|login|account/i.test((x.autocomplete||'')+' '+(x.name||'')+' '+(x.id||'')+' '+(x.placeholder||''))) || users[0];
    const a = set(username, data.username), b = set(password, data.password);
    return a || b;
  })()`,
        true,
      )
      .catch(() => false);
    return { filled: Boolean(result), origin: new URL(url).origin };
  }

  async function harvestTsPasswordFillCurrent(input = {}) {
    const tab = tabsService.harvestTsTabs.get(String(input.id || tabsService.activeHarvestTsId));
    if (!tab || tab.kind !== 'web') throw new Error('แท็บนี้ไม่มีฟอร์มล็อกอิน');
    let origin = '';
    try {
      origin = new URL(tab.view.webContents.getURL() || tab.url || '').origin;
    } catch {}
    const accounts = await harvestPasswordAccountsForOrigin(origin);
    if (!accounts.length) throw new Error('ไม่มีรหัสผ่านที่บันทึกไว้สำหรับเว็บนี้');
    if (accounts.length > 1) throw new Error('มีหลายบัญชี กรุณาเลือกจากปุ่มบัญชีข้างช่อง URL');
    const result = await fillHarvestCredentialById(tab, accounts[0].id);
    if (!result.filled) throw new Error('ไม่พบฟอร์มล็อกอินที่กรอกได้');
    return result;
  }
  return {
    harvestTsPasswordList,
    harvestPasswordAccountsForOrigin,
    emitHarvestPasswordHint,
    fillHarvestCredentialById,
    harvestTsPasswordStatus,
    harvestTsPasswordFillById,
    harvestTsPasswordSaveCandidate,
    harvestTsPasswordDismissCandidate,
    harvestTsPasswordSavePrompt,
    harvestTsPasswordPopupMenu,
    harvestTsPasswordSaveCurrent,
    harvestTsPasswordRemove,
    harvestTsPasswordFillCurrent,
  };
}
module.exports = { createCredentials };
