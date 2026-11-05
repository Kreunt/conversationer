import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, ToWindow } from './contract.ts';

const api: DesktopApi = {
  speech: (kind) => ipcRenderer.send('speech', kind),
  done: () => ipcRenderer.send('done'),
  stop: () => ipcRenderer.send('stop'),
  sendText: (text) => ipcRenderer.send('text', text),
  acceptSetup: () => ipcRenderer.send('accept-setup'),
  choosePartner: (id) => ipcRenderer.send('choose-partner', id),
  changePartner: () => ipcRenderer.send('change-partner'),
  askFeedback: (id, said) => ipcRenderer.send('feedback', id, said),
  setLevel: (level) => ipcRenderer.send('level', level),
  sendAudio: (wav) => ipcRenderer.send('audio', wav),
  playbackStarted: () => ipcRenderer.send('playback-started'),
  playbackFinished: () => ipcRenderer.send('playback-finished'),
  on: (listener) => {
    ipcRenderer.on('to-window', (_, event: ToWindow) => listener(event));
  },
};

contextBridge.exposeInMainWorld('desktop', api);
