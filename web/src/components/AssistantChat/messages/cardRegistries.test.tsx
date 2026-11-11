// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import type { ToolCallBlock } from '@/chat/types'
import {
    TOOL_PREVIEW_RENDERERS,
    TOOL_STEP_PREVIEW_PLUGINS,
    getToolPreviewRenderer,
} from '@/components/AssistantChat/messages/toolPreviewRegistry'
import {
    STANDALONE_BLOCK_RENDERER_REGISTRY,
    getStandaloneBlockRegistration,
    isStandaloneBlockKind,
} from '@/components/AssistantChat/messages/standaloneBlockRendererRegistry'
import { StepInlinePreviewCard } from '@/components/AssistantChat/messages/TimelineStepRows'
import { describeTurnToolStep, type TurnToolRow } from '@/components/AssistantChat/messages/turnBlockModel'
import {
    buildTurnHeadersById,
    getTurnCopyableText,
    type TurnEntitySnapshot,
} from '@/lib/assistant-runtime-blocks'

function makeToolBlock(id: string, name: string, extra: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1_700_000_000_000,
        children: [],
        tool: {
            id,
            name,
            state: 'completed',
            input: {},
            createdAt: 1_700_000_000_000,
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_001_000,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            ...extra,
        },
    }
}

function makeToolRow(block: ToolCallBlock, overrides: Partial<TurnToolRow> = {}): TurnToolRow {
    return {
        kind: 'tool',
        key: block.id,
        block,
        verb: block.tool.name,
        intent: '',
        pinned: false,
        error: block.tool.state === 'error',
        permission: false,
        ...overrides,
    }
}

describe('toolPreviewRegistry', () => {
    it('registers all 6 custom preview plugins plus the default fallback renderer', () => {
        expect(TOOL_STEP_PREVIEW_PLUGINS.map((plugin) => plugin.kind)).toEqual([
            'compaction',
            'web-fetch',
            'web-search',
            'bash',
            'file-read',
            'file-diff',
        ])
        for (const plugin of TOOL_STEP_PREVIEW_PLUGINS) {
            expect(getToolPreviewRenderer(plugin.kind)).toBe(plugin.PreviewComponent)
        }
        expect(typeof TOOL_PREVIEW_RENDERERS.default).toBe('function')
    })

    it('routes each preview kind through describeTurnToolStep and StepInlinePreviewCard with stable testids', () => {
        const cases: Array<{
            row: TurnToolRow
            expectedKind: string
            expectedTestId: string
            expectedText: string
        }> = [
            {
                row: makeToolRow(
                    makeToolBlock('c1', 'ContextCompaction', {
                        input: {
                            strategy: 'snapcompact',
                            reason: 'context-full',
                            tokensSaved: 4200,
                            result: { shortSummary: 'Archived earlier exploration turns' },
                        },
                    }),
                    { verb: 'turn.verb.compaction' }
                ),
                expectedKind: 'compaction',
                expectedTestId: 'turn-level2-compaction',
                expectedText: 'Archived earlier exploration turns',
            },
            {
                row: makeToolRow(
                    makeToolBlock('wf1', 'WebFetch', {
                        input: { url: 'https://example.com/docs' },
                        result: { title: 'Example Docs', content: 'Detailed documentation body', bytes: 2048, lines: 12 },
                    })
                ),
                expectedKind: 'web-fetch',
                expectedTestId: 'turn-level2-webfetch',
                expectedText: 'Example Docs',
            },
            {
                row: makeToolRow(
                    makeToolBlock('ws1', 'WebSearch', {
                        input: { query: 'vitest jsdom' },
                        result: {
                            results: [
                                { title: 'Vitest Guide', url: 'https://vitest.dev/guide', domain: 'vitest.dev' },
                            ],
                        },
                    })
                ),
                expectedKind: 'web-search',
                expectedTestId: 'turn-level2-websearch',
                expectedText: 'Vitest Guide',
            },
            {
                row: makeToolRow(
                    makeToolBlock('b1', 'Bash', {
                        input: { command: 'bun run test' },
                        result: '12 passed',
                    })
                ),
                expectedKind: 'bash',
                expectedTestId: 'turn-level2-bash',
                expectedText: 'bun run test',
            },
            {
                row: makeToolRow(
                    makeToolBlock('r1', 'Read', {
                        input: { file_path: 'src/index.ts' },
                        result: 'export const ok = true\n',
                    })
                ),
                expectedKind: 'file-read',
                expectedTestId: 'turn-level2-read',
                expectedText: 'src/index.ts',
            },
            {
                row: makeToolRow(
                    makeToolBlock('e1', 'Edit', {
                        input: {
                            file_path: 'src/app.tsx',
                            old_string: 'const a = 1',
                            new_string: 'const a = 2',
                        },
                    })
                ),
                expectedKind: 'file-diff',
                expectedTestId: 'turn-level2-diff',
                expectedText: 'src/app.tsx',
            },
            {
                row: makeToolRow(
                    makeToolBlock('g1', 'Grep', {
                        input: { pattern: 'StepInlinePreviewCard', path: 'web/src' },
                        result: 'TimelineStepRows.tsx:100',
                    })
                ),
                expectedKind: 'default',
                expectedTestId: 'turn-level2-generic',
                expectedText: 'Grep',
            },
        ]

        for (const testCase of cases) {
            const descriptor = describeTurnToolStep(testCase.row)
            expect(descriptor.preview.kind).toBe(testCase.expectedKind)
            const { unmount } = render(
                <I18nProvider>
                    <StepInlinePreviewCard preview={descriptor.preview} />
                </I18nProvider>
            )
            expect(screen.getByTestId(testCase.expectedTestId)).toBeInTheDocument()
            expect(screen.getByText(testCase.expectedText)).toBeInTheDocument()
            unmount()
        }
    })

    it('keeps Write to agent:// URI on default preview rather than file-diff', () => {
        const row = makeToolRow(
            makeToolBlock('w-agent', 'Write', {
                input: { path: 'agent://reviewer', content: 'Please check diff' },
            })
        )
        const descriptor = describeTurnToolStep(row)
        expect(descriptor.preview.kind).toBe('default')
        expect(descriptor.verbLabel).toBe('Messaged')
        expect(descriptor.intentLabel).toBe('reviewer')
    })
})

describe('standaloneBlockRendererRegistry', () => {
    it('identifies standalone block kinds and exposes consistent copy/speak policies', () => {
        expect(isStandaloneBlockKind('cli-output')).toBe(true)
        expect(isStandaloneBlockKind('codex-review')).toBe(true)
        expect(isStandaloneBlockKind('agent-text')).toBe(false)
        expect(isStandaloneBlockKind(undefined)).toBe(false)

        const cliReg = getStandaloneBlockRegistration('cli-output')
        const reviewReg = getStandaloneBlockRegistration('codex-review')
        expect(cliReg).toBe(STANDALONE_BLOCK_RENDERER_REGISTRY['cli-output'])
        expect(reviewReg).toBe(STANDALONE_BLOCK_RENDERER_REGISTRY['codex-review'])
        expect(cliReg.canSpeak).toBe(false)
        expect(reviewReg.canSpeak).toBe(false)
    })

    it('computes turn copy text and header canSpeak/hasCopyableText via standalone block specs', () => {
        const reviewTurn: TurnEntitySnapshot = {
            id: 'codex-review:r1',
            blocks: [
                {
                    kind: 'codex-review',
                    id: 'r1',
                    localId: null,
                    createdAt: 1000,
                    review: {
                        overallCorrectness: 'patch is correct',
                        overallExplanation: 'Looks solid.',
                        overallConfidenceScore: 0.95,
                        findings: [],
                    },
                },
            ],
            parts: [],
            timestamp: 1000,
        }

        const copyText = getTurnCopyableText(reviewTurn)
        expect(copyText).toContain('Codex review')
        expect(copyText).toContain('Overall: patch is correct')

        const headers = buildTurnHeadersById(
            new Map([[reviewTurn.id, reviewTurn]]),
            [{ id: reviewTurn.id, role: 'assistant', kind: 'codex-review' }],
            false,
            new Map()
        )
        const header = headers.get(reviewTurn.id)
        expect(header?.canSpeak).toBe(false)
        expect(header?.hasCopyableText).toBe(true)
        expect(header?.hasStrippedCopyableText).toBe(true)
    })

    it('renders runtime standalone blocks for cli-output and codex-review', () => {
        const CliRuntime = STANDALONE_BLOCK_RENDERER_REGISTRY['cli-output'].RuntimeRenderer
        const { unmount: unmountCli } = render(
            <I18nProvider>
                <CliRuntime
                    custom={{ kind: 'cli-output' }}
                    content={[{ type: 'text', text: '<command-name>git status</command-name>' }]}
                />
            </I18nProvider>
        )
        expect(screen.getAllByText(/git status/).length).toBeGreaterThan(0)
        unmountCli()

        const ReviewRuntime = STANDALONE_BLOCK_RENDERER_REGISTRY['codex-review'].RuntimeRenderer
        const { unmount: unmountReview } = render(
            <I18nProvider>
                <ReviewRuntime
                    custom={{
                        kind: 'codex-review',
                        review: {
                            overallCorrectness: 'patch is correct',
                            overallExplanation: 'No bugs found.',
                            overallConfidenceScore: 0.9,
                            findings: [],
                        },
                    }}
                    content={[]}
                />
            </I18nProvider>
        )
        expect(screen.getByText('No bugs found.')).toBeInTheDocument()
        unmountReview()
    })
})
