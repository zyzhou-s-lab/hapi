import type {
    CodexCollaborationMode,
    CopilotAgentMode,
    PermissionMode,
    PiThinkingLevel,
} from '@hapi/protocol'
import {
    getCodexCollaborationModeOptions,
    getCopilotAgentModeOptions,
    getPermissionModeOptionsForFlavor,
    PI_THINKING_LEVEL_LABELS,
    supportsEffort,
    supportsModelChange,
} from '@hapi/protocol'
import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FloatingOverlay } from '@/components/ChatInput/FloatingOverlay'
import { OmpModelRefreshRow } from '@/fork-features/omp-host-integration/OmpModelRefreshRow'
import { getClaudeComposerEffortOptions } from '../claudeEffortOptions'
import { isListedClaudeModel, normalizeCustomClaudeModelId } from '../claudeModelOptions'
import { getDisplayedCodexServiceTier } from '../codexFastMode'
import { getCodexComposerReasoningEffortOptions } from '../codexReasoningEffortOptions'
import { getModelOptionsForFlavor } from '../modelOptions'
import { groupModelsByProvider } from '../piModelGroups'
import { getHighestThinkingLevel, getPiThinkingLevelOptions, isThinkingLevelSupported } from '../piThinkingLevelOptions'
import { useNarrowViewport } from '@/hooks/useNarrowViewport'
import { useTranslation } from '@/lib/use-translation'
import type { OmpThinkingState, PiModelSummary } from '@/types/api'
import type {
    ComposerSettingsSection,
    ModelEffortOption,
    SessionFlavorModelController,
    SessionModelSelection,
} from './types'

/**
 * Prefer session `selectedModelVariant` only when it is still among the rows
 * currently shown. After a multi-variant base switch, session state can lag
 * while `cursorDrillDownDefaultVariant` already points at the new base's
 * default — stale variants must not win highlight.
 */
export function resolveVisibleModelEffortSelectedValue(args: {
    options: ReadonlyArray<{ value: string }> | null | undefined
    selectedModelVariant?: string | null
    cursorDrillDownDefaultVariant?: string | null
    model?: string | null
}): string | null | undefined {
    const {
        options,
        selectedModelVariant,
        cursorDrillDownDefaultVariant,
        model,
    } = args
    const selectedVisibleVariant = options?.some((option) => option.value === selectedModelVariant)
        ? selectedModelVariant
        : null
    return selectedVisibleVariant ?? cursorDrillDownDefaultVariant ?? model
}

export function ModelEffortSettingsSection(props: {
    agentFlavor?: string | null
    options: Array<{ value: string; label: string }>
    selectedValue: string | null | undefined
    controlsDisabled: boolean
    onChange: (value: string) => void
    /** Override the section title (e.g. Cursor base id during nested drill-down). */
    title?: string | null
    /** When set, show a back control above the title (Cursor nested variant drill-down). */
    onBack?: () => void
    backLabel?: string
}) {
    const { t } = useTranslation()
    const {
        agentFlavor,
        options,
        selectedValue,
        controlsDisabled,
        onChange,
        title,
        onBack,
        backLabel,
    } = props

    const heading = title
        ?? (agentFlavor === 'cursor' ? t('misc.variant') : t('misc.effort'))

    return (
        <div className="py-2">
            {onBack ? (
                <button
                    type="button"
                    data-testid="cursor-variant-back"
                    disabled={controlsDisabled}
                    className={`flex w-full items-center px-3 pb-1 text-left text-xs text-[var(--app-hint)] transition-colors ${
                        controlsDisabled
                            ? 'cursor-not-allowed opacity-50'
                            : 'cursor-pointer hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-link)]'
                    }`}
                    onClick={onBack}
                    onMouseDown={(e) => e.preventDefault()}
                    aria-label={backLabel ?? t('misc.backToModelList')}
                >
                    {backLabel ?? t('misc.backToModelList')}
                </button>
            ) : null}
            <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                {heading}
            </div>
            {options.map((option) => {
                const isSelected = selectedValue === option.value
                return (
                    <button
                        key={option.value}
                        type="button"
                        disabled={controlsDisabled}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                            controlsDisabled
                                ? 'cursor-not-allowed opacity-50'
                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                        }`}
                        onClick={() => onChange(option.value)}
                        onMouseDown={(e) => e.preventDefault()}
                    >
                        <div
                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                isSelected
                                    ? 'border-[var(--app-link)]'
                                    : 'border-[var(--app-hint)]'
                            }`}
                        >
                            {isSelected && (
                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                            )}
                        </div>
                        <span className={isSelected ? 'text-[var(--app-link)]' : ''}>
                            {option.label}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}

export interface ComposerFlavorPropsInput {
    flavorController?: SessionFlavorModelController
    agentFlavor?: string | null
    active?: boolean
    controlledByUser?: boolean
    permissionMode?: PermissionMode
    collaborationMode?: CodexCollaborationMode
    copilotAgentMode?: CopilotAgentMode
    model?: string | null
    modelReasoningEffort?: string | null
    effort?: string | null
    resumeWithSessionModel?: boolean
    contextWindow?: number | null
    availableModelOptions?: Array<{ value: string | null; label: string }>
    piModels?: PiModelSummary[]
    piSelectedModel?: { provider: string; modelId: string } | null
    availableModelReasoningEffortOptions?: Array<{ value: string; name?: string }>
    availableEffortOptions?: Array<{ value: string; name?: string }>
    ompThinkingState?: OmpThinkingState
    selectedModelBase?: string | null
    selectedModelVariant?: string | null
    modelEffortOptions?: Array<{ value: string; label: string }>
    resolveModelVariantsForBase?: (baseKey: string) => readonly { value: string; label: string }[]
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => void
    onCopilotAgentModeChange?: (mode: CopilotAgentMode) => void
    onPermissionModeChange?: (mode: PermissionMode) => void
    onModelChange?: (model: SessionModelSelection) => void
    onCycleModel?: () => void
    onRefreshModels?: () => void
    modelsRefreshing?: boolean
    modelsError?: string | null
    ccSwitchProviders?: Array<{ id: string; name: string; isCurrent: boolean }>
    currentCcSwitchProviderId?: string | null
    onCcSwitchProviderChange?: (providerId: string) => void
    onResumeWithSessionModelChange?: (enabled: boolean) => void
    onModelEffortChange?: (wireId: string | null) => void
    onModelReasoningEffortChange?: (modelReasoningEffort: string | null) => void
    onEffortChange?: (effort: string | null) => void
    serviceTier?: string | null
    onServiceTierChange?: (serviceTier: string | null) => void
    onSwitchToRemote?: () => Promise<void> | void
}

export function normalizeComposerFlavorProps(props: ComposerFlavorPropsInput) {
    const fc = props.flavorController
    return {
        agentFlavor: (props.agentFlavor !== undefined ? props.agentFlavor : fc?.agentFlavor) ?? null,
        active: props.active ?? fc?.active ?? true,
        controlledByUser: props.controlledByUser ?? fc?.controlledByUser ?? false,
        permissionMode: props.permissionMode ?? fc?.permissionMode ?? 'default',
        collaborationMode: props.collaborationMode ?? fc?.collaborationMode ?? 'default',
        copilotAgentMode: props.copilotAgentMode ?? fc?.copilotAgentMode ?? 'interactive',
        model: (props.model !== undefined ? props.model : fc?.model) ?? null,
        modelReasoningEffort: (
            props.modelReasoningEffort !== undefined
                ? props.modelReasoningEffort
                : fc?.modelReasoningEffort
        ) ?? null,
        effort: (props.effort !== undefined ? props.effort : fc?.effort) ?? null,
        resumeWithSessionModel: props.resumeWithSessionModel ?? fc?.resumeWithSessionModel ?? false,
        contextWindow: props.contextWindow !== undefined ? props.contextWindow : fc?.piContextWindow,
        availableModelOptions: props.availableModelOptions ?? fc?.availableModelOptions,
        piModels: props.piModels ?? fc?.piModels,
        piSelectedModel: props.piSelectedModel !== undefined ? props.piSelectedModel : fc?.piSelectedModel,
        availableModelReasoningEffortOptions:
            props.availableModelReasoningEffortOptions ?? fc?.availableModelReasoningEffortOptions,
        availableEffortOptions: props.availableEffortOptions ?? fc?.availableEffortOptions,
        ompThinkingState: props.ompThinkingState ?? fc?.ompThinkingState,
        selectedModelBase: props.selectedModelBase !== undefined ? props.selectedModelBase : fc?.selectedModelBase,
        selectedModelVariant:
            props.selectedModelVariant !== undefined ? props.selectedModelVariant : fc?.selectedModelVariant,
        modelEffortOptions: props.modelEffortOptions ?? fc?.modelEffortOptions,
        resolveModelVariantsForBase: props.resolveModelVariantsForBase ?? fc?.resolveModelVariantsForBase,
        onCollaborationModeChange: props.onCollaborationModeChange ?? fc?.onCollaborationModeChange,
        onCopilotAgentModeChange: props.onCopilotAgentModeChange ?? fc?.onCopilotAgentModeChange,
        onPermissionModeChange: props.onPermissionModeChange ?? fc?.onPermissionModeChange,
        onModelChange: props.onModelChange ?? fc?.onModelChange,
        onCycleModel: props.onCycleModel ?? fc?.onCycleModel,
        onRefreshModels: props.onRefreshModels ?? fc?.onRefreshModels,
        modelsRefreshing: props.modelsRefreshing ?? fc?.modelsRefreshing ?? false,
        modelsError: (
            props.modelsError !== undefined
                ? props.modelsError
                : (fc?.modelsError !== undefined ? fc.modelsError : fc?.codexModelsError)
        ) ?? null,
        ccSwitchProviders: props.ccSwitchProviders ?? fc?.ccSwitchProviders,
        currentCcSwitchProviderId:
            props.currentCcSwitchProviderId !== undefined
                ? props.currentCcSwitchProviderId
                : fc?.currentCcSwitchProviderId,
        onCcSwitchProviderChange: props.onCcSwitchProviderChange ?? fc?.onCcSwitchProviderChange,
        onResumeWithSessionModelChange:
            props.onResumeWithSessionModelChange ?? fc?.onResumeWithSessionModelChange,
        onModelEffortChange: props.onModelEffortChange ?? fc?.onModelEffortChange,
        onModelReasoningEffortChange:
            props.onModelReasoningEffortChange ?? fc?.onModelReasoningEffortChange,
        onEffortChange: props.onEffortChange ?? fc?.onEffortChange,
        serviceTier: (
            props.serviceTier !== undefined
                ? props.serviceTier
                : (fc?.serviceTier !== undefined ? fc.serviceTier : fc?.effectiveCodexServiceTier)
        ) ?? null,
        onServiceTierChange: props.onServiceTierChange ?? fc?.onServiceTierChange,
        onSwitchToRemote: props.onSwitchToRemote ?? fc?.handleSwitchToRemote,
    }
}

export interface UseComposerSettingsSheetParams {
    active: boolean
    agentFlavor: string | null
    configurationControlsDisabled: boolean
    controlsDisabled: boolean
    haptic: (type?: 'light' | 'success' | 'error') => void
    permissionMode: PermissionMode
    onPermissionModeChange?: (mode: PermissionMode) => void
    collaborationMode: CodexCollaborationMode
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => void
    copilotAgentMode: CopilotAgentMode
    onCopilotAgentModeChange?: (mode: CopilotAgentMode) => void
    model: string | null
    selectedModelBase?: string | null
    selectedModelVariant?: string | null
    availableModelOptions?: Array<{ value: string | null; label: string }>
    modelEffortOptions?: ModelEffortOption[]
    resolveModelVariantsForBase?: (baseKey: string) => readonly ModelEffortOption[]
    onModelChange?: (model: SessionModelSelection) => void
    onModelEffortChange?: (wireId: string | null) => void
    onRefreshModels?: () => void
    modelsRefreshing: boolean
    modelsError: string | null
    ccSwitchProviders?: Array<{ id: string; name: string; isCurrent: boolean }>
    currentCcSwitchProviderId?: string | null
    onCcSwitchProviderChange?: (providerId: string) => void
    resumeWithSessionModel: boolean
    onResumeWithSessionModelChange?: (enabled: boolean) => void
    modelReasoningEffort: string | null
    availableModelReasoningEffortOptions?: Array<{ value: string; name?: string }>
    onModelReasoningEffortChange?: (modelReasoningEffort: string | null) => void
    effort: string | null
    availableEffortOptions?: Array<{ value: string; name?: string }>
    onEffortChange?: (effort: string | null) => void
    piModels?: PiModelSummary[]
    piSelectedModel?: { provider: string; modelId: string } | null
    serviceTier: string | null
    onServiceTierChange?: (serviceTier: string | null) => void
}

export function useComposerSettingsSheet(params: UseComposerSettingsSheetParams) {
    const { t } = useTranslation()
    const {
        active,
        agentFlavor,
        configurationControlsDisabled,
        controlsDisabled,
        haptic,
        permissionMode,
        onPermissionModeChange,
        collaborationMode,
        onCollaborationModeChange,
        copilotAgentMode,
        onCopilotAgentModeChange,
        model,
        selectedModelBase,
        selectedModelVariant,
        availableModelOptions,
        modelEffortOptions,
        resolveModelVariantsForBase,
        onModelChange,
        onModelEffortChange,
        onRefreshModels,
        modelsRefreshing,
        modelsError,
        ccSwitchProviders,
        currentCcSwitchProviderId,
        onCcSwitchProviderChange,
        resumeWithSessionModel,
        onResumeWithSessionModelChange,
        modelReasoningEffort,
        availableModelReasoningEffortOptions,
        onModelReasoningEffortChange,
        effort,
        availableEffortOptions,
        onEffortChange,
        piModels,
        piSelectedModel,
        serviceTier,
        onServiceTierChange,
    } = params

    const displayedServiceTier = getDisplayedCodexServiceTier(serviceTier)
    const [showSettings, setShowSettings] = useState(false)
    // Anchored settings sheet: the model/effort value buttons open only their
    // own section; the gear (null) opens the full sheet.
    const [settingsSection, setSettingsSection] = useState<ComposerSettingsSection>(null)
    const [customModelDraft, setCustomModelDraft] = useState('')

    const settingsButtonRef = useRef<HTMLButtonElement>(null)
    const modelValueButtonRef = useRef<HTMLButtonElement>(null)
    const effortValueButtonRef = useRef<HTMLButtonElement>(null)
    const settingsOverlayRef = useRef<HTMLDivElement>(null)

    const permissionModeOptions = useMemo(
        () => getPermissionModeOptionsForFlavor(agentFlavor),
        [agentFlavor]
    )
    const collaborationModeOptions = useMemo(
        () => agentFlavor === 'codex' ? getCodexCollaborationModeOptions() : [],
        [agentFlavor]
    )
    const copilotAgentModeOptions = useMemo(
        () => agentFlavor === 'copilot' ? getCopilotAgentModeOptions() : [],
        [agentFlavor]
    )
    const modelOptions = useMemo(
        () => getModelOptionsForFlavor(agentFlavor, model, availableModelOptions),
        [agentFlavor, model, availableModelOptions]
    )

    // Cursor dual picker: after choosing a multi-variant base, drill into variant
    // rows in-place (picker stays open). Variant pick dismisses; back returns to
    // the full base list.
    const [cursorDrillDownBase, setCursorDrillDownBase] = useState<string | null>(null)
    const [cursorDrillDownDefaultVariant, setCursorDrillDownDefaultVariant] = useState<string | null>(null)
    useEffect(() => {
        if (!selectedModelBase || selectedModelBase === 'auto') {
            setCursorDrillDownBase(null)
            setCursorDrillDownDefaultVariant(null)
        }
    }, [selectedModelBase])

    const cursorDrillDownVariantOptions = useMemo(() => {
        if (!cursorDrillDownBase || !resolveModelVariantsForBase) {
            return null
        }
        const options = resolveModelVariantsForBase(cursorDrillDownBase)
        return options.length > 1 ? options : null
    }, [cursorDrillDownBase, resolveModelVariantsForBase])

    const cursorVariantDrillDownActive = agentFlavor === 'cursor' && cursorDrillDownVariantOptions !== null

    const visibleModelEffortOptions = cursorDrillDownVariantOptions ?? modelEffortOptions
    const codexReasoningEffortOptions = useMemo(
        () => agentFlavor === 'codex' || agentFlavor === 'opencode'
            ? getCodexComposerReasoningEffortOptions(
                modelReasoningEffort,
                agentFlavor,
                availableModelReasoningEffortOptions
            )
            : [],
        [agentFlavor, modelReasoningEffort, availableModelReasoningEffortOptions]
    )
    // Pi: group models by provider for hierarchical display
    const piModelGroups = useMemo(
        () => piModels && piModels.length > 0 ? groupModelsByProvider(piModels) : null,
        [piModels]
    )
    // Pi: find the currently selected model's thinkingLevelMap for effort filtering.
    // Prefer provider-qualified match (metadata.piSelectedModel) when available —
    // two providers may share a modelId, and a modelId-only match would pick the
    // wrong one, sending the wrong provider on the next model/effort change.
    const selectedPiModel = useMemo(
        () => piSelectedModel
            ? piModels?.find((m) => m.provider === piSelectedModel.provider && m.modelId === piSelectedModel.modelId)
            : piModels?.find((m) => m.modelId === model),
        [piModels, piSelectedModel, model]
    )

    // Pi: reset effort to highest supported level when model changes and current level is unsupported
    useEffect(() => {
        if (!effort || !selectedPiModel || !onEffortChange) return
        // Non-reasoning model: clear stale effort so the hub does not forward
        // a set_thinking_level the user can no longer see or change.
        if (selectedPiModel.reasoning === false) {
            onEffortChange(null)
            return
        }
        if (!isThinkingLevelSupported(effort, selectedPiModel.thinkingLevelMap)) {
            onEffortChange(getHighestThinkingLevel(selectedPiModel.thinkingLevelMap))
        }
    }, [selectedPiModel, effort, onEffortChange])

    const claudeEffortOptions = useMemo(
        () => agentFlavor === 'pi'
            ? getPiThinkingLevelOptions(effort, selectedPiModel?.thinkingLevelMap)
            : (agentFlavor === 'grok' || agentFlavor === 'omp') && availableEffortOptions && availableEffortOptions.length > 0
                ? [
                    ...(agentFlavor === 'grok' ? [{ value: null, label: 'Default' }] : []),
                    ...availableEffortOptions.map((option) => ({
                        value: option.value,
                        label: option.name ?? option.value,
                    })),
                ]
            : getClaudeComposerEffortOptions(effort),
        [agentFlavor, effort, selectedPiModel, availableEffortOptions]
    )
    const permissionModes = useMemo(
        () => permissionModeOptions.map((option) => option.mode),
        [permissionModeOptions]
    )

    // Opens (or closes) the settings sheet. `section` anchors the sheet to a
    // single section ('model' / 'effort'); the gear passes nothing = full sheet.
    // Re-clicking with a different anchor while open switches the anchor
    // instead of closing, so model->effort moves between sections directly.
    const handleSettingsToggle = useCallback((section: ComposerSettingsSection = null) => {
        haptic('light')
        if (showSettings && section !== settingsSection) {
            // Open with a different anchor: switch sections, keep the sheet up.
            setSettingsSection(section)
            return
        }
        if (showSettings) {
            setCursorDrillDownBase(null)
            setCursorDrillDownDefaultVariant(null)
            setShowSettings(false)
            setSettingsSection(null)
            return
        }
        setSettingsSection(section)
        setShowSettings(true)
    }, [haptic, showSettings, settingsSection])

    const clearCursorDrillDown = useCallback(() => {
        setCursorDrillDownBase(null)
        setCursorDrillDownDefaultVariant(null)
    }, [])

    const dismissSettings = useCallback(() => {
        clearCursorDrillDown()
        setShowSettings(false)
        setSettingsSection(null)
    }, [clearCursorDrillDown])

    const handleModelChange = useCallback((nextModel: SessionModelSelection) => {
        if (!onModelChange || configurationControlsDisabled) return
        onModelChange(nextModel)
        if (
            agentFlavor === 'claude'
            && !active
            && nextModel !== null
            && !resumeWithSessionModel
            && onResumeWithSessionModelChange
        ) {
            onResumeWithSessionModelChange(true)
        }
        dismissSettings()
        haptic('light')
    }, [
        onModelChange,
        configurationControlsDisabled,
        agentFlavor,
        active,
        resumeWithSessionModel,
        onResumeWithSessionModelChange,
        dismissSettings,
        haptic,
    ])

    const handleCursorModelRowClick = useCallback((nextModel: string | null) => {
        if (!onModelChange || controlsDisabled) return

        const variants = nextModel && nextModel !== 'auto' && resolveModelVariantsForBase
            ? resolveModelVariantsForBase(nextModel)
            : []

        const isMultiVariantBasePick = selectedModelBase !== undefined
            && nextModel !== null
            && nextModel !== 'auto'
            && !nextModel.includes('[')
            && variants.length > 1

        if (isMultiVariantBasePick) {
            setCursorDrillDownBase(nextModel)
            setCursorDrillDownDefaultVariant(variants[0]?.value ?? null)
            onModelChange(nextModel)
            haptic('light')
            return
        }

        onModelChange(nextModel)
        dismissSettings()
        haptic('light')
    }, [
        onModelChange,
        controlsDisabled,
        resolveModelVariantsForBase,
        selectedModelBase,
        haptic,
        dismissSettings,
    ])

    const handleModelEffortChange = useCallback((nextWireId: string | null) => {
        const handler = onModelEffortChange ?? onModelChange
        if (!handler || controlsDisabled) return
        handler(nextWireId)
        dismissSettings()
        haptic('light')
    }, [onModelEffortChange, onModelChange, controlsDisabled, haptic, dismissSettings])

    useEffect(() => {
        if (!showSettings) return

        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (settingsOverlayRef.current?.contains(target)) return
            if (settingsButtonRef.current?.contains(target)) return
            if (modelValueButtonRef.current?.contains(target)) return
            if (effortValueButtonRef.current?.contains(target)) return
            dismissSettings()
        }

        document.addEventListener('pointerdown', handlePointerDown, true)
        return () => document.removeEventListener('pointerdown', handlePointerDown, true)
    }, [dismissSettings, showSettings])

    const handlePermissionChange = useCallback((mode: PermissionMode) => {
        if (!onPermissionModeChange || controlsDisabled) return
        onPermissionModeChange(mode)
        dismissSettings()
        haptic('light')
    }, [onPermissionModeChange, controlsDisabled, haptic, dismissSettings])

    const handleCollaborationChange = useCallback((mode: CodexCollaborationMode) => {
        if (!onCollaborationModeChange || controlsDisabled) return
        onCollaborationModeChange(mode)
        dismissSettings()
        haptic('light')
    }, [onCollaborationModeChange, controlsDisabled, haptic, dismissSettings])

    useEffect(() => {
        if (showSettings) {
            setCustomModelDraft(
                agentFlavor === 'claude' && model && !isListedClaudeModel(model)
                    ? model
                    : ''
            )
        }
    }, [showSettings, agentFlavor, model])

    const handleCustomModelSubmit = useCallback(() => {
        const modelId = normalizeCustomClaudeModelId(customModelDraft)
        if (!modelId) return
        handleModelChange(modelId)
    }, [customModelDraft, handleModelChange])

    const handleResumeWithSessionModelChange = useCallback(() => {
        if (!onResumeWithSessionModelChange || controlsDisabled) return
        onResumeWithSessionModelChange(!resumeWithSessionModel)
        dismissSettings()
        haptic('light')
    }, [onResumeWithSessionModelChange, controlsDisabled, haptic, resumeWithSessionModel, dismissSettings])

    const handleCcSwitchProviderChange = useCallback((providerId: string) => {
        if (!onCcSwitchProviderChange || controlsDisabled) return
        if (providerId !== currentCcSwitchProviderId) onCcSwitchProviderChange(providerId)
        dismissSettings()
        haptic('light')
    }, [onCcSwitchProviderChange, currentCcSwitchProviderId, controlsDisabled, haptic, dismissSettings])

    const handleCopilotAgentModeChange = useCallback((mode: CopilotAgentMode) => {
        if (!onCopilotAgentModeChange || controlsDisabled) return
        onCopilotAgentModeChange(mode)
        dismissSettings()
        haptic('light')
    }, [onCopilotAgentModeChange, controlsDisabled, haptic, dismissSettings])

    const handleModelReasoningEffortChange = useCallback((nextModelReasoningEffort: string | null) => {
        if (!onModelReasoningEffortChange || controlsDisabled) return
        onModelReasoningEffortChange(nextModelReasoningEffort)
        dismissSettings()
        haptic('light')
    }, [onModelReasoningEffortChange, controlsDisabled, haptic, dismissSettings])

    const handleEffortChange = useCallback((nextEffort: string | null) => {
        if (!onEffortChange || configurationControlsDisabled) return
        onEffortChange(nextEffort)
        dismissSettings()
        haptic('light')
    }, [onEffortChange, configurationControlsDisabled, haptic, dismissSettings])

    const handleServiceTierChange = useCallback((nextServiceTier: string | null) => {
        if (!onServiceTierChange || controlsDisabled) return
        onServiceTierChange(nextServiceTier)
        dismissSettings()
        haptic('light')
    }, [onServiceTierChange, controlsDisabled, haptic, dismissSettings])

    // 'standard' (not null) is the explicit Fast-off choice so it persists
    // distinctly from an untouched/account-default session.
    const fastModeOptions: Array<{ value: string; label: string }> = useMemo(() => [
        { value: 'standard', label: t('misc.fastModeStandard') },
        { value: 'fast', label: t('misc.fastModeFast') },
    ], [t])

    const showCollaborationSettings = Boolean(onCollaborationModeChange && collaborationModeOptions.length > 0)
    const showCopilotAgentModeSettings = Boolean(onCopilotAgentModeChange && copilotAgentModeOptions.length > 0)
    const showPermissionSettings = Boolean(onPermissionModeChange && permissionModeOptions.length > 0)
    const showCcSwitchSettings = Boolean(onCcSwitchProviderChange && ccSwitchProviders?.length)
    const showModelSettings = agentFlavor === 'pi'
        // Pi models only come from the dynamic piModels catalog; never fall
        // back to the generic synthesized modelOptions rows (they would post a
        // bare model id the Pi runner cannot resolve to a provider).
        ? Boolean(onRefreshModels || (onModelChange && piModelGroups))
        : Boolean(onRefreshModels || (onModelChange && supportsModelChange(agentFlavor) && modelOptions.length > 0))
        && !cursorVariantDrillDownActive
    const showCustomModelInput = showModelSettings && agentFlavor === 'claude'
    const showResumeModelSettings = Boolean(agentFlavor === 'claude' && onResumeWithSessionModelChange)
    const showModelEffortSettings = cursorVariantDrillDownActive
        ? Boolean((onModelEffortChange ?? onModelChange) && visibleModelEffortOptions && visibleModelEffortOptions.length > 0)
        : Boolean(
            (onModelEffortChange ?? onModelChange)
            && modelEffortOptions
            && modelEffortOptions.length > 1
        )
    const showModelReasoningEffortSettings = Boolean(onModelReasoningEffortChange && codexReasoningEffortOptions.length > 0)
    // For Pi: hide effort while the selected model is unresolved (catalog
    // still loading/failed) or explicitly has reasoning: false — the generic
    // fallback levels would mutate a set_thinking_level the model may reject.
    const piEffortUnavailable = agentFlavor === 'pi'
        && (!selectedPiModel || selectedPiModel.reasoning === false)
    const showEffortSettings = Boolean(onEffortChange && supportsEffort(agentFlavor) && !piEffortUnavailable)
    const showFastModeSettings = Boolean(onServiceTierChange)
    const showSettingsButton = Boolean(
        showCollaborationSettings
        || showCopilotAgentModeSettings
        || showPermissionSettings
        || showCcSwitchSettings
        || showModelSettings
        || showResumeModelSettings
        || showModelEffortSettings
        || showModelReasoningEffortSettings
        || showEffortSettings
        || showFastModeSettings
    )

    // Generic model/effort value buttons. The current value label doubles as
    // the button caption; clicking opens the settings sheet. Hidden on narrow
    // viewports where only the settings button remains.
    const isNarrowViewport = useNarrowViewport()
    // Pi turns run for minutes with thread.isDisabled set the whole time, so
    // Pi keeps its model/effort controls live mid-turn (#1442) — the generic
    // disable rule (controlsDisabled) would lock them for the entire turn.
    const modelEffortControlsDisabled = agentFlavor === 'pi' ? configurationControlsDisabled : controlsDisabled
    const modelValueLabel = useMemo(() => {
        if (isNarrowViewport) return undefined
        if (!onModelChange || !supportsModelChange(agentFlavor)) return undefined
        // Pi models come from the dynamic piModels catalog; show the
        // provider-qualified selection name. No button until the catalog
        // resolves: a bare session model id has no provider and the sheet
        // would have no Model section to open anyway.
        if (agentFlavor === 'pi') {
            if (!selectedPiModel) return undefined
            return selectedPiModel.name ?? selectedPiModel.modelId
        }
        if (modelOptions.length === 0) return undefined
        const rawKey = selectedModelBase !== undefined ? selectedModelBase : model
        // `null` (default selection) and the `auto`/`default` wire values all
        // mean "let the agent pick" — normalize them onto the `value: null`
        // option so the localized option label is always found.
        const normalizedKey = !rawKey || rawKey === 'auto' || rawKey === 'default' ? null : rawKey
        const option = modelOptions.find((candidate) => candidate.value === normalizedKey)
        return option?.label ?? rawKey ?? undefined
    }, [isNarrowViewport, onModelChange, agentFlavor, selectedPiModel, model, modelOptions, selectedModelBase])

    const effortValueLabel = useMemo(() => {
        if (isNarrowViewport) return undefined
        if (!onEffortChange || !supportsEffort(agentFlavor)) return undefined
        // Pi: without a resolved catalog entry there is no capability map to
        // derive levels from; hide the button until the selected model is known.
        if (agentFlavor === 'pi') {
            if (!selectedPiModel || selectedPiModel.reasoning === false) return undefined
            const effectiveLevel = effort && isThinkingLevelSupported(effort, selectedPiModel?.thinkingLevelMap)
                ? effort
                : getHighestThinkingLevel(selectedPiModel?.thinkingLevelMap)
            return effectiveLevel
                ? (PI_THINKING_LEVEL_LABELS[effectiveLevel as PiThinkingLevel] ?? effectiveLevel)
                : undefined
        }
        const option = claudeEffortOptions.find((candidate) => candidate.value === effort)
        return option?.label ?? (effort ? effort : undefined)
    }, [isNarrowViewport, onEffortChange, agentFlavor, selectedPiModel, effort, claudeEffortOptions])

    // Wrapper for DOM onClick consumers: never leak the MouseEvent into the
    // `section` parameter (the gear must always open the full sheet).
    const handleGearToggle = useCallback(() => {
        handleSettingsToggle(null)
    }, [handleSettingsToggle])

    const handleModelValueToggle = useCallback(() => {
        if (modelEffortControlsDisabled) return
        handleSettingsToggle('model')
    }, [modelEffortControlsDisabled, handleSettingsToggle])

    const handleEffortValueToggle = useCallback(() => {
        if (modelEffortControlsDisabled) return
        handleSettingsToggle('effort')
    }, [modelEffortControlsDisabled, handleSettingsToggle])

    const sheetModelAreaOn = settingsSection !== 'effort'
    const sheetEffortAreaOn = settingsSection !== 'model'
    const sheetOthersOn = settingsSection === null
    const sheetModelSettings = showModelSettings && sheetModelAreaOn
    const sheetModelEffortSettings = showModelEffortSettings && sheetModelAreaOn
    const sheetModelReasoningEffortSettings = showModelReasoningEffortSettings && sheetEffortAreaOn
    const sheetEffortSettings = showEffortSettings && sheetEffortAreaOn
    const sheetResumeModelSettings = showResumeModelSettings && sheetModelAreaOn
    const sheetPermissionSettings = showPermissionSettings && sheetOthersOn
    const sheetCcSwitchSettings = showCcSwitchSettings && sheetOthersOn
    const sheetFastModeSettings = showFastModeSettings && sheetOthersOn
    const sheetCollaborationSettings = showCollaborationSettings && sheetOthersOn
    const sheetCopilotAgentModeSettings = showCopilotAgentModeSettings && sheetOthersOn
    const hasVisibleSettingsSheet = Boolean(
        showSettings && (
            sheetCollaborationSettings
            || sheetCopilotAgentModeSettings
            || sheetPermissionSettings
            || sheetCcSwitchSettings
            || sheetModelSettings
            || sheetModelEffortSettings
            || sheetModelReasoningEffortSettings
            || sheetEffortSettings
            || sheetResumeModelSettings
            || sheetFastModeSettings
        )
    )

    const sheetProps: ComposerSettingsSheetProps = {
        settingsOverlayRef,
        agentFlavor,
        controlsDisabled,
        modelEffortControlsDisabled,
        sheetModelSettings,
        sheetModelEffortSettings,
        sheetModelReasoningEffortSettings,
        sheetEffortSettings,
        sheetResumeModelSettings,
        sheetPermissionSettings,
        sheetCcSwitchSettings,
        sheetFastModeSettings,
        sheetCollaborationSettings,
        sheetCopilotAgentModeSettings,
        onRefreshModels,
        modelsRefreshing,
        modelsError,
        modelOptions,
        piModelGroups,
        piSelectedModel,
        model,
        selectedModelBase,
        selectedModelVariant,
        resolveModelVariantsForBase,
        handleModelChange,
        handleCursorModelRowClick,
        showCustomModelInput,
        customModelDraft,
        setCustomModelDraft,
        handleCustomModelSubmit,
        resumeWithSessionModel,
        handleResumeWithSessionModelChange,
        visibleModelEffortOptions,
        cursorDrillDownDefaultVariant,
        cursorVariantDrillDownActive,
        cursorDrillDownBase,
        clearCursorDrillDown,
        handleModelEffortChange,
        codexReasoningEffortOptions,
        modelReasoningEffort,
        handleModelReasoningEffortChange,
        claudeEffortOptions,
        effort,
        handleEffortChange,
        permissionModeOptions,
        permissionMode,
        handlePermissionChange,
        ccSwitchProviders,
        currentCcSwitchProviderId,
        handleCcSwitchProviderChange,
        fastModeOptions,
        displayedServiceTier,
        handleServiceTierChange,
        collaborationModeOptions,
        collaborationMode,
        handleCollaborationChange,
        copilotAgentModeOptions,
        copilotAgentMode,
        handleCopilotAgentModeChange,
    }

    return {
        showSettings,
        settingsSection,
        settingsButtonRef,
        modelValueButtonRef,
        effortValueButtonRef,
        permissionModes,
        showSettingsButton,
        isNarrowViewport,
        modelEffortControlsDisabled,
        modelValueLabel,
        effortValueLabel,
        handleGearToggle,
        handleModelValueToggle,
        handleEffortValueToggle,
        hasVisibleSettingsSheet,
        sheetProps,
    }
}

export interface ComposerModelOption {
    value: string | null
    label: string
    description?: string
}

export interface PiProviderModelGroup {
    provider: string
    label: string
    models: PiModelSummary[]
}

export interface ComposerModeOption<TMode extends string> {
    mode: TMode
    label: string
    description?: string
}

export interface ComposerSettingsSheetProps {
    overlayPositionClass?: string
    settingsOverlayRef: RefObject<HTMLDivElement | null>
    agentFlavor: string | null
    controlsDisabled: boolean
    modelEffortControlsDisabled: boolean
    sheetModelSettings: boolean
    sheetModelEffortSettings: boolean
    sheetModelReasoningEffortSettings: boolean
    sheetEffortSettings: boolean
    sheetResumeModelSettings: boolean
    sheetPermissionSettings: boolean
    sheetCcSwitchSettings: boolean
    sheetFastModeSettings: boolean
    sheetCollaborationSettings: boolean
    sheetCopilotAgentModeSettings: boolean
    onRefreshModels?: () => void
    modelsRefreshing: boolean
    modelsError: string | null
    modelOptions: ReadonlyArray<ComposerModelOption>
    piModelGroups: ReadonlyArray<PiProviderModelGroup> | null
    piSelectedModel?: { provider: string; modelId: string } | null
    model: string | null
    selectedModelBase?: string | null
    selectedModelVariant?: string | null
    resolveModelVariantsForBase?: (baseKey: string) => readonly ModelEffortOption[]
    handleModelChange: (model: SessionModelSelection) => void
    handleCursorModelRowClick: (model: string | null) => void
    showCustomModelInput: boolean
    customModelDraft: string
    setCustomModelDraft: (draft: string) => void
    handleCustomModelSubmit: () => void
    resumeWithSessionModel: boolean
    handleResumeWithSessionModelChange: () => void
    visibleModelEffortOptions?: readonly ModelEffortOption[] | null
    cursorDrillDownDefaultVariant: string | null
    cursorVariantDrillDownActive: boolean
    cursorDrillDownBase: string | null
    clearCursorDrillDown: () => void
    handleModelEffortChange: (wireId: string | null) => void
    codexReasoningEffortOptions: ReadonlyArray<ComposerModelOption>
    modelReasoningEffort: string | null
    handleModelReasoningEffortChange: (effort: string | null) => void
    claudeEffortOptions: Array<{ value: string | null; label: string }>
    effort: string | null
    handleEffortChange: (effort: string | null) => void
    permissionModeOptions: ReadonlyArray<ComposerModeOption<PermissionMode>>
    permissionMode: PermissionMode
    handlePermissionChange: (mode: PermissionMode) => void
    ccSwitchProviders?: Array<{ id: string; name: string; isCurrent: boolean }>
    currentCcSwitchProviderId?: string | null
    handleCcSwitchProviderChange: (providerId: string) => void
    fastModeOptions: Array<{ value: string; label: string }>
    displayedServiceTier: string | null
    handleServiceTierChange: (tier: string | null) => void
    collaborationModeOptions: ReadonlyArray<ComposerModeOption<CodexCollaborationMode>>
    collaborationMode: CodexCollaborationMode
    handleCollaborationChange: (mode: CodexCollaborationMode) => void
    copilotAgentModeOptions: ReadonlyArray<ComposerModeOption<CopilotAgentMode>>
    copilotAgentMode: CopilotAgentMode
    handleCopilotAgentModeChange: (mode: CopilotAgentMode) => void
}

export function ComposerSettingsSheet(props: ComposerSettingsSheetProps) {
    const { t } = useTranslation()
    const {
        overlayPositionClass = 'absolute z-10 bottom-[100%] mb-2',
        settingsOverlayRef,
        agentFlavor,
        controlsDisabled,
        modelEffortControlsDisabled,
        sheetModelSettings,
        sheetModelEffortSettings,
        sheetModelReasoningEffortSettings,
        sheetEffortSettings,
        sheetResumeModelSettings,
        sheetPermissionSettings,
        sheetCcSwitchSettings,
        sheetFastModeSettings,
        sheetCollaborationSettings,
        sheetCopilotAgentModeSettings,
        onRefreshModels,
        modelsRefreshing,
        modelsError,
        modelOptions,
        piModelGroups,
        piSelectedModel,
        model,
        selectedModelBase,
        selectedModelVariant,
        resolveModelVariantsForBase,
        handleModelChange,
        handleCursorModelRowClick,
        showCustomModelInput,
        customModelDraft,
        setCustomModelDraft,
        handleCustomModelSubmit,
        resumeWithSessionModel,
        handleResumeWithSessionModelChange,
        visibleModelEffortOptions,
        cursorDrillDownDefaultVariant,
        cursorVariantDrillDownActive,
        cursorDrillDownBase,
        clearCursorDrillDown,
        handleModelEffortChange,
        codexReasoningEffortOptions,
        modelReasoningEffort,
        handleModelReasoningEffortChange,
        claudeEffortOptions,
        effort,
        handleEffortChange,
        permissionModeOptions,
        permissionMode,
        handlePermissionChange,
        ccSwitchProviders,
        currentCcSwitchProviderId,
        handleCcSwitchProviderChange,
        fastModeOptions,
        displayedServiceTier,
        handleServiceTierChange,
        collaborationModeOptions,
        collaborationMode,
        handleCollaborationChange,
        copilotAgentModeOptions,
        copilotAgentMode,
        handleCopilotAgentModeChange,
    } = props

    const sheetModelAreaSettings =
        sheetModelSettings
        || sheetModelEffortSettings
        || sheetModelReasoningEffortSettings
        || sheetEffortSettings
        || sheetResumeModelSettings
    const sheetOtherSettings =
        sheetFastModeSettings
        || sheetCollaborationSettings
        || sheetCopilotAgentModeSettings
        || sheetCcSwitchSettings

    return (
        <div ref={settingsOverlayRef} className={`${overlayPositionClass} w-full`}>
            <FloatingOverlay maxHeight={320}>
                {sheetModelSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                            {t('misc.model')}
                        </div>
                        {onRefreshModels ? (
                            <OmpModelRefreshRow
                                refreshing={modelsRefreshing}
                                error={modelsError}
                                empty={modelOptions.length === 0}
                                disabled={controlsDisabled}
                                onRefresh={onRefreshModels}
                            />
                        ) : null}
                        {agentFlavor === 'pi'
                            ? piModelGroups?.map((group) => (
                                <div key={group.provider}>
                                    <div className="px-3 pt-2 pb-0.5 text-xs font-medium text-[var(--app-hint)]">
                                        {group.label}
                                    </div>
                                    {group.models.map((piModel) => {
                                        const piRowSelected = piSelectedModel
                                            ? piSelectedModel.provider === piModel.provider
                                                && piSelectedModel.modelId === piModel.modelId
                                            : model === piModel.modelId
                                        return (
                                            <button
                                                key={`${piModel.provider}:${piModel.modelId}`}
                                                type="button"
                                                disabled={modelEffortControlsDisabled}
                                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                                    modelEffortControlsDisabled
                                                        ? 'cursor-not-allowed opacity-50'
                                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                                }`}
                                                onClick={() => handleModelChange({ provider: piModel.provider, modelId: piModel.modelId })}
                                                onMouseDown={(e) => e.preventDefault()}
                                            >
                                                <div
                                                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                        piRowSelected
                                                            ? 'border-[var(--app-link)]'
                                                            : 'border-[var(--app-hint)]'
                                                    }`}
                                                >
                                                    {piRowSelected && (
                                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                                    )}
                                                </div>
                                                <span className={piRowSelected ? 'text-[var(--app-link)]' : ''}>
                                                    {piModel.name ?? piModel.modelId}
                                                </span>
                                            </button>
                                        )
                                    })}
                                </div>
                            ))
                            : modelOptions.map((option) => {
                                const isSelected = selectedModelBase !== undefined
                                    ? selectedModelBase === option.value
                                    : model === option.value
                                return (
                                    <button
                                        key={option.value ?? 'auto'}
                                        type="button"
                                        disabled={modelEffortControlsDisabled}
                                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                            modelEffortControlsDisabled
                                                ? 'cursor-not-allowed opacity-50'
                                                : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                        }`}
                                        onClick={() => {
                                            if (resolveModelVariantsForBase) {
                                                handleCursorModelRowClick(option.value)
                                            } else {
                                                handleModelChange(option.value)
                                            }
                                        }}
                                        onMouseDown={(e) => e.preventDefault()}
                                    >
                                        <div
                                            className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                                isSelected
                                                    ? 'border-[var(--app-link)]'
                                                    : 'border-[var(--app-hint)]'
                                            }`}
                                        >
                                            {isSelected && (
                                                <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                            )}
                                        </div>
                                        <span className={isSelected ? 'text-[var(--app-link)]' : ''}>
                                            {option.label}
                                        </span>
                                    </button>
                                )
                            })}
                        {showCustomModelInput ? (
                            <div className="flex items-center gap-2 px-3 py-2">
                                <button
                                    type="button"
                                    role="radio"
                                    aria-checked={Boolean(model && !isListedClaudeModel(model))}
                                    aria-label={t('composer.customModel')}
                                    disabled={controlsDisabled}
                                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                                        model && !isListedClaudeModel(model)
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                    onClick={handleCustomModelSubmit}
                                    onMouseDown={(event) => event.preventDefault()}
                                >
                                    {model && !isListedClaudeModel(model) ? (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    ) : null}
                                </button>
                                <input
                                    type="text"
                                    value={customModelDraft}
                                    disabled={controlsDisabled}
                                    spellCheck={false}
                                    autoCapitalize="off"
                                    autoCorrect="off"
                                    aria-label={t('composer.customModel')}
                                    placeholder={t('composer.customModelPlaceholder')}
                                    data-testid="custom-model-input"
                                    className="min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)]"
                                    onChange={(event) => setCustomModelDraft(event.target.value)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') {
                                            event.preventDefault()
                                            handleCustomModelSubmit()
                                        }
                                    }}
                                />
                            </div>
                        ) : null}
                    </div>
                ) : null}

                {sheetResumeModelSettings ? (
                    <div className="py-2">
                        <button
                            type="button"
                            role="checkbox"
                            aria-checked={resumeWithSessionModel}
                            disabled={controlsDisabled}
                            className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                controlsDisabled
                                    ? 'cursor-not-allowed opacity-50'
                                    : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                            }`}
                            onClick={handleResumeWithSessionModelChange}
                            onMouseDown={(e) => e.preventDefault()}
                        >
                            <div
                                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 ${
                                    resumeWithSessionModel
                                        ? 'border-[var(--app-link)] bg-[var(--app-link)] text-[var(--app-bg)]'
                                        : 'border-[var(--app-hint)]'
                                }`}
                            >
                                {resumeWithSessionModel ? (
                                    <span className="text-[10px] leading-none">✓</span>
                                ) : null}
                            </div>
                            <span className={resumeWithSessionModel ? 'text-[var(--app-link)]' : ''}>
                                <span className="block">{t('misc.resumeWithSessionModel')}</span>
                                <span className="block text-xs text-[var(--app-hint)]">
                                    {t('misc.resumeWithSessionModelHint')}
                                </span>
                            </span>
                        </button>
                    </div>
                ) : null}

                {sheetModelSettings && sheetModelEffortSettings ? (
                    <div className="mx-3 h-px bg-[var(--app-divider)]" />
                ) : null}

                {sheetModelEffortSettings ? (
                    <ModelEffortSettingsSection
                        agentFlavor={agentFlavor}
                        options={[...(visibleModelEffortOptions ?? [])]}
                        selectedValue={resolveVisibleModelEffortSelectedValue({
                            options: visibleModelEffortOptions,
                            selectedModelVariant,
                            cursorDrillDownDefaultVariant,
                            model,
                        })}
                        controlsDisabled={controlsDisabled}
                        onChange={handleModelEffortChange}
                        title={cursorVariantDrillDownActive && cursorDrillDownBase
                            ? cursorDrillDownBase
                            : undefined}
                        onBack={cursorVariantDrillDownActive ? clearCursorDrillDown : undefined}
                    />
                ) : null}

                {(sheetModelSettings || sheetModelEffortSettings) && sheetModelReasoningEffortSettings ? (
                    <div className="mx-3 h-px bg-[var(--app-divider)]" />
                ) : null}

                {sheetModelReasoningEffortSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                            {t('misc.reasoningEffort')}
                        </div>
                        {codexReasoningEffortOptions.map((option) => (
                            <button
                                key={option.value ?? 'default'}
                                type="button"
                                disabled={controlsDisabled}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                    controlsDisabled
                                        ? 'cursor-not-allowed opacity-50'
                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                }`}
                                onClick={() => handleModelReasoningEffortChange(option.value)}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <div
                                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                        modelReasoningEffort === option.value
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                >
                                    {modelReasoningEffort === option.value && (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    )}
                                </div>
                                <span className={modelReasoningEffort === option.value ? 'text-[var(--app-link)]' : ''}>
                                    {option.label}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}

                {sheetModelReasoningEffortSettings && sheetEffortSettings ? (
                    <div className="mx-3 h-px bg-[var(--app-divider)]" />
                ) : null}

                {sheetEffortSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                            {t('misc.effort')}
                        </div>
                        {claudeEffortOptions.map((option) => (
                            <button
                                key={option.value ?? 'auto'}
                                type="button"
                                disabled={modelEffortControlsDisabled}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                    modelEffortControlsDisabled
                                        ? 'cursor-not-allowed opacity-50'
                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                }`}
                                onClick={() => handleEffortChange(
                                    agentFlavor === 'pi' && effort === option.value ? null : option.value
                                )}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <div
                                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                        effort === option.value
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                >
                                    {effort === option.value && (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    )}
                                </div>
                                <span className={effort === option.value ? 'text-[var(--app-link)]' : ''}>
                                    {option.label}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}

                {agentFlavor === 'omp' ? (
                    <div className="border-t border-[var(--app-divider)] px-3 py-2 text-xs text-[var(--app-hint)]">
                        {t('misc.ompClaudeOnly')}
                    </div>
                ) : null}

                {sheetModelAreaSettings && sheetPermissionSettings ? (
                    <div className="mx-3 h-px bg-[var(--app-divider)]" />
                ) : null}

                {sheetPermissionSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                            {t('misc.permissionMode')}
                        </div>
                        {permissionModeOptions.map((option) => (
                            <button
                                key={option.mode}
                                type="button"
                                disabled={controlsDisabled}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                    controlsDisabled
                                        ? 'cursor-not-allowed opacity-50'
                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                }`}
                                onClick={() => handlePermissionChange(option.mode)}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <div
                                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                        permissionMode === option.mode
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                >
                                    {permissionMode === option.mode && (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    )}
                                </div>
                                <span className={permissionMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                    {option.label}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}

                {sheetCcSwitchSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">{t('misc.provider')}</div>
                        {ccSwitchProviders!.map((provider) => {
                            const selected = currentCcSwitchProviderId === provider.id
                            return (
                                <button key={provider.id} type="button" disabled={controlsDisabled}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--app-secondary-bg)] disabled:opacity-50"
                                    onClick={() => handleCcSwitchProviderChange(provider.id)} onMouseDown={(event) => event.preventDefault()}>
                                    <span className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${selected ? 'border-[var(--app-link)]' : 'border-[var(--app-hint)]'}`}>
                                        {selected ? <span className="h-2 w-2 rounded-full bg-[var(--app-link)]" /> : null}
                                    </span>
                                    <span className={selected ? 'text-[var(--app-link)]' : ''}>{provider.name}</span>
                                </button>
                            )
                        })}
                    </div>
                ) : null}

                {(sheetPermissionSettings || sheetModelAreaSettings) && sheetOtherSettings ? (
                    <div className="mx-3 h-px bg-[var(--app-divider)]" />
                ) : null}

                {sheetFastModeSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                            {t('misc.fastMode')}
                        </div>
                        {fastModeOptions.map((option) => (
                            <button
                                key={option.value ?? 'standard'}
                                type="button"
                                disabled={controlsDisabled}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                    controlsDisabled
                                        ? 'cursor-not-allowed opacity-50'
                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                }`}
                                onClick={() => handleServiceTierChange(option.value)}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <div
                                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                        displayedServiceTier === option.value
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                >
                                    {displayedServiceTier === option.value && (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    )}
                                </div>
                                <span className={displayedServiceTier === option.value ? 'text-[var(--app-link)]' : ''}>
                                    {option.label}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}

                {sheetFastModeSettings && (sheetCollaborationSettings || sheetCopilotAgentModeSettings) ? (
                    <div className="mx-3 h-px bg-[var(--app-divider)]" />
                ) : null}

                {sheetCollaborationSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                            {t('misc.collaborationMode')}
                        </div>
                        {collaborationModeOptions.map((option) => (
                            <button
                                key={option.mode}
                                type="button"
                                disabled={controlsDisabled}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                    controlsDisabled
                                        ? 'cursor-not-allowed opacity-50'
                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                }`}
                                onClick={() => handleCollaborationChange(option.mode)}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <div
                                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                        collaborationMode === option.mode
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                >
                                    {collaborationMode === option.mode && (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    )}
                                </div>
                                <span className={collaborationMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                    {option.label}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}

                {sheetCopilotAgentModeSettings ? (
                    <div className="py-2">
                        <div className="px-3 pb-1 text-xs font-semibold text-[var(--app-hint)]">
                            {t('misc.copilotAgentMode')}
                        </div>
                        {copilotAgentModeOptions.map((option) => (
                            <button
                                key={option.mode}
                                type="button"
                                disabled={controlsDisabled}
                                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                                    controlsDisabled
                                        ? 'cursor-not-allowed opacity-50'
                                        : 'cursor-pointer hover:bg-[var(--app-secondary-bg)]'
                                }`}
                                onClick={() => handleCopilotAgentModeChange(option.mode)}
                                onMouseDown={(e) => e.preventDefault()}
                            >
                                <div
                                    className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${
                                        copilotAgentMode === option.mode
                                            ? 'border-[var(--app-link)]'
                                            : 'border-[var(--app-hint)]'
                                    }`}
                                >
                                    {copilotAgentMode === option.mode && (
                                        <div className="h-2 w-2 rounded-full bg-[var(--app-link)]" />
                                    )}
                                </div>
                                <span className={copilotAgentMode === option.mode ? 'text-[var(--app-link)]' : ''}>
                                    {option.label}
                                </span>
                            </button>
                        ))}
                    </div>
                ) : null}
            </FloatingOverlay>
        </div>
    )
}
