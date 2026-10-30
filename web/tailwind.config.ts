import type { Config } from 'tailwindcss'

export default {
    content: ['./index.html', './src/**/*.{ts,tsx}'],
    theme: {
        extend: {
            screens: {
                // Dedicated split breakpoint for the sessions layout. Some compact
                // Android tablets (e.g. OPPO Pad mini) report a landscape CSS
                // viewport below Tailwind's `lg` (1024px) despite having enough
                // physical space, so they fall back to single-column. 920px lets
                // those tablets show the split view while staying clear of phone
                // landscape widths.
                split: '920px'
            },
            fontFamily: {
                sans: ['var(--app-font-sans)'],
                mono: ['var(--app-font-mono)']
            },
            fontWeight: {
                normal: 'var(--app-font-weight-regular)',
                medium: 'var(--app-font-weight-medium)',
                semibold: 'var(--app-font-weight-semibold)',
                bold: 'var(--app-font-weight-bold)'
            },
            fontSize: {
                xs: ['var(--app-font-size-meta)', { lineHeight: 'var(--app-line-meta)' }],
                sm: ['var(--app-font-size-nav)', { lineHeight: 'var(--app-line-nav)' }]
            },
            maxWidth: {
                content: 'var(--content-max-w, 960px)'
            }
        }
    },
    plugins: []
} satisfies Config

