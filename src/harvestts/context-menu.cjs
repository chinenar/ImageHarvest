'use strict';
const { app, BrowserWindow, dialog, clipboard, nativeImage, screen } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const sourceDir = require('node:path').resolve(__dirname, '..');

function createContextMenu({ tabs: tabsService, host: hostService }) {
  let harvestContextMenuWindow = null;

  let harvestContextMenuTarget = null;

  let harvestContextMenuModel = null;

  function liveHarvestContextMenu() {
    return harvestContextMenuWindow && !harvestContextMenuWindow.isDestroyed()
      ? harvestContextMenuWindow
      : null;
  }

  async function closeHarvestContextMenu() {
    const win = liveHarvestContextMenu();
    harvestContextMenuWindow = null;
    harvestContextMenuTarget = null;
    harvestContextMenuModel = null;
    if (win) {
      try {
        win.hide();
      } catch {}
      try {
        win.destroy();
      } catch {}
    }
  }

  function harvestContextSafeFilename(value, fallback = 'page') {
    const text = String(value || fallback)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/[. ]+$/, '')
      .trim()
      .slice(0, 120);
    return text || fallback;
  }

  function harvestContextItems(tab, params = {}) {
    const wc = tab.view.webContents,
      flags = params.editFlags || {},
      items = [];
    const add = (id, label, shortcut = '', disabled = false, extra = {}) =>
      items.push({ id, label, shortcut, disabled, ...extra });
    const sep = () => {
      if (items.length && items[items.length - 1]?.type !== 'separator')
        items.push({ type: 'separator' });
    };
    const section = (label) => items.push({ type: 'section', label });
    const selection = String(params.selectionText || '').trim();
    const linkURL = /^https?:\/\//i.test(params.linkURL || '') ? params.linkURL : '';
    const srcURL = /^https?:\/\//i.test(params.srcURL || '') ? params.srcURL : '';
    const image = params.mediaType === 'image' && srcURL;

    if (params.isEditable) {
      section('แก้ไข');
      add('undo', 'ย้อนกลับ', 'CTRL + Z', !flags.canUndo);
      add('redo', 'ทำซ้ำ', 'CTRL + Y', !flags.canRedo);
      sep();
      add('cut', 'ตัด', 'CTRL + X', !flags.canCut);
      add('copy', 'คัดลอก', 'CTRL + C', !flags.canCopy);
      add('paste', 'วาง', 'CTRL + V', !flags.canPaste);
      add('select-all', 'เลือกทั้งหมด', 'CTRL + A', !flags.canSelectAll);
      sep();
    } else if (selection) {
      section('ข้อความที่เลือก');
      add('copy', 'คัดลอก', 'CTRL + C', !flags.canCopy);
      add(
        'search-selection',
        `ค้นหา Google “${selection.slice(0, 42)}${selection.length > 42 ? '…' : ''}”`,
        '',
        false,
        { accent: true },
      );
      add('translate-selection', 'แปลข้อความนี้เป็นไทย', '', false, {
        accent: true,
      });
      sep();
    }

    if (linkURL) {
      section('ลิงก์');
      add('open-link-tab', 'เปิดลิงก์ในแท็บใหม่');
      add('download-link', 'ดาวน์โหลดลิงก์');
      add('copy-link', 'คัดลอกที่อยู่ลิงก์');
      sep();
    }

    if (image) {
      section('รูปภาพ');
      add('open-image-tab', 'เปิดรูปภาพในแท็บใหม่');
      add('download-image', 'ดาวน์โหลดรูปภาพ');
      add('copy-image', 'คัดลอกรูปภาพ');
      add('copy-image-address', 'คัดลอกที่อยู่รูปภาพ');
      sep();
    }

    section('หน้าเว็บ');
    add('back', 'ย้อนกลับ', 'ALT + ←', !wc.navigationHistory?.canGoBack?.());
    add('forward', 'ไปข้างหน้า', 'ALT + →', !wc.navigationHistory?.canGoForward?.());
    add('reload', 'โหลดใหม่', 'F5');
    sep();
    add('bookmark', 'เพิ่มใน Bookmark…', 'CTRL + D', false, { accent: true });
    add(
      'fullscreen',
      hostService.mainWindow?.isFullScreen?.() ? 'ออกจากเต็มจอ' : 'เต็มหน้าจอ',
      'F11',
    );
    sep();
    add('copy-address', 'คัดลอกที่อยู่หน้าเว็บ');
    add('save-page', 'บันทึกหน้าเว็บเป็น…', 'CTRL + S');
    add('save-pdf', 'บันทึกเป็น PDF…');
    add('print', 'พิมพ์…', 'CTRL + P');
    sep();
    add('inspect', 'Inspect element', 'CTRL + SHIFT + C');
    return items;
  }

  function harvestContextBounds(params, items) {
    const width = 318;
    const rawHeight =
      14 +
      items.reduce(
        (sum, row) => sum + (row.type === 'separator' ? 13 : row.type === 'section' ? 23 : 35),
        0,
      );
    const height = Math.max(70, Math.min(650, rawHeight));
    const content = hostService.mainWindow?.getContentBounds?.() || {
      x: 100,
      y: 100,
      width: 1360,
      height: 900,
    };
    const point = {
      x: content.x + tabsService.harvestTsBounds.x + Math.max(0, Number(params.x) || 0),
      y: content.y + tabsService.harvestTsBounds.y + Math.max(0, Number(params.y) || 0),
    };
    const display = screen.getDisplayNearestPoint(point),
      area = display.workArea;
    return {
      x: Math.round(Math.max(area.x + 4, Math.min(point.x, area.x + area.width - width - 4))),
      y: Math.round(Math.max(area.y + 4, Math.min(point.y, area.y + area.height - height - 4))),
      width,
      height,
    };
  }

  function harvestContextSender(event) {
    const win = liveHarvestContextMenu();
    if (!win || win.webContents !== event.sender)
      throw new Error('Unauthorized HarvestTS context menu IPC');
    return win;
  }

  function createHarvestContextWindow(bounds) {
    const win = new BrowserWindow({
      ...bounds,
      parent:
        hostService.mainWindow && !hostService.mainWindow.isDestroyed()
          ? hostService.mainWindow
          : undefined,
      modal: false,
      frame: false,
      transparent: true,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: false,
      backgroundColor: '#00000000',
      webPreferences: {
        partition: 'harvest-context-ui',
        preload: path.join(sourceDir, 'context-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });
    harvestContextMenuWindow = win;
    hostService.bindScreenshotWindow(win);
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('blur', () =>
      setTimeout(() => {
        if (harvestContextMenuWindow === win) closeHarvestContextMenu().catch(() => {});
      }, 30),
    );
    win.on('closed', () => {
      if (harvestContextMenuWindow === win) {
        harvestContextMenuWindow = null;
        harvestContextMenuTarget = null;
        harvestContextMenuModel = null;
      }
    });
    win.__ready = win.loadFile(path.join(sourceDir, 'context-menu.html'));
    return win;
  }

  async function showHarvestContextMenu(tab, params = {}) {
    await closeHarvestContextMenu();
    if (!tab || tab.kind !== 'web' || tab.view.webContents.isDestroyed()) return false;
    const items = harvestContextItems(tab, params),
      bounds = harvestContextBounds(params, items);
    harvestContextMenuTarget = {
      tabId: tab.id,
      x: Number(params.x) || 0,
      y: Number(params.y) || 0,
      selectionText: String(params.selectionText || ''),
      linkURL: String(params.linkURL || ''),
      srcURL: String(params.srcURL || ''),
      pageURL: tab.view.webContents.getURL() || tab.url || '',
    };
    harvestContextMenuModel = { items };
    const win = createHarvestContextWindow(bounds);
    try {
      await win.__ready;
    } catch {
      await closeHarvestContextMenu();
      return false;
    }
    if (win.isDestroyed()) return false;
    win.show();
    win.focus();
    return true;
  }

  async function harvestContextSavePage(tab) {
    const wc = tab.view.webContents,
      title = harvestContextSafeFilename(wc.getTitle() || 'page');
    const result = await dialog.showSaveDialog(hostService.mainWindow, {
      title: 'บันทึกหน้าเว็บ',
      defaultPath: path.join(app.getPath('downloads'), title + '.html'),
      filters: [{ name: 'Web page', extensions: ['html', 'htm'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await wc.savePage(result.filePath, 'HTMLComplete');
    return true;
  }

  async function harvestContextSavePdf(tab) {
    const wc = tab.view.webContents,
      title = harvestContextSafeFilename(wc.getTitle() || 'page');
    const result = await dialog.showSaveDialog(hostService.mainWindow, {
      title: 'บันทึกเป็น PDF',
      defaultPath: path.join(app.getPath('downloads'), title + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) return false;
    const data = await wc.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
    });
    await fs.writeFile(result.filePath, data);
    return true;
  }

  async function harvestContextCopyImage(tab, url) {
    const response = await tab.view.webContents.session.fetch(url, {
      referrer: tab.view.webContents.getURL() || undefined,
    });
    if (!response.ok) throw new Error('โหลดรูปภาพสำหรับคัดลอกไม่สำเร็จ');
    const buffer = Buffer.from(await response.arrayBuffer()),
      image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) throw new Error('รูปภาพนี้คัดลอกไม่ได้');
    clipboard.writeImage(image);
    return true;
  }

  async function executeHarvestContextAction(id) {
    const target = harvestContextMenuTarget,
      tab = target && tabsService.harvestTsTabs.get(target.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) throw new Error('แท็บต้นทางปิดไปแล้ว');
    const wc = tab.view.webContents,
      selection = target.selectionText.trim();
    if (id === 'undo') wc.undo();
    else if (id === 'redo') wc.redo();
    else if (id === 'cut') wc.cut();
    else if (id === 'copy') wc.copy();
    else if (id === 'paste') wc.paste();
    else if (id === 'select-all') wc.selectAll();
    else if (id === 'search-selection' && selection)
      tabsService.createHarvestTsTab({
        url: 'https://www.google.com/search?q=' + encodeURIComponent(selection),
        activate: true,
      });
    else if (id === 'translate-selection' && selection)
      tabsService.createHarvestTsTab({
        url:
          'https://translate.google.com/?sl=auto&tl=th&text=' +
          encodeURIComponent(selection) +
          '&op=translate',
        activate: true,
      });
    else if (id === 'open-link-tab' && /^https?:\/\//i.test(target.linkURL))
      tabsService.createHarvestTsTab({ url: target.linkURL, activate: true });
    else if (id === 'download-link' && /^https?:\/\//i.test(target.linkURL))
      wc.downloadURL(target.linkURL);
    else if (id === 'copy-link') clipboard.writeText(target.linkURL || '');
    else if (id === 'open-image-tab' && /^https?:\/\//i.test(target.srcURL))
      tabsService.createHarvestTsTab({ url: target.srcURL, activate: true });
    else if (id === 'download-image' && /^https?:\/\//i.test(target.srcURL))
      wc.downloadURL(target.srcURL);
    else if (id === 'copy-image' && /^https?:\/\//i.test(target.srcURL))
      await harvestContextCopyImage(tab, target.srcURL);
    else if (id === 'copy-image-address') clipboard.writeText(target.srcURL || '');
    else if (id === 'back' && wc.navigationHistory?.canGoBack?.()) wc.navigationHistory.goBack();
    else if (id === 'forward' && wc.navigationHistory?.canGoForward?.())
      wc.navigationHistory.goForward();
    else if (id === 'reload') wc.reload();
    else if (id === 'bookmark') hostService.emit('harvestts-menu-action', { action: 'bookmark' });
    else if (id === 'fullscreen')
      hostService.mainWindow.setFullScreen(!hostService.mainWindow.isFullScreen());
    else if (id === 'copy-address') clipboard.writeText(wc.getURL() || tab.url || '');
    else if (id === 'save-page') return harvestContextSavePage(tab);
    else if (id === 'save-pdf') return harvestContextSavePdf(tab);
    else if (id === 'print') wc.print({ silent: false, printBackground: true });
    else if (id === 'inspect') {
      wc.inspectElement(target.x, target.y);
      if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
    }
    return true;
  }
  return {
    get harvestContextMenuWindow() {
      return harvestContextMenuWindow;
    },
    set harvestContextMenuWindow(value) {
      harvestContextMenuWindow = value;
    },
    get harvestContextMenuTarget() {
      return harvestContextMenuTarget;
    },
    set harvestContextMenuTarget(value) {
      harvestContextMenuTarget = value;
    },
    get harvestContextMenuModel() {
      return harvestContextMenuModel;
    },
    set harvestContextMenuModel(value) {
      harvestContextMenuModel = value;
    },
    liveHarvestContextMenu,
    closeHarvestContextMenu,
    harvestContextSender,
    showHarvestContextMenu,
    harvestContextSavePage,
    executeHarvestContextAction,
  };
}
module.exports = { createContextMenu };
