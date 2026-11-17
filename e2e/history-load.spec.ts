import { expect, test } from '@playwright/test'

// Real message-window store + entity-backed HappyThread against a fake API:
// one canonical turn page per top approach, with scroll anchors preserved.
test('scroll-to-top loads one page per approach with correct scroll restore', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    // Wait for the initial tail sync plus the initial scroll-settling window.
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(2000)

    const afterFirst = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })

    // Exactly one page loaded, the DOM shows it, scroll restored away from top.
    expect(afterFirst.beforeReqs).toBe(1)
    expect(afterFirst.childCount).toBe(16)
    expect(afterFirst.scrollTop).toBeGreaterThan(1000)
    expect(await page.evaluate(() => window.__probe.windowState())).toEqual({
        messageCount: 16, oldestSeq: 2385, newestSeq: 2400
    })

    // Idle watch: no further loads may happen without another scroll.
    await page.waitForTimeout(2500)
    const idleReqs = await page.evaluate(() => window.__probe.requests.filter((r) => r.direction === 'before').length)
    expect(idleReqs).toBe(1)

    // A fresh scrollbar-style approach to the top loads exactly one more page.
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    await page.waitForTimeout(2000)
    const afterSecond = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })
    expect(afterSecond.beforeReqs).toBe(2)
    expect(afterSecond.childCount).toBe(24)
    expect(afterSecond.scrollTop).toBeGreaterThan(1000)
})

// A user may adjust position inside the preload area before a slow request
// finishes. The prepend must preserve their latest offset, not snap back to
// the stale top anchor captured when the request started.
test('scrolling within the preload area rebases the pending anchor', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    const latestAnchor = await page.evaluate(() => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        viewport.scrollTop = 100
        viewport.dispatchEvent(new Event('scroll'))
        const viewportRect = viewport.getBoundingClientRect()
        const message = Array.from(
            viewport.querySelectorAll<HTMLElement>('.happy-thread-messages > [id]')
        ).find((candidate) => {
            const rect = candidate.getBoundingClientRect()
            return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
        })
        if (!message) throw new Error('Expected a visible message anchor')
        return {
            id: message.id,
            topOffset: message.getBoundingClientRect().top - viewportRect.top
        }
    })

    await expect.poll(async () => await page.evaluate(() =>
        document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
    )).toBe(16)

    const restoredOffset = await page.evaluate((anchorId) => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        const message = document.getElementById(anchorId)
        if (!message) throw new Error('Expected the latest anchor to remain rendered')
        return message.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    }, latestAnchor.id)
    expect(Math.abs(restoredOffset - latestAnchor.topOffset)).toBeLessThanOrEqual(2)
})

// Returning to the tail while a slow prepend is pending cancels the obsolete
// load and preserves the user's latest visible anchor.
test('returning to the tail cancels a pending prepend', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    const approachTop = async () => {
        await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
        await page.evaluate(() => {
            const element = document.querySelector('.app-scroll-y') as HTMLElement
            element.scrollTop = 0
            element.dispatchEvent(new Event('scroll'))
        })
        await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    }

    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
        await approachTop()
        await expect.poll(async () => await page.evaluate(() => ({
            beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
        }))).toEqual({ beforeReqs: pageNumber, childCount: 8 + pageNumber * 8 })
    }
    const beforeCancellation = await page.evaluate(() => window.__probe.windowState())

    await approachTop()
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(4)

    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    const newerAnchor = await page.evaluate(() => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        viewport.scrollTop = viewport.scrollHeight
        viewport.dispatchEvent(new Event('scroll'))
        const viewportRect = viewport.getBoundingClientRect()
        const message = Array.from(
            viewport.querySelectorAll<HTMLElement>('.happy-thread-messages > [id]')
        ).find((candidate) => {
            const rect = candidate.getBoundingClientRect()
            return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom
        })
        if (!message) throw new Error('Expected a visible newer-history anchor')
        return {
            id: message.id,
            topOffset: message.getBoundingClientRect().top - viewportRect.top
        }
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })

    // Wait beyond the fixture's 500ms response delay. The invalidated response
    // must not apply or discard any of the already loaded history.
    await page.waitForTimeout(1000)
    const afterCancelledLoad = await page.evaluate((anchorId) => {
        const viewport = document.querySelector('.app-scroll-y') as HTMLElement
        const message = document.getElementById(anchorId)
        return {
            windowState: window.__probe.windowState(),
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
            anchorOffset: message
                ? message.getBoundingClientRect().top - viewport.getBoundingClientRect().top
                : null
        }
    }, newerAnchor.id)
    expect(afterCancelledLoad).toEqual({
        childCount: beforeCancellation.messageCount,
        windowState: beforeCancellation,
        beforeReqs: 4,
        anchorOffset: expect.any(Number)
    })
    expect(Math.abs(afterCancelledLoad.anchorOffset! - newerAnchor.topOffset)).toBeLessThanOrEqual(2)
})

// Regression: a normal tail synchronization invalidates any overlapping
// older-page request. That stop is transient: once synchronization drains,
// coverage must automatically issue a fresh request while the user remains
// near the top.
test('ordinary tail synchronization re-arms covered history loading', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    await page.evaluate(async () => {
        await window.__probe.refetch()
    })

    await expect.poll(async () => await page.evaluate(() => ({
        beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        scrollTop: Math.round((document.querySelector('.app-scroll-y') as HTMLElement).scrollTop)
    }))).toEqual({
        beforeReqs: 2,
        childCount: 16,
        scrollTop: expect.any(Number)
    })

    const restoredScrollTop = await viewport.evaluate((element) => Math.round(element.scrollTop))
    expect(restoredScrollTop).toBeGreaterThan(1000)
    await page.waitForTimeout(1000)
    const idleReqs = await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )
    expect(idleReqs).toBe(2)
})

// A short page can leave the top sentinel inside the preload margin after
// scroll restoration. That must not turn one approach into an opaque chain of
// older-page requests; a new approach is required for each automatic page.
test('short pages load once per top approach without automatic chaining', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?shortPages=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(2000)

    const afterFirst = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })

    expect(afterFirst.beforeReqs).toBe(1)
    expect(afterFirst.scrollTop).toBeGreaterThan(0)

    // Remaining covered and idle must not fetch the next short page.
    await page.waitForTimeout(2000)
    const idleReqs = await page.evaluate(() => window.__probe.requests.filter((r) => r.direction === 'before').length)
    expect(idleReqs).toBe(1)

    // Leave the preload area, then make a fresh approach. Exactly one more
    // page is allowed, even if that page is also too short to clear the margin.
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 500
    })
    await page.waitForTimeout(100)
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(2)
    await page.waitForTimeout(2000)
    const afterSecondIdle = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterSecondIdle).toBe(2)
})

// Regression: a failed older-page load changes no useful geometry, so no new
// scroll/resize signal is guaranteed. The same logical load must retry with
// bounded backoff without requiring another gesture.
test('a failed older-page load retries automatically while covered', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?failBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    // First attempt fails after ~50ms; backoff retries after 1000ms.
    await page.waitForTimeout(4000)

    const state = await page.evaluate(() => {
        const el = document.querySelector('.app-scroll-y') as HTMLElement
        return {
            scrollTop: Math.round(el.scrollTop),
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
            beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
        }
    })

    expect(state.beforeReqs).toBe(2)
    expect(state.childCount).toBe(16)
    expect(state.scrollTop).toBeGreaterThan(1000)
})

// Regression: when persistent failures burn through the bounded backoff, all
// automatic triggers go quiet — and at scrollTop=0 no further scroll events
// fire, so an explicit wheel-up / pull gesture is the only deterministic
// fallback left. It must route through the user-action path and recover.
test('wheel-up at the top loads older after automatic retries are exhausted', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?failBefore=4')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)
    const box = await viewport.boundingBox()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)

    await page.evaluate(() => {
        // Keep a non-zero position inside the preload margin. Warning
        // insertion/removal may emit browser scroll-anchoring events here;
        // those events must share the active backoff run.
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 50
    })
    // Initial attempt + 3 bounded backoff retries (1s/2s/3s) all fail.
    await page.waitForTimeout(8000)
    const stuck = await page.evaluate(() => ({
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(stuck.beforeReqs).toBe(4)
    expect(stuck.childCount).toBe(8)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.mouse.wheel(0, -300)
    await page.waitForTimeout(2000)
    const recovered = await page.evaluate(() => ({
        scrollTop: Math.round((document.querySelector('.app-scroll-y') as HTMLElement).scrollTop),
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(recovered.beforeReqs).toBe(5)
    expect(recovered.childCount).toBe(16)
    expect(recovered.scrollTop).toBeGreaterThan(1000)
})

// Regression: a page whose rows are all filtered by normalizeDecryptedMessage
// renders zero height, so the sentinel cannot move and the restore leaves
// scrollTop unchanged. Automatic loading must remain paused instead of paging
// through the remaining history, even though another page is available.
test('a fully filtered page keeps automatic history loading paused', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?filteredOlder=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await page.waitForTimeout(3000)

    const state = await page.evaluate(() => ({
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(state.beforeReqs).toBe(1)
    expect(state.childCount).toBe(8)

    // A later content shrink must not revive the no-progress coverage run.
    await page.evaluate(() => {
        const rows = document.querySelectorAll<HTMLElement>('.happy-thread-messages > *')
        const last = rows.item(rows.length - 1)
        if (last) last.style.display = 'none'
    })
    await page.waitForTimeout(1000)
    const afterResize = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterResize).toBe(1)
})

// Regression: an epoch mismatch makes the store deliberately stop the older
// load (reset + tail resync, typed stop outcome). Fresh-tail rendering can
// resize content and emit programmatic scroll signals; those signals must not
// re-arm the paused coverage run on their own.
test('an epoch-reset stop does not auto re-arm older requests', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?epochBump=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    // The stop triggers a tail resync and content resize; without the paused
    // controller state each cycle would fire another older request.
    await page.waitForTimeout(3000)

    const state = await page.evaluate(() => ({
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        beforeReqs: window.__probe.requests.filter((r) => r.direction === 'before').length
    }))
    expect(state.beforeReqs).toBe(1)
    expect(state.childCount).toBe(8)

    // Scroll events can be browser/programmatic effects of a reset. Moving
    // downward while the sentinel remains covered is not renewed older-history
    // intent and must leave the automatic run paused.
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 50
    })
    await page.waitForTimeout(1000)
    const afterDownwardScroll = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterDownwardScroll).toBe(1)

    // A focused keyboard user can explicitly resume the paused run. Home is
    // captured before the browser-generated scroll event, so that event is
    // classified as user intent rather than reset-driven geometry.
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 500
    })
    await page.waitForTimeout(100)
    await viewport.focus()
    await viewport.press('Home')
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(2)

    // The second request deliberately stops again. A scrollbar-style pointer
    // drag to the top is another explicit resume signal, while later
    // programmatic scroll events remain blocked.
    await page.waitForTimeout(1000)
    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 500
    })
    await page.waitForTimeout(100)
    await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
    await page.evaluate(() => {
        const element = document.querySelector('.app-scroll-y') as HTMLElement
        element.scrollTop = 300
        element.dispatchEvent(new Event('scroll'))
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })
    await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(3)
})

// Touch users need visible progress before the pull gesture becomes active.
// Crossing the threshold only arms the action; the request starts on release.
test('touch pull shows staged feedback and loads older on release', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?epochBump=1&slowBefore=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)
    await expect(page.getByText('Loading…', { exact: true })).toBeVisible()
    await expect(page.getByText('Loading…', { exact: true })).toBeHidden()
    await viewport.evaluate((element) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event('scroll'))
    })

    const dispatchTouch = async (type: 'touchstart' | 'touchmove' | 'touchend', clientY: number) => {
        await viewport.evaluate((element, eventInit) => {
            const event = new Event(eventInit.type, { bubbles: true, cancelable: true })
            Object.defineProperty(event, 'touches', {
                value: eventInit.type === 'touchend' ? [] : [{ clientY: eventInit.clientY }]
            })
            element.dispatchEvent(event)
        }, { type, clientY })
    }

    await dispatchTouch('touchstart', 100)
    await dispatchTouch('touchmove', 115)
    await expect(page.getByText('Keep pulling to load earlier messages')).toBeHidden()

    await dispatchTouch('touchmove', 116)
    await expect(page.getByText('Keep pulling to load earlier messages')).toBeVisible()
    expect(await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    await dispatchTouch('touchmove', 164)
    await expect(page.getByText('Release to load earlier messages')).toBeVisible()
    expect(await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(1)

    await dispatchTouch('touchend', 164)
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((request) => request.direction === 'before').length
    )).toBe(2)
    await expect(page.getByText('Loading…', { exact: true })).toBeVisible()
})

// Regression: scroll/resize signals emitted while a failed page is in backoff
// must join the same logical load. The delayed retry may discover an epoch
// reset, which then stops the run without a third request.
test('scroll events cannot bypass backoff before an epoch-reset stop', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?failBefore=1&epochBump=1')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    await page.evaluate(() => {
        (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop = 0
    })
    await expect(page.getByText('fixture: forced before-page failure')).toBeVisible()

    // Programmatic/browser scroll signals during backoff must not start an
    // immediate second request.
    await page.evaluate(() => {
        const viewport = document.querySelector('.app-scroll-y')
        viewport?.dispatchEvent(new Event('scroll'))
        viewport?.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(400)
    const duringBackoff = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(duringBackoff).toBe(1)

    // The controller-owned 1s retry returns the deliberate epoch-reset stop.
    await expect.poll(async () => await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )).toBe(2)
    const requestTimes = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').map((r) => r.at)
    )
    expect(requestTimes[1]! - requestTimes[0]!).toBeGreaterThanOrEqual(1000)

    await page.waitForTimeout(1500)
    const afterStop = await page.evaluate(() =>
        window.__probe.requests.filter((r) => r.direction === 'before').length
    )
    expect(afterStop).toBe(2)
})

// Tail synchronization while browsing must not replace loaded history with
// the latest turn page or move the user's current reading position.
test('a tail sync while browsing history preserves loaded messages and position', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html')
    const viewport = page.locator('.app-scroll-y')
    await expect(viewport).toBeVisible()
    await page.waitForTimeout(3500)

    const approachTop = async () => {
        await viewport.dispatchEvent('pointerdown', { button: 0, pointerType: 'mouse' })
        await page.evaluate(() => {
            const element = document.querySelector('.app-scroll-y') as HTMLElement
            element.scrollTop = 0
            element.dispatchEvent(new Event('scroll'))
        })
        await viewport.dispatchEvent('pointerup', { button: 0, pointerType: 'mouse' })
    }

    // Four older pages plus the initial tail; no historical rows are evicted.
    for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
        await approachTop()
        await expect.poll(async () => await page.evaluate(() => ({
            beforeReqs: window.__probe.requests.filter((request) => request.direction === 'before').length,
            childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0
        }))).toEqual({
            beforeReqs: pageNumber,
            childCount: 8 + pageNumber * 8
        })
    }
    const beforeSync = await page.evaluate(() => window.__probe.windowState())
    expect(beforeSync).toEqual({ messageCount: 40, oldestSeq: 2361, newestSeq: 2400 })
    const beforeScrollTop = await viewport.evaluate((element) => element.scrollTop)

    await page.evaluate(async () => {
        await window.__probe.refetch()
    })
    // Give a (wrong) latest-page application time to land before asserting.
    await page.waitForTimeout(1000)

    const afterSync = await page.evaluate(() => ({
        windowState: window.__probe.windowState(),
        latestReqs: window.__probe.requests.filter((request) => request.direction === 'latest').length,
        childCount: document.querySelector('.happy-thread-messages')?.childElementCount ?? 0,
        scrollTop: (document.querySelector('.app-scroll-y') as HTMLElement).scrollTop
    }))
    expect(afterSync).toEqual({
        windowState: beforeSync,
        latestReqs: 1,
        childCount: 40,
        scrollTop: expect.any(Number)
    })
    expect(Math.abs(afterSync.scrollTop - beforeScrollTop)).toBeLessThanOrEqual(2)
})
