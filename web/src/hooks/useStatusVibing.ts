import { useEffect, useState } from 'react'

const STORAGE_KEY = 'hapi-status-vibing'
const listeners = new Set<() => void>()

function readStatusVibing(): boolean {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        return false
    }
}

function writeStatusVibing(enabled: boolean) {
    try {
        localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0')
    } catch {
        // Ignore storage errors.
    }
    for (const listener of listeners) listener()
}

export function useStatusVibing(): { enabled: boolean; setEnabled: (enabled: boolean) => void } {
    const [enabled, setEnabledState] = useState(readStatusVibing)

    useEffect(() => {
        const sync = () => setEnabledState(readStatusVibing())
        listeners.add(sync)
        window.addEventListener('storage', sync)
        return () => {
            listeners.delete(sync)
            window.removeEventListener('storage', sync)
        }
    }, [])

    return { enabled, setEnabled: writeStatusVibing }
}
