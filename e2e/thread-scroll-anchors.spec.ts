import { expect, test } from '@playwright/test'

test.describe('PR 5 HappyThread modularization, scroll anchor preservation & ShareTurn sibling capture', () => {
    test('preserves .happy-thread-messages > [id] direct children, restores scroll anchor on older history load, and captures full turn for ShareTurnDialog', async ({ page }) => {
        const errors: string[] = []
        page.on('pageerror', (err) => errors.push(err.message))
        page.on('console', (msg) => {
            if (msg.type() === 'error') errors.push(msg.text())
        })

        await page.goto('/e2e-fixtures/turn-timeline-demo.html?fixture=thread-scroll-anchors')
        await page.locator('[data-testid="thread-scroll-anchors-fixture"]').waitFor()
        await page.waitForTimeout(300)

        // 1. Verify .happy-thread-messages > [id] direct-child contract (zero intermediate wrappers)
        const directChildAudit = await page.evaluate(() => {
            const container = document.querySelector('.happy-thread-messages')
            if (!container) return { totalChildren: 0, directWithId: 0, allHaveRole: false }
            const children = Array.from(container.children)
            const directWithId = children.filter((el) => el.id && el.id.startsWith('hapi-message-')).length
            const allHaveRole = children.every((el) => {
                const role = el.getAttribute('data-hapi-message-role')
                return role === 'user' || role === 'assistant'
            })
            return {
                totalChildren: children.length,
                directWithId,
                allHaveRole,
            }
        })
        expect(directChildAudit.totalChildren).toBe(20)
        expect(directChildAudit.directWithId).toBe(20)
        expect(directChildAudit.allHaveRole).toBe(true)

        // 2. Exit tail follow via real mouse wheel, position scrollTop=120, measure anchorBefore while hasMore=true, then trigger older load
        const viewport = page.locator('.chat-scroll-y')
        const box = await viewport.boundingBox()
        if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
            await page.mouse.wheel(0, -150)
            await page.waitForTimeout(250)
        }
        await expect(page.locator('[data-testid="thread-message-count"]')).toContainText('hasMore=true')
        const anchorBefore = await page.evaluate(() => {
            const scroller = document.querySelector('.chat-scroll-y')!
            scroller.scrollTop = 120
            const scrollerTop = scroller.getBoundingClientRect().top
            const anchorEl = document.getElementById('hapi-message-user-text:initial-user-12')!
            return {
                id: anchorEl.id,
                offsetFromViewportTop: anchorEl.getBoundingClientRect().top - scrollerTop,
            }
        })

        // Trigger older history load via scroll event in preload zone
        await viewport.evaluate((el) => {
            el.dispatchEvent(new Event('scroll'))
        })
        await expect(page.locator('[data-testid="thread-message-count"]')).toContainText('hasMore=false')
        await page.waitForTimeout(300)
        const anchorAfter = await page.evaluate((anchorId) => {
            const scroller = document.querySelector('.chat-scroll-y')!
            const scrollerTop = scroller.getBoundingClientRect().top
            const anchorEl = document.getElementById(anchorId)!
            const assistantEl = anchorEl.nextElementSibling as HTMLElement
            return {
                assistantId: assistantEl.id,
                offsetFromViewportTop: anchorEl.getBoundingClientRect().top - scrollerTop,
                scrollTop: scroller.scrollTop,
            }
        }, anchorBefore.id)

        // Prepending 8 older messages above the viewport must advance scrollTop so the anchor does not jump to 0
        expect(anchorAfter.scrollTop).toBeGreaterThan(400)
        expect(Math.abs(anchorAfter.offsetFromViewportTop - anchorBefore.offsetFromViewportTop)).toBeLessThan(140)

        // 3. Click Share Turn button on the assistant sibling of Turn 12 and verify useShareTurnCapture sibling traversal opens ShareTurnDialog
        const shareBtn = page.locator(`[id="${anchorAfter.assistantId}"] [data-hapi-share-action="true"]`)
        await shareBtn.scrollIntoViewIfNeeded()
        await page.waitForTimeout(250)
        await shareBtn.click({ force: true })
        await page.waitForTimeout(350)

        const dialog = page.locator('[role="dialog"]')
        await expect(dialog).toBeVisible()
        await expect(dialog).toContainText('Audit scroll anchor and turn structure for module 12')
        await expect(dialog).toContainText('Completed verification for Turn 12')
        await page.waitForTimeout(350)

        expect(errors).toEqual([])
    })
})
