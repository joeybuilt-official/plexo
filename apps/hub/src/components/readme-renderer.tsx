import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function ReadmeRenderer({ content }: { content: string }) {
    if (!content) {
        return <p className="text-text-muted text-sm italic">No README provided.</p>
    }

    return (
        <div className="prose prose-invert prose-sm max-w-none
            prose-headings:text-text-primary prose-headings:font-display
            prose-p:text-text-secondary prose-a:text-azure prose-a:no-underline hover:prose-a:underline
            prose-code:text-azure prose-code:bg-surface-2 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono
            prose-pre:bg-surface-2 prose-pre:border prose-pre:border-border prose-pre:rounded-xl
            prose-strong:text-text-primary
            prose-li:text-text-secondary
            prose-table:text-text-secondary prose-th:text-text-primary
        ">
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </div>
    )
}
