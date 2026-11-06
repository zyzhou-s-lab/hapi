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
})
