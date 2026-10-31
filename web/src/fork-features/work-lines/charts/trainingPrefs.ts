import { TRAINING_X_STEP } from '../trainingSeries'

export function trainingXAxisStorageKey(run: string): string {
    return `hapi.training.xAxis:${run}`
}

export function trainingHiddenStorageKey(run: string): string {
    return `hapi.training.hidden:${run}`
}

export type TrainingPrefStore = {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
}

export function trainingBrowserStore(): TrainingPrefStore | null {
    try {
        return window.localStorage
    } catch {
        return null
    }
}

export function readTrainingXAxis(run: string, store: TrainingPrefStore | null): string {
    if (!store || run.length === 0) return TRAINING_X_STEP
    try {
        const value = store.getItem(trainingXAxisStorageKey(run))
        return value && value.length > 0 ? value : TRAINING_X_STEP
    } catch {
        return TRAINING_X_STEP
    }
}

export function writeTrainingXAxis(run: string, value: string, store: TrainingPrefStore | null): void {
    if (!store || run.length === 0) return
    try {
        store.setItem(trainingXAxisStorageKey(run), value)
    } catch {
        // Private mode or a full quota. The in-memory choice still applies.
    }
}

export function readTrainingHidden(run: string, store: TrainingPrefStore | null): ReadonlySet<string> {
    if (!store || run.length === 0) return new Set()
    try {
        const raw = store.getItem(trainingHiddenStorageKey(run))
        if (!raw) return new Set()
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return new Set()
        return new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))
    } catch {
        return new Set()
    }
}

export function writeTrainingHidden(run: string, hidden: ReadonlySet<string>, store: TrainingPrefStore | null): void {
    if (!store || run.length === 0) return
    try {
        store.setItem(trainingHiddenStorageKey(run), JSON.stringify([...hidden].sort()))
    } catch {
        // Private mode or a full quota. The in-memory choice still applies.
    }
}
