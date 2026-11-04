import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { MarkdownRenderer } from './MarkdownRenderer'

describe('MarkdownRenderer', () => {
    afterEach(() => {
        cleanup()
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
                    content={'Colors: `#c9d0d8`, `#800020`, `rgb(96, 165, 250)`, `--app-md-quote-border: #800020`, issue `#1452`, cmd `npm test`.'}
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
