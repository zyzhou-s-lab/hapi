import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { ClaudeDesktopAlignmentDemo } from '../src/components/AssistantChat/messages/ClaudeDesktopAlignmentDemo'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <I18nProvider>
            <ClaudeDesktopAlignmentDemo />
        </I18nProvider>
    </React.StrictMode>
)
