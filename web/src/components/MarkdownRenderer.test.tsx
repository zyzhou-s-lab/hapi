import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MarkdownRenderer } from './MarkdownRenderer'
import { GitChatProvider } from '@/fork-features/source-control/GitChatContext'
import type { GitChatPreparation } from '@/fork-features/source-control/gitChat'

describe('MarkdownRenderer', () => {
    afterEach(() => {
        cleanup()
    })

    it.each([false, true])('renders a correlated hyphenated Git fence for explicit review (standalone=%s)', async standalone => {
        const preparation: GitChatPreparation = {
            requestId: 'e45b122f-f1c9-4d64-ae3f-f71d721833c2',
            action: 'commit', repoRoot: '/project', branch: 'feature', head: 'abc',
        }
        const send = vi.fn(async () => true)
        const code = JSON.stringify({ requestId: preparation.requestId, action: 'commit', paths: ['src/parser.ts'], message: 'Fix parser boundary' })
        render(
            <I18nProvider>
                <GitChatProvider value={{ preparation, disabled: false, send }}><MarkdownRenderer standalone={standalone} content={`\`\`\`hapi-git-draft\n${code}\n\`\`\``} /></GitChatProvider>
            </I18nProvider>
        )

        const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Review Git instruction' })
        expect(editor.value).toContain('Fix parser boundary')
        expect(send).not.toHaveBeenCalled()
        fireEvent.change(editor, { target: { value: 'Commit only the reviewed parser fix.' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
        expect(send).toHaveBeenCalledExactlyOnceWith('Commit only the reviewed parser fix.')
        expect(await screen.findByRole('status')).toHaveTextContent('Sent to the conversation')
    })

    it('renders fenced code blocks with the shared syntax highlighter shell in standalone mode', () => {
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={'```ts\nexport const ok = true\n```'} />
            </I18nProvider>
        )

        expect(document.querySelector('.aui-md-codeblock')).toBeTruthy()
    })

    it('renders inline code without the fenced-code shell in standalone mode', () => {
        render(
            <I18nProvider>
                <MarkdownRenderer standalone content={'Use `npm test` here.'} />
            </I18nProvider>
        )

        expect(document.querySelector('.aui-md-codeblock')).toBeFalsy()
        expect(document.querySelector('.aui-md-code')).toBeTruthy()
    })

    it('appends an inline color swatch for hex, rgb/oklch, and CSS property color literals in inline code', () => {
        const { getAllByTestId } = render(
            <I18nProvider>
                <MarkdownRenderer
                    standalone
                    content={'Colors: `#c9d0d8`, `#800020`, `rgb(96, 165, 250)`, `--app-md-quote-border: #800020`, issue `#1452`, tag `#7371`, entries `#4780eece` `#b5d8598f` `#99a2deb2`, fn `color(node)`, cmd `npm test`.'}
                />
            </I18nProvider>
        )

        const swatches = getAllByTestId('inline-color-swatch')
        expect(swatches).toHaveLength(4)
        expect(swatches[0]?.getAttribute('style')).toContain('rgb(201, 208, 216)')
        expect(swatches[1]?.getAttribute('style')).toContain('rgb(128, 0, 32)')
        expect(swatches[2]?.getAttribute('style')).toContain('rgb(96, 165, 250)')
        expect(swatches[3]?.getAttribute('style')).toContain('rgb(128, 0, 32)')
    })
})
