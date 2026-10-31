import { AnimatePresence, LayoutGroup, MotionConfig, motion } from 'motion/react'
import * as ToggleGroup from '@radix-ui/react-toggle-group'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'

type Card = { id: string; run: string; metric: string; axis: string }
type CiteStyle = 'apa' | 'vancouver'

const sources = [
    {
        id: '1',
        apa: 'Smith, J., Lee, A., & Chen, R. (2024). Step-wise decay of validation loss. Journal of Training Dynamics, 12(3), 44–58.',
        vancouver: 'Smith J, Lee A, Chen R. Step-wise decay of validation loss. J Train Dyn. 2024;12(3):44–58.',
        apaCite: '(Smith et al., 2024)',
    },
    {
        id: '2',
        apa: 'Garcia, M. (2023). Learning-rate schedules for small scientific models. Proceedings of the Workshop on Experiment Logs, 9–17.',
        vancouver: 'Garcia M. Learning-rate schedules for small scientific models. Proc Workshop Exp Logs. 2023:9–17.',
        apaCite: '(Garcia, 2023)',
    },
]

const explorations = {
    'loss-exp': {
        name: '损失曲线',
        conjecture: '逐步减小学习率后，验证 loss 会在第 16 步附近再降一截，而不是一直平下去。',
        sessions: ['loss 第 12 步', 'loss 第 3 步'],
    },
    'lr-exp': {
        name: '学习率扫描',
        conjecture: '把最大学习率从 0.1 降到 0.01，前期震荡会消失，最终 loss 仍能到同一水平。',
        sessions: ['lr 对照'],
    },
}

const iconButton = 'flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]'

function PlusIcon(): ReactNode {
    return (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function TrashIcon(): ReactNode {
    return (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6" />
            <path d="M14 11v6" />
        </svg>
    )
}

function ColumnsIcon(props: { count: 1 | 2 | 3 }): ReactNode {
    return (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            {props.count === 3 ? <path d="M9 3v18M15 3v18" /> : null}
            {props.count === 2 ? <path d="M12 3v18" /> : null}
        </svg>
    )
}

function Chart(props: { points: number[] }): ReactNode {
    const d = props.points.map((value, index) => {
        const x = (index / (props.points.length - 1)) * 280
        const y = 88 - value * 80
        return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    }).join(' ')
    return (
        <svg viewBox="0 0 280 96" className="mt-2 h-24 w-full text-[var(--app-link)]" role="img">
            <path d={d} fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
    )
}

function pointsFor(metric: string): number[] {
    if (metric === 'lr') return Array.from({ length: 24 }, (_, step) => (step < 8 ? 0.9 : step < 16 ? 0.35 : 0.12))
    return Array.from({ length: 24 }, (_, step) => 1.05 * Math.exp(-(step + 1) / 8))
}

function Rail(props: { selected: string; onSelect: (id: string) => void }): ReactNode {
    return (
        <aside className="w-full shrink-0 border-b border-[var(--app-divider)] md:w-64 md:border-b-0 md:border-r">
            <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">探索</div>
            {Object.entries(explorations).map(([id, row]) => (
                <button
                    key={id}
                    type="button"
                    onClick={() => props.onSelect(id)}
                    className={`flex w-full items-center justify-between px-3 py-3 text-left text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] ${props.selected === id ? 'bg-[var(--app-subtle-bg)]' : ''}`}
                >
                    <span>{row.name}</span>
                    <span className="text-xs text-[var(--app-hint)]">{row.sessions.length}</span>
                </button>
            ))}
        </aside>
    )
}

function Verify(props: { cards: Card[]; columns: 1 | 2 | 3; onColumns: (value: 1 | 2 | 3) => void; onAdd: () => void; onDelete: (id: string) => void }): ReactNode {
    return (
        <MotionConfig transition={{ type: 'spring', duration: 0.35, bounce: 0 }}>
            <LayoutGroup>
                <section>
                    <div className="mb-2 flex items-center justify-between gap-2">
                        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">验证</h2>
                        <div className="flex items-center gap-1">
                            <ToggleGroup.Root
                                type="single"
                                value={String(props.columns)}
                                onValueChange={(value) => {
                                    if (value === '1' || value === '2' || value === '3') props.onColumns(Number(value) as 1 | 2 | 3)
                                }}
                                aria-label="每行列数"
                                className="relative grid grid-cols-3 rounded-lg bg-[var(--app-secondary-bg)] p-0.5"
                            >
                                {([3, 2, 1] as const).map((count) => (
                                    <ToggleGroup.Item
                                        key={count}
                                        value={String(count)}
                                        title={`每行${count}张`}
                                        aria-label={`每行${count}张`}
                                        className="relative z-10 flex h-8 w-8 items-center justify-center text-[var(--app-hint)] data-[state=on]:text-[var(--app-fg)]"
                                    >
                                        {props.columns === count ? (
                                            <motion.span
                                                layoutId="columns-thumb"
                                                aria-hidden="true"
                                                className="absolute inset-0 rounded-md border border-[var(--app-divider)] bg-[var(--app-bg)]"
                                            />
                                        ) : null}
                                        <span className="relative z-10">
                                            <ColumnsIcon count={count} />
                                        </span>
                                    </ToggleGroup.Item>
                                ))}
                            </ToggleGroup.Root>
                            <button type="button" title="加卡" className={iconButton} onClick={props.onAdd}>
                                <PlusIcon />
                            </button>
                        </div>
                    </div>
                    <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${props.columns}, minmax(0, 1fr))` }}>
                        <AnimatePresence mode="popLayout" initial={false}>
                            {props.cards.map((card) => (
                                <motion.article
                                    key={card.id}
                                    layout
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    exit={{ opacity: 0 }}
                                    className="min-w-0 rounded-lg border border-[var(--app-divider)] p-3"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <div className="text-sm font-medium text-[var(--app-fg)]">训练曲线</div>
                                            <div className="truncate text-xs text-[var(--app-hint)]">{card.run} · {card.metric} · X {card.axis}</div>
                                        </div>
                                        <button type="button" title="删卡" className={iconButton} onClick={() => props.onDelete(card.id)}>
                                            <TrashIcon />
                                        </button>
                                    </div>
                                    <Chart points={pointsFor(card.metric)} />
                                </motion.article>
                            ))}
                        </AnimatePresence>
                    </div>
                </section>
            </LayoutGroup>
        </MotionConfig>
    )
}


function Exploration(props: { id: string }): ReactNode {
    const seed = explorations[props.id as keyof typeof explorations]
    const [text, setText] = useState(seed.conjecture)
    const [style, setStyle] = useState<CiteStyle>('apa')
    const [columns, setColumns] = useState<1 | 2 | 3>(2)
    const [cards, setCards] = useState<Card[]>([
        { id: 'loss', run: 'exp-1', metric: 'loss', axis: 'step' },
        { id: 'lr', run: 'exp-1', metric: 'lr', axis: 'lr' },
    ])
    const frame = useRef<HTMLDivElement>(null)
    const [narrow, setNarrow] = useState(false)
    useEffect(() => {
        const element = frame.current
        if (!element) return
        const observer = new ResizeObserver(() => setNarrow(element.clientWidth < 640))
        observer.observe(element)
        setNarrow(element.clientWidth < 640)
        return () => observer.disconnect()
    }, [])
    const shown = narrow ? 1 : columns
    return (
        <div ref={frame} className="flex min-w-0 flex-1 flex-col gap-8 p-4">
            <section>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">猜想</h2>
                <textarea
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    rows={4}
                    className="mt-2 w-full resize-y rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm leading-6 text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                />
                <p className="mt-2 text-xs text-[var(--app-hint)]">
                    依据 {style === 'apa' ? sources[0].apaCite : '[1]'} 与 {style === 'apa' ? sources[1].apaCite : '[2]'}。
                </p>
            </section>
            <section>
                <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--app-hint)]">相关会话</h2>
                <ul className="mt-2">
                    {seed.sessions.map((title) => (
                        <li key={title}>
                            <a href={`#session-${encodeURIComponent(title)}`} className="block rounded-lg px-2.5 py-2 text-sm font-medium text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]">{title}</a>
                        </li>
                    ))}
                </ul>
            </section>
            <Verify
                cards={cards}
                columns={shown}
                onColumns={setColumns}
                onAdd={() => setCards((current) => [...current, { id: `card-${crypto.randomUUID()}`, run: 'exp-1', metric: 'acc', axis: 'step' }])}
                onDelete={(id) => setCards((current) => current.filter((card) => card.id !== id))}
            />
            <section>
                <div className="mb-3 flex items-end justify-between gap-3 border-b-[1.5px] border-[var(--app-fg)] pb-1">
                    <h2 className="text-base font-medium text-[var(--app-fg)]">参考资料</h2>
                    <div className="flex gap-3 text-xs">
                        <button type="button" className={style === 'apa' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'} onClick={() => setStyle('apa')}>APA7</button>
                        <button type="button" className={style === 'vancouver' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'} onClick={() => setStyle('vancouver')}>温哥华</button>
                    </div>
                </div>
                <div className="flex flex-col gap-2">
                    {sources.map((source) => (
                        <p key={source.id} id={`ref-${source.id}`} className="text-[0.92em] leading-snug text-[var(--app-hint)]">
                            [{source.id}]. {style === 'apa' ? source.apa : source.vancouver}
                        </p>
                    ))}
                </div>
            </section>
        </div>
    )
}

function Page(): ReactNode {
    const [selected, setSelected] = useState('loss-exp')
    return (
        <div className="flex min-h-screen flex-col bg-[var(--app-bg)] text-[var(--app-fg)]">
            <style>{'html, body, #root { height: auto !important; min-height: 100%; overflow: visible !important; }'}</style>
            <header className="border-b border-[var(--app-divider)] px-3 py-2 font-semibold">工作台</header>
            <div className="flex flex-col md:flex-row">
                <Rail selected={selected} onSelect={setSelected} />
                <Exploration key={selected} id={selected} />
            </div>
        </div>
    )
}

createRoot(document.getElementById('root')!).render(<Page />)
