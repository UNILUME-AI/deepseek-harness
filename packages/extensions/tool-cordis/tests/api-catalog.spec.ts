/** Inspection callers can discover the local read check and its request types in the generated Host catalog. */
import { describe, expect, it } from 'vitest'
import { EVENT_API, SERVICE_API, queryEventApi, queryServiceApi } from '../src/api-catalog.ts'
import type { ServiceApiEntry } from '../src/api-catalog.ts'

describe('Host Cordis inspection catalog', () => {
  it('lists service signatures and exposes the local read check with its referenced request types', () => {
    expect(queryServiceApi()).toHaveProperty('mode', 'catalog')
    expect(queryServiceApi()).toHaveProperty('services.0.key', SERVICE_API[0]!.key)
    const result = queryServiceApi('sandboxPolicy') as {
      service: { methods: readonly { signature: string; parameters: readonly { name: string }[] }[] }
      referencedTypes: readonly { name: string }[]
    }
    expect(result.service.methods.find(method => method.signature.startsWith('readDenialCheck('))).toMatchObject({
      signature: 'readDenialCheck(request: SandboxPolicyRequest = {}): (path: string) => boolean',
      parameters: [{ name: 'request' }],
    })
    expect(result.referencedTypes.map(entry => entry.name)).toContain('SandboxPolicyRequest')
    expect(queryServiceApi('sandboxPolicy')).toHaveProperty('service.access.hardDependency.expression', 'ctx.sandboxPolicy')
  })

  it('describes a custom key with no callable members and rejects absent service keys', () => {
    const service: ServiceApiEntry = { key: 'custom-policy', summary: 'Fixture policy.', description: 'Fixture policy.', methods: [] }
    expect(queryServiceApi('custom-policy', [service])).toMatchObject({
      mode: 'service', service: { access: { hardDependency: { expression: 'ctx["custom-policy"]' } } }, referencedTypes: [],
    })
    expect(() => queryServiceApi('absent-service', [])).toThrow('no catalogued Service named "absent-service"')
  })

  it('lists event signatures and includes agent request types for an exact listener', () => {
    expect(queryEventApi()).toHaveProperty('mode', 'catalog')
    expect(queryEventApi()).toHaveProperty('events.0.name', EVENT_API[0]!.name)
    const result = queryEventApi('agent/request') as { referencedTypes: readonly { name: string }[] }
    expect(result.referencedTypes.map(entry => entry.name)).toContain('Agent')
    expect(queryEventApi('agent/request')).toHaveProperty('event.name', 'agent/request')
    expect(() => queryEventApi('absent/event', [])).toThrow('no catalogued Event named "absent/event"')
  })
})
