const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('saeedAPI', {
    executeTask: (taskDescription, payload) => ipcRenderer.invoke('execute-task', { taskDescription, payload }),
    confirmAction: (approved, taskDetails, payload) => ipcRenderer.invoke('confirm-final-action', { approved, taskDetails, payload })
});
