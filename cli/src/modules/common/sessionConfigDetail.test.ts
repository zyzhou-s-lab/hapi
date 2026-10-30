import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionConfigDetail, writeSessionConfigEnabled } from './sessionConfigDetail'

const tempDirs: string[] = []
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalCodexHome = process.env.CODEX_HOME
const originalClaudeJson = process.env.HAPI_CLAUDE_JSON

afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    if (originalClaudeJson === undefined) delete process.env.HAPI_CLAUDE_JSON
    else process.env.HAPI_CLAUDE_JSON = originalClaudeJson
})

describe('session config detail', () => {
    it('returns a hook script with secrets masked and can disable that hook', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-hook-'))
        tempDirs.push(dir)
        process.env.CLAUDE_CONFIG_DIR = dir
        const settingsPath = join(dir, 'settings.json')
        const scriptPath = join(dir, 'hook.sh')
        const apiLine = 'OPENAI_API_KEY=' + 'zz' + 'secret'
        const githubLine = 'GITHUB_TOKEN=' + 'zz' + 'github'
        writeFileSync(scriptPath, `${apiLine}\n${githubLine}\n`, { mode: 0o644 })
        writeFileSync(settingsPath, `{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "${scriptPath}" }]
    }]
  }
}
`)
        const detail = await readSessionConfigDetail({
            cwd: dir,
            flavor: 'claude',
            selector: { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', commandName: 'hook.sh', source: 'user' },
        })
        expect(detail).toMatchObject({ kind: 'hook', mutable: false, enabled: true })
        if (!('script' in detail)) throw new Error('missing script')
        expect(detail.script).toContain('OPENAI_API_KEY=***')
        expect(detail.script).toContain('GITHUB_TOKEN=***')
        expect(detail.script).not.toContain('zz' + 'secret')
        expect(detail.script).not.toContain('zz' + 'github')
        expect(detail.script).not.toContain('zzgithub')

        const toggled = await writeSessionConfigEnabled({
            cwd: dir,
            flavor: 'claude',
            enabled: false,
            selector: { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', commandName: 'my-hook', source: 'user' },
        })
        expect(toggled).toEqual({ error: 'This agent does not honor a per-item switch' })
        expect(readFileSync(settingsPath, 'utf8')).not.toContain('"disabled"')
        expect(readFileSync(settingsPath, 'utf8')).toContain('"matcher": "Bash"')
    })

    it('refuses to change an injected item', async () => {
        await expect(writeSessionConfigEnabled({
            cwd: '/tmp',
            flavor: 'claude',
            enabled: false,
            selector: { kind: 'mcp', name: 'hapi', source: 'injected' },
        })).resolves.toEqual({ error: 'This item cannot be changed' })
    })
    it('toggles a Claude project server stored under projects and deletes disabled when re-enabled', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-project-mcp-'))
        tempDirs.push(dir)
        const claudeJson = join(dir, '.claude.json')
        process.env.HAPI_CLAUDE_JSON = claudeJson
        writeFileSync(claudeJson, JSON.stringify({
            projects: { [dir]: { mcpServers: { docs: { command: 'npx', disabled: true } } } },
        }))
        const enabled = await writeSessionConfigEnabled({
            cwd: dir,
            flavor: 'claude',
            enabled: true,
            selector: { kind: 'mcp', name: 'docs', source: 'project' },
        })
        expect(enabled).toEqual({ enabled: true })
        expect(readFileSync(claudeJson, 'utf8')).not.toContain('disabled')
        const disabled = await writeSessionConfigEnabled({
            cwd: dir,
            flavor: 'claude',
            enabled: false,
            selector: { kind: 'mcp', name: 'docs', source: 'project' },
        })
        expect(disabled).toEqual({ enabled: false })
        expect(JSON.parse(readFileSync(claudeJson, 'utf8')).projects[dir].mcpServers.docs.disabled).toBe(true)
    })

    it('writes only the selected Codex mcp server boolean', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-codex-mcp-'))
        tempDirs.push(dir)
        process.env.CODEX_HOME = dir
        const path = join(dir, 'config.toml')
        writeFileSync(path, '[mcp_servers.docs]\ncommand = "npx"\n\n[mcp_servers.other]\ncommand = "keep"\n')
        const disabled = await writeSessionConfigEnabled({
            cwd: dir,
            flavor: 'codex',
            enabled: false,
            selector: { kind: 'mcp', name: 'docs', source: 'user' },
        })
        expect(disabled).toEqual({ enabled: false })
        const written = readFileSync(path, 'utf8')
        expect(written).toContain('enabled = false')
        expect(written).toContain('command = "keep"')
        expect(written).toContain('[mcp_servers.docs]')
    })

    it('returns a skill body without its frontmatter', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-skill-'))
        tempDirs.push(dir)
        const skillDir = join(dir, '.agents', 'skills', 'docs')
        mkdirSync(skillDir, { recursive: true })
        writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: docs\ndescription: Read docs\n---\n# Body only\n')
        const detail = await readSessionConfigDetail({
            cwd: dir,
            flavor: 'claude',
            selector: { kind: 'skill', name: 'docs', source: 'project' },
        })
        expect(detail).toMatchObject({ kind: 'skill', markdown: '# Body only\n' })
        if (!('markdown' in detail)) throw new Error('missing markdown')
        expect(detail.markdown).not.toContain('description:')
    })
})