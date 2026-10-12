/** Lease-scoped browser operations and one main-process event subscription per window. */
import { ipcRenderer } from 'electron'
import type { CredentialEntry, CredentialId, DesktopCredentialsBridge, DesktopBrowserBridge, DesktopBrowserLeaseId, CredentialFillResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** @returns browser operations that expose neither IPC nor Electron objects. */
export function createDesktopBrowserBridge(): DesktopBrowserBridge {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  ipcRenderer.on(DESKTOP_IPC.browserOpenRequested, (_event, request: unknown) => {
    if (typeof request !== 'object' || request === null || !('lease' in request) || !('url' in request)
      || typeof request.lease !== 'string' || typeof request.url !== 'string') return
    const callbacks = listeners.get(request.lease as DesktopBrowserLeaseId)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try { callback(request.url) }
      catch (error) { console.error('Desktop browser link handler failed', error) }
    }
  })
  return {
    acquire: workspace => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace) as ReturnType<DesktopBrowserBridge['acquire']>,
    release: lease => ipcRenderer.invoke(DESKTOP_IPC.browserRelease, lease) as Promise<void>,
    onOpenRequested(lease, listener) {
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks) }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
      }
    },
  }
}

/** @returns metadata and user-initiated credential operations without raw IPC access. */
export function createDesktopCredentialsBridge(): DesktopCredentialsBridge {
  return {
    list: (origin?: string) => ipcRenderer.invoke(DESKTOP_IPC.credentialsList, origin) as Promise<CredentialEntry[]>,
    add: (origin, label, username, password, totpSecret) =>
      ipcRenderer.invoke(DESKTOP_IPC.credentialsAdd, origin, label, username, password, totpSecret) as Promise<CredentialId>,
    remove: id => ipcRenderer.invoke(DESKTOP_IPC.credentialsRemove, id) as Promise<void>,
    fill: request => ipcRenderer.invoke(DESKTOP_IPC.credentialsFill, request) as Promise<CredentialFillResult>,
  }
}
