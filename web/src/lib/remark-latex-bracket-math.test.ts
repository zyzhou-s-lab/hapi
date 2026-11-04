import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'
import { toHtml } from 'hast-util-to-html'
import {
    MARKDOWN_PLUGINS,
    MARKDOWN_PLUGINS_WITH_BREAKS,
    MARKDOWN_REHYPE_PLUGINS,
} from '@/components/assistant-ui/markdown-text'
import remarkLatexBracketMath from '@/lib/remark-latex-bracket-math'

function render(markdown: string): string {
    const processor = unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkLatexBracketMath)
        .use(remarkMath, { singleDollarTextMath: false })
        .use(remarkRehype)
        .use(rehypeKatex)
    return toHtml(processor.runSync(processor.parse(markdown), markdown))
}

function renderProduction(markdown: string, withBreaks = false): string {
    const processor = unified()
        .use(remarkParse)
        .use(withBreaks ? MARKDOWN_PLUGINS_WITH_BREAKS : MARKDOWN_PLUGINS)
        .use(remarkRehype)
        .use(MARKDOWN_REHYPE_PLUGINS)
    return toHtml(processor.runSync(processor.parse(markdown), markdown))
}

describe('remarkLatexBracketMath', () => {
    it('renders bracket display math through KaTeX', () => {
        const html = render(String.raw`\[ 164.7亿\times\frac{599}{1440} \approx\boxed{68.5亿} \]`)
        expect(html).toContain('class="katex"')
        expect(html).toContain('katex-display')
        expect(html).toContain('mfrac')
        expect(html).not.toContain('[ 164.7')
    })

    it('renders parenthesized inline math without display mode', () => {
        const html = render(String.raw`Result: \(x^2 + y^2\).`)
        expect(html).toContain('class="katex"')
        expect(html).not.toContain('katex-display')
        expect(html).toContain('Result: ')
    })

    it('renders multiline display math before hard-break processing', () => {
        const html = renderProduction('Before\n\n\\[\nE = mc^2\n\\]\n\nAfter', true)
        expect(html).toContain('katex-display')
        expect(html).toContain('Before')
        expect(html).toContain('After')
    })

    it('renders multiple inline formulas', () => {
        const html = render(String.raw`Compare \(a^2\) with \(b^2\).`)
        expect(html.match(/class="katex"/g)).toHaveLength(2)
    })

    it.each([
        ['citation', 'See [1].'],
        ['ordinary parentheses', 'Do this (see above).'],
        ['Windows path', String.raw`Open (C:\Users\Admin\notes).`],
        ['inline code', 'Use `\\(x\\)`.'],
        ['fenced code', '```tex\n\\[x\\]\n```'],
    ])('leaves %s as text', (_name, markdown) => {
        expect(render(markdown)).not.toContain('class="katex"')
    })

    it('preserves dollar block math and currency prose', () => {
        expect(render('$$\nE = mc^2\n$$')).toContain('class="katex"')
        expect(renderProduction('The plan is $200/mo and the bill is $80.')).not.toContain('class="katex"')
    })

    it('uses the production assistant plugin chain', () => {
        expect(renderProduction(String.raw`\[a^2+b^2=c^2\]`)).toContain('katex-display')
    })

    it('renders multiple inline formulas with subscript underscores and preserves surrounding bold text', () => {
        const markdown = '在 `bulk_lognorm` 下，$\\hat{\\mu}_p$ **只取决于 400 个细胞在每个基因上的整数计数总和 $P_{p,g} = \\sum_{i=1}^{400} Y_{i,g}$**（`delta.py:1078-1088`）。使用 `rng.multinomial` 会让实现出来的列和 $P_{p,g}$ 围绕目标值产生剧烈的泊松随机偏离，导致距离 $\\|\\hat{\\mu}_p - \\mu_{\\text{real},p}\\|^2$ 凭空膨胀约 2 倍。'
        const html = renderProduction(markdown)
        expect(html).not.toContain('<em>')
        expect(html).toContain('<strong>只取决于 400 个细胞在每个基因上的整数计数总和 <span class="katex">')
        expect(html.match(/class="katex"/g)).toHaveLength(4)
        expect(html).not.toContain('$\\hat')
        expect(html).not.toContain('$P_')
    })

    it('preserves TeX spacing escapes and multiple subscripted terms on the same line', () => {
        const markdown = '其中 $\\hat{C}_{\\text{pred},p}$ 是修正项，$r = \\min\\left(1,\\; B_{\\text{pred}} / \\sum_q w_q \\min(\\hat{C}_{\\text{pred},q}, \\hat{C}_{\\text{real},q})\\right)$ 是跨扰动方差预算比。'
        const html = renderProduction(markdown)
        expect(html).not.toContain('<em>')
        expect(html.match(/class="katex"/g)).toHaveLength(2)
        expect(html).not.toContain('$r =')
    })

    it('hoists single-line $$...$$ and complex fraction equations inside a paragraph into katex-display blocks', () => {
        const markdown = [
            '其分子为：',
            '$$\\text{MSE}_{\\text{unbiased,capped}}(p) = \\frac{\\|\\hat{\\mu}_p - \\mu_{\\text{real},p}\\|_{G_p}^2 - r \\cdot \\min(\\hat{C}_{\\text{pred},p}, 1.0 \\cdot \\hat{C}_{\\text{real},p}) - \\hat{C}_{\\text{real},p}}{|G_p|}$$',
            '其中 $\\hat{C}_{\\text{pred},p}$ 是预测组的方差修正项。',
        ].join('\n')
        const html = renderProduction(markdown)
        expect(html).toContain('katex-display')
        expect(html).toContain('<p>其分子为：</p>')
        expect(html).toContain('<p>其中 <span class="katex">')
    })

    it('promotes dense inline fraction equations inside paragraphs to katex-display for readability', () => {
        const markdown = '直接优化目标：$\\widehat{\\text{MSE}}_{\\text{unbiased},p} = \\frac{1}{G}\\sum_{g=1}^G [(\\hat{\\delta}_{p,g} - \\delta_{p,g})^2 - \\hat{\\sigma}^2_{\\text{true},p,g} - \\hat{\\sigma}^2_{\\text{pred},p,g}]$，从而降低误差。'
        const html = renderProduction(markdown)
        expect(html).toContain('katex-display')
        expect(html).toContain('<p>直接优化目标：</p>')
        expect(html).toContain('<p>从而降低误差。</p>')
    })
})
