const { contextBridge, ipcRenderer } = require('electron');

// Mirrors the shape of chrome.runtime.sendMessage({ type, payload }) so the
// extension's popup.js can be reused with only this one call swapped.
// Used by popup.html.
contextBridge.exposeInMainWorld('agentAPI', {
  send: (type, payload) => ipcRenderer.invoke('message', { type, payload }),
});

// Used by floating.html — the always-on-top launcher bubble. Kept separate
// from agentAPI so the launcher can only move itself / open the popup, never
// touch auth or tracking directly (all of that stays with the popup).
contextBridge.exposeInMainWorld('floatingAPI', {
  move: (x, y) => ipcRenderer.send('floating-move', { x, y }),
  dragEnd: (x, y) => ipcRenderer.send('floating-drag-end', { x, y }),
  click: () => ipcRenderer.send('floating-click'),
  onState: (callback) =>
    ipcRenderer.on('floating-state', (_event, state) => callback(state)),
});
