import { cn } from '../lib/utils'

interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
    variant?: 'default' | 'success' | 'warning' | 'error' | 'info'
}

const variantClasses = {
    default: 'border-zinc-700 bg-zinc-800 text-zinc-300',
    success: 'border-emerald-800 bg-emerald-950 text-emerald-400',
    warning: 'border-amber-800 bg-amber-950 text-amber-400',
    error: 'border-red-800 bg-red-950 text-red-400',
    info: 'border-indigo-800 bg-indigo-950 text-indigo-400',
}

export function Badge({ className, variant = 'default', ...props }: BadgeProps) {
    return (
        <div
            className={cn(
                'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors',
                variantClasses[variant],
                className,
            )}
            {...props}
        />
    )
}
