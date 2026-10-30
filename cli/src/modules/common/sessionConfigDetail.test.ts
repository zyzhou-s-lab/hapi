import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSessionConfigDetail, writeSessionConfigEnabled } from './sessionConfigDetail'

const tempDirs: string[] = []
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('session config detail', () => {
    it('returns a hook script with secrets masked and can disable that hook', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-hook-'))
        tempDirs.push(dir)
        process.env.CLAUDE_CONFIG_DIR = dir
        const settingsPath = join(dir, 'settings.json')
        writeFileSync(settingsPath, `{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "my-hook --token secret-value" }]
    }]
  }
}
`)
        const detail = await readSessionConfigDetail({
            cwd: dir,
            flavor: 'claude',
            selector: { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', commandName: 'my-hook', source: 'user' },
        })
        expect(detail).toMatchObject({ kind: 'hook', mutable: true, enabled: true })
        if (!('script' in detail)) throw new Error('missing script')
        expect(detail.script).toContain('--token ***')
        expect(detail.script).not.toContain('secret-value')

        const toggled = await writeSessionConfigEnabled({
            cwd: dir,
            flavor: 'claude',
            enabled: false,
            selector: { kind: 'hook', event: 'PreToolUse', matcher: 'Bash', commandName: 'my-hook', source: 'user' },
        })
        expect(toggled).toEqual({ enabled: false })
        const written = readFileSync(settingsPath, 'utf8')
        expect(written).toContain('"disabled": true')
        expect(written).toContain('my-hook --token secret-value')
        expect(written).toContain('"matcher": "Bash"')
    })

    it('refuses to change an injected item', async () => {
        await expect(writeSessionConfigEnabled({
            cwd: '/tmp',
            flavor: 'claude',
            enabled: false,
            selector: { kind: 'mcp', name: 'hapi', source: 'injected' },
        })).resolves.toEqual({ error: 'This item cannot be changed' })
    })
})