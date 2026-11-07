import { expect, test } from '@playwright/test'

test.describe('PR 4 SessionFlavorModelController & ComposerSettingsSheet real-click E2E', () => {
    test('exercises OMP empty-list model refresh, Cursor variant drill-down, Pi runtime model steering, and Codex Fast Mode', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text())
        })

        await page.addInitScript(() => {
            window.localStorage.setItem('hapi.fue.v1.composer-model-effort', '1')
            window.localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
        })
        await page.goto('/e2e-fixtures/turn-timeline-demo.html?fixture=composer-flavor-settings')
        await page.locator('[data-testid="composer-flavor-fixture"]').waitFor()

        // 1. OMP flavor: settings sheet opens even when availableModelOptions is empty because onRefreshModels is provided
        await expect(page.locator('[data-testid="state-flavor"]')).toHaveText('flavor=omp')
        await page.locator('[data-testid="composer-settings-button"]').click()
        await page.waitForTimeout(250)

        const ompRefreshBtn = page.locator('[data-testid="omp-refresh-models"]')
        await expect(ompRefreshBtn).toBeVisible()
        await ompRefreshBtn.click()
        await page.waitForTimeout(250)

        await page.getByRole('button', { name: 'gpt-5.4' }).click()
        await expect(page.locator('[data-testid="state-model"]')).toHaveText('model=openai/gpt-5.4')
        await expect(page.locator('[data-testid="composer-model-value-button"]')).toBeVisible()
        await page.waitForTimeout(250)

        // Switch OMP thinking effort via effort value button
        await page.locator('[data-testid="composer-effort-value-button"]').click()
        await page.waitForTimeout(250)
        await page.getByRole('button', { name: 'High' }).click()
        await expect(page.locator('[data-testid="state-effort"]')).toHaveText('effort=high')
        await page.waitForTimeout(250)

        // 2. Cursor flavor: two-step base -> variant drill-down
        await page.locator('[data-testid="switch-flavor-cursor"]').click()
        await expect(page.locator('[data-testid="state-flavor"]')).toHaveText('flavor=cursor')
        await page.waitForTimeout(250)

        await page.locator('[data-testid="composer-model-value-button"]').click()
        await page.waitForTimeout(250)
        await page.getByRole('button', { name: 'sonnet-4.5', exact: true }).first().click()
        await page.waitForTimeout(250)

        await expect(page.locator('[data-testid="cursor-variant-back"]')).toBeVisible()
        await page.getByRole('button', { name: 'Claude 4.5 Sonnet Thinking' }).click()
        await expect(page.locator('[data-testid="state-variant"]')).toHaveText('variant=sonnet-4.5-thinking')
        await page.waitForTimeout(250)

        // 3. Pi flavor: model picker stays enabled even while thinking=true (runtime model steering)
        await page.locator('[data-testid="switch-flavor-pi"]').click()
        await expect(page.locator('[data-testid="state-flavor"]')).toHaveText('flavor=pi')
        await page.waitForTimeout(250)

        const modelValueBtn = page.locator('[data-testid="composer-model-value-button"]')
        await expect(modelValueBtn).toBeEnabled()
        await modelValueBtn.click()
        await page.waitForTimeout(250)
        await page.getByRole('button', { name: 'Claude Sonnet 4.5' }).click()
        await expect(page.locator('[data-testid="state-pi"]')).toHaveText('pi=anthropic:claude-sonnet-4-5')
        await page.waitForTimeout(250)

        // 4. Codex flavor: settings sheet Fast Mode (serviceTier) and Permission Mode
        await page.locator('[data-testid="switch-flavor-codex"]').click()
        await expect(page.locator('[data-testid="state-flavor"]')).toHaveText('flavor=codex')
        await page.waitForTimeout(250)

        await page.locator('[data-testid="composer-settings-button"]').click()
        await page.waitForTimeout(250)
        await page.getByRole('button', { name: 'gpt-5.4' }).click()
        await page.waitForTimeout(250)
        await page.locator('[data-testid="composer-settings-button"]').click()
        await page.waitForTimeout(250)
        await page.getByRole('button', { name: /Fast/i }).click()
        await expect(page.locator('[data-testid="state-tier"]')).toHaveText('tier=fast')
        await page.waitForTimeout(300)

        expect(errors).toEqual([])
    })

    test('verifies Scheme 2 composer layout, floating TodoPanel/SessionStatusPanel overlays, and paused task badge', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))

        await page.addInitScript(() => {
            window.localStorage.setItem('hapi.fue.v1.composer-model-effort', '1')
            window.localStorage.setItem('hapi.fue.v1.rich-composer-mentions', '1')
            window.localStorage.setItem('hapi.todo-panel.collapsed', '1')
            window.localStorage.setItem('hapi.todo-panel.collapsed', '1')
        })
        await page.goto('/e2e-fixtures/turn-timeline-demo.html?fixture=composer-flavor-settings')
        await page.locator('[data-testid="composer-flavor-fixture"]').waitFor()

        // 1. Scheme 2 (c2-balanced) composer layout: inline attach-plus inside frame, settings/model/effort on external bar
        const composerFrame = page.locator('[data-testid="composer-frame"]')
        const externalBar = page.locator('[data-testid="composer-external-bar"]')
        await expect(composerFrame.locator('[data-testid="composer-attach-plus"]')).toBeVisible()
        await expect(externalBar.locator('[data-testid="composer-settings-button"]')).toBeVisible()

        const frameBoxBefore = await composerFrame.boundingBox()
        const externalBoxBefore = await externalBar.boundingBox()
        expect(frameBoxBefore).not.toBeNull()
        expect(externalBoxBefore).not.toBeNull()
        expect(externalBoxBefore!.y).toBeGreaterThanOrEqual(frameBoxBefore!.y + frameBoxBefore!.height - 2)

        // 2. TodoPanel floating overlay: expanding does not shift HappyComposer and stays above composer top
        const todoPanel = page.locator('[data-testid="todo-panel"]')
        await expect(todoPanel).toBeVisible()
        await expect(todoPanel).toHaveClass(/composer-dock-card/)
        const overlayPosition = await todoPanel.evaluate((el) => window.getComputedStyle(el).position)
        expect(overlayPosition).toBe('absolute')

        await expect(todoPanel.locator('button[aria-expanded]')).toHaveAttribute('aria-expanded', 'false')
        await todoPanel.locator('button[aria-expanded]').click()
        await expect(todoPanel.locator('button[aria-expanded]')).toHaveAttribute('aria-expanded', 'true')
        await page.waitForTimeout(200)

        const frameBoxAfterTodo = await composerFrame.boundingBox()
        const overlayBox = await todoPanel.boundingBox()
        expect(frameBoxAfterTodo!.y).toBeCloseTo(frameBoxBefore!.y, 1)
        expect(overlayBox!.y + overlayBox!.height).toBeLessThanOrEqual(frameBoxAfterTodo!.y + 4)

        // 3. Paused (blocked) Todo item renders neutral pause badge instead of destructive !
        const blockedItem = todoPanel.locator('[data-todo-status="blocked"]')
        await expect(blockedItem).toBeVisible()
        await expect(blockedItem).toContainText('Paused fallback verification task')
        await expect(blockedItem.locator('[data-testid="checklist-item-blocked"]')).toBeVisible()
        await expect(blockedItem).not.toContainText('!')

        // Collapse TodoPanel
        await todoPanel.locator('button[aria-expanded]').click()
        await page.waitForTimeout(150)
        // 4. SessionStatusPanel floating overlay: opening details does not shift composer frame and renders ⏸ for blocked tasks
        const statusSummary = page.locator('details > summary').first()
        await statusSummary.click()
        await page.waitForTimeout(150)
        const statusOverlay = page.locator('details .composer-dock-card').first()
        await expect(statusOverlay).toBeVisible()
        await expect(statusOverlay.locator('[data-testid="checklist-item-blocked"]')).toBeVisible()
        const frameBoxAfterStatus = await composerFrame.boundingBox()
        expect(frameBoxAfterStatus!.y).toBeCloseTo(frameBoxBefore!.y, 1)
        expect(errors).toEqual([])
    })
})
