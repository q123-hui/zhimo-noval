'use strict';

/**
 * 预加载脚本：在开启 contextIsolation + sandbox 的情况下，
 * 只向页面暴露最小必要的桌面能力（原生保存对话框）。
 * 页面里通过 window.desktopAPI 判断当前是否运行在桌面端。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  /**
   * 弹出系统保存对话框，把文本写入用户选定的位置。
   * @param {string} filename 建议文件名（含扩展名）
   * @param {string} content  文本内容
   * @param {string} type     MIME 类型，用于推断文件过滤器
   * @returns {Promise<{ok:boolean, filePath?:string, reason?:string}>}
   */
  saveTextFile: (filename, content, type) =>
    ipcRenderer.invoke('save-text-file', { filename, content, type }),

  /**
   * 监听主进程发来的「用本软件打开的 txt 文件」（系统/微信「打开方式」）。
   * @param {(payload:{name:string, text:string}) => void} cb
   */
  onOpenTxtFile: (cb) =>
    ipcRenderer.on('open-txt-file', (event, payload) => cb(payload)),
});
