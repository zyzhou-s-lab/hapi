export type TrainingWatch = {
    accountId: number
    run: string
    machineId: string
    runDir: string
    cliSocketId: string
}

export function trainingRoom(accountId: number, run: string): string {
    return `training:${accountId}:${run}`
}

/**
 * Who is watching a run. Points are not stored here; the runner re-reads on
 * the next subscribe.
 */
export class TrainingRelay {
    private readonly watches = new Map<string, TrainingWatch>()
    private readonly viewers = new Map<string, Set<string>>()

    private key(accountId: number, run: string): string {
        return `${accountId}:${run}`
    }

    get(accountId: number, run: string): TrainingWatch | null {
        return this.watches.get(this.key(accountId, run)) ?? null
    }

    viewerCount(accountId: number, run: string): number {
        return this.viewers.get(this.key(accountId, run))?.size ?? 0
    }

    /**
     * @returns subscribe when the current runner should start,
     * and the previous runner socket when this call replaced it.
     */
    addViewer(watch: TrainingWatch, socketId: string): { subscribe: boolean; replacedCliSocketId: string | null } {
        const id = this.key(watch.accountId, watch.run)
        const existing = this.watches.get(id)
        let replacedCliSocketId: string | null = null
        if (existing && existing.cliSocketId !== watch.cliSocketId) {
            replacedCliSocketId = existing.cliSocketId
            existing.cliSocketId = watch.cliSocketId
            existing.machineId = watch.machineId
            existing.runDir = watch.runDir
        } else if (!existing) {
            this.watches.set(id, { ...watch })
        }
        const set = this.viewers.get(id) ?? new Set<string>()
        const first = set.size === 0
        set.add(socketId)
        this.viewers.set(id, set)
        return { subscribe: first || replacedCliSocketId !== null, replacedCliSocketId }
    }

    /** @returns the watch when the last viewer left. */
    removeViewer(accountId: number, run: string, socketId: string): TrainingWatch | null {
        const id = this.key(accountId, run)
        const set = this.viewers.get(id)
        if (!set) return null
        set.delete(socketId)
        if (set.size > 0) return null
        this.viewers.delete(id)
        const watch = this.watches.get(id) ?? null
        this.watches.delete(id)
        return watch
    }

    roomsFor(socketId: string): Array<{ accountId: number; run: string }> {
        const rooms: Array<{ accountId: number; run: string }> = []
        for (const [id, set] of this.viewers) {
            if (!set.has(socketId)) continue
            const watch = this.watches.get(id)
            if (watch) rooms.push({ accountId: watch.accountId, run: watch.run })
        }
        return rooms
    }

    /** Watches whose runner socket just died. */
    dropCli(cliSocketId: string): TrainingWatch[] {
        const dropped: TrainingWatch[] = []
        for (const [id, watch] of this.watches) {
            if (watch.cliSocketId !== cliSocketId) continue
            dropped.push(watch)
            this.watches.delete(id)
            this.viewers.delete(id)
        }
        return dropped
    }

    findByCli(cliSocketId: string, machineId: string, run: string): TrainingWatch | null {
        for (const watch of this.watches.values()) {
            if (watch.cliSocketId === cliSocketId && watch.machineId === machineId && watch.run === run) {
                return watch
            }
        }
        return null
    }
}
