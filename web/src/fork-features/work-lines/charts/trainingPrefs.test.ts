import { describe, expect, it } from 'vitest'
import { TRAINING_X_STEP } from '../trainingSeries'
import { readTrainingHidden, readTrainingXAxis, trainingBrowserStore, trainingHiddenStorageKey, trainingXAxisStorageKey, writeTrainingHidden, writeTrainingXAxis, type TrainingPrefStore } from './trainingPrefs'

function memoryStore(): TrainingPrefStore & { map: Map<string, string> } {
    const map = new Map<string, string>()
    return {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => { map.set(key, value) },
    }
}

describe('training chart prefs', () => {
    it('stores the x axis and hidden metrics per run', () => {
        const store = memoryStore()
        writeTrainingXAxis('exp-1', 'epoch', store)
        writeTrainingXAxis('exp-2', '_runtime', store)
        writeTrainingHidden('exp-1', new Set(['eval', 'loss']), store)
        writeTrainingHidden('exp-2', new Set(['acc']), store)
        expect(readTrainingXAxis('exp-1', store)).toBe('epoch')
        expect(readTrainingXAxis('exp-2', store)).toBe('_runtime')
        expect(readTrainingHidden('exp-1', store)).toEqual(new Set(['eval', 'loss']))
        expect(readTrainingHidden('exp-2', store)).toEqual(new Set(['acc']))
        expect(store.map.has('hapi.training.xAxis')).toBe(false)
        expect(JSON.parse(store.map.get(trainingHiddenStorageKey('exp-1')) ?? 'null')).toEqual(['eval', 'loss'])
        expect([...store.map.keys()]).toEqual([
            trainingXAxisStorageKey('exp-1'),
            trainingXAxisStorageKey('exp-2'),
            trainingHiddenStorageKey('exp-1'),
            trainingHiddenStorageKey('exp-2'),
        ])
    })

    it('ignores an empty run and falls back when storage throws or is corrupt', () => {
        const calls: string[] = []
        const idle: TrainingPrefStore = {
            getItem: () => {
                calls.push('get')
                return 'epoch'
            },
            setItem: () => { calls.push('set') },
        }
        expect(readTrainingXAxis('', idle)).toBe(TRAINING_X_STEP)
        expect(readTrainingHidden('', idle)).toEqual(new Set())
        writeTrainingXAxis('', 'epoch', idle)
        writeTrainingHidden('', new Set(['loss']), idle)
        expect(calls).toEqual([])

        const broken: TrainingPrefStore = {
            getItem() { throw new Error('denied') },
            setItem() { throw new Error('full') },
        }
        expect(readTrainingXAxis('exp-1', broken)).toBe(TRAINING_X_STEP)
        expect(readTrainingHidden('exp-1', broken)).toEqual(new Set())
        expect(() => writeTrainingXAxis('exp-1', 'epoch', broken)).not.toThrow()
        expect(() => writeTrainingHidden('exp-1', new Set(['loss']), broken)).not.toThrow()
        expect(readTrainingXAxis('exp-1', null)).toBe(TRAINING_X_STEP)
        expect(readTrainingHidden('exp-1', null)).toEqual(new Set())

        const store = memoryStore()
        store.map.set(trainingHiddenStorageKey('exp-1'), '{')
        expect(readTrainingHidden('exp-1', store)).toEqual(new Set())
        store.map.set(trainingHiddenStorageKey('exp-1'), '[1,"loss",""]')
        expect(readTrainingHidden('exp-1', store)).toEqual(new Set(['loss']))
        store.map.set(trainingXAxisStorageKey('exp-1'), '')
        expect(readTrainingXAxis('exp-1', store)).toBe(TRAINING_X_STEP)
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
