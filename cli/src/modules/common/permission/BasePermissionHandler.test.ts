import { describe, expect, it } from 'vitest'
import { resolveToolAutoApprovalDecision } from './BasePermissionHandler'

describe('resolveToolAutoApprovalDecision skill_lookup', () => {
    it.each([
        'skill_lookup',
        'hapi_skill_lookup',
        'happy__skill_lookup',
        'mcp_hapi_skill_lookup',
        'mcp__hapi__skill_lookup'
    ])('auto-approves the exact read-only HAPI tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            toolName,
            'call-1'
        )).toBe('approved')
    })

    it.each([
        'mcp_hapi_query_training_run',
        'mcp__hapi__query_training_run',
        'mcp_hapi_list_training_runs',
        'mcp__hapi__list_training_runs',
        'mcp_hapi_get_hypothesis',
        'mcp__hapi__get_exploration',
        'mcp_hapi_list_explorations',
        'mcp__hapi__list_linked_sessions',
        'mcp_hapi_list_verification_cards',
        'mcp__hapi__list_references'
    ])('auto-approves read-only training/explore HAPI tool %s in request-review/default', (toolName) => {
        expect(resolveToolAutoApprovalDecision('request-review', toolName, 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBe('approved')
    })

    it.each([
        'mcp__hapi__send_file',
        'mcp_hapi_send_file',
        'mcp__hapi__display_media',
        'mcp__hapi__ping_peer',
        'mcp__hapi__inspect_peer',
        'mcp__hapi__set_hypothesis',
        'mcp__hapi__create_exploration'
    ])('does not auto-approve gated or mutating HAPI MCP tool %s in request-review/default', (toolName) => {
        expect(resolveToolAutoApprovalDecision('request-review', toolName, 'call-1')).toBeNull()
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it('does not approve another tool solely from a skill-looking call id', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_tool',
            'skill_lookup-forged-id'
        )).toBeNull()
    })

    it('does not approve another tool whose name only contains skill_lookup', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'skill_lookup_write_file',
            'call-1'
        )).toBeNull()
        expect(resolveToolAutoApprovalDecision(
            'default',
            'dangerous_skill_lookup',
            'call-2'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision ping_peer', () => {
    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'ping_peer',
        'mcp__hapi__ping_peer',
        'hapi_ping_peer',
        'Ping Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })

    it('still auto-approves unrelated read tools in read-only mode', () => {
        expect(resolveToolAutoApprovalDecision('read-only', 'Read', 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('read-only', 'grep', 'call-2')).toBe('approved')
    })
})

describe('resolveToolAutoApprovalDecision inspect_peer', () => {
    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in default mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBeNull()
    })

    it.each([
        'inspect_peer',
        'mcp__hapi__inspect_peer',
        'hapi_inspect_peer',
        'Inspect Peer Session'
    ])('does not auto-approve %s in read-only mode', (toolName) => {
        expect(resolveToolAutoApprovalDecision('read-only', toolName, 'call-1')).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision list_peers', () => {
    it.each([
        'list_peers',
        'hapi_list_peers',
        'happy__list_peers',
        'mcp__hapi__list_peers',
        'List Peer Sessions'
    ])('auto-approves the exact discovery tool name %s', (toolName) => {
        expect(resolveToolAutoApprovalDecision('default', toolName, 'call-1')).toBe('approved')
    })

    it('does not approve another tool whose name only contains list_peers', () => {
        expect(resolveToolAutoApprovalDecision(
            'default',
            'list_peers_and_write',
            'call-1'
        )).toBeNull()
    })
})

describe('resolveToolAutoApprovalDecision delete_exploration', () => {
    it('refuses every automatic mode, including a session grant', () => {
        for (const mode of ['yolo', 'safe-yolo', 'always-proceed', 'bypassPermissions'] as const) {
            for (const name of [
                'delete_exploration',
                'mcp__hapi__delete_exploration',
                'Delete Exploration',
                'mcp_hapi_delete-exploration',
            ]) {
                expect(resolveToolAutoApprovalDecision(mode, name, 'call-1')).toBeNull()
            }
        }
        expect(resolveToolAutoApprovalDecision('yolo', 'custom_tool', 'call-1')).toBe('approved_for_session')
        expect(resolveToolAutoApprovalDecision('safe-yolo', 'custom_tool', 'call-1')).toBe('approved')
        expect(resolveToolAutoApprovalDecision('always-proceed', 'custom_tool', 'call-1')).toBe('approved_for_session')
    })

    it.each([
        'change_title',
        'Change Chat Title',
        'mcp_hapi_change_title',
        'mcp__hapi__change_title',
        'hapi_change_title',
        'happy__change_title',
    ])('auto-approves exact change_title name %s in request-review even with empty name hints', (toolName) => {
        expect(resolveToolAutoApprovalDecision(
            'request-review',
            toolName,
            'call-1',
            { alwaysToolNameHints: [], alwaysToolIdHints: [] }
        )).toBe('approved')
    })
})
