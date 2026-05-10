import { Code, MessageSquare, Database, Wrench, Globe, Shield, Cpu, Zap } from 'lucide-react'
import type { ElementType } from 'react'

export const CATEGORY_META: Record<string, { label: string; icon: ElementType; color: string }> = {
    automation: { label: 'Automation', icon: Zap, color: 'text-amber' },
    code: { label: 'Code', icon: Code, color: 'text-azure' },
    communication: { label: 'Communication', icon: MessageSquare, color: 'text-green-400' },
    data: { label: 'Data', icon: Database, color: 'text-purple-400' },
    devops: { label: 'DevOps', icon: Wrench, color: 'text-orange-400' },
    research: { label: 'Research', icon: Globe, color: 'text-cyan-400' },
    security: { label: 'Security', icon: Shield, color: 'text-red' },
    ai: { label: 'AI & ML', icon: Cpu, color: 'text-violet-400' },
    other: { label: 'Other', icon: Zap, color: 'text-text-muted' },
}
