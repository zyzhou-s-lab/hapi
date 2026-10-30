import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    })

    it('replaces a file through a temporary name', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-config-'))
        tempDirs.push(dir)
        const path = join(dir, 'settings.json')
        writeFileSync(path, '{"a":1}\n')
        writeTextAtomic(path, '{"a":1,"disabled":true}\n')
        expect(readFileSync(path, 'utf8')).toBe('{"a":1,"disabled":true}\n')
    })
})
