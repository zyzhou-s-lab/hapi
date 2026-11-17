import { Fragment, useLayoutEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getMessageWindowScopeVersion, setMessageWindowScope, suspendMessageWindowScope } from './message-window-store'

/** Admit consumers only after both singleton caches belong to their auth scope. */
export function MessageWindowScopeProvider(props: {
    scope: string | null | undefined
    children: ReactNode
}) {
    const queryClient = useQueryClient()
    const [ready, setReady] = useState<{ scope: typeof props.scope; version: number } | null>(null)

    useLayoutEffect(() => {
        if (setMessageWindowScope(props.scope)) queryClient.clear()
        setReady({ scope: props.scope, version: getMessageWindowScopeVersion() })
        // Retire requests on detach/StrictMode replay, not the same-scope data.
        return suspendMessageWindowScope
    }, [props.scope, queryClient])

    return ready && ready.scope === props.scope && ready.version === getMessageWindowScopeVersion()
        ? <Fragment key={ready.version}>{props.children}</Fragment>
        : null
}
