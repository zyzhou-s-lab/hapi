import React from 'react'
import ReactDOM from 'react-dom/client'
import '../src/index.css'
import { I18nProvider } from '../src/lib/i18n-context'
import { TurnTimelineDemo } from '../src/components/AssistantChat/messages/TurnTimelineDemo'

ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <I18nProvider>
            <TurnTimelineDemo />
        </I18nProvider>
    </React.StrictMode>
)
