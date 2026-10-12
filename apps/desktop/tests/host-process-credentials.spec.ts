import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopHostProcess } from '../src/host-process.ts'
import type { DesktopCredentialHostRequest, DesktopCredentialHostResponse } from '../src/credential-host.ts'
import type { CredentialId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const roots: string[] = []
const hosts: DesktopHostProcess[] = []

/**
 * The child sends one credential-list and one credential-fill request after reporting
 * readiness, records every answer into `answers.json` inside its profile directory,
 * and shuts down cleanly on request.
 */
const CREDENTIAL_HOST = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const answers = []
process.on('message', message => {
  if (message.type === 'credentials-list' || message.type === 'credentials-fill') {
    answers.push(message)
    writeFileSync(join(process.argv[3], 'answers.json'), JSON.stringify(answers))
    return
  }
  if (message.type !== 'shutdown') return
  process.send({ type: 'shutdown-complete' }, () => process.disconnect())
})
process.send({ type: 'ready', url: 'http://127.0.0.1:1/?token=fixture' })
process.send({ type: 'credentials-list', requestId: 11 })
process.send({ type: 'credentials-fill', requestId: 12, credentialId: '00000000-0000-4000-8000-000000000001', fields: ['username', 'password'] })
`

const INVALID_HOST = `
process.send({ type: 'ready', url: 'http://127.0.0.1:1/?token=fixture' })
process.send({ type: 'credentials-fill', requestId: 5, credentialId: 'x', fields: ['bogus'] })
process.on('message', message => {
  if (message.type === 'shutdown') process.send({ type: 'shutdown-complete' }, () => process.disconnect())
})
`

function projectWithHost(source = CREDENTIAL_HOST): string {
  const project = mkdtempSync(join(tmpdir(), 'dsh-desktop-host-credential-'))
  roots.push(project)
  const packageRoot = join(project, 'node_modules', '@deepseek-ai', 'dsh-desktop-host')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), '{"name":"@deepseek-ai/dsh-desktop-host","type":"module"}\n')
  writeFileSync(join(packageRoot, 'lib', 'index.js'), source)
  return project
}

function hostProcess(
  project: string,
  onCredentialRequest?: (request: DesktopCredentialHostRequest) => Promise<DesktopCredentialHostResponse>,
  onFailure?: (error: Error) => void,
): DesktopHostProcess {
  const host = new DesktopHostProcess(process.execPath, project, project, undefined, process.env, onFailure,
    undefined, undefined, undefined, onCredentialRequest)
  hosts.push(host)
  return host
}

async function answers(project: string): Promise<unknown[]> {
  let parsed: unknown[] = []
  await vi.waitFor(() => {
    parsed = JSON.parse(readFileSync(join(project, 'answers.json'), 'utf8')) as unknown[]
    expect(parsed).toHaveLength(2)
  }, { timeout: 5000 })
  return parsed
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.stop()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('desktop host credential channel', () => {
  it('forwards both request kinds to the handler and relays its category-only answers', async () => {
    const seen: DesktopCredentialHostRequest[] = []
    const project = projectWithHost()
    const host = hostProcess(project, async (request): Promise<DesktopCredentialHostResponse> => {
      seen.push(request)
      if (request.type === 'credentials-list') {
        return {
          site: 'https://example.com',
          entries: [{ id: '00000000-0000-4000-8000-000000000001' as CredentialId, origin: 'https://example.com', label: 'Shop', username: 'alice', hasTotp: false }],
        }
      }
      return { filled: ['username'], notFound: ['password'] }
    })
    await host.start()
    expect(await answers(project)).toEqual([
      {
        type: 'credentials-list', requestId: 11, site: 'https://example.com',
        entries: [{ id: '00000000-0000-4000-8000-000000000001', origin: 'https://example.com', label: 'Shop', username: 'alice', hasTotp: false }],
      },
      { type: 'credentials-fill', requestId: 12, filled: ['username'], notFound: ['password'] },
    ])
    expect(seen).toEqual([
      { type: 'credentials-list' },
      { type: 'credentials-fill', credentialId: '00000000-0000-4000-8000-000000000001', fields: ['username', 'password'] },
    ])
  })

  it('answers unavailable when no handler is installed', async () => {
    const project = projectWithHost()
    const host = hostProcess(project)
    await host.start()
    expect(await answers(project)).toEqual([
      { type: 'credentials-list', requestId: 11, error: 'unavailable' },
      { type: 'credentials-fill', requestId: 12, error: 'unavailable' },
    ])
  })

  it('answers error when the handler rejects, without forwarding its diagnostic', async () => {
    const project = projectWithHost()
    const host = hostProcess(project, async () => { throw new Error('vault contains fixture-secret') })
    await host.start()
    const received = await answers(project)
    expect(received).toEqual([
      { type: 'credentials-list', requestId: 11, error: 'error' },
      { type: 'credentials-fill', requestId: 12, error: 'error' },
    ])
    expect(JSON.stringify(received)).not.toContain('fixture-secret')
  })

  it('fails the host on a structurally invalid credential request', async () => {
    const onFailure = vi.fn()
    const host = hostProcess(projectWithHost(INVALID_HOST), undefined, onFailure)
    await host.start()
    await vi.waitFor(() => { expect(onFailure).toHaveBeenCalled() })
    expect(String(onFailure.mock.calls[0]![0])).toContain('invalid IPC event')
  })
})
