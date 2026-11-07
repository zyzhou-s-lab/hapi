import { expect, test } from '@playwright/test'

test.describe('TurnTimeline Todo projection, slot geometry, and TurnDockedWidgets contract (PR 2)', () => {
    test('inline TimelineTodoChecklistCard stays outside rail in both collapsed and expanded states and aligns with answer left edge', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text())
        })

        await page.goto('/e2e-fixtures/turn-timeline-demo.html')
        await page.locator('[data-testid="turn-timeline-workbench"]').waitFor()

        const showcase = page.locator('[data-testid="todo-card-redesign-showcase"]')
        const completedTurn = showcase.locator('[data-testid="turn-timeline-block"]').nth(2)
        const level0Header = completedTurn.locator('[data-testid="turn-level0-header"]')
        const level1Shell = completedTurn.locator('[data-testid="turn-level1-shell"]')
        const todoSection = completedTurn.locator('[data-testid="turn-live-todo-cards"]')
        const todoCard = completedTurn.locator('[data-testid="turn-todo-checklist-card"]')

        await expect(level1Shell).toHaveAttribute('data-open', 'false')
        await expect(todoSection).toHaveCount(1)
        await expect(todoCard).toHaveCount(1)

        // Check DOM containment & left-edge geometry in collapsed state
        const collapsedGeometry = await completedTurn.evaluate((turnEl) => {
            const rail = turnEl.querySelector('[data-testid="turn-level1-rail"]')
            const pinnedRail = turnEl.querySelector('[data-testid="turn-collapsed-pinned-rail"]')
            const todoEl = turnEl.querySelector('[data-testid="turn-todo-checklist-card"]')
            const answerEl = turnEl.querySelector('[data-testid="turn-trailing-answer"]')
            if (!todoEl || !answerEl) return null
            const todoRect = todoEl.getBoundingClientRect()
            const answerRect = answerEl.getBoundingClientRect()
            return {
                inRail: Boolean(rail && rail.contains(todoEl)),
                inPinnedRail: Boolean(pinnedRail && pinnedRail.contains(todoEl)),
                leftDelta: Math.abs(todoRect.left - answerRect.left),
                todoAboveAnswer: todoRect.bottom <= answerRect.top + 4,
            }
        })
        expect(collapsedGeometry).not.toBeNull()
        expect(collapsedGeometry!.inRail).toBe(false)
        expect(collapsedGeometry!.inPinnedRail).toBe(false)
        expect(collapsedGeometry!.leftDelta).toBeLessThanOrEqual(1)
        expect(collapsedGeometry!.todoAboveAnswer).toBe(true)

        // Verify completed checklist badge is rendered via canonical todoProjection
        await expect(todoCard.locator('[data-testid="turn-todo-item-check"]')).toHaveCount(1)
        // Expand Level-1 rail and verify Todo card still only appears once outside the rail
        await level0Header.click()
        await expect(level1Shell).toHaveAttribute('data-open', 'true')
        await expect(todoSection).toHaveCount(1)
        await expect(todoCard).toHaveCount(1)

        const expandedGeometry = await completedTurn.evaluate((turnEl) => {
            const rail = turnEl.querySelector('[data-testid="turn-level1-rail"]')
            const todoEl = turnEl.querySelector('[data-testid="turn-todo-checklist-card"]')
            const answerEl = turnEl.querySelector('[data-testid="turn-trailing-answer"]')
            if (!todoEl || !answerEl) return null
            const todoRect = todoEl.getBoundingClientRect()
            const answerRect = answerEl.getBoundingClientRect()
            return {
                inRail: Boolean(rail && rail.contains(todoEl)),
                leftDelta: Math.abs(todoRect.left - answerRect.left),
            }
        })
        expect(expandedGeometry).not.toBeNull()
        expect(expandedGeometry!.inRail).toBe(false)
        expect(expandedGeometry!.leftDelta).toBeLessThanOrEqual(1)

        // Switch interactive showcase tabs (running -> completed -> multi)
        await showcase.getByRole('button', { name: /3\. 多任务流转态/ }).click()
        const interactiveTurn = showcase.locator('[data-testid="turn-timeline-block"]').first()
        const interactiveCard = interactiveTurn.locator('[data-testid="turn-todo-checklist-card"]')
        await expect(interactiveCard).toHaveCount(1)
        await expect(interactiveCard.locator('[data-testid="turn-todo-progress-header"]')).toHaveCount(0)
        await expect(interactiveCard.locator('[data-testid="turn-todo-item-check"]')).toHaveCount(1)
        await expect(interactiveCard.locator('[data-testid="turn-todo-item-spinner"]')).toHaveCount(1)
        await expect(interactiveCard.locator('[data-testid="turn-todo-item-pending"]')).toHaveCount(1)
        await expect(interactiveTurn.locator('[data-testid="rail-step-spinner"]')).toHaveCount(1)

        const runningCardStyles = await interactiveTurn.evaluate((turnEl) => {
            const completedTextEl = turnEl.querySelector('[data-todo-status="completed"] > span:last-child')
            const runningTextEl = turnEl.querySelector('[data-todo-status="in_progress"] > span:last-child')
            const railSpinnerSvg = turnEl.querySelector('[data-testid="rail-step-spinner"] svg')
            if (!completedTextEl || !runningTextEl || !railSpinnerSvg) return null
            const completedStyle = window.getComputedStyle(completedTextEl)
            const runningStyle = window.getComputedStyle(runningTextEl)
            const spinnerStyle = window.getComputedStyle(railSpinnerSvg)
            return {
                completedTextDecorationLine: completedStyle.textDecorationLine,
                runningHasShimmerClass: runningTextEl.classList.contains('turn-text-shimmer'),
                runningColor: runningStyle.color,
                runningAnimationName: runningStyle.animationName,
                railSpinnerAnimationName: spinnerStyle.animationName,
            }
        })
        expect(runningCardStyles).not.toBeNull()
        expect(runningCardStyles!.completedTextDecorationLine).toContain('line-through')
        expect(runningCardStyles!.runningHasShimmerClass).toBe(true)
        expect(runningCardStyles!.runningColor).toBe('rgba(0, 0, 0, 0)')
        expect(runningCardStyles!.runningAnimationName).toBe('turn-shimmer-sweep')
        expect(runningCardStyles!.railSpinnerAnimationName).toBe('turn-step-ring-spin')
        expect(errors).toEqual([])
    })

    test('extracted TurnDockedWidgets support interactive todo progress toggle and question wizard submission', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text())
        })

        await page.goto('/e2e-fixtures/turn-timeline-demo.html')
        await page.locator('[data-testid="turn-timeline-workbench"]').waitFor()

        // DockedTodoProgressBar expand/collapse
        const dockedTodoBar = page.locator('[data-testid="docked-todo-bar"]')
        await expect(dockedTodoBar).toBeVisible()
        const todoToggle = dockedTodoBar.locator('button[aria-expanded]')
        await expect(todoToggle).toHaveAttribute('aria-expanded', 'false')
        await todoToggle.click()
        await expect(todoToggle).toHaveAttribute('aria-expanded', 'true')
        await todoToggle.click()
        await expect(todoToggle).toHaveAttribute('aria-expanded', 'false')

        // Switch to Stage 4 (asking-user) and drive DockedQuestionWizard to completion
        await page.locator('[data-testid="stage-btn-asking-user"]').click()
        const wizard = page.locator('[data-testid="docked-question-wizard"]')
        await expect(wizard).toBeVisible()

        // Answer all 3 questions via option 1 click
        await page.locator('[data-testid="question-option-1"]').click()
        await page.locator('[data-testid="question-option-1"]').click()
        await page.locator('[data-testid="question-option-1"]').click()

        // Wizard closes and SubmittedQuestionSummaryBubble renders
        await expect(wizard).toHaveCount(0)
        await expect(page.locator('[data-testid="submitted-qa-bubble"]')).toBeVisible()
        await expect(page.locator('[data-testid="turn-followup-block"]')).toBeVisible()

        expect(errors).toEqual([])
    })

    test('PR 3 SubturnView renders 3 peer slots and 390x844 Mobile PWA frame stays synchronized', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text())
        })

        await page.setViewportSize({ width: 1440, height: 900 })
        await page.goto('/e2e-fixtures/turn-timeline-demo.html')
        await page.locator('[data-testid="turn-timeline-workbench"]').waitFor()

        // Desktop preview and 390x844 Mobile PWA preview are rendered side-by-side
        await expect(page.locator('[data-testid="desktop-preview"]')).toBeVisible()
        const mobileFrame = page.locator('[data-testid="mobile-pwa-frame"]')
        await expect(mobileFrame).toBeVisible()
        const mobileIframe = page.locator('[data-testid="mobile-pwa-iframe"]')
        await expect(mobileIframe).toHaveAttribute('width', '390')
        await expect(mobileIframe).toHaveAttribute('height', '844')

        // Switch to completed stage and verify SubturnView contains all 3 peer slots
        await page.locator('[data-testid="stage-btn-completed"]').click()
        const desktopFollowUpSubturn = page.locator('[data-testid="desktop-preview"] [data-testid="turn-followup-block"] [data-testid="turn-subturn"]')
        await expect(desktopFollowUpSubturn).toBeVisible()
        await expect(desktopFollowUpSubturn.locator('[data-testid="turn-level0-header"]')).toBeVisible()
        await expect(desktopFollowUpSubturn.locator('[data-testid="turn-todo-section"]')).toBeVisible()
        await expect(desktopFollowUpSubturn.locator('[data-testid="turn-trailing-answer"]')).toBeVisible()

        // Tier 3 contract reference is collapsed by default and expands on click
        const contractToggle = page.locator('[data-testid="demo-contract-toggle"]')
        await expect(contractToggle).toHaveAttribute('aria-expanded', 'false')
        await contractToggle.click()
        await expect(contractToggle).toHaveAttribute('aria-expanded', 'true')

        expect(errors).toEqual([])
    })
})
