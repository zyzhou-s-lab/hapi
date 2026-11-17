import { Toast as ToastPrimitive } from '@base-ui/react/toast'
import { useNavigate } from '@tanstack/react-router'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { Toast } from '@/components/ui/Toast'
import { useToast } from '@/lib/toast-context'

export function ToastContainer() {
    const navigate = useNavigate()
    const { toasts, removeToast } = useToast()

    return (
        <ToastPrimitive.Portal>
            <ToastPrimitive.Viewport
                data-slot="toast-viewport"
                data-position="top-right"
                className="coss-toast-viewport pointer-events-none fixed top-[calc(env(safe-area-inset-top)+var(--toast-inset))] right-[calc(var(--toast-inset)+env(safe-area-inset-right))] z-60 flex h-[var(--toast-card-height)] w-[calc(100%-var(--toast-inset)-var(--toast-inset)-env(safe-area-inset-left)-env(safe-area-inset-right))] max-w-90 outline-none [--toast-inset:1rem] sm:[--toast-inset:2rem]"
            >
                {toasts.map((toast) => (
                    <Toast
                        key={toast.id}
                        toast={toast}
                        className={toast.data?.sessionId || toast.data?.url ? 'cursor-pointer' : undefined}
                        onClick={() => {
                            removeToast(toast.id)
                            if (toast.data?.sessionId) {
                                void navigate({
                                    to: '/sessions/$sessionId',
                                    params: { sessionId: toast.data.sessionId },
                                    ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                                })
                                return
                            }
                            if (toast.data?.url) {
                                void navigate({ to: toast.data.url })
                            }
                        }}
                    />
                ))}
            </ToastPrimitive.Viewport>
        </ToastPrimitive.Portal>
    )
}
