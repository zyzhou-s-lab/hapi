import { expect, test } from '@playwright/test'

test.describe('PR 3 4-context split & historical turn streaming isolation', () => {
    test('updating HappyChatTodosContext, HappyChatSessionStateContext, and tail streaming ticks produces zero re-renders on historical turns', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text())
        })

        await page.goto('/e2e-fixtures/turn-timeline-demo.html?fixture=streaming-isolation')
        await page.locator('[data-testid="streaming-isolation-fixture"]').waitFor()

        const getCounts = async () => {
            const historical: number[] = []
            for (let i = 0; i < 5; i++) {
                const raw = await page.locator(`[data-testid="fixture-turn-${i}"]`).getAttribute('data-render-count')
                historical.push(Number(raw ?? '0'))
            }
            const tailRaw = await page.locator('[data-testid="fixture-turn-5"]').getAttribute('data-render-count')
            return { historical, tail: Number(tailRaw ?? '0') }
        }

        const initial = await getCounts()
        expect(initial.historical.every((c) => c >= 1)).toBe(true)
        await expect(page.locator('[data-testid="fixture-turn-5"]')).toHaveAttribute(
            'data-active-todo',
            'Step 2: Streaming tick 0'
        )

        // Advance Todo + streaming ticks 3 times and toggle sessionThinking twice
        await page.locator('[data-testid="advance-todo-tick"]').click()
        await page.locator('[data-testid="advance-todo-tick"]').click()
        await page.locator('[data-testid="advance-todo-tick"]').click()
        await expect(page.locator('[data-testid="fixture-turn-5"]')).toHaveAttribute(
            'data-active-todo',
            'Step 2: Streaming tick 3'
        )

        await page.locator('[data-testid="toggle-session-thinking"]').click()
        await page.locator('[data-testid="toggle-session-thinking"]').click()

        const after = await getCounts()
        // Historical turns 0..4 MUST have zero additional renders
        expect(after.historical).toEqual(initial.historical)
        // Tail turn 5 MUST have re-rendered for the 5 updates
        expect(after.tail).toBeGreaterThanOrEqual(initial.tail + 5)
        expect(errors).toEqual([])
    })
})
