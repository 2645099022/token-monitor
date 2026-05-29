'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tokenMonitor', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  previewAppearance: (patch) => ipcRenderer.invoke('appearance:preview', patch),
  getStats: (options) => ipcRenderer.invoke('stats:get', options),
  getStreamStatus: () => ipcRenderer.invoke('stream:status'),
  getHubInfo: () => ipcRenderer.invoke('hub:getInfo'),
  regenerateHubSecret: () => ipcRenderer.invoke('hub:regenerateSecret'),
  onHubPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('hub:push', listener);
    return () => ipcRenderer.removeListener('hub:push', listener);
  },
  onStatsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('stats:push', listener);
    return () => ipcRenderer.removeListener('stats:push', listener);
  },
  onSettingsPush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('settings:push', listener);
    return () => ipcRenderer.removeListener('settings:push', listener);
  },
  onTokscalePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('tokscale:push', listener);
    return () => ipcRenderer.removeListener('tokscale:push', listener);
  },
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  openUserData: () => ipcRenderer.invoke('app:openUserData'),
  getTokscaleStatus: () => ipcRenderer.invoke('tokscale:getStatus'),
  checkTokscaleNpm: () => ipcRenderer.invoke('tokscale:checkNpm'),
  downloadTokscaleFromNpm: () => ipcRenderer.invoke('tokscale:downloadFromNpm'),
  resetTokscaleToBundled: () => ipcRenderer.invoke('tokscale:resetToBundled'),
  getAppUpdateState: () => ipcRenderer.invoke('appUpdate:getState'),
  checkAppUpdateNow: () => ipcRenderer.invoke('appUpdate:checkNow'),
  dismissAppUpdate: (version) => ipcRenderer.invoke('appUpdate:dismiss', version),
  expandFloatingBubble: () => ipcRenderer.invoke('floatingBubble:expand'),
  moveFloatingBubble: (delta) => ipcRenderer.invoke('floatingBubble:move', delta),
  signalContentReady: () => ipcRenderer.send('window:contentReady'),
  onFloatingBubbleState: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('floatingBubble:state', listener);
    return () => ipcRenderer.removeListener('floatingBubble:state', listener);
  },
  onAppUpdatePush: (callback) => {
    const listener = (_event, payload) => { try { callback(payload); } catch (_) {} };
    ipcRenderer.on('appUpdate:push', listener);
    return () => ipcRenderer.removeListener('appUpdate:push', listener);
  },
  setTrayIcons: (icons) => ipcRenderer.invoke('tray:setIcons', icons),
  cursor: {
    loginManual: (token) => ipcRenderer.invoke('cursor:loginManual', token),
    logout: () => ipcRenderer.invoke('cursor:logout'),
    status: () => ipcRenderer.invoke('cursor:status')
  },
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close')
});
