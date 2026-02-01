'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Download, RefreshCw, FileText, Table, Code } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/hooks/useAuth'
import { useSSE } from '@/hooks/useSSE'
import { useAppStore } from '@/lib/store'
import { getMatchingUrl, exportResults, getMatchingSession } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Terminal } from '@/components/terminal/Terminal'
import { MatchSection } from '@/components/matches/MatchSection'
import type { MatchResults, GrantMatch } from '@/types'

export default function ResultsPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const { currentOrganization, currentGrantDatabase, matchResults, setMatchResults } = useAppStore()
  const { lines, addLine, clearLines } = useSSE()

  const [isMatching, setIsMatching] = useState(false)
  const [sessionId, setSessionId] = useState<number | null>(null)
  const [sortBy, setSortBy] = useState<'score' | 'deadline' | 'amount'>('score')

  useEffect(() => {
    if (!currentOrganization || !currentGrantDatabase) {
      router.push('/setup')
      return
    }

    if (!matchResults) {
      handleStartMatching()
    }
  }, [currentOrganization, currentGrantDatabase, router])

  const handleStartMatching = async () => {
    if (!currentOrganization || !currentGrantDatabase) return

    setIsMatching(true)
    clearLines()

    const token = localStorage.getItem('token')
    const url = getMatchingUrl(currentOrganization.id, currentGrantDatabase.id)

    try {
      const eventSource = new EventSource(url)

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          if (data.type === 'status') {
            addLine(data.message, 'status')
          } else if (data.type === 'match') {
            const match = data.data as GrantMatch
            addLine(`${match.score}% — ${match.grant_name}`, 'extracted')
          } else if (data.type === 'complete') {
            setSessionId(data.session_id)
            loadResults(data.session_id)
            eventSource.close()
          }
        } catch (e) {
          console.error('Parse error:', e)
        }
      }

      eventSource.onerror = () => {
        setIsMatching(false)
        addLine('Connection error. Retrying...', 'warning')
        eventSource.close()
      }
    } catch (error) {
      setIsMatching(false)
      toast.error('Failed to start matching')
    }
  }

  const loadResults = async (id: number) => {
    try {
      const response = await getMatchingSession(id)
      const results = response.data.results as MatchResults

      setMatchResults({
        session_id: id,
        grants_evaluated: response.data.grants_evaluated,
        excellent_matches: results.excellent_matches || [],
        good_matches: results.good_matches || [],
        possible_matches: results.possible_matches || [],
        weak_matches: results.weak_matches || [],
        not_eligible: results.not_eligible || [],
        created_at: response.data.created_at,
      })

      setIsMatching(false)
      addLine(
        `Matching complete. Found ${(results.excellent_matches?.length || 0) + (results.good_matches?.length || 0)} strong matches.`,
        'success'
      )
    } catch (error) {
      setIsMatching(false)
      toast.error('Failed to load results')
    }
  }

  const handleExport = async (format: 'markdown' | 'csv' | 'json') => {
    if (!sessionId) return

    try {
      const response = await exportResults(sessionId, format)

      if (format === 'json') {
        const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' })
        downloadBlob(blob, `grant_matches_${sessionId}.json`)
      } else {
        downloadBlob(response.data, `grant_matches_${sessionId}.${format === 'markdown' ? 'md' : 'csv'}`)
      }

      toast.success(`Exported as ${format.toUpperCase()}`)
    } catch (error) {
      toast.error('Failed to export')
    }
  }

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (authLoading || !currentOrganization) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  const totalMatches = matchResults
    ? matchResults.excellent_matches.length +
      matchResults.good_matches.length +
      matchResults.possible_matches.length
    : 0

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Grant Matches</h1>
            <p className="text-gray-400">
              {currentOrganization.name}
              {matchResults && ` • ${matchResults.grants_evaluated} grants evaluated`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => router.push('/profile')}>
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </div>
        </div>

        {/* Terminal during matching */}
        {isMatching && (
          <Terminal title="Finding Matches" lines={lines} isActive={isMatching} />
        )}

        {/* Results */}
        {matchResults && !isMatching && (
          <>
            {/* Summary & Controls */}
            <div className="flex items-center justify-between flex-wrap gap-4 p-4 rounded-xl bg-gray-800/50 border border-gray-700">
              <div className="flex items-center gap-6">
                <div>
                  <p className="text-2xl font-bold text-green-400">
                    {matchResults.excellent_matches.length}
                  </p>
                  <p className="text-sm text-gray-400">Excellent</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-yellow-400">
                    {matchResults.good_matches.length}
                  </p>
                  <p className="text-sm text-gray-400">Good</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-orange-400">
                    {matchResults.possible_matches.length}
                  </p>
                  <p className="text-sm text-gray-400">Possible</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1 border border-gray-600 rounded-lg overflow-hidden">
                  <button
                    onClick={() => handleExport('markdown')}
                    className="px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-1"
                    title="Export as Markdown"
                  >
                    <FileText className="w-4 h-4" />
                    MD
                  </button>
                  <button
                    onClick={() => handleExport('csv')}
                    className="px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-1 border-l border-gray-600"
                    title="Export as CSV"
                  >
                    <Table className="w-4 h-4" />
                    CSV
                  </button>
                  <button
                    onClick={() => handleExport('json')}
                    className="px-3 py-2 text-sm text-gray-300 hover:bg-gray-700 flex items-center gap-1 border-l border-gray-600"
                    title="Export as JSON"
                  >
                    <Code className="w-4 h-4" />
                    JSON
                  </button>
                </div>

                <Button variant="outline" size="sm" onClick={handleStartMatching}>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Re-match
                </Button>
              </div>
            </div>

            {/* Sort controls */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-400">Sort by:</span>
              {(['score', 'deadline', 'amount'] as const).map((option) => (
                <button
                  key={option}
                  onClick={() => setSortBy(option)}
                  className={`px-3 py-1 rounded-full ${
                    sortBy === option
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {option.charAt(0).toUpperCase() + option.slice(1)}
                </button>
              ))}
            </div>

            {/* Match Sections */}
            <div className="space-y-8">
              <MatchSection
                title="Excellent Matches (85-100%)"
                emoji="🟢"
                matches={matchResults.excellent_matches}
                defaultExpanded
              />

              <MatchSection
                title="Good Matches (70-84%)"
                emoji="🟡"
                matches={matchResults.good_matches}
              />

              <MatchSection
                title="Possible Matches (50-69%)"
                emoji="🟠"
                matches={matchResults.possible_matches}
              />

              <MatchSection
                title="Weak Matches (25-49%)"
                emoji="🔴"
                matches={matchResults.weak_matches}
              />

              {matchResults.not_eligible.length > 0 && (
                <div className="pt-4 border-t border-gray-700">
                  <MatchSection
                    title="Not Eligible (0-24%)"
                    emoji="⚫"
                    matches={matchResults.not_eligible}
                  />
                </div>
              )}
            </div>

            {/* No matches message */}
            {totalMatches === 0 && (
              <div className="text-center py-12">
                <p className="text-xl text-gray-400 mb-4">No strong matches found</p>
                <p className="text-gray-500 max-w-md mx-auto">
                  This could mean your organization doesn't match the grants in your database, or
                  we need more information. Try adding more context or documents.
                </p>
                <Button variant="outline" className="mt-6" onClick={() => router.push('/context')}>
                  Add More Context
                </Button>
              </div>
            )}
          </>
        )}

        {/* Start Over */}
        <div className="flex justify-center pt-8 border-t border-gray-700">
          <Button
            variant="ghost"
            onClick={() => {
              setMatchResults(null)
              router.push('/setup')
            }}
          >
            Start Over with New Organization
          </Button>
        </div>
      </div>
    </div>
  )
}
