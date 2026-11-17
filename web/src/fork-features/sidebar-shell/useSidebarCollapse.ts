import { useCallback, useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-sidebar-collapsed'

function loadCollapsed(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

export function useSidebarCollapse() {
    const [collapsed, setCollapsed] = useState(loadCollapsed)
    const toggle = useCallback(() => setCollapsed(value => !value), [])

    useEffect(() => {
        try {
            localStorage.setItem(STORAGE_KEY, String(collapsed))
        } catch {
            // The control still works when browser storage is unavailable.
        }
    }, [collapsed])

    return { collapsed, toggle }
}
