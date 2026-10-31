import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
    jsonStringField,
    setFrontmatterBoolean,
    setJsonBoolean,
    setJsonBooleanWhere,
    setTomlBoolean,
    writeTextAtomic,
} from './sessionConfigEdit'

const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('session config edits', () => {
    it('flips or inserts one JSON boolean and leaves comments and secrets in place', () => {
        const original = `{
  // keep
  "mcpServers": {
    "docs": {
      "command": "npx",
      "args": ["--token", "secret"]
    }
  }
}
`
        const disabled = setJsonBoolean(original, ['mcpServers', 'docs'], 'disabled', true)
        expect(disabled).toContain('// keep')
        expect(disabled).toContain('"args": ["--token", "secret"]')
        expect(disabled).toContain('"disabled": true')
        const enabled = setJsonBoolean(disabled, ['mcpServers', 'docs'], 'disabled', false)
        expect(enabled).toContain('"disabled": false')
        expect(enabled).toContain('"args": ["--token", "secret"]')
        expect(enabled).not.toContain('"disabled": true')
    })

    it('updates every matching hook object without rewriting the file', () => {
        const original = `{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Bash",
      "hooks": [{ "type": "command", "command": "node /opt/my-hook.js --token abc" }]
    }]
  }
}
`
        const next = setJsonBooleanWhere(
            original,
            (objectText) => jsonStringField(objectText, 'command') === 'node /opt/my-hook.js --token abc',
            'disabled',
            true,
        )
        expect(next).toContain('"command": "node /opt/my-hook.js --token abc"')
        expect(next).toContain('"disabled": true')
        expect(next).toContain('"matcher": "Bash"')
    })

    it('inserts a TOML boolean under one table and keeps comments', () => {
        const original = `# comment
[mcp_servers.docs]
command = "npx"
url = "http://example.test/?token=abc"

[mcp_servers.other]
command = "stay"
`
        const disabled = setTomlBoolean(original, 'mcp_servers.docs', 'enabled', false)
        expect(disabled).toContain('# comment')
        expect(disabled).toContain('url = "http://example.test/?token=abc"')
        expect(disabled).toContain('command = "stay"')
        expect(disabled).toMatch(/\[mcp_servers\.docs\]\nenabled = false\ncommand = "npx"/)
        const enabled = setTomlBoolean(disabled, 'mcp_servers.docs', 'enabled', true)
        expect(enabled).toContain('enabled = true')
        expect(enabled).not.toContain('enabled = false')
    })

    it('adds a frontmatter boolean without touching the markdown body', () => {
        const original = `---
name: docs
description: Read docs
---
# Hello token=keep
`
        const disabled = setFrontmatterBoolean(original, 'disabled', true)
        expect(disabled).toContain('description: Read docs')
        expect(disabled).toContain('disabled: true')
        expect(disabled).toContain('# Hello token=keep')
        expect(setFrontmatterBoolean(disabled, 'disabled', false)).toContain('disabled: false')
        const quoted = setFrontmatterBoolean('---\nname: docs\ndisabled: "true"\n---\n# Body\n', 'disabled', true)
        expect(quoted.match(/disabled:/g)).toHaveLength(1)
        expect(quoted).toContain('disabled: true\n')
        const yes = setFrontmatterBoolean('---\nname: docs\ndisabled: yes # keep\n---\n# Body\n', 'disabled', false)
        expect(yes).toContain('disabled: false # keep')
        expect(yes.match(/disabled:/g)).toHaveLength(1)
        const empty = setFrontmatterBoolean('---\nname: docs\ndisabled:\ndescription: keep\n---\n# Body\n', 'disabled', true)
        expect(empty).toContain('description: keep')
        expect(empty.match(/disabled:/g)).toHaveLength(1)
        expect(empty).toContain('disabled: true\n')
        expect(() => setFrontmatterBoolean('# Hello only\n', 'disabled', true)).toThrow('Skill has no frontmatter')
    })

    it('replaces a file through a temporary name', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-config-'))
        tempDirs.push(dir)
        const path = join(dir, 'settings.json')
        writeFileSync(path, '{"a":1}\n')
        writeTextAtomic(path, '{"a":1,"disabled":true}\n')
        expect(readFileSync(path, 'utf8')).toBe('{"a":1,"disabled":true}\n')
        expect(readFileSync(path, 'utf8')).toBe('{"a":1,"disabled":true}\n')
    })

    it('keeps mode 0600 when replacing through a symlink', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-config-'))
        tempDirs.push(dir)
        const path = join(dir, 'settings.json')
        const link = join(dir, 'link.json')
        writeFileSync(path, '{"a":1}\n', { mode: 0o600 })
        chmodSync(path, 0o600)
        symlinkSync(path, link)
        writeTextAtomic(link, '{"a":2}\n')
        expect(readFileSync(path, 'utf8')).toBe('{"a":2}\n')
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(statSync(path).mode & 0o777).toBe(0o600)
    })
})
