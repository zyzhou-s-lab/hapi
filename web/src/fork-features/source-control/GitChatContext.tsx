import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { GitChatPreparation } from './gitChat'

export type GitChatContextValue = {
    preparation: GitChatPreparation | null
    disabled: boolean
    send: (text: string) => Promise<boolean>
}

type GitDraftReview = {
    edited: string | null
    cancelled: boolean
    sent: string | null
    pendingText: string | null
    error: string | null
}

export const EMPTY_GIT_REVIEW: Readonly<GitDraftReview> = {
    edited: null, cancelled: false, sent: null, pendingText: null, error: null,
}

type GitChatState = GitChatContextValue & {
    reviews: ReadonlyMap<string, GitDraftReview>
    updateReview: (code: string, patch: Partial<GitDraftReview>) => void
    sendReview: (code: string, text: string, failureMessage: string) => Promise<void>
}

const GitChatContext = createContext<GitChatState | null>(null)

/** Session-local ownership survives answer remounts; unchanged fences share one review. */
export function GitChatProvider({ value, children }: { value: GitChatContextValue; children: ReactNode }) {
    const reviews = useRef(new Map<string, GitDraftReview>())
    const [version, setVersion] = useState(0)
    const updateReview = useCallback((code: string, patch: Partial<GitDraftReview>) => {
        reviews.current.set(code, { ...(reviews.current.get(code) ?? EMPTY_GIT_REVIEW), ...patch })
        setVersion(current => current + 1)
    }, [])
    const sendReview = useCallback(async (code: string, text: string, failureMessage: string) => {
        const review = reviews.current.get(code)
        if (value.disabled || review?.pendingText != null || review?.sent) return
        updateReview(code, { pendingText: text, error: null })
        try {
            if (await value.send(text)) updateReview(code, { sent: text })
            else updateReview(code, { error: failureMessage })
        } catch (cause) {
            updateReview(code, { error: cause instanceof Error ? cause.message : failureMessage })
        } finally {
            updateReview(code, { pendingText: null })
        }
    }, [value.disabled, value.send, updateReview])
    const context = useMemo<GitChatState>(() => ({
        ...value, reviews: reviews.current, updateReview, sendReview,
    }), [value, version, updateReview, sendReview])

    return <GitChatContext.Provider value={context}>{children}</GitChatContext.Provider>
}

export function useGitChat() {
    return useContext(GitChatContext)
}
