// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import * as React from 'react'
import { cn } from '../lib/utils'
import { DynamicIcon, type IconName } from 'lucide-react/dynamic'
import { Sparkles } from 'lucide-react'

interface CategoryBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
    label: string
    iconName: string
    className?: string
}

/**
 * CategoryBadge — renders a lucide icon chosen dynamically by string name.
 *
 * Phase 8: switched from `import * as Icons from 'lucide-react'` (which
 * forced the entire ~1300-icon library into a shared chunk, ~690 KB) to
 * `DynamicIcon` from `lucide-react/dynamic`. `DynamicIcon` resolves each
 * icon via a dynamic import so only the icons actually requested at
 * runtime get loaded.
 *
 * Lucide's `IconName` type is the canonical kebab-case name (e.g. `"rocket"`,
 * `"file-text"`). For backward compat we also accept PascalCase by
 * converting it at the call boundary. Unknown names fall back to Sparkles.
 */
function pascalToKebab(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .toLowerCase()
}

export function CategoryBadge({
    label,
    iconName,
    className,
    ...props
}: CategoryBadgeProps) {
    const kebab = iconName.includes('-') ? iconName : pascalToKebab(iconName)

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-zinc-700/60 bg-surface-2/60 text-text-secondary",
                className
            )}
            {...props}
        >
            <DynamicIcon
                name={kebab as IconName}
                className="h-2.5 w-2.5"
                fallback={() => <Sparkles className="h-2.5 w-2.5" />}
            />
            {label}
        </span>
    )
}
