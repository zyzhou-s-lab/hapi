import { describe, expect, it } from 'vitest'
import { parseWorkSearch } from './workSearch'

describe('parseWorkSearch', () => {
    it('keeps a line and drops unknown keys', () => {
        expect(parseWorkSearch({ line: 'abc', tab: 'map', inbox: '1' })).toEqual({ line: 'abc' })
    })

    it('uses inbox only when no line is selected', () => {
        expect(parseWorkSearch({ inbox: '1' })).toEqual({ inbox: true })
        expect(parseWorkSearch({ inbox: '0', timeline: '1' })).toEqual({})
    })
})
