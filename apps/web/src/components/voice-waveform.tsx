// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

export function VoiceWaveform({ active, level }: { active: boolean; level: number }) {
    const bars = [0.4, 0.7, 1.0, 0.85, 0.6, 0.9, 0.5, 0.75, 0.45, 0.8, 0.55, 0.65]
    return (
        <div className="flex items-center justify-center gap-[3px] h-5">
            {bars.map((base, i) => (
                <div
                    key={i}
                    className="w-[3px] rounded-full bg-azure transition-all"
                    style={{
                        height: active
                            ? `${Math.max(3, Math.min(20, base * level * 20 + 3))}px`
                            : '4px',
                        opacity: active ? 0.9 : 0.3,
                        transitionDuration: `${80 + i * 20}ms`,
                    }}
                />
            ))}
        </div>
    )
}
