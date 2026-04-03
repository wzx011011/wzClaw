import { contextBridge } from 'electron'
import { api } from '@electron-toolkit/preload'

// Phase 1: Minimal preload. Plan 03 adds typed IPC.
const electronAPI = api

// Expose minimal API for testing
contextBridge.exposeInMainWorld('electron', electronAPI)
