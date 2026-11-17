import * as React from 'react'
import { Toast as ToastPrimitive } from '@base-ui/react/toast'
import { cn } from '@/lib/utils'
import type { Toast as ToastObject, ToastVariant } from '@/lib/toast-context'

export type ToastProps = React.HTMLAttributes<HTMLDivElement> & {
    toast: ToastObject
}

function CossToastIcon({ variant }: { variant: ToastVariant }) {
    if (variant === 'error') {
        return (
            <svg
                viewBox="0 0 24 24"
                className="text-red-500 dark:text-red-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
        )
    }
    if (variant === 'warning') {
        return (
            <svg
                viewBox="0 0 24 24"
                className="text-amber-500 dark:text-amber-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                <path d="M12 9v4" />
                <path d="M12 17h.01" />
            </svg>
        )
    }
    if (variant === 'success') {
        return (
            <svg
                viewBox="0 0 24 24"
                className="text-emerald-500 dark:text-emerald-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <circle cx="12" cy="12" r="10" />
                <path d="m9 12 2 2 4-4" />
            </svg>
        )
    }
    if (variant === 'loading') {
        return (
            <svg
                viewBox="0 0 24 24"
                className="animate-spin text-[var(--app-hint)] opacity-80"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
        )
    }
    return (
        <svg
            viewBox="0 0 24 24"
            className="text-blue-500 dark:text-blue-400"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="10" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
        </svg>
    )
}

export function Toast({ toast, className, ...props }: ToastProps) {
    const variant = toast.data?.variant ?? 'default'
    const effectiveType = variant === 'default' ? 'info' : variant

    return (
        <ToastPrimitive.Root
            toast={toast}
            swipeDirection="right"
            data-position="top-right"
            data-slot="toast-popup"
            data-type={effectiveType}
            data-toast-variant={variant}
            className={cn(
                'coss-toast-popup pointer-events-auto absolute w-full select-none rounded-lg border border-black/8 bg-clip-padding font-sans text-sm text-[var(--app-fg)] shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_rgba(0,0,0,0.04)] dark:border-white/6 dark:bg-clip-border dark:before:shadow-[0_-1px_rgba(255,255,255,0.06)]',
                className
            )}
            {...props}
        >
            <ToastPrimitive.Content
                data-slot="toast-content"
                className="coss-toast-content flex items-center justify-between gap-1.5 overflow-hidden px-3.5 py-2 text-sm"
            >
                <div className="flex min-w-0 gap-2">
                    <div
                        data-slot="toast-icon"
                        className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
                    >
                        <CossToastIcon variant={effectiveType} />
                    </div>
                    <div className="flex min-w-0 flex-col gap-0.5">
                        <ToastPrimitive.Title
                            data-slot="toast-title"
                            className="truncate font-medium leading-5"
                            title={typeof toast.title === 'string' ? toast.title : undefined}
                        />
                        {toast.description ? (
                            <ToastPrimitive.Description
                                data-slot="toast-description"
                                className="line-clamp-2 text-[var(--app-hint)] leading-5 break-words"
                                title={typeof toast.description === 'string' ? toast.description : undefined}
                            />
                        ) : null}
                    </div>
                </div>
                <ToastPrimitive.Close
                    className="shrink-0 rounded-md p-1 text-xs text-[var(--app-hint)] transition-colors hover:bg-black/5 hover:text-[var(--app-fg)] dark:hover:bg-white/10"
                    onClick={(event) => event.stopPropagation()}
                    aria-label="Dismiss"
                >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M18 6 6 18" />
                        <path d="m6 6 12 12" />
                    </svg>
                </ToastPrimitive.Close>
            </ToastPrimitive.Content>
        </ToastPrimitive.Root>
    )
}
