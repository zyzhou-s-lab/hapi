import { resolve } from 'node:path'

const web = '/Users/zyzhou./software/hapi/wt-worklines/web'
const rgl = '/Users/zyzhou./software/hapi/wt-worklines/node_modules/.bun/react-grid-layout@2.3.0+67f6792bdf102c28/node_modules/react-grid-layout'
const preview = '/Users/zyzhou./software/hapi/wt-worklines/web/grid-demo'
const radix = '/Users/zyzhou./software/hapi/wt-worklines/website/node_modules/@radix-ui/react-toggle-group'
const bun = '/Users/zyzhou./software/hapi/wt-worklines/node_modules/.bun'
export default {
    root: web,
    cacheDir: '/tmp/grid-demo-vite-cache',
    esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
    plugins: [
        {
            name: 'preview-index',
            configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
                server.middlewares.use((req, _res, next) => {
                    const url = (req.url ?? '').split('?')[0]
                    if (url === '/' || url === '/index.html') req.url = `/@fs${preview}/index.html`
                    next()
                })
            },
        },
    ],
    resolve: {
        alias: [
            { find: 'react-grid-layout', replacement: rgl },
            { find: '@radix-ui/react-toggle-group', replacement: radix },
            { find: '@', replacement: resolve(web, 'src') },
        ],
        dedupe: ['react', 'react-dom'],
    },
    server: {
        host: '127.0.0.1',
        port: 5197,
        strictPort: true,
        fs: { allow: [web, preview, rgl, radix, bun, '/tmp'] },
    },
}
