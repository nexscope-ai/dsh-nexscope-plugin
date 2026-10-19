/**
 * Integration test: mount the plugin on a real Cordis app with the real
 * credential and skill services.
 *
 * The unit tests use stubs; this test proves the plugin's `inject` list is
 * satisfiable, that `apply` registers on the real registries, and that the
 * bundled skill is discoverable through the real skill service. It never
 * contacts the network: no grant is stored, so the client stays idle.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import credentialsLocal from '@deepseek-ai/dsh-credentials-local'
import skills from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import tools from '@deepseek-ai/dsh-tools'
import systemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config, inject, name } from '../src/index.js'

let directory: string | undefined
let root: Context | undefined

afterEach(async () => {
  await root?.dispose?.()
  root = undefined
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

describe('plugin composition', () => {
  it('mounts on the real registries and publishes the bundled skill', async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-nexscope-'))
    root = new Context()
    root.plugin(systemPrompt as never, {})
    root.plugin(tools as never, {})
    root.plugin(skills as never, {})
    root.plugin(credentialsLocal as never, { path: join(directory, 'credentials.yaml') })
    root.plugin(skillFilesystem as never, { includeDefaultRoots: false, watch: false })
    root.plugin({ name, inject, Config, apply } as never, {})

    await new Promise((resolve) => setTimeout(resolve, 50))

    const registry = root.get('skills') as {
      list(options?: unknown): Promise<readonly { name: string }[]>
    }
    const available = await registry.list()
    expect(available.map((skill) => skill.name)).toContain('nexscope')

    const toolRegistry = root.get('tools') as {
      get(name: string): unknown
    }
    for (const owned of [
      'nexscope_sign_in',
      'nexscope_sign_out',
      'nexscope_status',
      'nexscope_find_tools',
      'nexscope_describe_tool',
      'nexscope_call_tool',
      'nexscope_export',
      'nexscope_account',
    ]) {
      expect(toolRegistry.get(owned), `${owned} should be registered`).toBeDefined()
    }
  })
})
