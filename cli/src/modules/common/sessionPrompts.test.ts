import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearSessionPromptLive, collectSessionPrompts, getSessionPromptLive, readSessionPromptDetail, setSessionPromptLive } from './sessionPrompts'

const dirs: string[] = []

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-prompts-'))
    dirs.push(dir)
    return dir
}
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

function titles(cwd: string, home: string, flavor: string, extra: Parameters<typeof collectSessionPrompts>[0] = { flavor, cwd, home }) {
    return collectSessionPrompts({ ...extra, flavor, cwd, home }).prompts
}

describe('session prompts', () => {
    it('skips AGENTS.md when a Claude project CLAUDE.md exists and marks path rules', () => {
        const home = tempDir()
        const cwd = tempDir()
        mkdirSync(join(cwd, '.claude', 'rules'), { recursive: true })
        writeFileSync(join(cwd, 'CLAUDE.md'), 'Use bun.\nOPENAI_API_KEY=zzsecret\n')
        writeFileSync(join(cwd, 'AGENTS.md'), 'Do not load this agents file.')
        writeFileSync(join(cwd, '.claude', 'rules', 'api.md'), '---\npaths:\n  - src/**/*.ts\n---\nCheck the API.\n')
        const prompts = titles(cwd, home, 'claude', { flavor: 'claude', cwd, home, env: { CLAUDE_CONFIG_DIR: join(home, '.claude') } })
        const user = prompts?.user?.items ?? []
        expect(user.map((item) => item.title)).toContain('CLAUDE.md')
        expect(user.map((item) => item.title)).not.toContain('AGENTS.md')
        const rule = user.find((item) => item.title === 'api.md')
        expect(rule?.load).toBe('path')
        expect(rule?.match).toBe('src/**/*.ts')
        const claude = user.find((item) => item.title === 'CLAUDE.md')
        expect(claude?.preview).toContain('OPENAI_API_KEY=***')
        expect(claude?.preview).not.toContain('zzsecret')
        expect(prompts?.system?.items[0]?.title).toBe('append-system-prompt')
        expect(prompts?.system?.note).toBe('claude-builtin')
    })

    it('does not follow a symlinked instruction file', () => {
        const home = tempDir()
        const cwd = tempDir()
        const outside = tempDir()
        writeFileSync(join(outside, 'secret.md'), 'OPENAI_API_KEY=from-link')
        symlinkSync(join(outside, 'secret.md'), join(cwd, 'CLAUDE.md'))
        const prompts = titles(cwd, home, 'claude', { flavor: 'claude', cwd, home, env: {} })
        expect(JSON.stringify(prompts)).not.toContain('from-link')
        expect(prompts?.user?.items.find((item) => item.pathLabel === 'CLAUDE.md')).toBeUndefined()
    })

    it('marks a Claude instruction truncated instead of dropping it', () => {
        const home = tempDir()
        const cwd = tempDir()
        writeFileSync(join(cwd, 'CLAUDE.md'), `${'word '.repeat(40000)}\n`)
        const prompts = titles(cwd, home, 'claude', { flavor: 'claude', cwd, home, env: {} })
        const item = prompts?.user?.items.find((entry) => entry.title === 'CLAUDE.md')
        expect(item?.truncated).toBe(true)
        const detail = readSessionPromptDetail({ flavor: 'claude', cwd, home, env: {}, id: item?.id ?? '' })
        expect('markdown' in detail ? detail.markdown.length : 0).toBeLessThanOrEqual(128 * 1024)
        expect('truncated' in detail ? detail.truncated : false).toBe(true)
    })

    it('prefers Codex AGENTS.override.md and marks files past the merge cap', () => {
        const home = tempDir()
        const cwd = tempDir()
        mkdirSync(join(home, '.codex'), { recursive: true })
        writeFileSync(join(home, '.codex', 'config.toml'), 'project_doc_max_bytes = 8\nproject_doc_fallback_filenames = ["TEAM_GUIDE.md"]\n')
        writeFileSync(join(home, '.codex', 'AGENTS.md'), 'global base')
        writeFileSync(join(home, '.codex', 'AGENTS.override.md'), 'global override')
        mkdirSync(join(cwd, '.git'))
        writeFileSync(join(cwd, 'AGENTS.md'), 'project agents that should lose')
        writeFileSync(join(cwd, 'AGENTS.override.md'), 'project override is long enough')
        writeFileSync(join(cwd, 'TEAM_GUIDE.md'), 'fallback not used')
        const prompts = titles(cwd, home, 'codex', { flavor: 'codex', cwd, home, startingMode: 'local', env: { CODEX_HOME: join(home, '.codex') } })
        const names = prompts?.user?.items.map((item) => `${item.scope}:${item.title}`)
        expect(names).toContain('user:AGENTS.override.md')
        expect(names).not.toContain('user:AGENTS.md')
        expect(names).toContain('project:AGENTS.override.md')
        expect(names).not.toContain('project:TEAM_GUIDE.md')
        expect(prompts?.user?.items.some((item) => item.codexCapped)).toBe(true)
        expect(prompts?.system?.items[0]?.title).toBe('developer_instructions')
    })

    it('does not count a large global Codex file toward the project byte cap', () => {
        const home = tempDir()
        const cwd = tempDir()
        mkdirSync(join(home, '.codex'), { recursive: true })
        mkdirSync(join(cwd, '.git'))
        writeFileSync(join(home, '.codex', 'config.toml'), 'project_doc_max_bytes = 32\n')
        writeFileSync(join(home, '.codex', 'AGENTS.md'), 'g'.repeat(10_000))
        writeFileSync(join(cwd, 'AGENTS.md'), 'small project file')
        const prompts = titles(cwd, home, 'codex', { flavor: 'codex', cwd, home, startingMode: 'local', env: { CODEX_HOME: join(home, '.codex') } })
        const globalFile = prompts?.user?.items.find((item) => item.scope === 'user')
        const project = prompts?.user?.items.find((item) => item.scope === 'project')
        expect(globalFile?.codexCapped).toBeUndefined()
        expect(project?.codexCapped).toBeUndefined()
        expect(project?.title).toBe('AGENTS.md')
    })

    it('drops live prompt state when the session ends', () => {
        setSessionPromptLive('session-end', { claude: { custom: 'kept' } })
        expect(getSessionPromptLive('session-end')?.claude?.custom).toBe('kept')
        clearSessionPromptLive('session-end')
        expect(getSessionPromptLive('session-end')).toBeUndefined()
    })

    it('lets an OpenCode AGENTS.md replace CLAUDE.md and does not fetch a URL', () => {
        const home = tempDir()
        const cwd = tempDir()
        mkdirSync(join(cwd, '.git'))
        writeFileSync(join(cwd, 'AGENTS.md'), 'Use the repo agents file.')
        writeFileSync(join(cwd, 'CLAUDE.md'), 'This claude file loses.')
        writeFileSync(join(cwd, 'opencode.json'), JSON.stringify({
            instructions: ['https://example.invalid/secret-token-do-not-fetch', 'AGENTS.md'],
        }))
        const prompts = titles(cwd, home, 'opencode', { flavor: 'opencode', cwd, home, startingMode: 'local', env: {}, hapiHome: home })
        const project = prompts?.user?.items.filter((item) => item.scope === 'project') ?? []
        expect(project.map((item) => item.title)).toContain('AGENTS.md')
        expect(project.map((item) => item.title)).not.toContain('CLAUDE.md')
        expect(project.some((item) => item.title === 'remote-url' && item.hasText === false)).toBe(true)
        expect(JSON.stringify(prompts)).not.toContain('example.invalid')
        expect(JSON.stringify(prompts)).not.toContain('secret-token-do-not-fetch')
    })

    it('lists every Cursor mdc and marks globs as path-scoped', () => {
        const home = tempDir()
        const cwd = tempDir()
        mkdirSync(join(cwd, '.git'))
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true })
        writeFileSync(join(cwd, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nAlways on.\n')
        writeFileSync(join(cwd, '.cursor', 'rules', 'api.mdc'), '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nAPI rules.\n')
        writeFileSync(join(cwd, '.cursor', 'rules', 'ignored.md'), 'not a rule')
        const prompts = titles(cwd, home, 'cursor', { flavor: 'cursor', cwd, home, env: {} })
        const titlesFound = prompts?.user?.items.map((item) => item.title)
        expect(titlesFound).toContain('always.mdc')
        expect(titlesFound).toContain('api.mdc')
        expect(titlesFound).not.toContain('ignored.md')
        expect(prompts?.user?.items.find((item) => item.title === 'api.mdc')?.load).toBe('path')
        expect(prompts?.user?.items.find((item) => item.title === 'api.mdc')?.match).toBe('src/**/*.ts')
        expect(prompts?.system?.note).toBe('no-hapi-system')
        expect(prompts?.user?.items.some((item) => item.title === 'cursor-account' && item.hasText === false)).toBe(true)
    })

    it('shows omp on-demand rules with globs and trigger regexes', () => {
        const home = tempDir()
        const cwd = tempDir()
        mkdirSync(join(cwd, '.git'))
        mkdirSync(join(cwd, '.cursor', 'rules'), { recursive: true })
        mkdirSync(join(cwd, '.omp', 'rules'), { recursive: true })
        mkdirSync(join(cwd, '.github', 'instructions'), { recursive: true })
        writeFileSync(join(cwd, 'AGENTS.md'), 'Codex agents text.')
        writeFileSync(join(cwd, '.cursor', 'rules', 'api.mdc'), '---\nglobs: src/**/*.ts\n---\nCursor body.\n')
        writeFileSync(join(cwd, '.github', 'instructions', 'style.instructions.md'), '---\napplyTo: "**/*.ts"\n---\nCopilot body.\n')
        writeFileSync(join(cwd, '.omp', 'rules', 'careful.md'), '---\ncondition: "rm -rf"\n---\nStop.\n')
        const prompts = titles(cwd, home, 'omp', {
            flavor: 'omp',
            cwd,
            home,
            env: { PI_CODING_AGENT_DIR: join(home, 'agent') },
            promptLive: { omp: { systemPrompt: ['omp system'] } },
        })
        expect(prompts?.system?.items.map((item) => item.preview)).toContain('omp system')
        const user = prompts?.user?.items ?? []
        expect(user.find((item) => item.title === 'api.mdc')?.load).toBe('demand')
        expect(user.find((item) => item.title === 'api.mdc')?.match).toContain('src/**/*.ts')
        expect(user.find((item) => item.title === 'style.instructions.md')?.match).toContain('**/*.ts')
        expect(user.find((item) => item.title === 'careful.md')?.match).toContain('rm -rf')
        expect(user.find((item) => item.title === 'AGENTS.md')?.load).toBe('demand')
    })

    it('reports no user files for flavors that do not read them', () => {
        const home = tempDir()
        const cwd = tempDir()
        writeFileSync(join(cwd, 'GEMINI.md'), 'do not read')
        const prompts = titles(cwd, home, 'pi', { flavor: 'pi', cwd, home, env: {} })
        expect(prompts?.system?.availability).toBe('none')
        expect(prompts?.user?.items).toEqual([])
        expect(JSON.stringify(prompts)).not.toContain('do not read')
    })
})
