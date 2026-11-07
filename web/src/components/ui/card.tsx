import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const cardVariants = cva('', {
    variants: {
        variant: {
            default: 'rounded-lg bg-[var(--app-secondary-bg)] shadow-sm',
            surface: 'rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3.5 py-2.5 shadow-2xs',
            dock: 'composer-dock-card rounded-lg',
        },
    },
    defaultVariants: {
        variant: 'default',
    },
})

export interface CardProps
    extends React.HTMLAttributes<HTMLDivElement>,
        VariantProps<typeof cardVariants> {}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
    ({ className, variant, ...props }, ref) => (
        <div
            ref={ref}
            className={cn(cardVariants({ variant }), className)}
            {...props}
        />
    )
)
Card.displayName = 'Card'

export function SmallChevron(props: { open: boolean; direction?: 'right' | 'up' | 'down'; className?: string }) {
    const baseRotation = props.direction === 'up' || props.direction === 'down'
        ? (props.open ? 'rotate-180' : 'rotate-0')
        : (props.open ? 'rotate-90' : 'rotate-0')
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn('shrink-0 transition-transform duration-150', baseRotation, props.className)}
            aria-hidden="true"
        >
            {props.direction === 'up' ? (
                <polyline points="18 15 12 9 6 15" />
            ) : props.direction === 'down' ? (
                <polyline points="6 9 12 15 18 9" />
            ) : (
                <polyline points="9 18 15 12 9 6" />
            )}
        </svg>
    )
}

export const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => (
        <div ref={ref} className={cn('flex flex-col space-y-1.5 p-4', className)} {...props} />
    )
)
CardHeader.displayName = 'CardHeader'

export const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
    ({ className, ...props }, ref) => (
        <h3
            ref={ref}
            className={cn('text-base font-semibold leading-none tracking-tight', className)}
            {...props}
        />
    )
)
CardTitle.displayName = 'CardTitle'

export const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
    ({ className, ...props }, ref) => (
        <p ref={ref} className={cn('text-sm text-[var(--app-hint)]', className)} {...props} />
    )
)
CardDescription.displayName = 'CardDescription'

export const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => (
        <div ref={ref} className={cn('p-4 pt-0', className)} {...props} />
    )
)
CardContent.displayName = 'CardContent'
