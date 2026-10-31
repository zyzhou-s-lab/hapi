import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Manager } from 'socket.io-client'

export function useTrainingCardSocket(baseUrl: string, token: string | null): void {
    const queryClient = useQueryClient()
    useEffect(() => {
        if (!token) return
        const manager = new Manager(baseUrl, {
            path: '/socket.io/',
            reconnection: true,
            transports: ['polling', 'websocket'],
            autoConnect: false,
        })
        const socket = manager.socket('/terminal', { auth: { token } })
        const refresh = () => {
            void queryClient.invalidateQueries({ queryKey: ['work', 'layout', 'workbench'] })
        }
        socket.on('training:card', refresh)
        socket.connect()
        return () => {
            socket.off('training:card', refresh)
            socket.disconnect()
        }
    }, [baseUrl, queryClient, token])
}
