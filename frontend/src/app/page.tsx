'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { getGoogleAuthUrl } from '@/lib/api'
import { useAppStore } from '@/lib/store'
import { Button } from '@/components/ui/Button'

export default function HomePage() {
  const router = useRouter()
  const { user, token } = useAppStore()
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    // If already logged in, redirect to setup
    const storedToken = localStorage.getItem('token')
    if (storedToken) {
      router.push('/setup')
    }
  }, [router])

  const handleGoogleLogin = async () => {
    setIsLoading(true)
    try {
      const response = await getGoogleAuthUrl()
      window.location.href = response.data.auth_url
    } catch (error) {
      console.error('Failed to get auth URL:', error)
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4">
      <div className="max-w-md w-full text-center space-y-8">
        {/* Logo and Title */}
        <div>
          <h1 className="text-4xl font-bold text-gray-100 mb-2">GrantFinder AI</h1>
          <p className="text-xl text-gray-400">
            Match your parish to the right grants — powered by AI
          </p>
        </div>

        {/* Features */}
        <div className="space-y-4 text-left bg-gray-800/50 rounded-xl p-6 border border-gray-700">
          <div className="flex gap-3">
            <span className="text-2xl">🔍</span>
            <div>
              <h3 className="font-medium text-gray-200">Scan Your Website</h3>
              <p className="text-sm text-gray-400">AI learns about your organization automatically</p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="text-2xl">📄</span>
            <div>
              <h3 className="font-medium text-gray-200">Upload Documents</h3>
              <p className="text-sm text-gray-400">Bulletins, meeting minutes, newsletters</p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="text-2xl">🎯</span>
            <div>
              <h3 className="font-medium text-gray-200">Get Matched</h3>
              <p className="text-sm text-gray-400">Ranked recommendations with explanations</p>
            </div>
          </div>
        </div>

        {/* Login Button */}
        <div className="space-y-4">
          <Button
            onClick={handleGoogleLogin}
            isLoading={isLoading}
            size="lg"
            className="w-full"
          >
            <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="currentColor"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="currentColor"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="currentColor"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            Sign in with Google
          </Button>
          <p className="text-sm text-gray-500">
            Free and open source. Your data stays yours.
          </p>
        </div>

        {/* Footer */}
        <div className="pt-8 border-t border-gray-700">
          <p className="text-sm text-gray-500">
            Support this project:{' '}
            <a
              href="https://patreon.com/christreadaway"
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-400 hover:underline"
            >
              patreon.com/christreadaway
            </a>
          </p>
        </div>
      </div>
    </div>
  )
}
