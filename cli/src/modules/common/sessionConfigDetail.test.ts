import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
    it('refuses to write disabled on a Claude MCP server because Claude does not honor it', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-project-mcp-'))
        tempDirs.push(dir)
        const claudeJson = join(dir, '.claude.json')
        process.env.HAPI_CLAUDE_JSON = claudeJson
        const original = JSON.stringify({
            projects: { [dir]: { mcpServers: { docs: { command: 'npx', disabled: true } } } },
        })
        writeFileSync(claudeJson, original)
        const detail = await readSessionConfigDetail({
            cwd: dir,
            flavor: 'claude',
            selector: { kind: 'mcp', name: 'docs', source: 'project' },
        })
        expect(detail).toMatchObject({ kind: 'mcp', mutable: false, enabled: false })
        const toggled = await writeSessionConfigEnabled({
            cwd: dir,
            flavor: 'claude',
            enabled: true,
            selector: { kind: 'mcp', name: 'docs', source: 'project' },
        })
        expect(toggled).toEqual({ error: 'This agent does not honor a per-item switch' })
        expect(readFileSync(claudeJson, 'utf8')).toBe(original)
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

    it('writes only disabled in the winning user SKILL.md, including outside the workspace', async () => {
        const home = mkdtempSync(join(tmpdir(), 'hapi-skill-home-'))
        const cwd = mkdtempSync(join(tmpdir(), 'hapi-skill-cwd-'))
        tempDirs.push(home, cwd)
        const originalHome = process.env.HOME
        process.env.HOME = home
        try {
            const skillDir = join(home, '.agents', 'skills', 'agent-browser')
            const claudeDir = join(home, '.claude', 'skills', 'agent-browser')
            const ompDir = join(home, '.omp', 'agent', 'agent-browser')
            mkdirSync(skillDir, { recursive: true })
            mkdirSync(claudeDir, { recursive: true })
            mkdirSync(ompDir, { recursive: true })
            const body = '---\nname: agent-browser\ndescription: Drive a browser\n---\n# Keep this body\n'
            writeFileSync(join(skillDir, 'SKILL.md'), body)
            writeFileSync(join(claudeDir, 'SKILL.md'), '---\nname: agent-browser\ndescription: other\n---\n# Other\n')
            writeFileSync(join(ompDir, 'SKILL.md'), '---\nname: agent-browser\ndescription: omp\n---\n# Omp\n')

            const disabled = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'agent-browser', source: 'user' },
            })
            expect(disabled).toEqual({ enabled: false })
            const written = readFileSync(join(skillDir, 'SKILL.md'), 'utf8')
            expect(written).toBe('---\nname: agent-browser\ndescription: Drive a browser\ndisabled: true\n---\n# Keep this body\n')
            expect(readFileSync(join(claudeDir, 'SKILL.md'), 'utf8')).not.toContain('disabled:')
            expect(readFileSync(join(ompDir, 'SKILL.md'), 'utf8')).not.toContain('disabled:')

            const linkedDir = join(home, '.agents', 'skills', 'linked')
            const claudeLinked = join(home, '.claude', 'skills', 'linked')
            mkdirSync(linkedDir, { recursive: true })
            mkdirSync(claudeLinked, { recursive: true })
            const real = join(claudeLinked, 'SKILL.md')
            writeFileSync(real, '---\nname: linked\ndescription: Linked\n---\n# Linked body\n')
            symlinkSync(real, join(linkedDir, 'SKILL.md'))
            const linked = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'linked', source: 'user' },
            })
            expect(linked).toEqual({ error: 'Only a SKILL.md frontmatter disabled field can be changed' })
            expect(readFileSync(real, 'utf8')).not.toContain('disabled:')
            expect(lstatSync(join(linkedDir, 'SKILL.md')).isSymbolicLink()).toBe(true)

            const outsideDir = join(home, '.agents', 'skills', 'outside')
            const sharedDir = join(home, 'shared')
            mkdirSync(outsideDir, { recursive: true })
            mkdirSync(sharedDir, { recursive: true })
            const outsideFile = join(sharedDir, 'SKILL.md')
            writeFileSync(outsideFile, '---\nname: outside\ndescription: Outside\n---\n# Outside\n')
            symlinkSync(outsideFile, join(outsideDir, 'SKILL.md'))
            const outside = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'outside', source: 'user' },
            })
            expect(outside).toEqual({ error: 'Only a SKILL.md frontmatter disabled field can be changed' })
            expect(readFileSync(outsideFile, 'utf8')).not.toContain('disabled:')

            const escapeDir = join(home, '.agents', 'skills', 'escape')
            mkdirSync(escapeDir, { recursive: true })
            const notes = join(home, 'notes.txt')
            writeFileSync(notes, '---\nname: escape\ndescription: Escape\n---\n# Secret\n')
            symlinkSync(notes, join(escapeDir, 'SKILL.md'))
            const refused = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'escape', source: 'user' },
            })
            expect(refused).toEqual({ error: 'Only a SKILL.md frontmatter disabled field can be changed' })
            expect(readFileSync(notes, 'utf8')).not.toContain('disabled:')

            const bridgeOutside = join(home, '.claude', 'skills', 'bridge')
            mkdirSync(bridgeOutside, { recursive: true })
            const bridgeFile = join(bridgeOutside, 'SKILL.md')
            writeFileSync(bridgeFile, '---\nname: bridge\ndescription: Bridge\n---\n# Bridge\n')
            const bridgeDir = join(cwd, '.agents', 'skills', 'bridge')
            mkdirSync(bridgeDir, { recursive: true })
            symlinkSync(bridgeFile, join(bridgeDir, 'SKILL.md'))
            const bridge = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'bridge', source: 'project' },
            })
            expect(bridge).toEqual({ error: 'Only a SKILL.md frontmatter disabled field can be changed' })
            expect(readFileSync(bridgeFile, 'utf8')).not.toContain('disabled:')

            rmSync(join(cwd, '.agents', 'skills'), { recursive: true, force: true })
            const rootedOutside = join(home, 'rooted-skills')
            mkdirSync(join(rootedOutside, 'rooted'), { recursive: true })
            const rootedFile = join(rootedOutside, 'rooted', 'SKILL.md')
            writeFileSync(rootedFile, '---\nname: rooted\ndescription: Rooted\n---\n# Rooted\n')
            symlinkSync(rootedOutside, join(cwd, '.agents', 'skills'))
            const rooted = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'rooted', source: 'project' },
            })
            expect(rooted).toEqual({ error: 'Only a SKILL.md frontmatter disabled field can be changed' })
            expect(readFileSync(rootedFile, 'utf8')).not.toContain('disabled:')

            rmSync(join(cwd, '.agents'), { recursive: true, force: true })
            const parentOutside = join(home, 'agents-link')
            mkdirSync(join(parentOutside, 'skills', 'escaped'), { recursive: true })
            const escapedFile = join(parentOutside, 'skills', 'escaped', 'SKILL.md')
            writeFileSync(escapedFile, '---\nname: escaped\ndescription: Escaped\n---\n# Escaped\n')
            symlinkSync(parentOutside, join(cwd, '.agents'))
            const escaped = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'escaped', source: 'project' },
            })
            expect(escaped).toEqual({ error: 'Only a SKILL.md frontmatter disabled field can be changed' })
            expect(readFileSync(escapedFile, 'utf8')).not.toContain('disabled:')

            const system = await writeSessionConfigEnabled({
                cwd,
                flavor: 'omp',
                enabled: false,
                selector: { kind: 'skill', name: 'agent-browser', source: 'system' },
            })
            expect(system).toEqual({ error: 'This item cannot be changed' })
            expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf8')).toBe(written)
        } finally {
            if (originalHome === undefined) delete process.env.HOME
            else process.env.HOME = originalHome
        }
    })
})