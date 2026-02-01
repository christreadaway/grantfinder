'use client'

import { useCallback, useRef, useState } from 'react'
import type { TerminalLine } from '@/types'

interface SSEOptions {
  onMessage?: (data: any) => void
  onComplete?: (data: any) => void
  onError?: (error: Error) => void
}

export function useSSE() {
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [isConnected, setIsConnected] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)

  const formatTimestamp = () => {
    const now = new Date()
    return now.toLocaleTimeString('en-US', { hour12: false })
  }

  const addLine = useCallback((message: string, type: TerminalLine['type'] = 'status') => {
    setLines((prev) => [
      ...prev,
      {
        timestamp: formatTimestamp(),
        message,
        type,
      },
    ])
  }, [])

  const connect = useCallback(
    (url: string, options: SSEOptions = {}) => {
      const token = localStorage.getItem('token')

      // EventSource doesn't support custom headers, so we pass token as query param
      const urlWithAuth = `${url}${url.includes('?') ? '&' : '?'}token=${token}`

      const eventSource = new EventSource(urlWithAuth)
      eventSourceRef.current = eventSource

      setIsConnected(true)
      setLines([])

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          if (data.type === 'status') {
            addLine(data.message, 'status')
          } else if (data.type === 'extracted') {
            const item = data.item || data.source
            addLine(`  → ${item}`, 'extracted')
          } else if (data.type === 'warning') {
            addLine(data.message, 'warning')
          } else if (data.type === 'complete') {
            addLine('Processing complete.', 'success')
            options.onComplete?.(data)
            eventSource.close()
            setIsConnected(false)
          } else if (data.type === 'match') {
            // Handle match results streaming
            options.onMessage?.(data)
          }

          options.onMessage?.(data)
        } catch (error) {
          console.error('Failed to parse SSE message:', error)
        }
      }

      eventSource.onerror = (error) => {
        console.error('SSE error:', error)
        addLine('Connection error. Please try again.', 'error')
        options.onError?.(new Error('SSE connection failed'))
        eventSource.close()
        setIsConnected(false)
      }

      return eventSource
    },
    [addLine]
  )

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
      setIsConnected(false)
    }
  }, [])

  const clearLines = useCallback(() => {
    setLines([])
  }, [])

  return {
    lines,
    isConnected,
    connect,
    disconnect,
    addLine,
    clearLines,
  }
}
