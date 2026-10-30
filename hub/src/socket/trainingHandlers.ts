import { z } from 'zod'
import type { DefaultEventsMap, Namespace } from 'socket.io'
import {
    TrainingErrorPayloadSchema,
    TrainingHistoryPayloadSchema
} from '@hapi/protocol'
import type { WorkTrainingRun } from '../store/workLines'

import type { CliSocketWithData, SocketData, SocketServer, SocketWithData } from './socketTypes'
import { TrainingRelay, trainingRoom } from './trainingRelay'

export type HubNamespace = Namespace<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>

const webSubscribeSchema = z.object({ run: z.string().min(1) })

export type TrainingWebDeps = {
    io: SocketServer
    relay: TrainingRelay
    getRun: (accountId: number, run: string) => WorkTrainingRun | null
    /** Core namespace of a machine this account may open, or null. */
    canAccessMachine: (accountId: number, machineId: string) => string | null
}

export function registerTrainingWebHandlers(socket: SocketWithData, deps: TrainingWebDeps): void {
    const cliNamespace = deps.io.of('/cli')

    const fail = (run: string, message: string) => {
        socket.emit('training:error', { run, message })
    }

    const pickCli = (machineId: string, namespace: string) => {
        const room = cliNamespace.adapter.rooms.get(`machine:${machineId}`)
        if (!room) return null
        for (const socketId of room) {
            const cliSocket = cliNamespace.sockets.get(socketId)
            if (cliSocket && cliSocket.data.namespace === namespace) return cliSocket
        }
        return null
    }

    const stopIfEmpty = (accountId: number, run: string) => {
        const watch = deps.relay.removeViewer(accountId, run, socket.id)
        if (!watch) return
        socket.leave(trainingRoom(accountId, run))
        cliNamespace.sockets.get(watch.cliSocketId)?.emit('training:unsubscribe', { run })
    }

    socket.on('training:subscribe', (data: unknown) => {
        const parsed = webSubscribeSchema.safeParse(data)
        if (!parsed.success) return
        const accountId = socket.data.gatewayAccountId
        const { run } = parsed.data
        if (typeof accountId !== 'number') {
            fail(run, 'Training run is unavailable.')
            return
        }
        const row = deps.getRun(accountId, run)
        const machineNamespace = row ? deps.canAccessMachine(accountId, row.machineId) : null
        if (!row || !machineNamespace) {
            fail(run, 'Training run is unavailable.')
            return
        }
        const cliSocket = pickCli(row.machineId, machineNamespace)
        if (!cliSocket) {
            fail(run, 'Runner is not connected.')
            return
        }
        const added = deps.relay.addViewer({
            accountId,
            run,
            machineId: row.machineId,
            runDir: row.runDir,
            cliSocketId: cliSocket.id
        }, socket.id)
        socket.join(trainingRoom(accountId, run))
        if (added.replacedCliSocketId) {
            cliNamespace.sockets.get(added.replacedCliSocketId)?.emit('training:unsubscribe', { run })
        }
        if (added.subscribe) {
            cliSocket.emit('training:subscribe', { run, runDir: row.runDir, machineId: row.machineId })
        }
    })

    socket.on('training:unsubscribe', (data: unknown) => {
        const parsed = webSubscribeSchema.safeParse(data)
        if (!parsed.success) return
        const accountId = socket.data.gatewayAccountId
        if (typeof accountId !== 'number') return
        stopIfEmpty(accountId, parsed.data.run)
    })

    socket.on('disconnect', () => {
        for (const room of deps.relay.roomsFor(socket.id)) {
            stopIfEmpty(room.accountId, room.run)
        }
    })
}

function forwardTrainingFrame(
    socket: CliSocketWithData,
    terminalNamespace: HubNamespace,
    relay: TrainingRelay,
    event: 'training:history' | 'training:points',
    data: unknown
): void {
    const parsed = TrainingHistoryPayloadSchema.safeParse(data)
    if (!parsed.success) return
    if (!socket.rooms.has(`machine:${parsed.data.machineId}`)) return
    const watch = relay.findByCli(socket.id, parsed.data.machineId, parsed.data.run)
    if (!watch) return
    const { machineId, ...webPayload } = parsed.data
    if (machineId !== watch.machineId) return
    terminalNamespace.to(trainingRoom(watch.accountId, watch.run)).emit(event, webPayload)
}

export function registerTrainingCliHandlers(socket: CliSocketWithData, deps: {
    relay: TrainingRelay
    terminalNamespace: HubNamespace
}): void {
    socket.on('training:history', (data: unknown) => {
        forwardTrainingFrame(socket, deps.terminalNamespace, deps.relay, 'training:history', data)
    })
    socket.on('training:points', (data: unknown) => {
        forwardTrainingFrame(socket, deps.terminalNamespace, deps.relay, 'training:points', data)
    })
    socket.on('training:error', (data: unknown) => {
        const parsed = TrainingErrorPayloadSchema.safeParse(data)
        if (!parsed.success) return
        if (!socket.rooms.has(`machine:${parsed.data.machineId}`)) return
        const watch = deps.relay.findByCli(socket.id, parsed.data.machineId, parsed.data.run)
        if (!watch) return
        deps.terminalNamespace.to(trainingRoom(watch.accountId, watch.run)).emit('training:error', {
            run: parsed.data.run,
            message: parsed.data.message
        })
    })
}

export function cleanupTrainingCli(socket: CliSocketWithData, deps: {
    relay: TrainingRelay
    terminalNamespace: HubNamespace
}): void {
    for (const watch of deps.relay.dropCli(socket.id)) {
        deps.terminalNamespace.to(trainingRoom(watch.accountId, watch.run)).emit('training:error', {
            run: watch.run,
            message: 'Runner is not connected.'
        })
    }
}
