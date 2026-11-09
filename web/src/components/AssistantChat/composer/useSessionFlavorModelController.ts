import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ApiClient } from '@/api/client'
import type { CodexCollaborationMode, CopilotAgentMode, PermissionMode, PiModelSummary, Session } from '@/types/api'
import { usePlatform } from '@/hooks/usePlatform'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { useCcSwitchProvider } from '@/hooks/mutations/useCcSwitchProvider'
import { useCodexModels } from '@/hooks/queries/useCodexModels'
import { useCcSwitchProviders } from '@/hooks/queries/useCcSwitchProviders'
import { useCursorModels } from '@/hooks/queries/useCursorModels'
import { useCursorModelsForMachine } from '@/hooks/queries/useCursorModelsForMachine'
import { mergeCursorCliModelSkus, resolveCursorBaseFromWire } from '@/lib/cursorPickerState'
import {
    buildSessionCursorPickerState,
    isSessionCursorCatalogAwaitingSkus,
    isSessionCursorCatalogPendingWithTimeout,
    SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS,
    resolveSessionCursorBaseSelectValue,
    resolveSessionCursorModelChange,
    resolveSessionCursorVariantSelectValue,
} from '@/lib/sessionChatCursorModel'
import { buildCursorEffortPickerOptionsWithDefaultFirst } from '@/lib/cursorModelOptions'
import { useOpencodeModels } from '@/hooks/queries/useOpencodeModels'
import { useGrokModels } from '@/hooks/queries/useGrokModels'
import { useCopilotModels } from '@/hooks/queries/useCopilotModels'
import { useGrokReasoningEffortOptions } from '@/hooks/queries/useGrokReasoningEffortOptions'
import { usePiModels } from '@/hooks/queries/usePiModels'
import { useOpencodeReasoningEffortOptions } from '@/hooks/queries/useOpencodeReasoningEffortOptions'
import { useOmpModels } from '@/hooks/queries/useOmpModels'
import { useOmpThinkingOptions } from '@/hooks/queries/useOmpThinkingOptions'
import { useSessionComposerConfig } from '@/hooks/queries/useSession'
import { getCodexModelReasoningEfforts, supportsCodexReasoningEffort } from '@/lib/codexModelCapabilities'
import { createSerialAsyncQueue } from '@/lib/serialAsyncQueue'
import { codexModelAdvertisesFastTier, getEffectiveCodexServiceTier } from '../codexFastMode'
import { applyModelChangeWithReasoningRollback, resolvePiContextWindow } from '@/components/sessionChatHelpers'
import type { SessionFlavorModelController, SessionModelSelection } from './types'

export function useSessionFlavorModelController(rawProps: {
    api: ApiClient
    session: Session
    onRefresh: () => void
}): SessionFlavorModelController {
    const composerConfig = useSessionComposerConfig(rawProps.api, rawProps.session.id, rawProps.session)
    const session = useMemo<Session>(() => {
        if (!composerConfig) {
            return rawProps.session
        }
        const baseMetadata = rawProps.session.metadata
        const mergedMetadata = (baseMetadata || composerConfig.path || composerConfig.flavor || composerConfig.machineId)
            ? {
                path: composerConfig.path ?? baseMetadata?.path ?? '',
                host: baseMetadata?.host ?? '',
                ...baseMetadata,
                flavor: composerConfig.flavor !== undefined ? composerConfig.flavor : baseMetadata?.flavor,
                machineId: composerConfig.machineId !== undefined ? composerConfig.machineId : baseMetadata?.machineId,
                worktree: composerConfig.worktree !== undefined ? composerConfig.worktree : baseMetadata?.worktree,
                ompThinking: composerConfig.ompThinking !== undefined ? composerConfig.ompThinking : baseMetadata?.ompThinking,
                piAvailableModels: composerConfig.piAvailableModels !== undefined ? composerConfig.piAvailableModels : baseMetadata?.piAvailableModels,
                piSelectedModel: composerConfig.piSelectedModel !== undefined ? composerConfig.piSelectedModel : baseMetadata?.piSelectedModel,
                ccSwitchProviderId: composerConfig.ccSwitchProviderId !== undefined ? composerConfig.ccSwitchProviderId : baseMetadata?.ccSwitchProviderId,
                ...(composerConfig.piThinkingLevel !== undefined ? { piThinkingLevel: composerConfig.piThinkingLevel } : {}),
                ...(composerConfig.claudePromptCacheTtl !== undefined ? { claudePromptCacheTtl: composerConfig.claudePromptCacheTtl } : {}),
                ...(composerConfig.ccSwitchProviderName !== undefined ? { ccSwitchProviderName: composerConfig.ccSwitchProviderName } : {}),
            } as Session['metadata']
            : null
        return {
            ...rawProps.session,
            active: composerConfig.active,
            permissionMode: composerConfig.permissionMode,
            collaborationMode: composerConfig.collaborationMode,
            copilotAgentMode: composerConfig.copilotAgentMode,
            model: composerConfig.model ?? rawProps.session.model ?? null,
            modelReasoningEffort: composerConfig.modelReasoningEffort ?? null,
            effort: composerConfig.effort ?? null,
            serviceTier: composerConfig.serviceTier ?? null,
            resumeWithSessionModel: composerConfig.resumeWithSessionModel ?? rawProps.session.resumeWithSessionModel ?? false,
            metadata: mergedMetadata,
        }
    }, [composerConfig, rawProps.session])
    const props = { ...rawProps, session }
    const { haptic } = usePlatform()
    const navigate = useNavigate()
    const [cursorSelectedBase, setCursorSelectedBase] = useState('auto')
    // Serialize Cursor setModel RPCs so drill-down default apply cannot finish
    // after a later explicit variant click and overwrite it.
    const enqueueCursorModelApply = useMemo(() => createSerialAsyncQueue(), [])
    const lastSyncedCursorModelRef = useRef<string | null | undefined>(undefined)
    const agentFlavor = props.session.metadata?.flavor ?? null
    const controlledByUser = props.session.agentState?.controlledByUser === true
    const codexCollaborationModeSupported = agentFlavor === 'codex' && !controlledByUser
    const codexModelsState = useCodexModels({
        api: props.api,
        sessionId: props.session.id,
        machineId: props.session.metadata?.machineId ?? null,
        enabled: agentFlavor === 'codex'
            && props.session.active
            && !controlledByUser
            && Boolean(props.session.metadata?.machineId)
    })
    const effectiveCodexServiceTier = agentFlavor === 'codex'
        ? getEffectiveCodexServiceTier(
            props.session.serviceTier,
            props.session.model,
            codexModelsState.models
        )
        : undefined
    const codexModelOptions = useMemo(() => {
        if (agentFlavor !== 'codex') {
            return undefined
        }

        const options: Array<{ value: string | null; label: string }> = []
        for (const codexModel of codexModelsState.models) {
            options.push({
                value: codexModel.id,
                label: codexModel.displayName
            })
        }
        return options
    }, [agentFlavor, codexModelsState.models])
    const codexSupportedReasoningEfforts = useMemo(
        () => agentFlavor === 'codex'
            ? getCodexModelReasoningEfforts(codexModelsState.models, props.session.model)
            : undefined,
        [agentFlavor, codexModelsState.models, props.session.model]
    )
    const codexReasoningEffortOptions = useMemo(
        () => codexSupportedReasoningEfforts?.map((value) => ({ value })),
        [codexSupportedReasoningEfforts]
    )
    const opencodeModelsState = useOpencodeModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'opencode' && props.session.active
    })
    const opencodeReasoningEffortState = useOpencodeReasoningEffortOptions({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'opencode' && props.session.active
    })
    const opencodeModelOptions = useMemo(() => {
        if (agentFlavor !== 'opencode') {
            return undefined
        }

        return opencodeModelsState.availableModels.map((opencodeModel) => ({
            value: opencodeModel.modelId,
            label: opencodeModel.name ?? opencodeModel.modelId
        }))
    }, [agentFlavor, opencodeModelsState.availableModels])
    const ompModelsState = useOmpModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'omp' && props.session.active && !controlledByUser
    })
    const ompThinkingState = useOmpThinkingOptions({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'omp' && props.session.active && !controlledByUser
    })
    const ompModelOptions = useMemo(() => agentFlavor === 'omp'
        ? ompModelsState.availableModels.map((ompModel) => ({
            value: `${ompModel.provider}/${ompModel.modelId}`,
            label: `${ompModel.name} (${ompModel.provider})`
        }))
        : undefined, [agentFlavor, ompModelsState.availableModels])
    const grokModelsState = useGrokModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'grok' && props.session.active && !controlledByUser
    })
    const grokEffortState = useGrokReasoningEffortOptions({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'grok' && props.session.active && !controlledByUser
    })
    const grokModelOptions = useMemo(() => (
        agentFlavor === 'grok'
            ? [
                { value: null, label: 'Default' },
                ...grokModelsState.availableModels.map((model) => ({
                    value: model.modelId,
                    label: model.name ?? model.modelId
                }))
            ]
            : undefined
    ), [agentFlavor, grokModelsState.availableModels])
    const copilotModelsState = useCopilotModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'copilot' && props.session.active && !controlledByUser
    })
    const copilotModelOptions = useMemo(() => (
        agentFlavor === 'copilot'
            ? [
                { value: null, label: 'Auto' },
                ...copilotModelsState.availableModels
                    .filter((model) => model.modelId !== 'auto')
                    .map((model) => ({
                        value: model.modelId,
                        label: model.name ?? model.modelId
                    }))
            ]
            : undefined
    ), [agentFlavor, copilotModelsState.availableModels])
    const cursorModelsState = useCursorModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'cursor' && props.session.active
    })
    const sessionMachineId = props.session.metadata?.machineId ?? null
    const ccSwitchProvidersState = useCcSwitchProviders({
        api: props.api,
        machineId: sessionMachineId,
        enabled: agentFlavor === 'claude' && Boolean(sessionMachineId)
    })
    const { switchProvider: switchCcSwitchProvider } = useCcSwitchProvider({
        api: props.api,
        machineId: sessionMachineId,
        sessionId: props.session.id
    })
    const machineCursorModelsState = useCursorModelsForMachine({
        api: props.api,
        machineId: sessionMachineId,
        enabled: agentFlavor === 'cursor' && props.session.active && Boolean(sessionMachineId)
    })
    const sessionCliModelSkus = useMemo(() => (
        mergeCursorCliModelSkus(
            machineCursorModelsState.cliModelSkus,
            cursorModelsState.cliModelSkus
        )
    ), [cursorModelsState.cliModelSkus, machineCursorModelsState.cliModelSkus])
    const cursorPicker = useMemo(() => {
        if (agentFlavor !== 'cursor') {
            return null
        }

        return buildSessionCursorPickerState({
            sessionModels: cursorModelsState.availableModels,
            machineModels: machineCursorModelsState.availableModels,
            cliModelSkus: sessionCliModelSkus,
            sessionModel: props.session.model,
            sessionCurrentModelId: cursorModelsState.currentModelId
        })
    }, [
        agentFlavor,
        cursorModelsState.availableModels,
        cursorModelsState.currentModelId,
        machineCursorModelsState.availableModels,
        sessionCliModelSkus,
        props.session.model
    ])
    const piModelsState = usePiModels({
        api: props.api,
        sessionId: props.session.id,
        enabled: agentFlavor === 'pi' && props.session.active
    })
    // Fallback to cached models from metadata when session is inactive
    const piMetadata = props.session.metadata as Record<string, unknown> | null
    const piCachedModels = piMetadata?.piAvailableModels as PiModelSummary[] | undefined ?? []
    // Provider-qualified selected model — disambiguates when two providers
    // share a modelId (hub persists this alongside the legacy modelId string).
    const piSelectedModel = piMetadata?.piSelectedModel as { provider: string; modelId: string } | null | undefined
    const piModels = agentFlavor === 'pi' ? (piModelsState.availableModels.length > 0 ? piModelsState.availableModels : piCachedModels) : undefined
    const piContextWindow = useMemo(() => {
        if (agentFlavor !== 'pi' || !props.session.model) return undefined
        return resolvePiContextWindow(piModels, piSelectedModel, props.session.model)
    }, [agentFlavor, piModels, piSelectedModel, props.session.model])
    const cursorCatalogReadinessArgs = useMemo(() => ({
        sessionLoading: cursorModelsState.isLoading,
        machineLoading: machineCursorModelsState.isLoading,
        hasMachineId: Boolean(sessionMachineId),
        sessionError: cursorModelsState.error,
        machineError: machineCursorModelsState.error,
        mergedSkus: sessionCliModelSkus,
        picker: cursorPicker
    }), [
        cursorModelsState.isLoading,
        cursorModelsState.error,
        machineCursorModelsState.isLoading,
        machineCursorModelsState.error,
        sessionMachineId,
        sessionCliModelSkus,
        cursorPicker
    ])
    const cursorCatalogAwaitingSkus = useMemo(
        () => isSessionCursorCatalogAwaitingSkus(cursorCatalogReadinessArgs),
        [cursorCatalogReadinessArgs]
    )
    const [cursorSkuAwaitingSince, setCursorSkuAwaitingSince] = useState<number | null>(null)
    const [cursorCatalogNowMs, setCursorCatalogNowMs] = useState(() => Date.now())
    useEffect(() => {
        if (cursorCatalogAwaitingSkus) {
            setCursorSkuAwaitingSince((previous) => previous ?? Date.now())
            const timer = setTimeout(
                () => setCursorCatalogNowMs(Date.now()),
                SESSION_CURSOR_CATALOG_SKU_TIMEOUT_MS
            )
            return () => clearTimeout(timer)
        }
        setCursorSkuAwaitingSince(null)
        setCursorCatalogNowMs(Date.now())
        return undefined
    }, [cursorCatalogAwaitingSkus])
    const cursorCatalogPending = isSessionCursorCatalogPendingWithTimeout({
        ...cursorCatalogReadinessArgs,
        awaitingStartedAtMs: cursorSkuAwaitingSince,
        nowMs: cursorCatalogNowMs
    })

    useEffect(() => {
        if (agentFlavor !== 'cursor' || !cursorPicker) {
            lastSyncedCursorModelRef.current = undefined
            return
        }
        const sessionModel = props.session.model ?? null
        const baseFromSession = sessionModel
            ? resolveCursorBaseFromWire(sessionModel, cursorPicker.catalog)
            : 'auto'
        if (lastSyncedCursorModelRef.current === sessionModel) {
            if (!sessionModel) {
                return
            }
            setCursorSelectedBase((prev) => (prev === 'auto' ? baseFromSession : prev))
            return
        }
        lastSyncedCursorModelRef.current = sessionModel
        setCursorSelectedBase(baseFromSession)
    }, [agentFlavor, props.session.model, cursorPicker])

    const cursorSelectedBaseValue = useMemo(() => (
        agentFlavor === 'cursor' && cursorPicker
            ? resolveSessionCursorBaseSelectValue(cursorPicker, cursorSelectedBase)
            : undefined
    ), [agentFlavor, cursorPicker, cursorSelectedBase])

    const resolveCursorVariantsForBase = useCallback((baseKey: string) => {
        if (!cursorPicker) {
            return []
        }
        return buildCursorEffortPickerOptionsWithDefaultFirst(baseKey, cursorPicker.catalog)
    }, [cursorPicker])

    const cursorModelEffortOptions = useMemo(() => {
        if (agentFlavor !== 'cursor' || !cursorPicker) {
            return undefined
        }
        if (cursorPicker.mode !== 'dual') {
            return cursorPicker.effortOptions
        }
        const baseKey = cursorSelectedBaseValue && cursorSelectedBaseValue !== 'auto'
            ? cursorSelectedBaseValue
            : cursorPicker.baseKey
        if (!baseKey || baseKey === 'auto') {
            return undefined
        }
        return buildCursorEffortPickerOptionsWithDefaultFirst(baseKey, cursorPicker.catalog)
    }, [agentFlavor, cursorPicker, cursorSelectedBaseValue])

    const cursorVariantSelectValue = useMemo(() => (
        agentFlavor === 'cursor' && cursorModelEffortOptions
            ? resolveSessionCursorVariantSelectValue(props.session.model, cursorModelEffortOptions)
            : null
    ), [agentFlavor, cursorModelEffortOptions, props.session.model])
    const {
        abortSession,
        switchSession,
        setPermissionMode,
        setCollaborationMode,
        setCopilotAgentMode,
        setModel,
        setResumeWithSessionModel,
        setModelReasoningEffort,
        setEffort,
        setServiceTier
    } = useSessionActions(
        props.api,
        props.session.id,
        agentFlavor,
        codexCollaborationModeSupported
    )
    // Permission mode change handler
    const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
        try {
            await setPermissionMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set permission mode:', e)
        }
    }, [setPermissionMode, props.onRefresh, haptic])

    const handleCcSwitchProviderChange = useCallback(async (providerId: string) => {
        try {
            const restartedSessionId = await switchCcSwitchProvider(providerId)
            haptic.notification('success')
            if (restartedSessionId !== props.session.id) {
                navigate({
                    to: '/sessions/$sessionId',
                    params: { sessionId: restartedSessionId },
                    replace: true
                })
            } else {
                props.onRefresh()
            }
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to switch cc-switch provider:', e)
        }
    }, [switchCcSwitchProvider, props.onRefresh, props.session.id, haptic, navigate])

    const handleCollaborationModeChange = useCallback(async (mode: CodexCollaborationMode) => {
        try {
            await setCollaborationMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set collaboration mode:', e)
        }
    }, [setCollaborationMode, props.onRefresh, haptic])

    const handleCopilotAgentModeChange = useCallback(async (mode: CopilotAgentMode) => {
        try {
            await setCopilotAgentMode(mode)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set Copilot agent mode:', e)
        }
    }, [setCopilotAgentMode, props.onRefresh, haptic])

    // Model mode change handler
    const handleModelChange = useCallback(async (model: SessionModelSelection) => {
        const previousModelReasoningEffort = props.session.modelReasoningEffort
        const shouldClearReasoningEffort = agentFlavor === 'codex'
            && Boolean(previousModelReasoningEffort)
            && supportsCodexReasoningEffort(
                codexModelsState.models,
                model,
                previousModelReasoningEffort
            ) === false

        try {
            await applyModelChangeWithReasoningRollback({
                model,
                previousModelReasoningEffort,
                shouldClearReasoningEffort,
                setModel,
                setModelReasoningEffort
            })
            if (agentFlavor === 'omp') {
                await Promise.all([
                    ompModelsState.refetch(),
                    ompThinkingState.refetch()
                ])
            }
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model:', e)
        }
    }, [
        agentFlavor,
        codexModelsState.models,
        props.session.modelReasoningEffort,
        ompModelsState,
        ompThinkingState,
        setModelReasoningEffort,
        setModel,
        props.onRefresh,
        haptic
    ])

    const handleOmpModelCycle = useCallback(async () => {
        if (!props.api) return
        try {
            const result = await props.api.cycleSessionOmpModel(props.session.id)
            if (!result.success) throw new Error(result.error ?? 'Failed to cycle OMP model')
            await Promise.all([
                ompModelsState.refetch(),
                ompThinkingState.refetch()
            ])
            haptic.notification('success')
            props.onRefresh()
        } catch (error) {
            haptic.notification('error')
            console.error('Failed to cycle OMP model:', error)
        }
    }, [props.api, props.session.id, props.onRefresh, haptic, ompModelsState, ompThinkingState])

    const handleOmpModelsRefresh = useCallback(async () => {
        try {
            await Promise.all([
                ompModelsState.refresh(),
                ompThinkingState.refetch()
            ])
        } catch (error) {
            console.error('Failed to refresh OMP models:', error)
        }
    }, [ompModelsState, ompThinkingState])

    const handleResumeWithSessionModelChange = useCallback(async (enabled: boolean) => {
        try {
            await setResumeWithSessionModel(enabled)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set resume model setting:', e)
        }
    }, [setResumeWithSessionModel, props.onRefresh, haptic])

    const handleCursorBaseModelChange = useCallback(async (baseKey: string | null) => {
        if (!cursorPicker) {
            await enqueueCursorModelApply(() => handleModelChange(baseKey))
            return
        }
        const plan = resolveSessionCursorModelChange({
            picker: cursorPicker,
            sessionModel: props.session.model,
            cursorSelectedBase,
            kind: cursorPicker.mode === 'flat' ? 'flat' : 'base',
            value: baseKey
        })
        if (!plan.ok) {
            return
        }
        setCursorSelectedBase(plan.nextSelectedBase)
        if (plan.shouldApply) {
            await enqueueCursorModelApply(() => handleModelChange(plan.wireId))
        }
    }, [cursorPicker, cursorSelectedBase, enqueueCursorModelApply, handleModelChange, props.session.model])

    const handleCursorEffortChange = useCallback(async (wireId: string | null) => {
        if (!cursorPicker) {
            await enqueueCursorModelApply(() => handleModelChange(wireId))
            return
        }
        const plan = resolveSessionCursorModelChange({
            picker: cursorPicker,
            sessionModel: props.session.model,
            cursorSelectedBase,
            kind: 'effort',
            value: wireId
        })
        if (!plan.ok) {
            console.error(plan.reason)
            return
        }
        setCursorSelectedBase(plan.nextSelectedBase)
        await enqueueCursorModelApply(() => handleModelChange(plan.wireId))
    }, [cursorPicker, cursorSelectedBase, enqueueCursorModelApply, handleModelChange, props.session.model])

    const handleModelReasoningEffortChange = useCallback(async (modelReasoningEffort: string | null) => {
        try {
            await setModelReasoningEffort(modelReasoningEffort)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set model reasoning effort:', e)
        }
    }, [setModelReasoningEffort, props.onRefresh, haptic])

    const handleEffortChange = useCallback(async (effort: string | null) => {
        try {
            await setEffort(effort)
            if (agentFlavor === 'omp') {
                await ompThinkingState.refetch()
            }
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set effort:', e)
        }
    }, [agentFlavor, ompThinkingState, setEffort, props.onRefresh, haptic])

    const handleServiceTierChange = useCallback(async (serviceTier: string | null) => {
        try {
            await setServiceTier(serviceTier)
            haptic.notification('success')
            props.onRefresh()
        } catch (e) {
            haptic.notification('error')
            console.error('Failed to set service tier:', e)
        }
    }, [setServiceTier, props.onRefresh, haptic])

    // Abort handler
    const handleAbort = useCallback(async () => {
        await abortSession()
        props.onRefresh()
    }, [abortSession, props.onRefresh])

    // Switch to remote handler
    const handleSwitchToRemote = useCallback(async () => {
        await switchSession()
        props.onRefresh()
    }, [switchSession, props.onRefresh])
    const availableModelOptions = useMemo(() => (
        agentFlavor === 'codex'
            ? codexModelOptions
            : agentFlavor === 'cursor'
                ? (
                    cursorCatalogPending
                    || !cursorPicker
                    || cursorPicker.modelOptions.length === 0
                        ? undefined
                        : cursorPicker.modelOptions
                )
                : agentFlavor === 'opencode'
                    ? opencodeModelOptions
                    : agentFlavor === 'omp'
                        ? ompModelOptions
                        : agentFlavor === 'grok'
                            ? grokModelOptions
                            : agentFlavor === 'copilot'
                                ? copilotModelOptions
                                // Pi gets its provider-qualified model list from the piModels prop;
                                // feeding piModelOptions here would make the generic Ctrl/Cmd+M
                                // cycler (getNextModelForFlavor) post a bare modelId string,
                                // which loses the provider and can pick the wrong cached
                                // match or throw in runPi. undefined makes the shortcut a no-op
                                // so Pi model changes go through the settings sheet only.
                                : undefined
    ), [
        agentFlavor,
        codexModelOptions,
        copilotModelOptions,
        cursorCatalogPending,
        cursorPicker,
        grokModelOptions,
        ompModelOptions,
        opencodeModelOptions,
    ])

    const availableModelReasoningEffortOptions = useMemo(() => (
        agentFlavor === 'codex'
            ? codexReasoningEffortOptions
            : agentFlavor === 'opencode' && opencodeReasoningEffortState.options.length > 0
                ? opencodeReasoningEffortState.options
                : undefined
    ), [agentFlavor, codexReasoningEffortOptions, opencodeReasoningEffortState.options])

    const availableEffortOptions = useMemo(() => (
        agentFlavor === 'omp' && ompThinkingState.options.length > 0
            ? ompThinkingState.options
            : agentFlavor === 'grok' && grokEffortState.options.length > 0
                ? grokEffortState.options
                : undefined
    ), [agentFlavor, grokEffortState.options, ompThinkingState.options])

    const onCcSwitchProviderChange = useCallback((providerId: string) => {
        void handleCcSwitchProviderChange(providerId)
    }, [handleCcSwitchProviderChange])

    const onCursorBaseModelChange = useCallback((model: SessionModelSelection) => {
        return handleCursorBaseModelChange(typeof model === 'string' ? model : model?.modelId ?? null)
    }, [handleCursorBaseModelChange])

    const onModelChange = (
        agentFlavor === 'codex'
            ? (props.session.active && !controlledByUser && !codexModelsState.error ? handleModelChange : undefined)
            : agentFlavor === 'cursor'
                ? (props.session.active
                    && !controlledByUser
                    && !cursorCatalogPending
                    && !cursorModelsState.error
                    && cursorPicker
                    && cursorPicker.modelOptions.length > 0
                    ? onCursorBaseModelChange
                    : undefined)
                : agentFlavor === 'pi'
                    ? (props.session.active && !piModelsState.error ? handleModelChange : undefined)
                    : agentFlavor === 'grok'
                        ? (props.session.active && !controlledByUser && !grokModelsState.error
                            ? handleModelChange
                            : undefined)
                        : agentFlavor === 'omp'
                            ? (props.session.active && !controlledByUser
                                ? handleModelChange
                                : undefined)
                            : agentFlavor === 'copilot'
                                ? (props.session.active && !controlledByUser
                                    ? handleModelChange
                                    : undefined)
                                : handleModelChange
    )

    return {
        active: props.session.active,
        agentFlavor,
        controlledByUser,
        codexCollaborationModeSupported,
        codexModelsError: codexModelsState.error,
        effectiveCodexServiceTier,
        piContextWindow,
        permissionMode: props.session.permissionMode,
        collaborationMode: codexCollaborationModeSupported ? props.session.collaborationMode : undefined,
        copilotAgentMode: agentFlavor === 'copilot' ? props.session.copilotAgentMode : undefined,
        model: agentFlavor === 'omp'
            ? props.session.model ?? (ompModelsState.currentModel
                ? `${ompModelsState.currentModel.provider}/${ompModelsState.currentModel.modelId}`
                : null)
            : props.session.model,
        modelReasoningEffort: agentFlavor === 'codex' || agentFlavor === 'opencode' ? props.session.modelReasoningEffort : undefined,
        effort: agentFlavor === 'omp'
            ? props.session.metadata?.ompThinking?.configured
                ?? ompThinkingState.state?.configured
                ?? props.session.effort
            : props.session.effort,
        resumeWithSessionModel: props.session.resumeWithSessionModel,
        serviceTier: effectiveCodexServiceTier,
        availableModelOptions,
        piModels,
        piSelectedModel: agentFlavor === 'pi' ? piSelectedModel : undefined,
        availableModelReasoningEffortOptions,
        availableEffortOptions,
        ompThinkingState: agentFlavor === 'omp'
            ? props.session.metadata?.ompThinking ?? ompThinkingState.state ?? undefined
            : undefined,
        ccSwitchProviders: agentFlavor === 'claude' && ccSwitchProvidersState.available
            ? ccSwitchProvidersState.providers
            : undefined,
        currentCcSwitchProviderId: props.session.metadata?.ccSwitchProviderId ?? ccSwitchProvidersState.currentProviderId,
        selectedModelBase: agentFlavor === 'cursor' && cursorPicker
            ? cursorSelectedBaseValue
            : undefined,
        selectedModelVariant: agentFlavor === 'cursor' && !cursorCatalogPending
            ? cursorVariantSelectValue
            : undefined,
        modelEffortOptions: agentFlavor === 'cursor'
            && !cursorCatalogPending
            && cursorPicker?.mode === 'dual'
            && cursorModelEffortOptions
            && cursorModelEffortOptions.length > 1
            ? cursorModelEffortOptions
            : undefined,
        resolveModelVariantsForBase: agentFlavor === 'cursor' && cursorPicker?.mode === 'dual'
            ? resolveCursorVariantsForBase
            : undefined,
        modelsRefreshing: agentFlavor === 'omp' ? (ompModelsState.isRefreshing || ompModelsState.isFetching) : undefined,
        modelsError: agentFlavor === 'omp' ? ompModelsState.error : undefined,
        onPermissionModeChange: agentFlavor === 'copilot' && controlledByUser
            ? undefined
            : handlePermissionModeChange,
        onCollaborationModeChange: codexCollaborationModeSupported && props.session.active && !controlledByUser
            ? handleCollaborationModeChange
            : undefined,
        onCopilotAgentModeChange: agentFlavor === 'copilot' && props.session.active && !controlledByUser
            ? handleCopilotAgentModeChange
            : undefined,
        onCcSwitchProviderChange: agentFlavor === 'claude' && ccSwitchProvidersState.available && props.session.active && !controlledByUser
            ? onCcSwitchProviderChange
            : undefined,
        onModelChange,
        onCycleModel: agentFlavor === 'omp' && props.session.active && !controlledByUser
            ? handleOmpModelCycle
            : undefined,
        onRefreshModels: agentFlavor === 'omp' && props.session.active && !controlledByUser
            ? handleOmpModelsRefresh
            : undefined,
        onResumeWithSessionModelChange: agentFlavor === 'claude' ? handleResumeWithSessionModelChange : undefined,
        onModelEffortChange: agentFlavor === 'cursor'
            && props.session.active
            && !controlledByUser
            && !cursorCatalogPending
            && !cursorModelsState.error
            ? handleCursorEffortChange
            : undefined,
        onModelReasoningEffortChange: (agentFlavor === 'codex' || agentFlavor === 'opencode')
            && props.session.active
            && !controlledByUser
            && (agentFlavor !== 'opencode' || opencodeReasoningEffortState.options.length > 0)
            ? handleModelReasoningEffortChange
            : undefined,
        onEffortChange: agentFlavor === 'grok' || agentFlavor === 'omp'
            ? (props.session.active && !controlledByUser
                && (agentFlavor === 'omp' ? ompThinkingState.options.length > 0 : grokEffortState.options.length > 0)
                ? handleEffortChange
                : undefined)
            : handleEffortChange,
        onServiceTierChange: agentFlavor === 'codex'
            && props.session.active
            && !controlledByUser
            && !codexModelsState.error
            && codexModelAdvertisesFastTier(props.session.model, codexModelsState.models)
            ? handleServiceTierChange
            : undefined,
        handleAbort,
        handleSwitchToRemote,
    }
}
