import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MachinePathPolicy } from '../../api/machinePathPolicy'
import { resolveTrainingRunDir, startTrainingTail } from './wandbTail'

const roots: string[] = []

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('resolveTrainingRunDir', () => {
    it('rejects a symlink whose real path is not a wandb run', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-wandb-link-'))
        roots.push(root)
        const secret = join(root, 'secret')
        mkdirSync(secret)
        mkdirSync(join(root, 'wandb'))
        symlinkSync(secret, join(root, 'wandb', 'offline-run-1'))
        expect(await resolveTrainingRunDir(join(root, 'wandb', 'offline-run-1'))).toBeNull()
    })

    it('rejects a run outside the machine workspace roots and does not spawn', async () => {
        const root = mkdtempSync(join(tmpdir(), 'hapi-wandb-root-'))
        roots.push(root)
        const inside = join(root, 'proj', 'wandb', 'offline-run-1')
        const outside = join(root, 'other', 'wandb', 'run-x')
        mkdirSync(inside, { recursive: true })
        mkdirSync(outside, { recursive: true })
        const policy = new MachinePathPolicy({ workspaceRoots: [join(root, 'proj')], homeDirectory: root })
        expect(await resolveTrainingRunDir(inside, policy)).toBe(await realpath(inside))
        expect(await resolveTrainingRunDir(outside, policy)).toBeNull()
        let spawned = false
        const frames: { run?: string; message?: string }[] = []
        startTrainingTail({
            run: 'exp-1',
            runDir: outside,
            machineId: 'gpu',
            policy,
            emit: (_event, payload) => frames.push(payload),
            spawnPython: () => {
                spawned = true
                throw new Error('should not spawn')
            },
        })
        await vi.waitFor(() => expect(frames).toEqual([{ run: 'exp-1', machineId: 'gpu', message: 'cannot read this run' }]))
        expect(spawned).toBe(false)
        expect(frames[0]?.message).not.toContain(root)
    })
})
