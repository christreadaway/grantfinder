import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User, Organization, GrantDatabase, MatchResults } from '@/types'

interface AppState {
  // Auth
  user: User | null
  token: string | null
  setAuth: (user: User, token: string) => void
  clearAuth: () => void

  // Current working state
  currentOrganization: Organization | null
  setCurrentOrganization: (org: Organization | null) => void

  currentGrantDatabase: GrantDatabase | null
  setCurrentGrantDatabase: (db: GrantDatabase | null) => void

  matchResults: MatchResults | null
  setMatchResults: (results: MatchResults | null) => void

  // Settings
  darkMode: boolean
  toggleDarkMode: () => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      // Auth
      user: null,
      token: null,
      setAuth: (user, token) => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('token', token)
        }
        set({ user, token })
      },
      clearAuth: () => {
        if (typeof window !== 'undefined') {
          localStorage.removeItem('token')
        }
        set({ user: null, token: null })
      },

      // Current working state
      currentOrganization: null,
      setCurrentOrganization: (org) => set({ currentOrganization: org }),

      currentGrantDatabase: null,
      setCurrentGrantDatabase: (db) => set({ currentGrantDatabase: db }),

      matchResults: null,
      setMatchResults: (results) => set({ matchResults: results }),

      // Settings
      darkMode: true,
      toggleDarkMode: () => set((state) => ({ darkMode: !state.darkMode })),
    }),
    {
      name: 'grantfinder-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        darkMode: state.darkMode,
      }),
    }
  )
)
