import { describe, expect, it } from 'bun:test'
import { absoluteDirectoryAncestors, freshApprovalDecision, requiresFreshApproval } from './exploreApproval'

describe('requiresFreshApproval', () => {
    it('matches delete_exploration after prefix, case and separator normalization', () => {
        for (const name of [
            'delete_exploration',
            'Delete Exploration',
            'mcp__hapi__delete_exploration',
            'mcp_hapi__delete-exploration',
            'happy__delete_exploration',
            'hapi_delete_exploration',
        ]) {
            expect(requiresFreshApproval(name)).toBe(true)
        }
        expect(requiresFreshApproval('delete_explorations')).toBe(false)
        expect(requiresFreshApproval('Bash')).toBe(false)
    })

    it('turns a session grant into one approval and leaves other tools alone', () => {
        expect(freshApprovalDecision('mcp__hapi__delete_exploration', 'approved_for_session')).toBe('approved')
        expect(freshApprovalDecision('Bash', 'approved_for_session')).toBe('approved_for_session')
        expect(freshApprovalDecision('delete_exploration', 'denied')).toBe('denied')
    })
})

describe('absoluteDirectoryAncestors', () => {
    it('walks absolute parents and keeps a relative path exact', () => {
        expect(absoluteDirectoryAncestors('/data/proj/pkg/src')).toEqual([
            '/data/proj/pkg/src',
            '/data/proj/pkg',
            '/data/proj',
            '/data',
        ])
        expect(absoluteDirectoryAncestors('/')).toEqual(['/'])
        expect(absoluteDirectoryAncestors('pkg/src')).toEqual(['pkg/src'])
        expect(absoluteDirectoryAncestors('  /data/proj/  ')).toEqual(['/data/proj', '/data'])
    })
})
