import { expect, test } from '@playwright/test'

test.describe('PR 4 SessionFlavorModelController & ComposerSettingsSheet real-click E2E', () => {
    test('exercises OMP empty-list model refresh, Cursor variant drill-down, Pi runtime model steering, and Codex Fast Mode', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text())
        })

        await page.addInitScript(() => {
            window.localStorage.setItem('hapi.fue.v1.composer-model-effort', 'acknowledged')
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
})
