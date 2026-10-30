import { describe, expect, it } from 'bun:test'
import { registerTrainingCliHandlers, registerTrainingWebHandlers } from './trainingHandlers'
import { TrainingRelay } from './trainingRelay'
import type { SocketWithData } from './socketTypes'
import type { WorkTrainingRun } from '../store/workLines'

class FakeSocket {
    readonly id: string
    readonly data: Record<string, unknown> = {}
    readonly emitted: Array<{ event: string; data: unknown }> = []
    readonly rooms = new Set<string>()
    private readonly handlers = new Map<string, (data?: unknown) => void>()

    constructor(id: string) {
        this.id = id
    }

    on(event: string, handler: (data?: unknown) => void): void {
        this.handlers.set(event, handler)
    }

    emit(event: string, data: unknown): void {
        this.emitted.push({ event, data })
    }

    join(room: string): void {
        this.rooms.add(room)
    }

    leave(room: string): void {
        this.rooms.delete(room)
    }

    trigger(event: string, data?: unknown): void {
        this.handlers.get(event)?.(data)
    }
}

class FakeNamespace {
    readonly sockets = new Map<string, FakeSocket>()
    readonly adapter = { rooms: new Map<string, Set<string>>() }
    readonly roomEmits: Array<{ room: string; event: string; data: unknown }> = []

    add(socket: FakeSocket, room?: string): void {
        this.sockets.set(socket.id, socket)
        if (!room) return
        const members = this.adapter.rooms.get(room) ?? new Set<string>()
        members.add(socket.id)
        this.adapter.rooms.set(room, members)
        socket.rooms.add(room)
    }

    to(room: string) {
        return {
            emit: (event: string, data: unknown) => {
                this.roomEmits.push({ room, event, data })
            }
        }
    }
}

const run: WorkTrainingRun = {
    run: 'exp-1',
    machineId: 'gpu',
    runDir: '/data/wandb/run-abc',
    createdAt: 1
}

function harness() {
    const relay = new TrainingRelay()
    const cliNamespace = new FakeNamespace()
    const terminalNamespace = new FakeNamespace()
    const cli = new FakeSocket('cli-1')
    cli.data.namespace = 'account-a'
    cliNamespace.add(cli, 'machine:gpu')
    const io = { of: () => cliNamespace }
    const web = (id: string) => {
        const socket = new FakeSocket(id)
        socket.data.namespace = 'account-a'
        socket.data.gatewayAccountId = 7
        registerTrainingWebHandlers(socket as unknown as SocketWithData, {
            io: io as never,
            relay,
            getRun: (accountId, name) => accountId === 7 && name === 'exp-1' ? run : null,
            canAccessMachine: (accountId, machineId) => accountId === 7 && machineId === 'gpu' ? 'account-a' : null
        })
        return socket
    }
    registerTrainingCliHandlers(cli as never, { relay, terminalNamespace: terminalNamespace as never })
    return { relay, cli, cliNamespace, terminalNamespace, web }
}

describe('training relay', () => {
    it('asks the runner once for the first viewer and stops after the last one leaves', () => {
        const { cli, web } = harness()
        const first = web('web-1')
        const second = web('web-2')
        first.trigger('training:subscribe', { run: 'exp-1' })
        second.trigger('training:subscribe', { run: 'exp-1' })
        expect(cli.emitted.filter((event) => event.event === 'training:subscribe')).toHaveLength(1)
        first.trigger('training:unsubscribe', { run: 'exp-1' })
        expect(cli.emitted.some((event) => event.event === 'training:unsubscribe')).toBe(false)
        second.trigger('training:unsubscribe', { run: 'exp-1' })
        expect(cli.emitted.filter((event) => event.event === 'training:unsubscribe')).toEqual([
            { event: 'training:unsubscribe', data: { run: 'exp-1' } }
        ])
    })

    it('forwards points only to the subscribed account room', () => {
        const { cli, terminalNamespace, web } = harness()
        web('web-1').trigger('training:subscribe', { run: 'exp-1' })
        cli.trigger('training:points', {
            run: 'exp-1',
            machineId: 'gpu',
            batch: [{ step: 1, metric: 'loss', value: 0.2 }]
        })
        expect(terminalNamespace.roomEmits).toEqual([{
            room: 'training:7:exp-1',
            event: 'training:points',
            data: { run: 'exp-1', batch: [{ step: 1, metric: 'loss', value: 0.2 }] }
        }])
    })

    it('rejects another account and an offline runner', () => {
        const { cli, cliNamespace, web } = harness()
        const stranger = web('web-x')
        stranger.data.gatewayAccountId = 8
        stranger.trigger('training:subscribe', { run: 'exp-1' })
        expect(stranger.emitted).toEqual([{
            event: 'training:error',
            data: { run: 'exp-1', message: 'Training run is unavailable.' }
        }])
        expect(cli.emitted).toHaveLength(0)

        cliNamespace.adapter.rooms.delete('machine:gpu')
        const offline = web('web-off')
        offline.trigger('training:subscribe', { run: 'exp-1' })
        expect(offline.emitted.at(-1)).toEqual({
            event: 'training:error',
            data: { run: 'exp-1', message: 'Runner is not connected.' }
        })
    })

    it('sends training:subscribe again when the runner socket changes', () => {
        const { cli, cliNamespace, web } = harness()
        const viewer = web('web-1')
        viewer.trigger('training:subscribe', { run: 'exp-1' })
        const next = new FakeSocket('cli-2')
        next.data.namespace = 'account-a'
        cliNamespace.add(next, 'machine:gpu')
        cliNamespace.adapter.rooms.get('machine:gpu')!.delete(cli.id)
        viewer.trigger('training:subscribe', { run: 'exp-1' })
        expect(next.emitted).toEqual([{
            event: 'training:subscribe',
            data: { run: 'exp-1', runDir: '/data/wandb/run-abc', machineId: 'gpu' }
        }])
    })

    it('follows a granted machine into the owner namespace', () => {
        const relay = new TrainingRelay()
        const cliNamespace = new FakeNamespace()
        const cli = new FakeSocket('cli-owner')
        cli.data.namespace = 'owner-namespace'
        cliNamespace.add(cli, 'machine:gpu')
        const socket = new FakeSocket('web-grant')
        socket.data.namespace = 'viewer-namespace'
        socket.data.gatewayAccountId = 7
        registerTrainingWebHandlers(socket as unknown as SocketWithData, {
            io: { of: () => cliNamespace } as never,
            relay,
            getRun: () => run,
            canAccessMachine: () => 'owner-namespace'
        })
        socket.trigger('training:subscribe', { run: 'exp-1' })
        expect(cli.emitted).toEqual([{
            event: 'training:subscribe',
            data: { run: 'exp-1', runDir: '/data/wandb/run-abc', machineId: 'gpu' }
        }])
    })
})
