const { contextBridge, ipcRenderer } = require('electron');

// Mirrors the shape of chrome.runtime.sendMessage({ type, payload }) so the
// extension's popup.js can be reused with only this one call swapped.
contextBridge.exposeInMainWorld('agentAPI', {
  send: (type, payload) => ipcRenderer.invoke('message', { type, payload }),
});
