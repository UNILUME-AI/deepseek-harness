/** Test-only composition exercising Sidebar tools through the shipped provider and ToolRuntime. */
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import AttachmentLocal from '@deepseek-ai/dsh-attachment-local'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as Provider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'

class FixtureImageModel extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }
  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('Sidebar fixture never requests a model turn')
  }
}

/**
 * Start the real Sidebar provider without requesting a model turn.
 * @param directory - caller-owned fixture directory.
 * @param config - validated Sidebar provider settings.
 * @returns context and Agent; the caller must await context disposal.
 */
export async function loadSidebarProvider(directory: string, config: Provider.Config): Promise<{ ctx: Context; agent: Agent }> {
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['attachments', AttachmentLocal],
    ['model', { inject: ['llm'], apply(ctx: Context) {
      ctx.effect(() => ctx.llm.registerAdapter(['sidebar-fixture'], new FixtureImageModel()))
    } }],
    ['browser', Provider],
  ])
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name, name, config: name === 'browser' ? config : name === 'loop' ? { agents: [] }
      : name === 'attachments' ? { dshHome: resolve(directory, 'home') } : {},
  }))), { mode: 0o600 })
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
        return modules.get(specifier)
      },
    } as never
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('sidebar-owner'), agentOptions: { provider: 'sidebar-fixture', model: 'vision' },
      meta: { cwd: resolve(directory) },
    })
    return { ctx, agent }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
