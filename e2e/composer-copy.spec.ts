import { expect, test } from '@playwright/test'

/**
 * Regression spec for the Chromium select-all quirk: a page containing a
 * contenteditable (the rich composer) makes Ctrl+A collapse to an empty
 * caret when focus is outside the editable, so Ctrl+C copies nothing.
 * SessionChat's applyGlobalSelectAll takeover must restore the expected
 * "select the conversation" behavior while leaving composer/input
 * select-all to the browser.
 */
test.describe('composer Ctrl+A + Ctrl+C copy', () => {
    test.beforeEach(async ({ context, page }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write'])
        await page.goto('/e2e-fixtures/composer-copy-fixture.html')
        await page.locator('[data-testid="rich-composer-input"]').waitFor()
    })

    test('Ctrl+A outside the composer selects the message thread and Ctrl+C copies it', async ({ page }) => {
        await page.keyboard.press('Control+a')
        const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
        expect(selected).toContain('The quick brown fox jumps over the lazy dog')
        expect(selected).toContain('my earlier user message')
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toBe(selected)
    })

    test('Ctrl+A with composer focused still selects only the composer draft', async ({ page }) => {
        const editor = page.locator('[data-testid="rich-composer-input"]')
        await editor.click()
        await page.keyboard.type('my draft message')
        await page.keyboard.press('Control+a')
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toBe('my draft message')
    })

    test('Ctrl+A in a textarea keeps native behavior', async ({ page }) => {
        await page.evaluate(() => {
            const textarea = document.createElement('textarea')
            textarea.id = 'plain-textarea'
            textarea.value = 'textarea draft'
            document.body.appendChild(textarea)
        })
        const textarea = page.locator('#plain-textarea')
        await textarea.click()
        await page.keyboard.press('Control+a')
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toBe('textarea draft')
    })

    test('mouse-drag selection still copies via plain Ctrl+C', async ({ page }) => {
        const msg = page.locator('[data-testid="assistant-message-2"]')
        const user = page.locator('[data-testid="user-message-1"]')
        // A fixed x:5 sat past the midpoint of "A" once chat text became 14px
        // (glyph ~9px wide), so the drag started at "nother".
        const pointInText = (locator, start, end, edge) => locator.evaluate((el, arg) => {
            const node = el.firstChild
            if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error('expected a text node')
            const range = document.createRange()
            range.setStart(node, arg.start)
            range.setEnd(node, arg.end)
            const rect = range.getBoundingClientRect()
            const host = el.getBoundingClientRect()
            const x = arg.edge === 'start'
                ? rect.left - host.left + rect.width / 4
                : rect.right - host.left - 1
            return { x, y: rect.top - host.top + rect.height / 2 }
        }, { start, end, edge })
        const sourcePosition = await pointInText(msg, 0, 1, 'start')
        const userLength = await user.evaluate((el) => el.textContent?.length ?? 1)
        const targetPosition = await pointInText(user, Math.max(0, userLength - 1), userLength, 'end')
        await msg.dragTo(user, { sourcePosition, targetPosition })
        await page.keyboard.press('Control+c')
        const copied = await page.evaluate(() => navigator.clipboard.readText())
        expect(copied).toContain('Another assistant message')
        expect(copied).toContain('my earlier user message')
    })
})
