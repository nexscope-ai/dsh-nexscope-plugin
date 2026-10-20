import { Context } from '@deepseek-ai/cordis'
import tools from '@deepseek-ai/dsh-tools'
import skills from '@deepseek-ai/dsh-skill'
import systemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as skillFs from '@deepseek-ai/dsh-skill-filesystem'
import credentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as plugin from './lib/index.js'

const dir = await mkdtemp(join(tmpdir(), 'verify-'))
const root = new Context()
root.plugin(systemPrompt, {})
root.plugin(tools, {})
root.plugin(skills, {})
root.plugin(credentialsLocal, { path: join(dir, 'credentials.yaml') })
root.plugin(skillFs, { includeDefaultRoots: false, watch: false })
root.plugin({ name: plugin.name, inject: plugin.inject, Config: plugin.Config, apply: plugin.apply }, {})
await new Promise((r) => setTimeout(r, 300))

const registry = root.get('skills')
const summaries = await registry.list()
const entry = summaries.find((s) => s.name === 'nexscope')
const toolNames = ['nexscope_sign_in','nexscope_sign_out','nexscope_status','nexscope_find_tools','nexscope_describe_tool','nexscope_call_tool','nexscope_export','nexscope_account']
const toolRegistry = root.get('tools')
const registered = toolNames.filter((n) => toolRegistry.get(n) !== undefined)

console.log('plugin name      :', plugin.name)
console.log('inject           :', plugin.inject.join(', '))
console.log('skill in catalog :', entry !== undefined)
console.log('skill description:', (entry?.description ?? '').slice(0, 60) + '...')
console.log('skill provider   :', entry?.provider, '| source:', entry?.source)
console.log('tools registered :', registered.length + '/' + toolNames.length)
console.log('missing          :', toolNames.filter((n) => !registered.includes(n)).join(', ') || '(none)')
await root.dispose?.()
