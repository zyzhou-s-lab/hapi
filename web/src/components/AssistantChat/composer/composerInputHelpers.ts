import type { PermissionMode } from '@hapi/protocol'
import { supportsModelChange } from '@hapi/protocol'
import { flushTapSync } from '@assistant-ui/tap'
import type {
    ChangeEvent as ReactChangeEvent,
    ClipboardEvent as ReactClipboardEvent,
    KeyboardEvent as ReactKeyboardEvent,
    MutableRefObject,
    RefObject,
    SyntheticEvent as ReactSyntheticEvent,
} from 'react'
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import type { ApiClient } from '@/api/client'
import type { RichComposerInputHandle } from '@/components/AssistantChat/RichComposerInput'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import { useActiveSuggestions } from '@/hooks/useActiveSuggestions'
import { useActiveWord } from '@/hooks/useActiveWord'
import { useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { useDictation } from '@/hooks/useDictation'
import { useVoiceInputPreferences } from '@/hooks/useVoiceInputPreferences'
import type { AttachmentDropPosition } from '@/lib/attachmentOrder'
import {
    moveAttachmentId,
    orderItemsById,
    reconcileAttachmentOrder,
} from '@/lib/attachmentOrder'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
import { markSkillUsed } from '@/lib/recent-skills'
import type { FueStatus } from '@/lib/use-fue'
import type { ConversationStatus } from '@/realtime/types'
import { applySuggestion } from '@/utils/applySuggestion'
import { getNextModelForFlavor } from '../modelOptions'
import type { ComposerSendError, SessionModelSelection, TextInputState } from './types'

export function getComposerEscapeAction(input: {
    hasSuggestions: boolean
    threadIsRunning: boolean
    isExpanded: boolean
}): 'clearSuggestions' | 'abort' | 'collapse' | null {
    if (input.hasSuggestions) return 'clearSuggestions'
    if (input.threadIsRunning) return 'abort'
    if (input.isExpanded) return 'collapse'
    return null
}

export type RichComposerBridgeApi = {
    composer: () => {
        setText: (text: string) => void
    }
}

/**
 * The custom rich contenteditable must follow ComposerPrimitive.Input's
 * synchronous composer-write contract. Kept separate so its callback identity
 * is stable across unrelated HappyComposer renders and directly testable.
 */
export function useRichComposerBridge(
    api: RichComposerBridgeApi,
    setInputState: (state: TextInputState) => void,
    sendError: ComposerSendError | null,
    onClearSendError?: () => void,
    onUserEdit?: () => void,
) {
    const onValueChange = useCallback((text: string) => {
        flushTapSync(() => {
            api.composer().setText(text)
        })
    }, [api])

    const onMirrorChange = useCallback((state: TextInputState) => {
        setInputState(state)
    }, [setInputState])

    const onEdit = useCallback(() => {
        onUserEdit?.()
        if (sendError && onClearSendError) onClearSendError()
    }, [sendError, onClearSendError, onUserEdit])

    return { onValueChange, onMirrorChange, onEdit }
}

/** True when composer text/attachment ids match a pre-park snapshot. */
export function composerParkSnapshotUnchanged(
    snapshot: { text: string; attachments: readonly { id: string }[] },
    current: { text: string; attachments: readonly { id: string }[] },
): boolean {
    return current.text === snapshot.text
        && current.attachments.length === snapshot.attachments.length
        && current.attachments.every(
            (attachment, index) => attachment.id === snapshot.attachments[index]?.id,
        )
}

export function useOrderedComposerAttachments<T extends { id: string }>(
    attachments: readonly T[],
    externalAttachmentOrderRef?: MutableRefObject<string[]>,
) {
    const localAttachmentOrderRef = useRef<string[]>([])
    const attachmentOrderRef = externalAttachmentOrderRef ?? localAttachmentOrderRef
    const attachmentIds = useMemo(
        () => attachments.map((attachment) => attachment.id),
        [attachments],
    )
    const orderedAttachmentIds = reconcileAttachmentOrder(attachmentOrderRef.current, attachmentIds)
    attachmentOrderRef.current = orderedAttachmentIds
    const [, setAttachmentOrderRevision] = useState(0)
    const handleAttachmentReorder = useCallback((activeId: string, targetId: string, position: AttachmentDropPosition) => {
        const currentOrder = reconcileAttachmentOrder(attachmentOrderRef.current, attachmentIds)
        const nextOrder = moveAttachmentId(currentOrder, activeId, targetId, position)
        if (nextOrder.every((id, index) => id === currentOrder[index])) return
        attachmentOrderRef.current = nextOrder
        setAttachmentOrderRevision((revision) => revision + 1)
    }, [attachmentIds, attachmentOrderRef])
    const orderedAttachments = orderItemsById(attachments, orderedAttachmentIds)
    return {
        attachmentOrderRef,
        orderedAttachmentIds,
        orderedAttachments,
        handleAttachmentReorder,
    }
}

export function useComposerDictationController(params: {
    api: { composer: () => { setText: (text: string) => void } }
    composerText: string
    voiceTranscriptionApi?: ApiClient
    voiceStatus: ConversationStatus
    onVoiceToggle?: () => void
}) {
    const {
        api,
        composerText,
        voiceTranscriptionApi,
        voiceStatus,
        onVoiceToggle,
    } = params
    const composerTextRef = useRef(composerText)
    composerTextRef.current = composerText
    const getCurrentComposerText = useCallback(() => composerTextRef.current, [])
    const setComposerText = useCallback((text: string) => api.composer().setText(text), [api])
    const voiceInput = useVoiceInputPreferences(voiceTranscriptionApi ?? null)
    const dictationConfig = useMemo(() => ({
        api: voiceTranscriptionApi ?? null,
        provider: voiceInput.provider,
        mode: voiceInput.transcriptionMode,
        getCurrentText: getCurrentComposerText,
        onTextChange: setComposerText,
    }), [
        voiceTranscriptionApi,
        voiceInput.provider,
        voiceInput.transcriptionMode,
        getCurrentComposerText,
        setComposerText,
    ])
    const dictation = useDictation(dictationConfig)
    const dictationActive = voiceInput.voiceMode === 'dictation'
    const effectiveVoiceStatus = dictationActive ? dictation.status : voiceStatus
    const effectiveVoiceToggle = dictationActive
        ? (dictation.supported ? dictation.toggle : undefined)
        : onVoiceToggle
    const previousVoiceModeRef = useRef(voiceInput.voiceMode)
    useEffect(() => {
        if (previousVoiceModeRef.current === voiceInput.voiceMode) return
        previousVoiceModeRef.current = voiceInput.voiceMode
        if (dictationActive && (voiceStatus === 'connected' || voiceStatus === 'connecting')) {
            onVoiceToggle?.()
        } else if (!dictationActive && (dictation.status === 'connected' || dictation.status === 'connecting')) {
            void dictation.toggle()
        }
    }, [dictationActive, voiceInput.voiceMode, voiceStatus, onVoiceToggle, dictation.status, dictation.toggle])

    return {
        dictation,
        dictationActive,
        effectiveVoiceStatus,
        effectiveVoiceToggle,
    }
}

export interface UseComposerKeyboardAndInputHandlersParams {
    api: {
        composer: () => {
            setText: (text: string) => void
            addAttachment: (file: File) => Promise<void>
        }
    }
    composerText: string
    richMentionsEnabled: boolean
    textareaRef: RefObject<HTMLTextAreaElement | null>
    richInputRef: RefObject<RichComposerInputHandle | null>
    autocompletePrefixes: string[]
    autocompleteSuggestions: (query: string) => Promise<Suggestion[]>
    isExpanded: boolean
    isExpandedRef: MutableRefObject<boolean>
    setExpanded: (next: boolean) => void
    setShowContinueHint: (next: boolean) => void
    canSend: boolean
    flushAndSend: (intent?: ComposerSendIntent) => void
    threadIsRunning: boolean
    handleAbort: () => void
    richComposerFueStatus: FueStatus
    dismissRichComposerFue: () => void
    permissionMode: PermissionMode
    permissionModes: readonly PermissionMode[]
    onPermissionModeChange?: (mode: PermissionMode) => Promise<void> | void
    agentFlavor?: string | null
    model: string | null
    availableModelOptions?: Array<{ value: string | null; label: string }>
    onModelChange?: (model: SessionModelSelection) => Promise<void> | void
    onCycleModel?: () => Promise<void> | void
    pendingSchedule: PendingSchedule | null
    sendError: ComposerSendError | null
    onClearSendError?: () => void
    recordUserEdit: () => void
    handleUserEdit: () => void
    haptic: (type?: 'light' | 'success' | 'error') => void
}

export function useComposerKeyboardAndInputHandlers(
    params: UseComposerKeyboardAndInputHandlersParams,
) {
    const {
        api,
        composerText,
        richMentionsEnabled,
        textareaRef,
        richInputRef,
        autocompletePrefixes,
        autocompleteSuggestions,
        isExpanded,
        isExpandedRef,
        setExpanded,
        setShowContinueHint,
        canSend,
        flushAndSend,
        threadIsRunning,
        handleAbort,
        richComposerFueStatus,
        dismissRichComposerFue,
        permissionMode,
        permissionModes,
        onPermissionModeChange,
        agentFlavor,
        model,
        availableModelOptions,
        onModelChange,
        onCycleModel,
        pendingSchedule,
        sendError,
        onClearSendError,
        recordUserEdit,
        handleUserEdit,
        haptic,
    } = params

    const { composerEnterBehavior } = useComposerEnterBehavior()
    const [inputState, setInputState] = useState<TextInputState>({
        text: '',
        selection: { start: 0, end: 0 },
    })

    const {
        onValueChange: handleRichValueChange,
        onMirrorChange: handleRichMirrorChange,
        onEdit: handleRichEdit,
    } = useRichComposerBridge(api, setInputState, sendError, onClearSendError, recordUserEdit)

    useEffect(() => {
        if (richMentionsEnabled) {
            return
        }
        setInputState((prev) => {
            if (prev.text === composerText) return prev
            const newPos = composerText.length
            return { text: composerText, selection: { start: newPos, end: newPos } }
        })
    }, [composerText, richMentionsEnabled])

    const activeWord = useActiveWord(inputState.text, inputState.selection, autocompletePrefixes)
    const [suggestions, selectedIndex, moveUp, moveDown, clearSuggestions] = useActiveSuggestions(
        activeWord,
        autocompleteSuggestions,
        { clampSelection: true, wrapAround: true },
    )

    const handleExpandedToggle = useCallback(() => {
        const currentInput = textareaRef.current
        const selection = currentInput ? {
            start: currentInput.selectionStart,
            end: currentInput.selectionEnd,
            direction: currentInput.selectionDirection,
        } : null

        setExpanded(!isExpandedRef.current)
        haptic('light')
        setTimeout(() => {
            if (richMentionsEnabled) {
                richInputRef.current?.focus()
                return
            }
            const input = textareaRef.current
            if (!input) return
            try {
                input.focus({ preventScroll: true })
            } catch {
                input.focus()
            }
            if (selection) {
                const maxOffset = input.value.length
                input.setSelectionRange(
                    Math.min(selection.start, maxOffset),
                    Math.min(selection.end, maxOffset),
                    selection.direction,
                )
            }
        }, 0)
    }, [haptic, isExpandedRef, richInputRef, richMentionsEnabled, setExpanded, textareaRef])

    const handleSuggestionSelect = useCallback((index: number) => {
        const suggestion = suggestions[index]
        if (!suggestion) return
        if (suggestion.text.startsWith('$')) {
            markSkillUsed(suggestion.text.slice(1))
        }

        handleUserEdit()

        if (richMentionsEnabled && richInputRef.current) {
            if (suggestion.sessionMention) {
                richInputRef.current.insertSessionMention(
                    suggestion.sessionMention,
                    autocompletePrefixes,
                )
            } else {
                richInputRef.current.applyPlainSuggestion(
                    suggestion.text,
                    autocompletePrefixes,
                )
            }
            setTimeout(() => {
                richInputRef.current?.focus()
            }, 0)
            haptic('light')
            return
        }

        if (!textareaRef.current) return

        const result = applySuggestion(
            inputState.text,
            inputState.selection,
            suggestion.text,
            autocompletePrefixes,
            true,
        )

        api.composer().setText(result.text)
        setInputState({
            text: result.text,
            selection: { start: result.cursorPosition, end: result.cursorPosition },
        })

        setTimeout(() => {
            const el = textareaRef.current
            if (!el) return
            el.setSelectionRange(result.cursorPosition, result.cursorPosition)
            try {
                el.focus({ preventScroll: true })
            } catch {
                el.focus()
            }
        }, 0)

        haptic('light')
    }, [api, suggestions, inputState, autocompletePrefixes, haptic, richInputRef, richMentionsEnabled, handleUserEdit, textareaRef])

    const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLTextAreaElement | HTMLDivElement>) => {
        const key = e.key

        if (e.nativeEvent.isComposing || e.keyCode === 229) {
            return
        }

        if (key === 'Enter' && e.shiftKey) {
            return
        }

        if (key === 'Enter' && suggestions.length > 0) {
            e.preventDefault()
            const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
            handleSuggestionSelect(indexToSelect)
            return
        }

        if (key === 'Enter') {
            if (composerEnterBehavior === 'newline') {
                if ((e.ctrlKey || e.metaKey) && !e.altKey && canSend) {
                    e.preventDefault()
                    flushAndSend()
                    setShowContinueHint(false)
                }
                return
            }
            e.preventDefault()
            if (!e.ctrlKey && !e.altKey && !e.metaKey && canSend) {
                flushAndSend()
                setShowContinueHint(false)
            }
            return
        }

        if (suggestions.length > 0) {
            if (key === 'ArrowUp') {
                e.preventDefault()
                moveUp()
                return
            }
            if (key === 'ArrowDown') {
                e.preventDefault()
                moveDown()
                return
            }
            if (key === 'Tab' && !e.shiftKey) {
                e.preventDefault()
                const indexToSelect = selectedIndex >= 0 ? selectedIndex : 0
                handleSuggestionSelect(indexToSelect)
                return
            }
        }

        if (key === 'Escape') {
            if (richComposerFueStatus === 'engaging') {
                e.preventDefault()
                e.stopPropagation()
                dismissRichComposerFue()
                return
            }
            const action = getComposerEscapeAction({
                hasSuggestions: suggestions.length > 0,
                threadIsRunning,
                isExpanded,
            })
            if (action) {
                e.preventDefault()
                if (action === 'clearSuggestions') clearSuggestions()
                else if (action === 'abort') handleAbort()
                else handleExpandedToggle()
                return
            }
        }

        if (key === 'Tab' && e.shiftKey && onPermissionModeChange && permissionModes.length > 0) {
            e.preventDefault()
            const currentIndex = permissionModes.indexOf(permissionMode)
            const nextIndex = (currentIndex + 1) % permissionModes.length
            const nextMode = permissionModes[nextIndex] ?? 'default'
            void onPermissionModeChange(nextMode)
            haptic('light')
        }
    }, [
        suggestions,
        selectedIndex,
        moveUp,
        moveDown,
        clearSuggestions,
        handleSuggestionSelect,
        threadIsRunning,
        handleAbort,
        onPermissionModeChange,
        permissionMode,
        permissionModes,
        canSend,
        haptic,
        composerEnterBehavior,
        richComposerFueStatus,
        dismissRichComposerFue,
        flushAndSend,
        isExpanded,
        handleExpandedToggle,
        setShowContinueHint,
    ])

    useEffect(() => {
        const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
            if (agentFlavor === 'pi') return
            if (e.key === 'm' && (e.metaKey || e.ctrlKey) && (onCycleModel || onModelChange) && supportsModelChange(agentFlavor)) {
                e.preventDefault()
                if (onCycleModel) {
                    void onCycleModel()
                } else {
                    void onModelChange?.(getNextModelForFlavor(agentFlavor, model, availableModelOptions))
                }
                haptic('light')
            }
        }

        window.addEventListener('keydown', handleGlobalKeyDown)
        return () => window.removeEventListener('keydown', handleGlobalKeyDown)
    }, [model, onModelChange, onCycleModel, haptic, agentFlavor, availableModelOptions])

    const handleChange = useCallback((e: ReactChangeEvent<HTMLTextAreaElement>) => {
        const selection = {
            start: e.target.selectionStart,
            end: e.target.selectionEnd,
        }
        setInputState({ text: e.target.value, selection })
        handleUserEdit()
    }, [handleUserEdit])

    const handleSelect = useCallback((e: ReactSyntheticEvent<HTMLTextAreaElement>) => {
        const target = e.target as HTMLTextAreaElement
        setInputState((prev) => ({
            ...prev,
            selection: { start: target.selectionStart, end: target.selectionEnd },
        }))
    }, [])

    const handlePaste = useCallback(async (e: ReactClipboardEvent<HTMLTextAreaElement | HTMLDivElement>) => {
        const files = Array.from(e.clipboardData?.files || [])
        const imageFiles = files.filter((file) => file.type.startsWith('image/'))

        if (imageFiles.length === 0) return

        if (pendingSchedule != null) {
            e.preventDefault()
            return
        }

        e.preventDefault()

        try {
            for (const file of imageFiles) {
                await api.composer().addAttachment(file)
            }
        } catch (error) {
            console.error('Error adding pasted image:', error)
        }
    }, [api, pendingSchedule])

    return {
        suggestions,
        selectedIndex,
        handleRichValueChange,
        handleRichMirrorChange,
        handleRichEdit,
        handleExpandedToggle,
        handleSuggestionSelect,
        handleKeyDown,
        handleChange,
        handleSelect,
        handlePaste,
    }
}
