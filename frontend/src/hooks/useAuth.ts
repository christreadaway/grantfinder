'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAppStore } from '@/lib/store'
import { getCurrentUser } from '@/lib/api'

export function useAuth(requireAuth: boolean = true) {
  const router = useRouter()
  const { user, token, setAuth, clearAuth } = useAppStore()
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const checkAuth = async () => {
      const storedToken = localStorage.getItem('token')

      if (!storedToken) {
        if (requireAuth) {
          router.push('/')
        }
        setIsLoading(false)
        return
      }

      try {
        const response = await getCurrentUser()
        setAuth(response.data, storedToken)
      } catch (error) {
        clearAuth()
        if (requireAuth) {
          router.push('/')
        }
      } finally {
        setIsLoading(false)
      }
    }

    checkAuth()
  }, [requireAuth, router, setAuth, clearAuth])

  return { user, token, isLoading, isAuthenticated: !!user }
}
