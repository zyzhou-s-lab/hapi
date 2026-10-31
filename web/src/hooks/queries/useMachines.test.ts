import { describe, expect, it } from 'vitest'
import type { Machine } from '@/types/api'
import { presentMachines } from './useMachines'

describe('presentMachines', () => {
    it('drops null and machines without an id', () => {
        const machine = { id: 'gpu' } as Machine
        expect(presentMachines([null, undefined, { id: '' } as Machine, machine])).toEqual([machine])
        expect(presentMachines(null)).toEqual([])
    })
})
