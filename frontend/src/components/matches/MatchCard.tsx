'use client'

import { clsx } from 'clsx'
import { ExternalLink, AlertTriangle, CheckCircle, HelpCircle } from 'lucide-react'
import type { GrantMatch } from '@/types'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'

interface MatchCardProps {
  match: GrantMatch
  expanded?: boolean
  onToggleExpand?: () => void
}

const scoreConfig = {
  excellent: { emoji: '🟢', color: 'text-green-400', bg: 'bg-green-900/20', border: 'border-green-700' },
  good: { emoji: '🟡', color: 'text-yellow-400', bg: 'bg-yellow-900/20', border: 'border-yellow-700' },
  possible: { emoji: '🟠', color: 'text-orange-400', bg: 'bg-orange-900/20', border: 'border-orange-700' },
  weak: { emoji: '🔴', color: 'text-red-400', bg: 'bg-red-900/20', border: 'border-red-700' },
  not_eligible: { emoji: '⚫', color: 'text-gray-500', bg: 'bg-gray-900/20', border: 'border-gray-700' },
}

export function MatchCard({ match, expanded = false, onToggleExpand }: MatchCardProps) {
  const config = scoreConfig[match.score_label]

  return (
    <div
      className={clsx(
        'rounded-xl border p-4 transition-all cursor-pointer hover:shadow-lg',
        config.bg,
        config.border
      )}
      onClick={onToggleExpand}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={clsx('text-2xl font-bold', config.color)}>{match.score}%</span>
            <span className="text-lg font-semibold text-gray-100">{match.grant_name}</span>
          </div>
          {match.granting_authority && (
            <p className="text-sm text-gray-400 mt-0.5">{match.granting_authority}</p>
          )}
        </div>
        <div className="text-right text-sm">
          <p className="font-medium text-gray-200">{match.amount_display}</p>
          <p
            className={clsx('flex items-center justify-end gap-1', {
              'text-yellow-400': match.deadline_urgent,
              'text-gray-400': !match.deadline_urgent,
            })}
          >
            {match.deadline_urgent && <AlertTriangle className="w-3 h-3" />}
            {match.deadline_display}
          </p>
        </div>
      </div>

      {/* Divider */}
      <hr className="my-3 border-gray-700" />

      {/* Why it fits */}
      <div>
        <p className="text-gray-300">{match.why_it_fits}</p>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-4 space-y-4">
          {/* Score breakdown */}
          <div className="grid grid-cols-5 gap-2 text-xs">
            <ScoreBar label="Eligibility" value={match.eligibility_score} max={40} />
            <ScoreBar label="Need Match" value={match.need_alignment_score} max={30} />
            <ScoreBar label="Capacity" value={match.capacity_score} max={15} />
            <ScoreBar label="Timing" value={match.timing_score} max={10} />
            <ScoreBar label="Info" value={match.completeness_score} max={5} />
          </div>

          {/* Eligibility notes */}
          {match.eligibility_notes.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-1">
                <CheckCircle className="w-4 h-4 text-green-400" />
                Eligibility Met
              </h4>
              <ul className="text-sm text-gray-400 space-y-1">
                {match.eligibility_notes.map((note, i) => (
                  <li key={i}>✓ {note}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Verify items */}
          {match.verify_items.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-1">
                <HelpCircle className="w-4 h-4 text-yellow-400" />
                Verify Before Applying
              </h4>
              <ul className="text-sm text-gray-400 space-y-1">
                {match.verify_items.map((item, i) => (
                  <li key={i}>• {item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Apply button */}
          {match.apply_url && (
            <div className="pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  window.open(match.apply_url, '_blank')
                }}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                View Grant
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const percentage = (value / max) * 100

  return (
    <div className="text-center">
      <div className="h-16 bg-gray-700/50 rounded relative overflow-hidden">
        <div
          className="absolute bottom-0 left-0 right-0 bg-blue-500/50"
          style={{ height: `${percentage}%` }}
        />
        <span className="absolute inset-0 flex items-center justify-center font-bold text-gray-200">
          {value}
        </span>
      </div>
      <p className="mt-1 text-gray-500">{label}</p>
    </div>
  )
}
