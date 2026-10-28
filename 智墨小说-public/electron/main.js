'use strict';

/**
 * 智墨小说生成器 · 桌面端主进程
 *
 * 做三件事：
 *   1) 在本机 18799 端口起一个本地服务器（复用 scripts/server-core.js），
 *      页面与网页版读写同一份数据文件（~/.zhimo-novel/data.json）
 *   2) 用这个地址加载界面，因此桌面端与网页版数据实时共享
 *   3) 提供原生「另存为」对话框、接收系统「用本软件打开 txt」
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');

const { createNovelServer, getDataFile } = require('../scripts/server-core.js');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18799;
const START_URL = 'http://127.0.0.1:' + PORT + '/';

let mainWindow = null;
let httpServer = null;
let pendingTxt = null; // 启动前收到的 txt（等页面加载完再发）

/* ---------------- 本地服务器 ---------------- */

function startServer() {
  return new Promise((resolve, reject) => {
    const { server } = createNovelServer({ wwwDir: ROOT, dataFile: getDataFile() });
    server.once('error', (err) => {
      // 端口已被占用：多半是网页版/另一个窗口已经在跑，直接连它
      if (err && err.code === 'EADDRINUSE') return resolve(null);
      reject(err);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

/* ---------------- 窗口 ---------------- */

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [];
  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 ' + app.name },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    });
  }
  template.push(
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    }
  );
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 700,
    title: '智墨小说生成器',
    backgroundColor: '#f5f7fb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外部链接交给系统浏览器，避免把应用窗口带走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (pendingTxt && mainWindow) {
      mainWindow.webContents.send('open-txt-file', pendingTxt);
      pendingTxt = null;
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  await mainWindow.loadURL(START_URL);
}

/* ---------------- 原生能力 ---------------- */

const FILTERS = {
  'application/json': [{ name: 'JSON 文件', extensions: ['json'] }],
  'text/plain': [{ name: '文本文件', extensions: ['txt', 'md'] }],
  'text/markdown': [{ name: 'Markdown 文件', extensions: ['md'] }]
};

ipcMain.handle('save-text-file', async (event, payload) => {
  const { filename = '导出.txt', content = '', type = 'text/plain' } = payload || {};
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  try {
    const result = await dialog.showSaveDialog(win, {
      title: '保存文件',
      defaultPath: path.join(app.getPath('documents'), filename),
      filters: FILTERS[type] || [{ name: '所有文件', extensions: ['*'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, reason: 'canceled' };
    await fs.promises.writeFile(result.filePath, content, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
});

/* 系统/微信「用本软件打开 txt」 */
function readTxtFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return { name: path.basename(filePath), text };
  } catch (e) {
    return null;
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (!/\.(txt|md)$/i.test(filePath)) return;
  const payload = readTxtFile(filePath);
  if (!payload) return;
  if (mainWindow) mainWindow.webContents.send('open-txt-file', payload);
  else pendingTxt = payload;
});

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  buildMenu();
  try {
    httpServer = await startServer();
  } catch (e) {
    dialog.showErrorBox('启动失败', '本地服务启动失败：' + (e && e.message ? e.message : e));
    app.quit();
    return;
  }
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (httpServer) {
    try { httpServer.close(); } catch (e) { /* ignore */ }
    httpServer = null;
  }
});
