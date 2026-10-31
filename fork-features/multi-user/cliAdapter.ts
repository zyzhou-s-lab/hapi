import type { MultiUserGatewayStore } from './gatewayStore'
import { hashApiToken } from './token'

function activeGatewayCliToken(store: MultiUserGatewayStore, plaintextToken: string): { accountId: number; namespace: string } | null {
    const token = store.getActiveTokenByHash(hashApiToken(plaintextToken))
    if (!token) return null
    const account = store.getAccount(token.accountId)
    if (!account || account.disabledAt !== null) return null
    store.touchTokenLastUsed(token.id)
    return { accountId: account.id, namespace: token.namespace }
}

export function resolveGatewayCliNamespace(store: MultiUserGatewayStore, plaintextToken: string): string | null {
    return activeGatewayCliToken(store, plaintextToken)?.namespace ?? null
}

export function resolveGatewayCliAccountId(store: MultiUserGatewayStore, plaintextToken: string): number | null {
    return activeGatewayCliToken(store, plaintextToken)?.accountId ?? null
}
