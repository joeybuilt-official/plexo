export type ModelCapability = 'text' | 'image' | 'voice' | 'video' | 'tools' | 'reasoning'

export const MODEL_CAPABILITIES: Record<string, ModelCapability[]> = {
    'claude-opus-4-5': ['text', 'image', 'tools'],
    'claude-sonnet-4-5': ['text', 'image', 'tools', 'reasoning'],
    'claude-haiku-4-5': ['text', 'image', 'tools'],
    'claude-opus-4-6': ['text', 'image', 'tools'],
    'claude-sonnet-4-6': ['text', 'image', 'tools', 'reasoning'],
    'gpt-4o': ['text', 'image', 'voice', 'tools'],
    'gpt-4o-mini': ['text', 'image', 'tools'],
    'o1': ['text', 'image', 'reasoning'],
    'o1-mini': ['text', 'reasoning'],
    'o3': ['text', 'reasoning'],
    'o3-mini': ['text', 'reasoning'],
    'gemini-1.5-flash-002': ['text', 'image', 'voice', 'video', 'tools'],
    'gemini-1.5-pro-002': ['text', 'image', 'voice', 'video', 'tools'],
    'gemini-2.0-flash-exp': ['text', 'image', 'voice', 'video', 'tools'],
    'gemini-1.5-flash-latest': ['text', 'image', 'voice', 'video', 'tools'],
    'llama-3.3-70b-versatile': ['text', 'tools'],
    'llama-3.1-8b-instant': ['text', 'tools'],
    'mixtral-8x7b-32768': ['text', 'tools'],
    'mistral-large-latest': ['text', 'tools'],
    'mistral-small-latest': ['text', 'tools'],
    'open-mistral-nemo': ['text', 'tools'],
    'deepseek-chat': ['text', 'tools'],
    'deepseek-reasoner': ['text', 'reasoning'],
    'grok-3': ['text', 'image', 'tools'],
    'grok-3-mini': ['text', 'image', 'tools'],
    'grok-2': ['text', 'image', 'tools'],
}

export function getModelCapabilities(modelName: string): ModelCapability[] {
    const directMatch = MODEL_CAPABILITIES[modelName]
    if (directMatch) return directMatch

    const defaultRegexMatches = Object.entries(MODEL_CAPABILITIES).find(([k]) => modelName.toLowerCase().includes(k))
    if (defaultRegexMatches) return defaultRegexMatches[1]

    // heuristics for dynamic or unknown models
    const caps: ModelCapability[] = ['text']
    const name = modelName.toLowerCase()

    if (name.includes('vision') || name.includes('vl') || name.includes('llava')) caps.push('image')
    if (name.includes('audio') || name.includes('whisper')) caps.push('voice')
    if (name.includes('instruct') || name.includes('chat')) caps.push('tools')
    if (name.includes('reason') || name.includes('r1') || name.includes('think')) caps.push('reasoning')

    return caps
}

export function recommendModelForInput(text: string, selectedModel: string): { suggestedModel: string; reason: string } | null {
    if (!text || !selectedModel) return null

    const input = text.toLowerCase()
    // A simple threshold heuristics
    if (input.length < 5) return null

    const needsReasoning = input.includes('math') || input.search(/\b(logic|complex logic|equation|proof)\b/) >= 0
    const needsCode = input.search(/\b(code|function|typescript|react|python|component|refactor)\b/) >= 0
    const needsSpeed = input.search(/\b(quick|fast|summarize|translate|tldr)\b/) >= 0

    const currentCaps = getModelCapabilities(selectedModel)

    if (needsReasoning && !currentCaps.includes('reasoning')) {
        return {
            suggestedModel: 'o1-mini (or DeepSeek R1)',
            reason: 'You appear to be asking a complex logic or math question. Switching to a reasoning model might yield better results.',
        }
    }

    if (needsCode && !selectedModel.includes('sonnet') && !selectedModel.includes('gpt-4o')) {
        return {
            suggestedModel: 'claude-sonnet-4-5',
            reason: 'For coding tasks, Claude 3.5 Sonnet or GPT-4o are strongly recommended over your current model for the best results.',
        }
    }

    if (needsSpeed && (selectedModel.includes('opus') || selectedModel.includes('o1') || selectedModel.includes('o3') || selectedModel.includes('large'))) {
        return {
            suggestedModel: 'claude-haiku-4-5 / gpt-4o-mini',
            reason: 'For quick tasks like summarization or translation, a faster model like Haiku or GPT-4o-mini can save resources without losing quality.',
        }
    }

    return null
}

export function checkAttachmentPrompt(text: string): boolean {
    if (!text) return false
    const input = text.toLowerCase()
    return input.includes('attached file') ||
        input.includes('this image') ||
        input.includes('this audio') ||
        input.includes('this document') ||
        input.includes('in the picture') ||
        input.includes('this screenshot')
}
