import { expect, test } from '@playwright/test'

test.describe('CSS @layer cascade, focus outline, and TurnTimeline click/geometry contract (PR 1)', () => {
    test('composer input has zero focus outline when clicked while @layer base :focus-visible remains active for buttons', async ({ page }) => {
        await page.goto('/e2e-fixtures/composer-copy-fixture.html')
        const editor = page.locator('[data-testid="rich-composer-input"]')
        await editor.waitFor()
        await editor.click()

        const composerOutline = await editor.evaluate((el) => {
            const style = window.getComputedStyle(el)
            return {
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
            }
        })
        expect(composerOutline.outlineStyle).toBe('none')
        expect(composerOutline.outlineWidth).toBe('0px')
    })

    test('keyboard Tab focus on interactive buttons applies @layer base :focus-visible 2px solid outline', async ({ page }) => {
        await page.goto('/e2e-fixtures/turn-timeline-demo.html')
        const autoplayBtn = page.locator('[data-testid="demo-autoplay-btn"]')
        await autoplayBtn.waitFor()

        await page.keyboard.press('Tab')
        const focusOutline = await autoplayBtn.evaluate((el) => {
            const style = window.getComputedStyle(el)
            return {
                isFocused: document.activeElement === el,
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
            }
        })
        expect(focusOutline.isFocused).toBe(true)
        expect(focusOutline.outlineStyle).toBe('solid')
        expect(focusOutline.outlineWidth).toBe('2px')
    })

    test('TurnTimeline Level-0 header click toggles Level-1 collapsible shell, preserves Todo sibling geometry, and keeps trailing answer whiteSpace normal', async ({ page }) => {
        await page.goto('/e2e-fixtures/turn-timeline-demo.html')
        await page.locator('[data-testid="turn-timeline-workbench"]').waitFor()

        // Card B in the Todo showcase renders a completed turn with auto-collapsed Level-1 shell,
        // inline Todo checklist card outside the rail, and trailing assistant answer markdown.
        const primaryTurn = page
            .locator('[data-testid="todo-card-redesign-showcase"] [data-testid="turn-timeline-block"]')
            .nth(2)
        const headerBtn = primaryTurn.locator('[data-testid="turn-level0-header"]')
        const shell = primaryTurn.locator('[data-testid="turn-level1-shell"]')
        const trailingAnswer = primaryTurn.locator('[data-testid="turn-trailing-answer"]').first()
        await expect(shell).toHaveAttribute('data-open', 'false')

        const collapsedMetrics = await shell.evaluate((el) => {
            const style = window.getComputedStyle(el)
            const body = el.querySelector('.turn-collapsible-body')
            return {
                opacity: style.opacity,
                pointerEvents: style.pointerEvents,
                bodyHeight: body?.getBoundingClientRect().height ?? -1,
            }
        })
        expect(collapsedMetrics.opacity).toBe('0')
        expect(collapsedMetrics.pointerEvents).toBe('none')
        expect(collapsedMetrics.bodyHeight).toBe(0)

        // Click Level-0 header to expand Level-1 rail
        await headerBtn.click()
        await expect(shell).toHaveAttribute('data-open', 'true')

        await expect.poll(async () => {
            return shell.evaluate((el) => {
                const style = window.getComputedStyle(el)
                const body = el.querySelector('.turn-collapsible-body')
                return {
                    opacity: style.opacity,
                    pointerEvents: style.pointerEvents,
                    hasPositiveHeight: (body?.getBoundingClientRect().height ?? 0) > 20,
                }
            })
        }).toEqual({
            opacity: '1',
            pointerEvents: 'auto',
            hasPositiveHeight: true,
        })

        // Verify Todo checklist card is rendered outside the rail and below Level-1 shell without overlap
        const geometry = await primaryTurn.evaluate((turnEl) => {
            const shellEl = turnEl.querySelector('[data-testid="turn-level1-shell"]')
            const railEl = turnEl.querySelector('[data-testid="turn-level1-rail"]')
            const todoEl = turnEl.querySelector('[data-testid="turn-live-todo-cards"]')
            const pinnedRailEl = turnEl.querySelector('[data-testid="turn-collapsed-pinned-rail"]')
            if (!shellEl || !railEl || !todoEl) return null
            const shellRect = shellEl.getBoundingClientRect()
            const todoRect = todoEl.getBoundingClientRect()
            return {
                todoInsideRail: railEl.contains(todoEl),
                todoInsidePinnedRail: pinnedRailEl ? pinnedRailEl.contains(todoEl) : false,
                todoBelowShell: todoRect.top >= shellRect.bottom - 1,
                todoHeight: todoRect.height,
            }
        })
        expect(geometry).not.toBeNull()
        expect(geometry!.todoInsideRail).toBe(false)
        expect(geometry!.todoInsidePinnedRail).toBe(false)
        expect(geometry!.todoBelowShell).toBe(true)
        expect(geometry!.todoHeight).toBeGreaterThan(20)

        // Verify trailing answer wrapper does not apply redundant whitespace-pre-wrap
        const trailingStyle = await trailingAnswer.evaluate((el) => {
            return window.getComputedStyle(el).whiteSpace
        })
        expect(trailingStyle).toBe('normal')
    })
})
