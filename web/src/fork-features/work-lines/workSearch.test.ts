import { describe, expect, it } from 'vitest'
import { defaultWorkSearch, missingWorkLine, parseWorkSearch } from './workSearch'

describe('parseWorkSearch', () => {
    it('keeps a line and drops unknown keys', () => {
        expect(parseWorkSearch({ line: 'abc', tab: 'map', inbox: '1' })).toEqual({ line: 'abc' })
    })

    it('uses inbox only when no line is selected', () => {
        expect(parseWorkSearch({ inbox: '1' })).toEqual({ inbox: true })
        expect(parseWorkSearch({ inbox: '0', timeline: '1' })).toEqual({})
    })

    it('defaults a bare visit to the first line, or the inbox when there is none', () => {
        expect(defaultWorkSearch({}, ['line-1', 'line-2'])).toEqual({ line: 'line-1' })
        expect(defaultWorkSearch({}, [])).toEqual({ inbox: true })
        expect(defaultWorkSearch({ line: 'kept' }, ['line-1'])).toBeNull()
        expect(defaultWorkSearch({ inbox: true }, ['line-1'])).toBeNull()
    })

    it('flags a line id that is not in the map', () => {
        expect(missingWorkLine({ line: 'no-such-line' }, ['line-1'])).toBe(true)
        expect(missingWorkLine({ line: 'line-1' }, ['line-1'])).toBe(false)
        expect(missingWorkLine({ inbox: true }, [])).toBe(false)
    })
})
