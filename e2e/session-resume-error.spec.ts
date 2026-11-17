import { expect, test, type Page } from '@playwright/test'
import type { Session } from '../web/src/types/api'

type RecoveryFailure = { status: number; error: string; code?: string } | 'network'

test.use({ serviceWorkers: 'block' })

async function openInactiveSession(page: Page, failure: RecoveryFailure, resumable = true) {
    const session: Session = {
        id: 'resume-error-session',
        namespace: 'default',
        seq: 1,
        createdAt: 1_742_372_800_000,
        updatedAt: 1_742_372_800_000,
        active: false,
        activeAt: 0,
        metadata: {
            path: resumable ? '/repo/project' : '',
            host: 'isolated-test',
            name: 'Recovery failure regression',
            flavor: 'omp',
            ompSession: { id: 'omp-resume-thread' },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        model: null,
        modelReasoningEffort: null,
        effort: null,
        serviceTier: null,
        resumeWithSessionModel: false,
    }
    const requests = { resume: 0, sent: [] as string[] }
    let recover = false
    await page.addInitScript(() => localStorage.setItem('hapi-lang', 'en'))
    // Intercept every hub request; this test must never reach a real hub.
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        if (path === `/api/sessions/${session.id}/resume`) {
            requests.resume += 1
            if (recover) {
                session.active = true
                await route.fulfill({ json: { sessionId: session.id } })
            } else if (failure === 'network') {
                await route.abort('failed')
            } else {
                await route.fulfill({ status: failure.status, json: { error: failure.error, code: failure.code } })
            }
        } else if (path === `/api/sessions/${session.id}/messages`) {
            if (request.method() === 'POST') {
                requests.sent.push(request.postDataJSON().text)
                await route.fulfill({ json: { ok: true } })
            } else {
                await route.fulfill({ json: {
                    messages: [],
                    page: {
                        direction: 'latest', limit: 200, epoch: 1, reset: false,
                        nextBeforeSeq: null, nextBeforeAt: null, nextAfterSeq: null, nextAfterAt: null,
                        snapshotHeadSeq: null, snapshotHeadAt: null, hasMore: false,
                    },
                } })
            }
        } else if (path === '/api/auth') {
            await route.fulfill({ json: { token: ['isolated', 'browser', 'test'].join('-'), user: { id: 1, username: 'test' } } })
        } else if (path === '/api/sessions') {
            await route.fulfill({ json: { sessions: [session] } })
        } else if (path === `/api/sessions/${session.id}`) {
            await route.fulfill({ json: { session } })
        } else if (path === '/api/machines') {
            await route.fulfill({ json: { machines: [] } })
        } else if (path === '/api/events') {
            await route.fulfill({ contentType: 'text/event-stream', body: ': isolated test\n\n' })
        } else {
            await route.fulfill({ status: 404, json: { error: 'Not available in isolated test' } })
        }
    })
    await page.route('**/health', (route) => route.fulfill({ json: { status: 'ok', protocolVersion: 1 } }))
    await page.goto(`/sessions/${session.id}?token=isolated-test-token`)
    const editor = page.getByTestId('rich-composer-input')
    await expect(editor).toBeVisible()
    return { editor, requests, recover: () => { recover = true } }
}

test.afterEach(async ({ page }) => {
    // Stop background refetches while the mock routes are still installed.
    await page.goto('about:blank')
})

test('resume 503 preserves the draft, offers no reopen, and allows a successful retry', async ({ page }) => {
    const fixture = await openInactiveSession(page, { status: 503, error: 'No machine online', code: 'no_machine_online' })
    await fixture.editor.fill('keep my recovery draft')
    await fixture.editor.press('Enter')
    const error = page.getByTestId('composer-send-error')
    await expect(error).toHaveText('No machine online')
    await expect(fixture.editor).toHaveText('keep my recovery draft')
    await expect(page.getByTestId('composer-send-error-action')).toHaveCount(0)
    await expect(page.locator('[data-toast-variant]')).toHaveCount(0)
    expect(fixture.requests).toEqual({ resume: 1, sent: [] })

    fixture.recover()
    await fixture.editor.press('Enter')
    await expect.poll(() => fixture.requests.sent).toEqual(['keep my recovery draft'])
    expect(fixture.requests.resume).toBe(2)
    await expect(error).toHaveCount(0)
    await expect(fixture.editor).toBeEmpty()
})

test('an explicit inactive response retains its reopen action', async ({ page }) => {
    const fixture = await openInactiveSession(page, { status: 409, error: 'Session is inactive', code: 'session_inactive' })
    await fixture.editor.fill('keep my inactive draft')
    await fixture.editor.press('Enter')
    await expect(page.getByTestId('composer-send-error-action')).toBeVisible()
    await expect(fixture.editor).toHaveText('keep my inactive draft')
    expect(fixture.requests).toEqual({ resume: 1, sent: [] })
})

test('missing resume metadata rejects before issuing a recovery request', async ({ page }) => {
    const fixture = await openInactiveSession(page, { status: 503, error: 'Unused' }, false)
    await fixture.editor.fill('keep my blocked draft')
    await fixture.editor.press('Enter')
    await expect(page.getByTestId('composer-send-error')).toBeVisible()
    await expect(fixture.editor).toHaveText('keep my blocked draft')
    expect(fixture.requests).toEqual({ resume: 0, sent: [] })
})

for (const failure of [
    { status: 500, error: 'Recovery service unavailable' },
    'network',
] satisfies RecoveryFailure[]) {
    test(`a ${typeof failure === 'string' ? failure : failure.status} recovery failure does not offer reopen`, async ({ page }) => {
        const fixture = await openInactiveSession(page, failure)
        await fixture.editor.fill('keep my transient draft')
        await fixture.editor.press('Enter')
        await expect(page.getByTestId('composer-send-error')).toBeVisible()
        await expect(fixture.editor).toHaveText('keep my transient draft')
        await expect(page.getByTestId('composer-send-error-action')).toHaveCount(0)
        expect(fixture.requests).toEqual({ resume: 1, sent: [] })
    })
}
