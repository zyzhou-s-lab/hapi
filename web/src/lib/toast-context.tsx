import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { Toast as ToastPrimitive } from '@base-ui/react/toast'

export type ToastVariant = 'default' | 'info' | 'success' | 'warning' | 'error' | 'loading'

export type ToastData = {
    sessionId: string
    url: string
    variant: ToastVariant
}

export type Toast = ToastPrimitive.Root.ToastObject<ToastData>

export type AddToastInput = {
    title: string
    body: string
    sessionId: string
    url: string
    variant?: ToastVariant
    durationMs?: number
}
export type ToastContextValue = {
    toasts: Toast[]
    addToast: (toast: AddToastInput) => void
    removeToast: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)
const DEFAULT_TOAST_DURATION_MS = 6000

export function ToastProvider({ children }: { children: ReactNode }) {
    return (
        <ToastPrimitive.Provider timeout={DEFAULT_TOAST_DURATION_MS} limit={3}>
            <ToastContextBridge>{children}</ToastContextBridge>
        </ToastPrimitive.Provider>
    )
}

function ToastContextBridge({ children }: { children: ReactNode }) {
    const { toasts, add, close } = ToastPrimitive.useToastManager<ToastData>()
    const addToast = useCallback(({ title, body, sessionId, url, variant = 'default', durationMs }: AddToastInput) => {
        add({
            title,
            description: body,
            type: variant === 'default' ? 'info' : variant,
            timeout: durationMs,
            data: { sessionId, url, variant },
        })
    }, [add])

    const value = useMemo<ToastContextValue>(() => ({
        toasts,
        addToast,
        removeToast: close,
    }), [toasts, addToast, close])

    return (
        <ToastContext.Provider value={value}>
            {children}
        </ToastContext.Provider>
    )
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext)
    if (!ctx) {
        throw new Error('useToast must be used within ToastProvider')
    }
    return ctx
}

export function useOptionalToast(): ToastContextValue | null {
    return useContext(ToastContext)
}
