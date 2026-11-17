import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { MessagesResponse } from '@/types/api'
import { useMessages, type MessageWindowControls } from '@/hooks/queries/useMessages'
import { useSendMessage } from '@/hooks/mutations/useSendMessage'
import { useCancelQueuedMessage } from '@/hooks/mutations/useCancelQueuedMessage'
import { useRetryIndeterminateMessage } from '@/hooks/mutations/useRetryIndeterminateMessage'
import { I18nProvider } from './i18n-context'
import { ToastProvider } from './toast-context'
import { MessageWindowScopeProvider } from './message-window-scope'
import {
    flushDeferredPersistedStates,
    getMessageWindowState,
    ingestIncomingMessages,
    setMessageWindowScope,
    syncTailMessages,
} from './message-window-store'

const sessionId = 'same-session'
const storageKey = `hapi:message-window:v2:${sessionId}`
const ownerKey = 'hapi:message-window:scope'
const scopeA = 'http://hub-a|1'

function page(id: string, direction: 'latest' | 'before' = 'latest'): MessagesResponse {
    return {
        messages: [{
            id, seq: 2, localId: null, createdAt: 2_000, invokedAt: 2_000,
            content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: id } } },
        }],
        page: {
            direction, limit: 200, epoch: 1, reset: false, hasMore: true,
            nextBeforeAt: 1_000, nextBeforeSeq: 1, nextAfterAt: null, nextAfterSeq: null,
            snapshotHeadAt: 2_000, snapshotHeadSeq: 2,
        },
    }
}

function api(getMessages: ApiClient['getMessages']): ApiClient {
    return { getMessages } as ApiClient
}

type SavedActions = Pick<MessageWindowControls, 'loadMore' | 'refetch' | 'cancelLoadMore' | 'setViewMode'>

type ProbeProps = {
    client: ApiClient | null
    id?: string
    observe?: (value: string) => void
    save?: (actions: SavedActions) => void
}

function Probe(props: ProbeProps) {
    const messages = useMessages(props.client, props.id ?? sessionId)
    const value = messages.messages.map((message) => message.id).join(',')
    props.observe?.(value)
    props.save?.(messages)
    return <output data-testid="messages">{value}</output>
}

function tree(scope: string | null | undefined, client: ApiClient | null, props?: Omit<ProbeProps, 'client'>) {
    return (
        <QueryClientProvider client={queryClient}>
            <MessageWindowScopeProvider scope={scope}>
                <Probe client={client} {...props} />
            </MessageWindowScopeProvider>
        </QueryClientProvider>
    )
}

let queryClient: QueryClient
beforeEach(() => {
    setMessageWindowScope(null)
    sessionStorage.clear()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
    cleanup()
    setMessageWindowScope(null)
    queryClient.clear()
    sessionStorage.clear()
})

describe('message scope admission', () => {
    it.each([
        ['account', 'http://hub-a|2'],
        ['Hub', 'http://hub-b|1'],
        ['logout', null],
    ])('isolates RAM, storage and Query data before the first %s consumer render', async (_label, nextScope) => {
        setMessageWindowScope(scopeA)
        ingestIncomingMessages(sessionId, page('private-prior-scope').messages)
        flushDeferredPersistedStates()
        const oldTail = Promise.withResolvers<MessagesResponse>()
        const newTail = Promise.withResolvers<MessagesResponse>()
        const oldClient = api(() => oldTail.promise)
        const newClient = nextScope ? api(() => newTail.promise) : null
        const view = render(tree(scopeA, oldClient))
        expect(screen.getByTestId('messages').textContent).toBe('private-prior-scope')
        expect(sessionStorage.getItem(storageKey)).toContain('private-prior-scope')
        queryClient.setQueryData(['private-session'], { text: 'private-prior-scope' })

        const firstRenders: string[] = []
        view.rerender(tree(nextScope, newClient, { observe: (value) => firstRenders.push(value) }))
        expect(firstRenders.every((value) => !value.includes('private-prior-scope'))).toBe(true)
        expect(screen.getByTestId('messages').textContent).toBe('')
        expect(queryClient.getQueryData(['private-session'])).toBeUndefined()
        expect(sessionStorage.getItem(storageKey)).toBeNull()
        await act(async () => { oldTail.resolve(page('private-late-tail')) })
        expect(getMessageWindowState(sessionId).messages).toEqual([])
        if (nextScope) {
            await act(async () => { newTail.resolve(page('new-scope')) })
            await waitFor(() => expect(screen.getByTestId('messages').textContent).toBe('new-scope'))
        }
    })

    it.each([
        ['tail', 'resolve'], ['tail', 'reject'], ['history', 'resolve'], ['history', 'reject'],
    ] as const)('rejects old %s %s and retired controls after A → B → A', async (kind, settlement) => {
        setMessageWindowScope(scopeA)
        await syncTailMessages(api(async () => page('old-visible')), sessionId)
        const tail = Promise.withResolvers<MessagesResponse>()
        const older = Promise.withResolvers<MessagesResponse>()
        let oldRequests = 0
        const oldClient = api((_id, options) => {
            oldRequests += 1
            return options?.beforeAt !== undefined
                ? older.promise
                : kind === 'tail' ? tail.promise : Promise.resolve(page('old-visible'))
        })
        let saved!: SavedActions
        const view = render(tree(scopeA, oldClient, { save: (actions) => { saved = actions } }))
        await act(async () => {})
        const oldActions = saved
        let history: Promise<unknown> = Promise.resolve()
        if (kind === 'history') act(() => { history = oldActions.loadMore() })
        expect(oldRequests).toBe(kind === 'history' ? 2 : 1)
        view.rerender(tree('http://hub-a|2', null))
        const fresh = Promise.withResolvers<MessagesResponse>()
        view.rerender(tree(scopeA, api(() => fresh.promise)))
        expect(getMessageWindowState(sessionId).isSyncingTail).toBe(true)
        await act(async () => {
            const pending = kind === 'tail' ? tail : older
            if (settlement === 'resolve') {
                pending.resolve(page('private-late-result', kind === 'tail' ? 'latest' : 'before'))
            } else {
                pending.reject(new Error('private-prior-scope-failure'))
            }
            await history
            await oldActions.refetch()
            await expect(oldActions.loadMore()).resolves.toEqual({ kind: 'stopped', reason: 'invalidated' })
            oldActions.cancelLoadMore()
            oldActions.setViewMode('history')
        })
        expect(oldRequests).toBe(kind === 'history' ? 2 : 1)
        expect(getMessageWindowState(sessionId)).toMatchObject({
            messages: [], warning: null, isSyncingTail: true, isLoadingMore: false, viewMode: 'tail',
        })
        await act(async () => { fresh.resolve(page('fresh-A')) })
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toBe('fresh-A'))
    })

    it('preserves matching-owner hydration through pending auth and purges unknown ownership', () => {
        setMessageWindowScope(undefined)
        const persisted = JSON.stringify({ messages: page('persisted-A').messages, finalizedStreamIds: [], hasMore: false, epoch: 1 })
        sessionStorage.setItem(ownerKey, scopeA)
        sessionStorage.setItem(storageKey, persisted)
        const view = render(tree(undefined, null))
        expect(screen.getByTestId('messages').textContent).toBe('')
        expect(sessionStorage.getItem(storageKey)).toBe(persisted)
        const pending = Promise.withResolvers<MessagesResponse>()
        view.rerender(tree(scopeA, api(() => pending.promise)))
        expect(screen.getByTestId('messages').textContent).toBe('persisted-A')
        view.unmount()
        setMessageWindowScope(null)
        sessionStorage.setItem(storageKey, persisted)
        const unknownOwner = render(tree(scopeA, api(() => pending.promise)))
        expect(screen.getByTestId('messages').textContent).toBe('')
        expect(sessionStorage.getItem(storageKey)).toBeNull()
        unknownOwner.unmount()
    })

    it('does not let retired send/cancel/retry settlements delete or restore rows in the next account', async () => {
        const send = Promise.withResolvers<void>()
        const cancel = Promise.withResolvers<never>()
        const retry = Promise.withResolvers<{ status: 'not-found' }>()
        let requests = 0
        const oldClient = {
            sendMessage: () => { requests += 1; return send.promise },
            cancelMessage: () => { requests += 1; return cancel.promise },
            retryIndeterminateMessage: () => { requests += 1; return retry.promise },
        } as unknown as ApiClient
        const snapshot = { ...page('private-cancelled-row').messages[0]!, localId: 'cancel-local', invokedAt: null, status: 'queued' as const }
        let actions!: { send: () => Promise<{ attemptId: string } | false>; cancel: () => Promise<unknown>; retry: () => Promise<unknown> }
        function MutationProbe() {
            const sending = useSendMessage(oldClient, sessionId)
            const cancelling = useCancelQueuedMessage(oldClient)
            const retrying = useRetryIndeterminateMessage(oldClient)
            actions = {
                send: () => sending.sendMessage('private-old-send'),
                cancel: () => cancelling.mutateAsync({ sessionId, messageId: snapshot.id, localId: snapshot.localId, snapshot }),
                retry: () => retrying.mutateAsync({ sessionId, messageId: 'retry-local' }),
            }
            return null
        }
        const view = render(
            <QueryClientProvider client={queryClient}>
                <MessageWindowScopeProvider scope={scopeA}>
                    <I18nProvider><ToastProvider><MutationProbe /></ToastProvider></I18nProvider>
                </MessageWindowScopeProvider>
            </QueryClientProvider>,
        )
        let accepted!: { attemptId: string } | false
        let cancelled!: Promise<unknown>
        let retried!: Promise<unknown>
        await act(async () => {
            accepted = await actions.send()
            cancelled = actions.cancel().catch((error: unknown) => error)
            retried = actions.retry()
        })
        await waitFor(() => expect(requests).toBe(3))
        if (!accepted) throw new Error('Expected an accepted send')
        const sendId = accepted.attemptId
        const fresh = Promise.withResolvers<MessagesResponse>()
        view.rerender(tree('http://hub-a|2', api(() => fresh.promise)))
        const freshRows = [sendId, 'retry-local'].map((id) => ({ ...page(id).messages[0]!, localId: id, status: 'queued' as const }))
        act(() => { ingestIncomingMessages(sessionId, freshRows) })
        await act(async () => {
            send.reject(new Error('retired-send'))
            cancel.reject(new Error('retired-cancel'))
            retry.resolve({ status: 'not-found' })
            await Promise.all([cancelled, retried])
        })
        expect(getMessageWindowState(sessionId).messages.map((message) => message.id)).toEqual([sendId, 'retry-local'])
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toBe(`${sendId},retry-local`))
        await act(async () => { fresh.resolve(page('current-tail')) })
    })

    it('retires pending history on a same-scope StrictMode detach without dropping the warm window', async () => {
        setMessageWindowScope(scopeA)
        await syncTailMessages(api(async () => page('warm-history')), sessionId)
        const older = Promise.withResolvers<MessagesResponse>()
        const oldClient = api((_id, options) => options?.beforeAt !== undefined
            ? older.promise
            : Promise.resolve(page('warm-history')))
        let saved!: SavedActions
        const view = render(<StrictMode>{tree(scopeA, oldClient, { save: (actions) => { saved = actions } })}</StrictMode>)
        await waitFor(() => expect(getMessageWindowState(sessionId).isSyncingTail).toBe(false))
        let history!: Promise<unknown>
        act(() => { history = saved.loadMore() })
        expect(getMessageWindowState(sessionId).isLoadingMore).toBe(true)
        view.unmount()
        const fresh = Promise.withResolvers<MessagesResponse>()
        render(<StrictMode>{tree(scopeA, api(() => fresh.promise))}</StrictMode>)
        await act(async () => { older.resolve(page('retired-history', 'before')); await history })
        expect(screen.getByTestId('messages').textContent).toBe('warm-history')
        expect(getMessageWindowState(sessionId)).toMatchObject({ isSyncingTail: true, isLoadingMore: false })
        await act(async () => { fresh.resolve(page('current-tail')) })
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toContain('current-tail'))
    })

    it('keeps warm windows across same-scope session/client switches and retires detached requests', async () => {
        setMessageWindowScope(scopeA)
        ingestIncomingMessages(sessionId, page('warm-one').messages)
        ingestIncomingMessages('other-session', page('warm-two').messages)
        const detached = Promise.withResolvers<MessagesResponse>()
        const view = render(<StrictMode>{tree(scopeA, api(() => detached.promise))}</StrictMode>)
        expect(screen.getByTestId('messages').textContent).toBe('warm-one')
        view.rerender(<StrictMode>{tree(scopeA, api(() => detached.promise), { id: 'other-session' })}</StrictMode>)
        expect(screen.getByTestId('messages').textContent).toBe('warm-two')
        view.unmount()
        const fresh = Promise.withResolvers<MessagesResponse>()
        render(<StrictMode>{tree(scopeA, api(() => fresh.promise))}</StrictMode>)
        expect(screen.getByTestId('messages').textContent).toBe('warm-one')
        await act(async () => { detached.resolve(page('retired-request')) })
        expect(screen.getByTestId('messages').textContent).toBe('warm-one')
        expect(getMessageWindowState(sessionId).isSyncingTail).toBe(true)
        await act(async () => { fresh.resolve(page('fresh-request')) })
        await waitFor(() => expect(screen.getByTestId('messages').textContent).toContain('fresh-request'))
    })
})
