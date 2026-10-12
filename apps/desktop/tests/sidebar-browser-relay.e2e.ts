/** Real Electron webview read through the shipped Sidebar provider and ToolRuntime. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as Provider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { loadSidebarProvider } from './sidebar-browser-provider.ts'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const electron: unknown = createRequire(import.meta.url)('electron')
const electronBinary = typeof electron === 'string' && existsSync(electron) ? electron : undefined

const FIXTURE_MAIN = `
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { SidebarBrowserRelay, listenSidebarBrowserRelay } from './relay.mjs'

app.setPath('userData', process.env.FIXTURE_USER_DATA)
process.on('uncaughtException', error => {
  process.stderr.write('fixture uncaught exception: ' + error.message + '\\n')
  app.exit(1)
})
const PAGE = '<!doctype html><title>Orders</title><h1>Order list</h1>'
  + '<button onclick="document.getElementById(\\'out\\').textContent = \\'saved\\'">Save</button><p id=out>idle</p>'
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8')
  response.end(request.url === '/page2' ? '<!doctype html><title>Page 2</title><h1>Second page</h1>' : PAGE)
})
app.whenReady().then(async () => {
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const origin = 'http://127.0.0.1:' + server.address().port
  const window = new BrowserWindow({ show: false, width: 900, height: 640, webPreferences: { webviewTag: true } })
  window.showInactive()
  let guest
  window.webContents.on('did-attach-webview', (_event, attached) => { guest = attached })
  const relay = new SidebarBrowserRelay({
    primary: () => window,
    guests: { getActiveGuest: () => guest, getActiveLease: () => guest === undefined || guest.isDestroyed() ? undefined : 'lease' },
    confirmVisible: async () => true,
  })
  const listener = await listenSidebarBrowserRelay(relay, process.env.FIXTURE_RELAY_DIRECTORY)
  let quitting = false
  const quit = async () => {
    if (quitting) return
    quitting = true
    await listener.close()
    server.closeAllConnections()
    await new Promise(resolve => { server.close(resolve) })
    app.quit()
  }
  const lines = createInterface({ input: process.stdin })
  lines.on('close', () => { void quit() })
  lines.on('line', async line => {
    const command = JSON.parse(line)
    let result
    if (command.method === 'close-guest') {
      const destroyed = new Promise(resolve => { guest.once('destroyed', resolve) })
      await window.webContents.executeJavaScript('document.querySelector("webview").remove()')
      await destroyed
      result = 'guest destroyed'
    } else if (command.method === 'state') {
      result = await guest.executeJavaScript('document.getElementById("out").textContent')
    } else if (command.method === 'ping') result = 'alive'
    else if (command.method === 'quit') { await quit(); return }
    process.stdout.write(JSON.stringify({ id: command.id, result }) + '\\n')
  })
  await window.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0"><webview src="' + origin + '/" partition="sidebar-e2e" style="position:absolute;inset:0"></webview></body>'))
  while (guest === undefined || guest.isLoading() || guest.getURL() !== origin + '/') await new Promise(resolve => { setTimeout(resolve, 50) })
  process.stdout.write(JSON.stringify({ socketPath: listener.socketPath, socketToken: listener.socketToken, origin }) + '\\n')
}).catch(error => { process.stderr.write('fixture startup failure: ' + error.message + '\\n'); app.exit(1) })
`

/** Await child exit even on setup failures; the isolated process group also owns Electron helpers. */
async function stopShell(child: ChildProcess | undefined): Promise<void> {
  if (child?.pid === undefined) return
  const pid = child.pid
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise<void>((resolve) => { child.once('exit', () => { resolve() }) })
  const killGroup = (signal: NodeJS.Signals): void => {
    try { process.kill(-pid, signal) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.stdin?.end(`${JSON.stringify({ method: 'quit' })}\n`)
  }
  const terminate = setTimeout(() => { killGroup('SIGTERM') }, 3_000)
  const force = setTimeout(() => { killGroup('SIGKILL') }, 6_000)
  try { await exited } finally {
    clearTimeout(terminate)
    clearTimeout(force)
    killGroup('SIGKILL')
  }
  const deadline = Date.now() + 5_000
  for (;;) {
    try { process.kill(-pid, 0) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
      throw error
    }
    if (Date.now() >= deadline) throw new Error('Electron process group remained after cleanup')
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
  }
}

const text = (result: ToolExecutionResult): string => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

interface Ready { socketPath: string; socketToken: string; origin: string }

describe.skipIf(process.platform === 'win32' || electronBinary === undefined)('Sidebar browser tools through a real Electron webview', () => {
  let directory: string | undefined
  let origin: string
  let shell: ChildProcess | undefined
  let disposal: (() => Promise<void>) | undefined
  let call: (name: string, args?: object) => Promise<ToolExecutionResult>
  let names: string[]
  let stderr = ''
  let fixtureCall: (method: string) => Promise<unknown>

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-sidebar-e2e-'))
    const esbuild = createRequire(createRequire(join(repository, 'package.json')).resolve('tsx/package.json'))('esbuild') as { build: (options: object) => Promise<unknown> }
    await esbuild.build({
      entryPoints: [fileURLToPath(new URL('../src/sidebar-browser-relay.ts', import.meta.url))],
      outfile: join(directory, 'relay.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['electron'], logLevel: 'silent',
    })
    await writeFile(join(directory, 'main.mjs'), FIXTURE_MAIN)
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'sidebar-e2e', type: 'module', main: 'main.mjs' }))
    shell = spawn(electronBinary!, [resolve(directory)], {
      cwd: repository, detached: true,
      env: { ...process.env, FIXTURE_USER_DATA: resolve(directory, 'user-data'), FIXTURE_RELAY_DIRECTORY: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    shell.stdin!.on('error', (_error: Error) => {
      // Electron can exit between a cleanup write and stdin closure; exit remains the cleanup signal.
    })
    shell.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384) })
    const pending = new Map<number, (result: unknown) => void>()
    let nextId = 1
    const ready = await new Promise<Ready>((accept, reject) => {
      const timer = setTimeout(() => { reject(new Error(`Electron did not become ready: ${stderr}`)) }, 15_000)
      shell!.once('error', (error) => { clearTimeout(timer); reject(error) })
      shell!.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Electron exited (${code}, ${signal}): ${stderr}`)) })
      createInterface({ input: shell!.stdout! }).on('line', (line) => {
        const message = JSON.parse(line) as Ready & { id?: number; result?: unknown }
        if (message.id !== undefined) pending.get(message.id)?.(message.result)
        else { clearTimeout(timer); accept(message) }
      })
    })
    fixtureCall = async (method) => {
      const id = nextId++
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await new Promise((accept, reject) => {
          pending.set(id, accept)
          timer = setTimeout(() => { reject(new Error(`Electron ${method} did not answer: ${stderr}`)) }, 5_000)
          shell!.stdin!.write(`${JSON.stringify({ id, method })}\n`)
        })
      } finally { clearTimeout(timer); pending.delete(id) }
    }
    const { ctx, agent } = await loadSidebarProvider(directory, Provider.Config({
      name: 'sidebar-browser', mode: 'sidebar', socketPath: ready.socketPath, socketToken: ready.socketToken,
      executablePath: fileURLToPath(new URL('../resources/sidebar-browser-connect', import.meta.url)),
      toolCallTimeoutMs: 15_000,
    }))
    disposal = () => ctx.fiber.dispose()
    names = ctx.tools.schemas(agent).map(tool => tool.name)
    call = async (name, args = {}) => ctx.tools.execute({
      agent, name: `mcp__sidebar-browser__${name}`, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal,
    })
    origin = ready.origin
  }, 45_000)

  afterAll(async () => {
    try {
      const results = await Promise.allSettled([stopShell(shell), Promise.resolve().then(() => disposal?.())])
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } finally {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('hides scripts and actions, rejects a direct evaluate call, and preserves the page', async () => {
    for (const name of ['browser_evaluate', 'browser_run_code_unsafe', 'browser_fill_form', 'browser_select_option', 'browser_click']) {
      expect(names).not.toContain(`mcp__sidebar-browser__${name}`)
    }
    expect((await call('browser_snapshot')).isError).toBe(false)
    expect(await fixtureCall('state')).toBe('idle')
    const result = await call('browser_evaluate', { function: '() => { document.getElementById("out").textContent = "changed" }' })
    expect(result.isError).toBe(true)
    expect(await fixtureCall('state')).toBe('idle')
    expect(text(await call('browser_snapshot'))).toContain('idle')
  })

  it('reads, screenshots, lists and navigates the tab, while actions and new tabs are refused', async () => {
    expect(text(await call('browser_snapshot'))).toContain('heading "Order list"')
    const screenshot = await call('browser_take_screenshot')
    expect(screenshot.isError).toBe(false)
    expect(screenshot.content.some(block => block.type === 'image')).toBe(true)
    expect((await readdir(join(directory!, '.playwright-mcp'))).some(name => /^page-.*\.png$/.test(name))).toBe(true)
    expect((await call('browser_tabs', { action: 'list' })).isError).toBe(false)
    expect((await call('browser_click', { element: 'Save', target: 'e1' })).isError).toBe(true)
    expect((await call('browser_tabs', { action: 'new' })).isError).toBe(true)
    expect(await fixtureCall('state')).toBe('idle')
    expect((await call('browser_navigate', { url: `${origin}/page2` })).isError).toBe(false)
    expect(text(await call('browser_snapshot'))).toContain('heading "Second page"')
    expect((await call('browser_navigate_back')).isError).toBe(false)
    expect(text(await call('browser_snapshot'))).toContain('heading "Order list"')
  })

  it('refuses filenames without creating or truncating files and rejects about:blank', async () => {
    const manifest = join(directory!, 'package.json')
    const original = await readFile(manifest, 'utf8')
    for (const rawName of ['browser_snapshot', 'browser_take_screenshot']) {
      const filename = `${rawName}.new`
      for (const target of ['package.json', filename]) {
        const result = await call(rawName, { filename: target })
        expect(await readFile(manifest, 'utf8')).toBe(original)
        expect(existsSync(join(directory!, filename))).toBe(false)
        expect(result.isError).toBe(true)
        expect(text(result)).toContain('filename is refused')
      }
    }
    const result = await call('browser_navigate', { url: 'about:blank' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('navigation requires an HTTP(S) URL')
    expect(text(await call('browser_snapshot'))).toContain('heading "Order list"')
  })

  it('keeps the main process alive without uncaught exceptions when the connected guest is closed', async () => {
    expect((await call('browser_snapshot')).isError).toBe(false)
    expect(await fixtureCall('close-guest')).toBe('guest destroyed')
    expect(await fixtureCall('ping')).toBe('alive')
    expect((await call('browser_snapshot')).isError).toBe(true)
    expect(shell!.exitCode).toBeNull()
    expect(shell!.signalCode).toBeNull()
    expect(stderr).not.toContain('fixture uncaught exception:')
  })
})
