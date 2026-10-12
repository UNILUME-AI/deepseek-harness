/** Main-process ownership and fixed isolation policy for Sidebar webview guests. */
import { createHash, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { app, session, type BrowserWindow, type Session, type WebContents } from 'electron'
import type { DesktopBrowserLeaseId, DesktopBrowserOpenRequest, DesktopBrowserReservation } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { credentialOrigin } from './credential-validation.ts'
import { DESKTOP_IPC } from './ipc.ts'

/** Electron stores `persist:<name>` under `<sessionData>/Partitions/<name>`; names here are already lowercase and path-safe. */
const PARTITION_DIRECTORY_PREFIX = 'dsh-sidebar-browser-'

/**
 * @param origin - normalized HTTP(S) origin, for example `https://example.com`.
 * @returns the stable persistent partition name; the origin is hashed so no plaintext site reaches disk paths.
 */
export function sidebarPartitionName(origin: string): string {
  return `persist:${PARTITION_DIRECTORY_PREFIX}${createHash('sha256').update(origin).digest('hex')}`
}

interface GuestLease {
  readonly owner: WebContents
  readonly partition: string
  attached: boolean
  guest?: WebContents
  releaseInput?: () => void
}

/** Owns per-site storage partitions independently from individual tab guests. */
export class DesktopBrowserGuests {
  private readonly configured = new Set<string>()
  private readonly leases = new Map<DesktopBrowserLeaseId, GuestLease>()
  /** Per-owner most recently activated browser tab, as reported by the renderer and guest focus. */
  private readonly active = new Map<WebContents, DesktopBrowserLeaseId>()
  /** Per-partition tail of acquire and clear operations, so a clear never erases a guest acquired meanwhile. */
  private readonly partitionQueue = new Map<string, Promise<unknown>>()
  /** Pending clear count per partition; its tabs cannot become or stay the active fill target meanwhile. */
  private readonly clearing = new Map<string, number>()

  /**
   * @param hostUrl - current authenticated DSH Host, which guests cannot request.
   * @param partitionsDirectory - Electron's `<sessionData>/Partitions` directory, listed to clear partitions of earlier runs.
   */
  constructor(private readonly hostUrl: () => string | undefined, private readonly partitionsDirectory: string) {}

  /**
   * Reserve one guest in the target site's persistent partition.
   * @param owner - authenticated primary application WebContents.
   * @param siteUrl - HTTP(S) URL whose normalized origin scopes the partition.
   * @returns opaque lease and the partition approved for it.
   */
  async acquire(owner: WebContents, siteUrl: unknown): Promise<DesktopBrowserReservation> {
    // The vault's origin normalization is the one HTTP(S) site rule this shell already enforces.
    const partition = sidebarPartitionName(credentialOrigin(siteUrl))
    return await this.exclusive(partition, () => {
      if (!this.configured.has(partition)) {
        this.configureSession(session.fromPartition(partition))
        this.configured.add(partition)
      }
      const lease = randomUUID() as DesktopBrowserLeaseId
      this.leases.set(lease, { owner, partition, attached: false })
      return { lease, partition }
    })
  }

  /**
   * Release only a lease issued to this application window; the site's persistent storage survives.
   * @param owner - authenticated IPC sender.
   * @param id - lease received over IPC.
   */
  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined) return
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    lease.releaseInput?.()
    this.leases.delete(key)
    if (this.active.get(owner) === key) this.active.delete(owner)
    const guest = lease.guest
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>((resolve) => { guest.once('destroyed', resolve) })
      guest.close({ waitForBeforeUnload: false })
      await destroyed
    }
  }

  /**
   * Get the guest WebContents for a lease, if active.
   * @param owner - authenticated IPC sender.
   * @param id - lease identifier.
   * @returns guest WebContents, or undefined if not found, destroyed, or its partition has a pending clear.
   */
  getGuest(owner: WebContents, id: unknown): WebContents | undefined {
    if (typeof id !== 'string') return undefined
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined || lease.owner !== owner || lease.guest?.isDestroyed()
      || this.clearing.has(lease.partition)) return undefined
    return lease.guest
  }

  /**
   * Record the renderer-reported activation of one browser tab.
   * @param owner - authenticated IPC sender.
   * @param id - lease the renderer marked active.
   */
  markActive(owner: WebContents, id: unknown): void {
    if (typeof id !== 'string') return
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease === undefined || lease.owner !== owner || this.clearing.has(lease.partition)) return
    this.active.set(owner, key)
  }

  /**
   * Clear the renderer-reported activation of one browser tab when its tab became invisible.
   * @param owner - authenticated IPC sender.
   * @param id - lease the renderer marked inactive.
   */
  markInactive(owner: WebContents, id: unknown): void {
    if (typeof id !== 'string') return
    const key = id as DesktopBrowserLeaseId
    const lease = this.leases.get(key)
    if (lease !== undefined && lease.owner !== owner) return
    if (this.active.get(owner) === key) this.active.delete(owner)
  }

  /**
   * Resolve the owner's most recently activated browser tab.
   * @param owner - authenticated primary application WebContents.
   * @returns the live guest, or undefined when no tab was activated or it has since closed.
   */
  getActiveGuest(owner: WebContents): WebContents | undefined {
    const id = this.getActiveLease(owner)
    if (id === undefined) return undefined
    return this.getGuest(owner, id)
  }

  /**
   * Resolve the lease of the owner's most recently activated browser tab.
   * @param owner - authenticated primary application WebContents.
   * @returns the tracked lease, or undefined when no tab is active or its partition has a pending clear.
   */
  getActiveLease(owner: WebContents): DesktopBrowserLeaseId | undefined {
    const id = this.active.get(owner)
    const lease = id === undefined ? undefined : this.leases.get(id)
    return lease === undefined || this.clearing.has(lease.partition) ? undefined : id
  }

  /**
   * Close this window's guests in the lease's partition, then erase all of that partition's stored data.
   * @param owner - authenticated IPC sender.
   * @param id - lease of the tab whose partition is cleared; its page URL is not consulted.
   */
  async clearSite(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== 'string') throw new Error('desktop browser: invalid guest lease')
    const lease = this.leases.get(id as DesktopBrowserLeaseId)
    if (lease === undefined) throw new Error('desktop browser: unknown guest lease')
    if (lease.owner !== owner) throw new Error('desktop browser: guest belongs to another window')
    await this.clearPartition(owner, lease.partition)
  }

  /**
   * Clear every sidebar partition on disk or used in this run, closing this window's guests first.
   * @param owner - authenticated IPC sender.
   */
  async clearAllSites(owner: WebContents): Promise<void> {
    const partitions = new Set(this.configured)
    let entries: string[] = []
    try {
      entries = await readdir(this.partitionsDirectory)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    for (const entry of entries) {
      if (entry.startsWith(PARTITION_DIRECTORY_PREFIX) && /^[\da-f]{64}$/.test(entry.slice(PARTITION_DIRECTORY_PREFIX.length))) partitions.add(`persist:${entry}`)
    }
    const results = await Promise.allSettled([...partitions].map(partition => this.clearPartition(owner, partition)))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result): unknown => result.reason), 'Sidebar browser storage cleanup failed')
    }
  }

  private exclusive<T>(partition: string, task: () => T | Promise<T>): Promise<T> {
    const run = (this.partitionQueue.get(partition) ?? Promise.resolve()).then(task, task)
    const tail = run.catch((_error: unknown) => {
      // The caller receives this failure; the queue only orders later operations.
    })
    this.partitionQueue.set(partition, tail)
    void tail.then(() => { if (this.partitionQueue.get(partition) === tail) this.partitionQueue.delete(partition) })
    return run
  }

  /** Close this window's leases on the partition, then erase every storage kind; the session stays configured. */
  private clearPartition(owner: WebContents, partition: string): Promise<void> {
    this.clearing.set(partition, (this.clearing.get(partition) ?? 0) + 1)
    const cleared = this.exclusive(partition, async () => {
      const ids = [...this.leases.entries()].filter(([, lease]) => lease.partition === partition).map(([id]) => id)
      await Promise.all(ids.map(id => this.release(owner, id)))
      const browserSession = session.fromPartition(partition)
      const expected = join(this.partitionsDirectory, partition.slice('persist:'.length))
      if (browserSession.storagePath !== expected) {
        throw new Error('Sidebar browser partition is not stored where clearing expects it')
      }
      await browserSession.closeAllConnections()
      const results = await Promise.allSettled([
        // No `storages` filter: unlike Platform documents, sidebar sites keep nothing, including localStorage.
        browserSession.clearStorageData(),
        browserSession.clearCache(),
        browserSession.clearAuthCache(),
      ])
      const failures = results.filter(result => result.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(failures.map((result): unknown => result.reason), 'Sidebar browser storage cleanup failed')
      }
    })
    return cleared.finally(() => {
      const pending = (this.clearing.get(partition) ?? 1) - 1
      if (pending === 0) this.clearing.delete(partition)
      else this.clearing.set(partition, pending)
    })
  }

  /**
   * Install attachment checks before the application document can create a webview.
   * @param window - primary application window.
   * @param attachInput - attaches native input after guest ownership is verified and returns its disposer.
   */
  bind(window: BrowserWindow, attachInput: (guest: WebContents, name: DesktopBrowserLeaseId) => () => void): void {
    const owner = window.webContents
    owner.on('will-attach-webview', (event, preferences, params) => {
      const id = typeof params.src === 'string' && params.src.startsWith('about:blank#')
        ? params.src.slice('about:blank#'.length) : ''
      const lease = this.leases.get(id as DesktopBrowserLeaseId)
      if (lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        event.preventDefault()
        return
      }
      lease.attached = true
      // Keep Electron's allowpopups dispatch flag; the guest handler still denies native windows.
      for (const key of Object.keys(preferences)) {
        if (key !== 'disablePopups') Reflect.deleteProperty(preferences, key)
      }
      Object.assign(preferences, {
        partition: lease.partition,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: true,
        devTools: !app.isPackaged,
      })
      params.httpreferrer = ''
    })
    owner.on('did-attach-webview', (_event, guest) => {
      let attachedLease: DesktopBrowserLeaseId | undefined
      // The first document is an inert about:blank carrying the approved lease.
      // Bind on the main-process event before the renderer can navigate the ready guest.
      guest.once('dom-ready', () => {
        const url = guest.getURL()
        const id = (url.startsWith('about:blank#') ? url.slice('about:blank#'.length) : '') as DesktopBrowserLeaseId
        const lease = this.leases.get(id)
        if (lease === undefined || lease.owner !== owner || lease.guest !== undefined) {
          guest.close({ waitForBeforeUnload: false })
          return
        }
        lease.guest = guest
        attachedLease = id
        lease.releaseInput = attachInput(guest, id)
        // Split panes leave several guests visible; a focused guest is the newer active page.
        guest.on('focus', () => {
          if (this.leases.get(id) === lease && !this.clearing.has(lease.partition)) this.active.set(owner, id)
        })
        guest.once('destroyed', () => {
          lease.releaseInput?.()
          this.leases.delete(id)
          if (this.active.get(owner) === id) this.active.delete(owner)
        })
      })
      guest.setWindowOpenHandler(({ url, postBody }) => {
        const lease = attachedLease === undefined ? undefined : this.leases.get(attachedLease)
        if (attachedLease !== undefined && lease?.guest === guest && lease.owner === owner && !owner.isDestroyed()
          && postBody === undefined && this.allowedNavigation(url)) {
          const request: DesktopBrowserOpenRequest = { lease: attachedLease, url: new URL(url).href }
          owner.send(DESKTOP_IPC.browserOpenRequested, request)
        }
        return { action: 'deny' }
      })
      guest.on('will-frame-navigate', (event) => {
        if (event.isMainFrame && !this.allowedNavigation(event.url)) event.preventDefault()
      })
      guest.on('will-redirect', (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.allowedNavigation(url)) event.preventDefault()
      })
      guest.on('will-attach-webview', (event) => { event.preventDefault() })
      guest.on('login', (event, _details, _authInfo, callback) => { event.preventDefault(); callback() })
    })
    const releaseAll = (): void => {
      for (const [id, lease] of this.leases) {
        if (lease.owner === owner) void this.release(owner, id).catch((error: unknown) => { console.error(error) })
      }
    }
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseAll()
    })
    owner.on('render-process-gone', releaseAll)
    owner.once('destroyed', releaseAll)
  }

  private configureSession(browserSession: Session): void {
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    browserSession.setPermissionCheckHandler(() => false)
    browserSession.setDevicePermissionHandler(() => false)
    browserSession.setDisplayMediaRequestHandler((_request, callback) => { callback({}) })
    browserSession.on('will-download', (event) => { event.preventDefault() })
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url)
      const network = ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      callback({ cancel: network
        ? url.username !== '' || url.password !== '' || this.isApplicationHost(url)
        : !['about:', 'data:', 'blob:'].includes(url.protocol) })
    })
  }

  private allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
      && !this.isApplicationHost(url)
  }

  private isApplicationHost(url: URL): boolean {
    const value = this.hostUrl()
    if (value === undefined) return false
    const host = new URL(value)
    return url.port === host.port
      && (url.hostname === host.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  }
}
