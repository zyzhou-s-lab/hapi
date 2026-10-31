export type WorkHub = {
    request(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: unknown }>
}

export async function registerTrainingRun(hub: WorkHub, input: { run: string; machineId: string; runDir: string }): Promise<{ status: number; body: unknown }> {
    return hub.request('/cli/work/training-runs', { method: 'POST', body: input })
}

export async function queryTrainingRun(hub: WorkHub, run: string): Promise<{ status: number; body: unknown }> {
    return hub.request(`/cli/work/training-runs/${encodeURIComponent(run)}`)
}

export async function bindTrainingCard(hub: WorkHub, input: { lineId: string; run: string; metrics?: string[]; instanceId?: string; xAxis?: string }): Promise<{ status: number; body: unknown }> {
    return hub.request('/cli/work/training-card', { method: 'PUT', body: input })
}

export async function unbindTrainingCard(hub: WorkHub, instanceId: string): Promise<{ status: number; body: unknown }> {
    return hub.request(`/cli/work/training-card/${encodeURIComponent(instanceId)}`, { method: 'DELETE' })
}

export function formatWorkResult(status: number, body: unknown): { text: string; isError: boolean } {
    if (status >= 200 && status < 300) return { text: JSON.stringify(body), isError: false }
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${status}`
    return { text: message, isError: true }
}
