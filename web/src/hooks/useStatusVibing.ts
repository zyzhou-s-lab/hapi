import { useState } from 'react'

const STORAGE_KEY = 'hapi-status-vibing'

function readStatusVibing(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

export function useStatusVibing(): { enabled: boolean; setEnabled: (enabled: boolean) => void } {
    const [enabled, setEnabledState] = useState(readStatusVibing)

    const setEnabled = (next: boolean) => {
        setEnabledState(next)
        try {
            localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
        } catch {
            // Ignore storage errors.
        }
    }

    return { enabled, setEnabled }
}
