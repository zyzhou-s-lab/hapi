import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { partitionTurn } from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnBlockView } from '@/components/AssistantChat/messages/TurnBlock'
import type { ToolCallBlock } from '@/chat/types'

function tool(id: string, name: string): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        children: [],
        tool: {
            id,
            name,
            state: 'completed',
            input: { file_path: 'home.tsx' },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
        },
    }
}

function renderBlock(node: ReactNode) {
    const value = {
        api: {},
        sessionId: 'session',
        metadata: null,
        disabled: false,
        onRefresh: vi.fn(),
    } as unknown as HappyChatContextValue
    return render(
        <I18nProvider>
            <HappyChatProvider value={value}>{node}</HappyChatProvider>
        </I18nProvider>
    )
}

describe('TurnBlockView markdown', () => {
    it('renders real markdown for the answer and for text inside the block', () => {
        const answer = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read', 'Read'),
            },
            { type: 'text', text: '这是 **加粗** 的回答' },
        ], null)
        renderBlock(<TurnBlockView partition={answer} streaming={false} durationMs={null} initiallyOpen={false} />)
        expect(screen.getByText('加粗').closest('strong')).not.toBeNull()
        expect(screen.queryByText('**加粗**')).toBeNull()

        const note = partitionTurn([
            { type: 'text', text: '中间的 *斜体* 说明' },
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read-2', 'Read'),
            },
        ], null)
        renderBlock(<TurnBlockView partition={note} streaming={false} durationMs={null} initiallyOpen />)
        expect(screen.getByText('斜体').closest('em')).not.toBeNull()

        const withTable = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read-3', 'Read'),
            },
            {
                type: 'text',
                text: '| 指标 | 数值 |\n| --- | --- |\n| 延迟 | 12ms |\n\n---\n\n### 下一节',
            },
        ], null)
        const { container } = renderBlock(<TurnBlockView partition={withTable} streaming={false} durationMs={null} initiallyOpen={false} />)
        expect(screen.getByRole('table')).toHaveClass('aui-md-table')
        expect(screen.getByRole('columnheader', { name: '指标' })).toHaveClass('aui-md-th', 'whitespace-nowrap')
        const dataCell = screen.getByRole('cell', { name: '12ms' })
        expect(dataCell).toHaveClass('aui-md-td', 'whitespace-nowrap')
        expect(dataCell.closest('tr')).toHaveClass('last:border-b-0')
        expect(container.querySelector('.aui-md-table-wrapper')).toHaveClass('[&+.aui-md-hr]:hidden')
    })

    it('supports cycling asc, desc, and original order on multi-row markdown tables including byte units and inline code', () => {
        const multiRowTable = partitionTurn([
            {
                type: 'text',
                text: [
                    '| 文件 / 目录 | 大小 | 说明 |',
                    '| --- | --- | --- |',
                    '| `reactome_gmt/ReactomePathways.gmt.zip` | 66.1 MB | Reactome 基因集 |',
                    '| `msigdb_v2026.1.Hs.json` | 291.5 KB | MSigDB 集合 |',
                    '| `gencode.v43.annotation.gtf` | 1.2 GB | GENCODE 注释 |',
                ].join('\n'),
            },
        ], null)

        renderBlock(<TurnBlockView partition={multiRowTable} streaming={false} durationMs={null} initiallyOpen={false} />)
        const table = screen.getByRole('table')
        const sizeHeader = within(table).getByRole('columnheader', { name: '大小' })
        expect(sizeHeader).toHaveAttribute('aria-sort', 'none')

        const getRowFileNames = () =>
            within(table)
                .getAllByRole('row')
                .slice(1)
                .map((row) => within(row).getAllByRole('cell')[0]?.textContent)

        expect(getRowFileNames()).toEqual([
            'reactome_gmt/ReactomePathways.gmt.zip',
            'msigdb_v2026.1.Hs.json',
            'gencode.v43.annotation.gtf',
        ])

        const sortBtn = within(sizeHeader).getByRole('button', { name: '大小' })
        fireEvent.click(sortBtn)
        expect(sizeHeader).toHaveAttribute('aria-sort', 'ascending')
        expect(getRowFileNames()).toEqual([
            'msigdb_v2026.1.Hs.json',
            'reactome_gmt/ReactomePathways.gmt.zip',
            'gencode.v43.annotation.gtf',
        ])

        fireEvent.click(sortBtn)
        expect(sizeHeader).toHaveAttribute('aria-sort', 'descending')
        expect(getRowFileNames()).toEqual([
            'gencode.v43.annotation.gtf',
            'reactome_gmt/ReactomePathways.gmt.zip',
            'msigdb_v2026.1.Hs.json',
        ])

        fireEvent.click(sortBtn)
        expect(sizeHeader).toHaveAttribute('aria-sort', 'none')
        expect(getRowFileNames()).toEqual([
            'reactome_gmt/ReactomePathways.gmt.zip',
            'msigdb_v2026.1.Hs.json',
            'gencode.v43.annotation.gtf',
        ])
    })
})
