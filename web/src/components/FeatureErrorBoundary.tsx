import { Component, type ErrorInfo, type ReactNode } from 'react'

export interface FeatureErrorBoundaryProps {
    readonly name: string
    /**
     * Stable identity key (e.g. `${sessionId}:${subturnKey}`).
     * Must NOT include streaming text length or row count, so errors do not
     * auto-reset on every streaming chunk.
     */
    readonly resetKey?: string | number
    readonly fallbackTitle?: string
    readonly onReset?: () => void
    readonly children: ReactNode
}

interface FeatureErrorBoundaryState {
    readonly hasError: boolean
    readonly errorMessage: string | null
}

function sanitizeErrorSummary(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error ?? 'Render error')
    const singleLine = raw.replace(/\s+/g, ' ').trim()
    if (!singleLine) return 'Component failed to render'
    return singleLine.length > 140 ? `${singleLine.slice(0, 140)}…` : singleLine
}

/**
 * Lightweight slot-level React ErrorBoundary.
 *
 * In normal state (`hasError === false`), returns `this.props.children` directly
 * with zero extra wrapper DOM nodes so layout geometry, `.happy-thread-messages > [id]`,
 * and rail `getBoundingClientRect()` measurements remain unchanged.
 */
export class FeatureErrorBoundary extends Component<
    FeatureErrorBoundaryProps,
    FeatureErrorBoundaryState
> {
    override state: FeatureErrorBoundaryState = {
        hasError: false,
        errorMessage: null,
    }

    static getDerivedStateFromError(error: unknown): FeatureErrorBoundaryState {
        return {
            hasError: true,
            errorMessage: sanitizeErrorSummary(error),
        }
    }

    override componentDidCatch(error: Error, _errorInfo: ErrorInfo): void {
        // Log only bounded feature name + error type; never dump transcript or tokens.
        console.warn(`[FeatureErrorBoundary:${this.props.name}]`, error.name)
    }

    override componentDidUpdate(prevProps: FeatureErrorBoundaryProps): void {
        if (this.state.hasError && this.props.resetKey !== prevProps.resetKey) {
            this.setState({
                hasError: false,
                errorMessage: null,
            })
        }
    }

    private readonly handleRetry = (): void => {
        this.props.onReset?.()
        this.setState({
            hasError: false,
            errorMessage: null,
        })
    }

    override render(): ReactNode {
        if (!this.state.hasError) {
            return this.props.children
        }

        const label = this.props.fallbackTitle ?? this.props.name
        return (
            <div
                role="alert"
                data-testid={`feature-error-boundary-${this.props.name}`}
                data-feature-error-boundary={this.props.name}
                className="my-1.5 flex items-center justify-between gap-3 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-fg)]"
            >
                <div className="min-w-0 flex-1">
                    <div className="font-medium text-[var(--app-badge-error-text)]">
                        {label} unavailable
                    </div>
                    {this.state.errorMessage ? (
                        <div className="mt-0.5 truncate text-[11px] text-[var(--app-hint)]">
                            {this.state.errorMessage}
                        </div>
                    ) : null}
                </div>
                <button
                    type="button"
                    data-testid={`feature-error-retry-${this.props.name}`}
                    data-feature-error-retry={this.props.name}
                    onClick={this.handleRetry}
                    className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-fg)] transition-colors hover:bg-[var(--app-secondary-bg)]"
                >
                    Retry
                </button>
            </div>
        )
    }
}
