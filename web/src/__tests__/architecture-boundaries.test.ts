import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const WEB_SRC_DIR = path.resolve(__dirname, '..')

function collectSourceFiles(dir: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(dir)) {
        const fullPath = path.join(dir, entry)
        if (statSync(fullPath).isDirectory()) {
            files.push(...collectSourceFiles(fullPath))
        } else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry)) {
            files.push(fullPath)
        }
    }
    return files
}

function parseModuleSpecifiers(filePath: string): string[] {
    const sf = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true)
    const specifiers: string[] = []
    const visit = (node: ts.Node) => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text)
        }
        ts.forEachChild(node, visit)
    }
    visit(sf)
    return specifiers
}

describe('architecture & CSS cascade boundaries', () => {
    it('keeps all web/src/index.css selector rules inside @layer base or @layer components', () => {
        const cssPath = path.join(WEB_SRC_DIR, 'index.css')
        const root = postcss.parse(readFileSync(cssPath, 'utf8'), { from: cssPath })
        const unlayered: string[] = []
        let hasLayeredKatex = false
        let focusVisibleInBase = false
        const whereOnStateModifier: string[] = []

        for (const node of root.nodes) {
            if (node.type === 'comment') continue
            if (node.type === 'rule') {
                unlayered.push(node.selector)
                continue
            }
            if (node.type === 'atrule') {
                if (node.name === 'import' && node.params.includes('katex') && node.params.includes('layer(base)')) {
                    hasLayeredKatex = true
                } else if (node.name === 'layer') {
                    const layerName = node.params.trim()
                    node.walkRules((rule) => {
                        if (rule.selector.includes(':focus-visible') && layerName === 'base') {
                            focusVisibleInBase = true
                        }
                        if (/:where\([^)]*\[data-(?:open|dragging)/.test(rule.selector)) {
                            whereOnStateModifier.push(rule.selector)
                        }
                    })
                } else if (!['import', 'config', 'keyframes', 'property'].includes(node.name)) {
                    unlayered.push(`@${node.name} ${node.params}`)
                }
            }
        }

        expect(hasLayeredKatex).toBe(true)
        expect(unlayered).toEqual([])
        expect(focusVisibleInBase).toBe(true)
        expect(whereOnStateModifier).toEqual([])
    })

    it('keeps web/src/chat/** pure domain modules free of React, router, API, hook, and AssistantChat imports', () => {
        const violations: string[] = []
        for (const filePath of collectSourceFiles(path.join(WEB_SRC_DIR, 'chat'))) {
            const relFile = path.relative(WEB_SRC_DIR, filePath).split(path.sep).join('/')
            for (const spec of parseModuleSpecifiers(filePath)) {
                const resolved = spec.startsWith('@/')
                    ? spec.slice(2)
                    : spec.startsWith('.')
                        ? path.relative(WEB_SRC_DIR, path.resolve(path.dirname(filePath), spec)).split(path.sep).join('/')
                        : ''
                if (
                    spec === 'react' || spec.startsWith('react/') || spec === 'react-dom' || spec.startsWith('react-dom/')
                    || spec.startsWith('@tanstack/') || spec.startsWith('@assistant-ui/')
                    || /^(api|hooks|routes|components\/SessionChat|components\/AssistantChat)\b/.test(resolved)
                    || (relFile.startsWith('chat/projections/') && /^(components|fork-features)\b/.test(resolved))
                ) {
                    violations.push(`${relFile} -> ${spec}`)
                }
            }
        }
        expect(violations).toEqual([])
    })

    it('enforces web/src/chat/projections/todoProjection.ts as the single Todo parsing/projection entry point', () => {
        const requiredConsumers = [
            'chat/sessionStatus.ts',
            'components/SessionStatusPanel.tsx',
            'components/ToolCard/checklist.tsx',
            'components/AssistantChat/messages/turnBlockModel.ts',
            'components/AssistantChat/messages/TurnBlock.tsx',
            'fork-features/task-panel/TodoPanel.tsx',
        ]
        for (const relPath of requiredConsumers) {
            const fullPath = path.join(WEB_SRC_DIR, relPath)
            const specifiers = parseModuleSpecifiers(fullPath)
            expect(
                specifiers.includes('@/chat/projections/todoProjection'),
                `${relPath} must import from @/chat/projections/todoProjection`,
            ).toBe(true)
        }

        const duplicateParserFiles: string[] = []
        for (const filePath of collectSourceFiles(WEB_SRC_DIR)) {
            const relFile = path.relative(WEB_SRC_DIR, filePath).split(path.sep).join('/')
            if (relFile === 'chat/projections/todoProjection.ts') continue
            const src = readFileSync(filePath, 'utf8')
            if (/\bfunction\s+(?:selectRelevantOmpPhases|scopeChecklistItemsByOmpPhaseId|parseOmpTodoDocument|parseOmpTodoResultText)\b/.test(src)) {
                duplicateParserFiles.push(relFile)
            }
        }
        expect(duplicateParserFiles).toEqual([])
    })

    it('enforces PR 3 Subturn slot isolation, FeatureErrorBoundary wrapping, and 4-context split', () => {
        const contextSrc = readFileSync(path.join(WEB_SRC_DIR, 'components/AssistantChat/context.tsx'), 'utf8')
        expect(contextSrc).not.toMatch(/\buseHappyChatContext\b/)
        expect(contextSrc).not.toMatch(/\buseOptionalHappyChatContext\b/)

        const timelineTurnSrc = readFileSync(path.join(WEB_SRC_DIR, 'components/AssistantChat/messages/TimelineTurnBlock.tsx'), 'utf8')
        expect(timelineTurnSrc.split('\n').length).toBeLessThan(180)
        const timelineSpecifiers = parseModuleSpecifiers(path.join(WEB_SRC_DIR, 'components/AssistantChat/messages/TimelineTurnBlock.tsx'))
        expect(timelineSpecifiers).toContain('@/components/AssistantChat/slotRegistry')
        const slotRegistrySpecifiers = parseModuleSpecifiers(path.join(WEB_SRC_DIR, 'components/AssistantChat/slotRegistry.tsx'))
        expect(slotRegistrySpecifiers).toContain('@/components/FeatureErrorBoundary')
        expect(timelineSpecifiers).toContain('@/components/AssistantChat/messages/TurnExecutionRail')
        expect(timelineSpecifiers).toContain('@/components/AssistantChat/messages/TurnTodoSection')
        expect(timelineSpecifiers).toContain('@/components/AssistantChat/messages/TurnAnswerSection')

        const railSpecifiers = parseModuleSpecifiers(path.join(WEB_SRC_DIR, 'components/AssistantChat/messages/TurnExecutionRail.tsx'))
        expect(railSpecifiers).not.toContain('@/components/AssistantChat/messages/TurnTodoSection')
        expect(railSpecifiers).not.toContain('@/components/AssistantChat/messages/TurnAnswerSection')
    })

    it('enforces PR 4 and PR 5 component line-count and controller boundary budgets', () => {
        const countLines = (relPath: string) =>
            readFileSync(path.join(WEB_SRC_DIR, relPath), 'utf8').split('\n').length

        expect(countLines('components/AssistantChat/messages/TimelineTurnBlock.tsx')).toBeLessThanOrEqual(300)
        expect(countLines('components/AssistantChat/messages/TurnBlock.tsx')).toBeLessThanOrEqual(220)
        expect(countLines('components/SessionChat.tsx')).toBeLessThanOrEqual(900)
        expect(countLines('components/AssistantChat/HappyComposer.tsx')).toBeLessThanOrEqual(750)
        expect(countLines('components/AssistantChat/HappyThread.tsx')).toBeLessThanOrEqual(900)

        const sessionChatSpecifiers = parseModuleSpecifiers(path.join(WEB_SRC_DIR, 'components/SessionChat.tsx'))
        expect(sessionChatSpecifiers).toContain('@/components/AssistantChat/composer/useSessionFlavorModelController')
        expect(sessionChatSpecifiers).toContain('@/components/AssistantChat/composer/useSessionComposerSendBridge')
        expect(sessionChatSpecifiers).toContain('@/components/AssistantChat/slotRegistry')
        expect(sessionChatSpecifiers).not.toContain('@/hooks/queries/useCodexModels')
        expect(sessionChatSpecifiers).not.toContain('@/hooks/queries/useCursorModels')
        expect(sessionChatSpecifiers).not.toContain('@/hooks/queries/useOmpModels')
        expect(sessionChatSpecifiers).not.toContain('@/hooks/queries/usePiModels')

        const happyComposerSpecifiers = parseModuleSpecifiers(path.join(WEB_SRC_DIR, 'components/AssistantChat/HappyComposer.tsx'))
        expect(happyComposerSpecifiers).toContain('./composer/ComposerSettingsSheet')
        expect(happyComposerSpecifiers).toContain('./composer/composerInputHelpers')
        expect(happyComposerSpecifiers).toContain('./composer/useComposerDraftAndSendLifecycle')

        const happyThreadSpecifiers = parseModuleSpecifiers(path.join(WEB_SRC_DIR, 'components/AssistantChat/HappyThread.tsx'))
        expect(happyThreadSpecifiers).toContain('@/components/AssistantChat/useThreadScrollAndHistoryController')
        expect(happyThreadSpecifiers).toContain('@/components/AssistantChat/useShareTurnCapture')
    })
})
