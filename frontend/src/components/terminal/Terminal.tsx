'use client'

import { useEffect, useRef } from 'react'
import { clsx } from 'clsx'
import type { TerminalLine } from '@/types'

interface TerminalProps {
  title: string
  lines: TerminalLine[]
  isActive?: boolean
  showCursor?: boolean
}

export function Terminal({ title, lines, isActive = false, showCursor = true }: TerminalProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  return (
    <div className="rounded-xl border border-gray-700 overflow-hidden bg-terminal-bg">
      {/* Terminal header */}
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-800/50 border-b border-gray-700">
        <div className="flex gap-1.5">
          <div className="w-3 h-3 rounded-full bg-red-500" />
          <div className="w-3 h-3 rounded-full bg-yellow-500" />
          <div className="w-3 h-3 rounded-full bg-green-500" />
        </div>
        <span className="ml-2 text-sm text-gray-400 font-mono">{title}</span>
      </div>

      {/* Terminal content */}
      <div
        ref={scrollRef}
        className="p-4 h-80 overflow-y-auto font-mono text-sm terminal-scroll"
      >
        {lines.map((line, index) => (
          <TerminalLineComponent key={index} line={line} />
        ))}
        {isActive && showCursor && (
          <div className="flex items-center">
            <span className="text-gray-500">[{formatTime()}]</span>
            <span className="ml-2 text-terminal-text terminal-cursor">_</span>
          </div>
        )}
      </div>
    </div>
  )
}

function TerminalLineComponent({ line }: { line: TerminalLine }) {
  return (
    <div className="flex py-0.5">
      <span className="text-gray-500 select-none">[{line.timestamp}]</span>
      <span
        className={clsx('ml-2', {
          'text-terminal-text': line.type === 'status',
          'text-green-400': line.type === 'success',
          'text-terminal-cyan': line.type === 'extracted',
          'text-yellow-400': line.type === 'warning',
          'text-red-400': line.type === 'error',
        })}
      >
        {line.type === 'success' && '✓ '}
        {line.type === 'warning' && '⚠ '}
        {line.type === 'error' && '✗ '}
        {line.message}
      </span>
    </div>
  )
}

function formatTime() {
  return new Date().toLocaleTimeString('en-US', { hour12: false })
}
