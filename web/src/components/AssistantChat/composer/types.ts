import type {
    CodexCollaborationMode,
    CopilotAgentMode,
    MessageDeliveryMode,
    OmpThinkingState,
    PermissionMode,
} from '@hapi/protocol'
import type { PiModelSummary } from '@/types/api'

export type SessionModelSelection = { provider: string; modelId: string } | string | null

export type ModelEffortOption = {
    value: string
    label: string
}

export type ComposerSettingsSection = 'model' | 'effort' | null

export type ComposerSendError = {
    id: number
    text: string
    message: string
    scheduledAt: number | null
    /** False for guards that reject before the underlying message mutation starts. */
    mutationStarted: boolean
    /** Wire mode retained for retry/error provenance; composer rendering is mode-agnostic. */
    deliveryMode?: MessageDeliveryMode
    /** True once the user has retried; retain UI but never restore this id again. */
    restoreSuppressed: boolean
    action?: {
        label: string
        onClick: () => void
        pending?: boolean
    } | null
}

export interface TextInputState {
    text: string
    selection: { start: number; end: number }
}

export interface SessionFlavorModelController {
    agentFlavor: string | null
    active: boolean
    controlledByUser: boolean
    codexCollaborationModeSupported: boolean
    codexModelsError: string | null
    effectiveCodexServiceTier: string | null | undefined
    piContextWindow: number | undefined
    // Mode & Permission
    permissionMode: PermissionMode | undefined
    onPermissionModeChange?: (mode: PermissionMode) => Promise<void> | void
    collaborationMode?: CodexCollaborationMode
    onCollaborationModeChange?: (mode: CodexCollaborationMode) => Promise<void> | void
    copilotAgentMode?: CopilotAgentMode
    onCopilotAgentModeChange?: (mode: CopilotAgentMode) => Promise<void> | void
    // Model & Variant
    model?: string | null
    selectedModelBase?: string | null
    selectedModelVariant?: string | null
    availableModelOptions?: Array<{ value: string | null; label: string }>
    modelEffortOptions?: Array<{ value: string; label: string }>
    resolveModelVariantsForBase?: (baseKey: string) => readonly { value: string; label: string }[]
    piModels?: PiModelSummary[]
    piSelectedModel?: { provider: string; modelId: string } | null
    onModelChange?: (model: SessionModelSelection) => Promise<void> | void
    onCycleModel?: () => Promise<void> | void
    onRefreshModels?: () => Promise<void> | void
    modelsRefreshing?: boolean
    modelsError?: string | null
    ccSwitchProviders?: Array<{ id: string; name: string; isCurrent: boolean }>
    currentCcSwitchProviderId?: string | null
    onCcSwitchProviderChange?: (providerId: string) => void
    resumeWithSessionModel?: boolean
    onResumeWithSessionModelChange?: (enabled: boolean) => Promise<void> | void
    onModelEffortChange?: (wireId: string | null) => Promise<void> | void
    // Reasoning & Effort & Fast Tier
    modelReasoningEffort?: string | null
    availableModelReasoningEffortOptions?: Array<{ value: string; name?: string }>
    onModelReasoningEffortChange?: (modelReasoningEffort: string | null) => Promise<void> | void
    effort?: string | null
    availableEffortOptions?: Array<{ value: string; name?: string }>
    onEffortChange?: (effort: string | null) => Promise<void> | void
    ompThinkingState?: OmpThinkingState
    serviceTier?: string | null
    onServiceTierChange?: (serviceTier: string | null) => Promise<void> | void
    // Actions
    handleAbort: () => Promise<void>
    handleSwitchToRemote: () => Promise<void>
}
