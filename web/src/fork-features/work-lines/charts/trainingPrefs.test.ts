import { describe, expect, it } from 'vitest'
import { TRAINING_X_STEP } from '../trainingSeries'
import { TRAINING_PREF_LIMIT, TRAINING_PREF_TTL_MS, readTrainingHidden, readTrainingXAxis, trainingBrowserStore, trainingHiddenStorageKey, trainingPrefId, trainingXAxisStorageKey, writeTrainingHidden, writeTrainingXAxis, type TrainingPrefStore } from './trainingPrefs'

function memoryStore(): TrainingPrefStore & { map: Map<string, string> } {
    const map = new Map<string, string>()
    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => { map.set(key, value) },
        removeItem: (key) => { map.delete(key) },
        keys: () => [...map.keys()],
    }
}

describe('training chart prefs', () => {
    it('stores the x axis and hidden metrics per card instance', () => {
        const store = memoryStore()
        const first = trainingPrefId('card-1')
        const sameRun = trainingPrefId('card-2')
        const other = trainingPrefId('card-3')
        expect(first).not.toBe(sameRun)
        writeTrainingXAxis(first, 'epoch', store)
        writeTrainingXAxis(sameRun, '_runtime', store)
        writeTrainingXAxis(other, '_timestamp', store)
        writeTrainingHidden(first, new Set(['eval', 'loss']), store)
        writeTrainingHidden(sameRun, new Set(['acc']), store)
        expect(readTrainingXAxis(first, store)).toBe('epoch')
        expect(readTrainingXAxis(sameRun, store)).toBe('_runtime')
        expect(readTrainingXAxis(other, store)).toBe('_timestamp')
        expect(readTrainingHidden(first, store)).toEqual(new Set(['eval', 'loss']))
        expect(readTrainingHidden(sameRun, store)).toEqual(new Set(['acc']))
        expect(store.map.has('hapi.training.xAxis')).toBe(false)
        expect(store.map.has('hapi.training.xAxis:exp-1')).toBe(false)
        expect(JSON.parse(store.map.get(trainingHiddenStorageKey(first)) ?? 'null')).toEqual(['eval', 'loss'])
    })

    it('drops expired prefs, the oldest entries, and leftover run-name keys', () => {
        const store = memoryStore()
        store.map.set('hapi.training.xAxis:exp-old', '_runtime')
        store.map.set('hapi.training.hidden:exp-old', '["loss"]')
        const stale = trainingPrefId('stale')
        writeTrainingXAxis(stale, 'epoch', store, 0)
        writeTrainingHidden(stale, new Set(['loss']), store, 0)
        for (let index = 0; index < TRAINING_PREF_LIMIT; index += 1) {
            writeTrainingXAxis(trainingPrefId(`card-${index}`), 'epoch', store, TRAINING_PREF_TTL_MS + 1 + index)
        }
        expect(store.map.has('hapi.training.xAxis:exp-old')).toBe(false)
        expect(store.map.has('hapi.training.hidden:exp-old')).toBe(false)
        expect(readTrainingXAxis(stale, store)).toBeNull()
        expect(readTrainingHidden(stale, store)).toEqual(new Set())
        expect(store.map.has(trainingXAxisStorageKey(stale))).toBe(false)
        const oldest = trainingPrefId('card-0')
        expect(readTrainingXAxis(oldest, store)).toBe('epoch')
        writeTrainingXAxis(trainingPrefId('card-new'), '_runtime', store, TRAINING_PREF_TTL_MS + TRAINING_PREF_LIMIT + 2)
        expect(readTrainingXAxis(oldest, store)).toBeNull()
        expect(store.map.has(trainingXAxisStorageKey(oldest))).toBe(false)
        expect(readTrainingXAxis(trainingPrefId('card-1'), store)).toBe('epoch')
        expect(readTrainingXAxis(trainingPrefId('card-new'), store)).toBe('_runtime')
    })

    it('ignores an incomplete id and falls back when storage throws or is corrupt', () => {
        const calls: string[] = []
        const idle: TrainingPrefStore = {
            getItem: () => {
                calls.push('get')
                return 'epoch'
            },
            setItem: () => { calls.push('set') },
            removeItem: () => { calls.push('remove') },
            keys: () => {
                calls.push('keys')
                return []
            },
        }
        expect(trainingPrefId('')).toBe('')
        expect(readTrainingXAxis('', idle)).toBeNull()
        expect(readTrainingHidden('', idle)).toEqual(new Set())
        writeTrainingXAxis('', 'epoch', idle)
        writeTrainingHidden('', new Set(['loss']), idle)
        expect(calls).toEqual([])

        const broken: TrainingPrefStore = {
            getItem() { throw new Error('denied') },
            setItem() { throw new Error('full') },
            removeItem() { throw new Error('full') },
            keys() { throw new Error('denied') },
        }
        const id = trainingPrefId('card-1')
        expect(readTrainingXAxis(id, broken)).toBeNull()
        expect(readTrainingHidden(id, broken)).toEqual(new Set())
        expect(() => writeTrainingXAxis(id, 'epoch', broken)).not.toThrow()
        expect(() => writeTrainingHidden(id, new Set(['loss']), broken)).not.toThrow()
        expect(readTrainingXAxis(id, null)).toBeNull()
        expect(readTrainingHidden(id, null)).toEqual(new Set())

        const store = memoryStore()
        store.map.set(trainingHiddenStorageKey(id), '{')
        expect(readTrainingHidden(id, store)).toEqual(new Set())
        store.map.set(trainingHiddenStorageKey(id), '[1,"loss",""]')
        expect(readTrainingHidden(id, store)).toEqual(new Set(['loss']))
        store.map.set(trainingXAxisStorageKey(id), '')
        expect(readTrainingXAxis(id, store)).toBeNull()
        store.map.set('hapi.training.prefs', '{')
        store.map.set('hapi.training.xAxis:exp-old', '_runtime')
        expect(() => writeTrainingXAxis(id, 'epoch', store)).not.toThrow()
        expect(readTrainingXAxis(id, store)).toBe('epoch')
        expect(store.map.get('hapi.training.xAxis:exp-old')).toBe('_runtime')
    })

    it('leaves storage alone when the choice already matches and drops an empty selection', () => {
        let scans = 0
        const map = new Map<string, string>()
        const store: TrainingPrefStore = {
            getItem: (key) => map.get(key) ?? null,
            setItem: (key, value) => { map.set(key, value) },
            removeItem: (key) => { map.delete(key) },
            keys: () => {
                scans += 1
                return [...map.keys()]
            },
        }
        const id = trainingPrefId('card-1')
        writeTrainingXAxis(id, TRAINING_X_STEP, store)
        writeTrainingHidden(id, new Set(), store)
        expect(scans).toBe(0)
        expect(map.size).toBe(0)
        map.set('hapi.training.xAxis', 'epoch')
        writeTrainingHidden(id, new Set(['eval']), store)
        expect(map.has('hapi.training.xAxis')).toBe(false)
        expect(map.get(trainingHiddenStorageKey(id))).toBe('["eval"]')
        expect(scans).toBe(1)
        writeTrainingHidden(id, new Set(['eval']), store)
        expect(scans).toBe(1)
        writeTrainingHidden(id, new Set(), store)
        expect(map.has(trainingHiddenStorageKey(id))).toBe(false)
        expect(map.has('hapi.training.prefs')).toBe(false)
        writeTrainingXAxis(id, '_runtime', store)
        writeTrainingXAxis(id, TRAINING_X_STEP, store)
        expect(map.has(trainingXAxisStorageKey(id))).toBe(false)
        expect(map.has('hapi.training.prefs')).toBe(false)
    })

    it('returns null when the browser storage getter throws', () => {
        const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
        Object.defineProperty(window, 'localStorage', {
            configurable: true,
            get() { throw new Error('denied') },
        })
        try {
            expect(trainingBrowserStore()).toBeNull()
        } finally {
            if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
        }
    })
})
