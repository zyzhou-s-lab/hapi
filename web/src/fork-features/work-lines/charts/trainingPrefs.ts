import { TRAINING_X_STEP } from '../trainingSeries'

const AXIS_PREFIX = 'hapi.training.xAxis:'
const HIDDEN_PREFIX = 'hapi.training.hidden:'
const LEGACY_X_AXIS_KEY = 'hapi.training.xAxis'
const INDEX_KEY = 'hapi.training.prefs'

export const TRAINING_PREF_LIMIT = 32
export const TRAINING_PREF_TTL_MS = 90 * 24 * 60 * 60 * 1000

export function trainingPrefId(instanceId: string): string {
    if (instanceId.length === 0) return ''
    return encodeURIComponent(instanceId)
}

export function trainingXAxisStorageKey(prefId: string): string {
    return `${AXIS_PREFIX}${prefId}`
}

export function trainingHiddenStorageKey(prefId: string): string {
    return `${HIDDEN_PREFIX}${prefId}`
}

export type TrainingPrefStore = {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
    keys(): string[]
}

export function trainingBrowserStore(): TrainingPrefStore | null {
    try {
        const storage = window.localStorage
        return {
            getItem: (key) => storage.getItem(key),
            setItem: (key, value) => storage.setItem(key, value),
            removeItem: (key) => storage.removeItem(key),
            keys: () => {
                const names: string[] = []
                for (let index = 0; index < storage.length; index += 1) {
                    const key = storage.key(index)
                    if (key) names.push(key)
                }
                return names
            },
        }
    } catch {
        return null
    }
}

export function readTrainingXAxis(prefId: string, store: TrainingPrefStore | null): string | null {
    if (!store || prefId.length === 0) return null
    try {
        const value = store.getItem(trainingXAxisStorageKey(prefId))
        return value && value.length > 0 ? value : null
    } catch {
        return null
    }
}

export function writeTrainingXAxis(prefId: string, value: string, store: TrainingPrefStore | null, now = Date.now(), baseline = TRAINING_X_STEP): void {
    if (!store || prefId.length === 0) return
    try {
        const next = value.length > 0 ? value : TRAINING_X_STEP
        const floor = baseline.length > 0 ? baseline : TRAINING_X_STEP
        const stored = readTrainingXAxis(prefId, store)
        if (next === floor) {
            if (stored == null) return
            store.removeItem(trainingXAxisStorageKey(prefId))
            touchTrainingPref(store, prefId, now)
            return
        }
        if (stored === next) return
        store.setItem(trainingXAxisStorageKey(prefId), next)
        touchTrainingPref(store, prefId, now)
    } catch {
        // Private mode or a full quota. The in-memory choice still applies.
    }
}

export function readTrainingHidden(prefId: string, store: TrainingPrefStore | null): ReadonlySet<string> {
    if (!store || prefId.length === 0) return new Set()
    try {
        const raw = store.getItem(trainingHiddenStorageKey(prefId))
        if (!raw) return new Set()
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return new Set()
        return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))
    } catch {
        return new Set()
    }
}

export function writeTrainingHidden(prefId: string, hidden: ReadonlySet<string>, store: TrainingPrefStore | null, now = Date.now()): void {
    if (!store || prefId.length === 0) return
    try {
        if (sameHidden(readTrainingHidden(prefId, store), hidden)) return
        const key = trainingHiddenStorageKey(prefId)
        if (hidden.size === 0) store.removeItem(key)
        else store.setItem(key, JSON.stringify([...hidden].sort()))
        touchTrainingPref(store, prefId, now)
    } catch {
        // Private mode or a full quota. The in-memory choice still applies.
    }
}

function sameHidden(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
    if (left.size !== right.size) return false
    for (const id of left) if (!right.has(id)) return false
    return true
}

function prefStillStored(store: TrainingPrefStore, prefId: string): boolean {
    const axis = store.getItem(trainingXAxisStorageKey(prefId))
    if (axis && axis !== TRAINING_X_STEP) return true
    const hidden = store.getItem(trainingHiddenStorageKey(prefId))
    return hidden != null && hidden !== '[]'
}

function prefIdFromStorageKey(key: string): string | null {
    if (key.startsWith(AXIS_PREFIX)) return key.slice(AXIS_PREFIX.length)
    if (key.startsWith(HIDDEN_PREFIX)) return key.slice(HIDDEN_PREFIX.length)
    return null
}

function readPrefIndex(store: TrainingPrefStore): { rows: { id: string; at: number }[]; ok: boolean } {
    const raw = store.getItem(INDEX_KEY)
    if (!raw) return { rows: [], ok: true }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return { rows: [], ok: false }
    const rows: { id: string; at: number }[] = []
    for (const item of parsed) {
        const touch = prefTouch(item)
        if (touch) rows.push(touch)
    }
    return { rows, ok: true }
}

function prefTouch(item: unknown): { id: string; at: number } | null {
    if (!item || typeof item !== 'object' || !('id' in item) || !('at' in item)) return null
    const id = item.id
    const at = item.at
    if (typeof id !== 'string' || id.length === 0 || typeof at !== 'number' || !Number.isFinite(at)) return null
    return { id, at }
}

function touchTrainingPref(store: TrainingPrefStore, touchedId: string, now: number): void {
    store.removeItem(LEGACY_X_AXIS_KEY)
    const index = readPrefIndex(store)
    const kept = index.ok
        ? index.rows.filter((row) => row.id !== touchedId && now - row.at <= TRAINING_PREF_TTL_MS)
        : []
    if (prefStillStored(store, touchedId)) kept.push({ id: touchedId, at: now })
    kept.sort((left, right) => left.at - right.at)
    if (kept.length > TRAINING_PREF_LIMIT) kept.splice(0, kept.length - TRAINING_PREF_LIMIT)
    if (index.ok) {
        const live = new Set(kept.map((row) => row.id))
        for (const key of store.keys()) {
            const id = prefIdFromStorageKey(key)
            if (id != null && id.length > 0 && !live.has(id)) store.removeItem(key)
        }
    }
    if (kept.length === 0) store.removeItem(INDEX_KEY)
    else store.setItem(INDEX_KEY, JSON.stringify(kept))
}
