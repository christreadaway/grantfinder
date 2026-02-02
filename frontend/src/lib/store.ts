/**
 * Global state management for GrantFinder AI
 */
import { create } from 'zustand';

interface User {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  claude_api_key_set: boolean;
}

interface Grant {
  id: string;
  grant_name: string;
  funder: string;
  amount: string;
  deadline: string;
  category: string;
  geo_qualified: string;
}

interface GrantMatch {
  grant_id: string;
  grant_name: string;
  funder: string;
  amount: string;
  deadline: string;
  url: string;
  contact: string;
  category: string;
  geo_qualified: string;
  score: number;
  score_tier: string;
  score_breakdown: {
    eligibility_fit: number;
    need_alignment: number;
    capacity_signals: number;
    timing: number;
    completeness: number;
  };
  explanation: string;
  evidence: string[];
  is_shortlisted: boolean;
}

interface MatchResults {
  session_id: string;
  total_grants_evaluated: number;
  matches: GrantMatch[];
  excellent_matches: number;
  good_matches: number;
  possible_matches: number;
  weak_matches: number;
  not_eligible: number;
}

interface ProcessingLog {
  timestamp: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface AppState {
  // Auth
  user: User | null;
  isAuthenticated: boolean;
  setUser: (user: User | null) => void;

  // Setup step
  setupStep: number;
  setSetupStep: (step: number) => void;

  // Grants
  grants: Grant[];
  grantStats: any;
  setGrants: (grants: Grant[]) => void;
  setGrantStats: (stats: any) => void;

  // Profile
  profile: any;
  setProfile: (profile: any) => void;

  // Match Results
  matchResults: MatchResults | null;
  setMatchResults: (results: MatchResults | null) => void;

  // Processing
  isProcessing: boolean;
  processingLogs: ProcessingLog[];
  setIsProcessing: (value: boolean) => void;
  addProcessingLog: (log: ProcessingLog) => void;
  clearProcessingLogs: () => void;

  // Theme
  isDarkMode: boolean;
  toggleTheme: () => void;

  // Reset
  reset: () => void;
}

export const useStore = create<AppState>((set) => ({
  // Auth
  user: null,
  isAuthenticated: false,
  setUser: (user) => set({ user, isAuthenticated: !!user }),

  // Setup
  setupStep: 1,
  setSetupStep: (step) => set({ setupStep: step }),

  // Grants
  grants: [],
  grantStats: null,
  setGrants: (grants) => set({ grants }),
  setGrantStats: (stats) => set({ grantStats: stats }),

  // Profile
  profile: null,
  setProfile: (profile) => set({ profile }),

  // Match Results
  matchResults: null,
  setMatchResults: (results) => set({ matchResults: results }),

  // Processing
  isProcessing: false,
  processingLogs: [],
  setIsProcessing: (value) => set({ isProcessing: value }),
  addProcessingLog: (log) => set((state) => ({
    processingLogs: [...state.processingLogs, log],
  })),
  clearProcessingLogs: () => set({ processingLogs: [] }),

  // Theme
  isDarkMode: true,
  toggleTheme: () => set((state) => ({ isDarkMode: !state.isDarkMode })),

  // Reset
  reset: () => set({
    user: null,
    isAuthenticated: false,
    setupStep: 1,
    grants: [],
    grantStats: null,
    profile: null,
    matchResults: null,
    isProcessing: false,
    processingLogs: [],
  }),
}));
