export type TrainingCardUpdate = {
    lineId: string
    run: string
    metrics: string[]
    instanceId: string
}

type Push = (accountId: number, update: TrainingCardUpdate) => void

let push: Push | null = null

export function setTrainingCardPush(next: Push | null): void {
    push = next
}

export function pushTrainingCard(accountId: number, update: TrainingCardUpdate): void {
    push?.(accountId, update)
}
