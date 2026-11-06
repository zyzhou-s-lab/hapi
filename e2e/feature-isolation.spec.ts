import { expect, test } from '@playwright/test'

test.describe('PR 3 FeatureErrorBoundary slot isolation and recovery', () => {
    test('crashing turn-answer or todo-panel isolates the failure and recovers via Retry or resetKey without unmounting sibling slots', async ({ page }) => {
        await page.goto('/e2e-fixtures/turn-timeline-demo.html?fixture=feature-isolation')
        await page.locator('[data-testid="feature-isolation-fixture"]').waitFor()

        const level0Header = page.locator('[data-testid="turn-level0-header"]')
        const level1Shell = page.locator('[data-testid="turn-level1-shell"]')
        const todoCard = page.locator('[data-testid="turn-todo-checklist-card"]')

        // Initially all 3 Subturn slots and todo-panel are healthy
        await expect(level1Shell).toHaveAttribute('data-open', 'false')
        await expect(todoCard).toHaveCount(1)
        await expect(page.locator('[data-testid="healthy-answer-content"]')).toBeVisible()
        await expect(page.locator('[data-testid="healthy-todo-panel"]')).toContainText('session-alpha')

        // Expand the execution rail before crashing sibling slots
        await level0Header.click()
        await expect(level1Shell).toHaveAttribute('data-open', 'true')

        // Crash turn-answer slot and todo-panel simultaneously
        await page.locator('[data-testid="toggle-crash-answer"]').click()
        await page.locator('[data-testid="toggle-crash-todo-panel"]').click()

        // Error boundaries render inline fallback bars for turn-answer and todo-panel
        await expect(page.locator('[data-testid="feature-error-boundary-turn-answer"]')).toBeVisible()
        await expect(page.locator('[data-testid="feature-error-boundary-todo-panel"]')).toBeVisible()

        // Sibling turn-rail (still expanded!) and turn-todo remain mounted and interactive
        await expect(level1Shell).toHaveAttribute('data-open', 'true')
        await expect(todoCard).toHaveCount(1)
        await level0Header.click()
        await expect(level1Shell).toHaveAttribute('data-open', 'false')

        // Heal answer and click Retry on turn-answer error boundary
        await page.locator('[data-testid="toggle-crash-answer"]').click()
        await page.locator('[data-testid="feature-error-retry-turn-answer"]').click()
        await expect(page.locator('[data-testid="feature-error-boundary-turn-answer"]')).toHaveCount(0)
        await expect(page.locator('[data-testid="healthy-answer-content"]')).toBeVisible()

        // Switch session resetKey to auto-recover todo-panel without clicking Retry
        await page.locator('[data-testid="switch-session-reset-key"]').click()
        await expect(page.locator('[data-testid="feature-error-boundary-todo-panel"]')).toHaveCount(0)
        await expect(page.locator('[data-testid="healthy-todo-panel"]')).toContainText('session-beta')
    })
})
