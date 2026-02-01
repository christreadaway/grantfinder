'use client'

import { useState } from 'react'
import type { GrantMatch } from '@/types'
import { MatchCard } from './MatchCard'

interface MatchSectionProps {
  title: string
  emoji: string
  matches: GrantMatch[]
  defaultExpanded?: boolean
}

export function MatchSection({ title, emoji, matches, defaultExpanded = false }: MatchSectionProps) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(defaultExpanded)

  if (matches.length === 0) return null

  const visibleMatches = showAll ? matches : matches.slice(0, 3)

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 px-2">
        <span className="text-lg">{emoji}</span>
        <h2 className="text-lg font-semibold text-gray-200">{title}</h2>
        <span className="text-sm text-gray-500">({matches.length})</span>
      </div>

      <div className="space-y-3">
        {visibleMatches.map((match) => (
          <MatchCard
            key={match.grant_id}
            match={match}
            expanded={expandedId === match.grant_id}
            onToggleExpand={() =>
              setExpandedId(expandedId === match.grant_id ? null : match.grant_id)
            }
          />
        ))}
      </div>

      {matches.length > 3 && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          Show {matches.length - 3} more...
        </button>
      )}
    </div>
  )
}
