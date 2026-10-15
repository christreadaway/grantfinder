'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { GoogleOAuthProvider, GoogleLogin, type CredentialResponse } from '@react-oauth/google';
import { Search, FileText, BarChart3, Download, ChevronRight, Loader2, AlertCircle } from 'lucide-react';
import api, { errorDetail, isSessionEnded } from '@/lib/api';
import { useStore } from '@/lib/store';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

/** Where this browser keeps the session (for a guest, the only key to their work)... */
const TOKEN_KEY = 'auth_token';
/** ...and the session a new sign-in replaced, so lost guest work can still be recovered by hand. */
const PREVIOUS_TOKEN_KEY = 'auth_token_previous';

/** How long to wait for the engine to recognize a saved session before offering "Try again". */
const RESTORE_TIMEOUT_MS = 20_000;

const EXPIRED_NOTICE =
  "Your session ended. If you signed in with Google, sign in again and your work will be there. A guest session can't be reopened.";
const RESTORE_FAILED =
  "Couldn't reach GrantFinder to reopen your saved work. Check your internet connection, then try again. Don't start a new guest session; it would be empty.";
const REPLACE_SESSION_QUESTION =
  'This browser already has a GrantFinder session. A new guest session starts empty, and the current one can no longer be opened here. Continue?';

type EngineStatus =
  | { state: 'checking' }
  | { state: 'ready'; google: boolean; guest: boolean }
  | { state: 'unreachable' };

/** Reopening the session saved in this browser: still checking, couldn't reach GrantFinder, the engine ended it, or none saved. */
type RestoreStatus = 'checking' | 'failed' | 'ended' | 'none';

type SignedInUser = Parameters<ReturnType<typeof useStore.getState>['setUser']>[0];

type RestoreOutcome =
  | { kind: 'none' }
  | { kind: 'ended' }
  | { kind: 'failed' }
  | { kind: 'ok'; user: SignedInUser };

// Values only the browser knows. React reads them again on every render and once
// more right after mounting, so no subscription is needed (and the server render,
// which can't see them, stays the same as the first browser render).
const subscribeNowhere = () => () => {};
const serverSnapshot = () => false;
const expiredSnapshot = () => new URLSearchParams(window.location.search).get('expired') === '1';
const storedTokenSnapshot = () => {
  try {
    return Boolean(window.localStorage.getItem(TOKEN_KEY));
  } catch {
    return false;
  }
};

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch (error) {
    console.warn('[GrantFinder] Could not read the saved session in this browser:', error);
    return null;
  }
}

function keepPreviousToken(token: string) {
  try {
    window.localStorage.setItem(PREVIOUS_TOKEN_KEY, token);
  } catch (error) {
    console.warn('[GrantFinder] Could not keep a copy of the earlier session:', error);
  }
}

/** Reject with a timeout error (worded by errorDetail) if the engine doesn't answer in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('GrantFinder took too long to answer.'), { code: 'ETIMEDOUT' }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Ask the engine (this site's /api) which sign-in methods it offers. */
async function checkEngine(): Promise<EngineStatus> {
  try {
    const options = await api.getAuthOptions();
    return { state: 'ready', google: options.google, guest: options.guest };
  } catch (error) {
    // Failure here means the site's functions are not running or misconfigured.
    console.error('[GrantFinder] The engine at /api/auth/options did not answer:', error);
    return { state: 'unreachable' };
  }
}

/**
 * Reopen the session saved in this browser. Only the engine saying the session
 * is over (401) forgets it: a Wi-Fi blip or a Netlify error keeps it for the next try.
 */
async function reopenSavedSession(): Promise<RestoreOutcome> {
  let token: string | null = null;
  try {
    token = api.loadToken();
  } catch (error) {
    console.warn('[GrantFinder] Could not read the saved session in this browser:', error);
  }
  if (!token) return { kind: 'none' };
  try {
    return { kind: 'ok', user: await withTimeout(api.getMe(), RESTORE_TIMEOUT_MS) };
  } catch (error) {
    if (isSessionEnded(error)) {
      console.warn('[GrantFinder] The saved session has ended; showing sign-in.');
      try {
        api.clearToken();
      } catch (clearError) {
        console.warn('[GrantFinder] Could not forget the ended session:', clearError);
      }
      return { kind: 'ended' };
    }
    console.error('[GrantFinder] Could not reopen the saved session (it is kept for the next try):', error);
    return { kind: 'failed' };
  }
}

export default function Home() {
  const router = useRouter();
  const { setUser } = useStore();
  const expired = useSyncExternalStore(subscribeNowhere, expiredSnapshot, serverSnapshot);
  const hasStoredToken = useSyncExternalStore(subscribeNowhere, storedTokenSnapshot, serverSnapshot);
  const [engine, setEngine] = useState<EngineStatus>({ state: 'checking' });
  const [restore, setRestore] = useState<RestoreStatus>('checking');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);

  const finishRestore = useCallback((outcome: RestoreOutcome) => {
    if (outcome.kind === 'ok') {
      setUser(outcome.user);
      router.push('/dashboard');
      return; // keep "Opening your saved work..." until the dashboard shows
    }
    setRestore(outcome.kind);
  }, [router, setUser]);

  useEffect(() => {
    let active = true;
    reopenSavedSession().then((outcome) => {
      if (active) finishRestore(outcome);
    });
    checkEngine().then((status) => {
      if (active) setEngine(status);
    });
    return () => {
      active = false;
    };
  }, [finishRestore]);

  const retryRestore = () => {
    setRestore('checking');
    setSignInError(null);
    if (engine.state !== 'ready') {
      setEngine({ state: 'checking' });
      checkEngine().then(setEngine);
    }
    reopenSavedSession().then(finishRestore);
  };

  const handleGoogleSuccess = async (credentialResponse: CredentialResponse) => {
    setSignInError(null);
    if (!credentialResponse.credential) {
      setSignInError('Google sign-in did not finish. Please try again.');
      return;
    }
    const existing = readStoredToken();
    if (existing) keepPreviousToken(existing);
    try {
      const data = await api.googleAuth(credentialResponse.credential);
      setUser(data.user);
      router.push('/dashboard');
    } catch (error) {
      console.error('[GrantFinder] Google sign-in failed:', error);
      setSignInError(`Google sign-in failed: ${errorDetail(error, 'please try again.')}`);
    }
  };

  const handleGuest = async () => {
    setSignInError(null);
    const existing = readStoredToken();
    if (existing) {
      // A new guest session replaces the token, which is the only key to the current work.
      if (!window.confirm(REPLACE_SESSION_QUESTION)) return;
      keepPreviousToken(existing);
    }
    setGuestBusy(true);
    try {
      const data = await api.guestAuth();
      setUser(data.user);
      router.push('/dashboard'); // stays "Starting..." until the dashboard shows
    } catch (error) {
      console.error('[GrantFinder] Guest sign-in failed:', error);
      setSignInError(`Guest sign-in failed: ${errorDetail(error, 'please try again.')}`);
      setGuestBusy(false);
    }
  };

  const restoring = hasStoredToken && restore === 'checking';
  const restoreFailed = hasStoredToken && restore === 'failed';

  // NEXT_PUBLIC_GOOGLE_CLIENT_ID serves both the button and the engine's check.
  const showGoogle = !restoring && Boolean(GOOGLE_CLIENT_ID) && engine.state === 'ready' && engine.google;
  const showGuest = !restoring && engine.state === 'ready' && engine.guest;

  const features = [
    {
      icon: <Search className="w-6 h-6" />,
      title: 'Website Scanning',
      description: 'AI scans your parish/school website to understand your organization',
    },
    {
      icon: <FileText className="w-6 h-6" />,
      title: 'Document Processing',
      description: 'Upload bulletins, meeting minutes, and other documents for analysis',
    },
    {
      icon: <BarChart3 className="w-6 h-6" />,
      title: 'Probability Scoring',
      description: 'Every grant scored 0-100% based on your fit with eligibility criteria',
    },
    {
      icon: <Download className="w-6 h-6" />,
      title: 'Write and Export',
      description: 'Draft the application with AI, then download it for Word or the funder portal',
    },
  ];

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <div className="min-h-screen flex flex-col">
        {/* Header */}
        <header className="border-b border-[var(--card-border)]">
          <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-[var(--primary)] rounded-lg flex items-center justify-center">
                <Search className="w-5 h-5 text-white" aria-hidden="true" />
              </div>
              <span className="text-xl font-bold">GrantFinder AI</span>
            </div>
            <span className="text-sm text-gray-400">v2.6</span>
          </div>
        </header>

        {/* Hero */}
        <main className="flex-1 flex flex-col items-center justify-center px-4 py-16">
          <div className="max-w-3xl text-center">
            <h1 className="text-4xl md:text-5xl font-bold mb-6">
              Find Grants for Your{' '}
              <span className="text-[var(--primary)]">Catholic Parish or School</span>
            </h1>
            <p className="text-xl text-gray-400 mb-8">
              Upload your documents. Enter your website. Get every grant opportunity
              scored and ranked by how well it fits your organization.
            </p>

            {/* Sign In */}
            <div className="flex flex-col items-center gap-4 mb-12">
              {((expired && !hasStoredToken) || restore === 'ended') && (
                <p className="text-sm text-amber-400 max-w-md">{EXPIRED_NOTICE}</p>
              )}

              {restoring && (
                <p className="text-sm text-gray-300 flex items-center gap-2" role="status">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--primary)]" aria-hidden="true" />
                  Opening your saved work...
                </p>
              )}

              {restoreFailed && (
                <div className="card max-w-lg text-left text-sm" role="alert">
                  <p className="flex items-start gap-2 text-red-300">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{RESTORE_FAILED}</span>
                  </p>
                  <button type="button" onClick={retryRestore} className="btn btn-primary mt-4">
                    Try again
                  </button>
                </div>
              )}

              {!restoring && engine.state === 'checking' && (
                <p className="text-sm text-gray-400" role="status">Connecting to GrantFinder...</p>
              )}

              {!restoring && !restoreFailed && engine.state === 'unreachable' && (
                <div className="card max-w-lg text-left text-sm">
                  <p className="font-semibold text-red-400 mb-1">Can&apos;t reach the GrantFinder engine</p>
                  <p className="text-gray-400">
                    This site&apos;s engine (/api) didn&apos;t answer. If you run this site: in Netlify,
                    open Logs, then Functions, and look for the error; check that SECRET_KEY is set
                    under Site configuration, then Environment variables; then redeploy and reload.
                  </p>
                </div>
              )}

              {showGoogle && (
                <GoogleLogin
                  onSuccess={handleGoogleSuccess}
                  onError={() => setSignInError('Google sign-in was cancelled or blocked. Please try again.')}
                  theme="filled_black"
                  size="large"
                  text="continue_with"
                  shape="pill"
                />
              )}

              {showGuest && (
                <div className="flex flex-col items-center gap-2">
                  <button
                    type="button"
                    onClick={handleGuest}
                    disabled={guestBusy}
                    className={`btn ${showGoogle ? 'btn-secondary' : 'btn-primary'} text-lg px-8 py-3`}
                  >
                    {guestBusy ? 'Starting...' : 'Continue as guest'}
                    <ChevronRight className="w-5 h-5" aria-hidden="true" />
                  </button>
                  <p className="text-sm text-gray-400 max-w-sm">
                    Guest work is saved in this browser only. Come back in this same browser; signing out
                    or clearing browsing data loses it.
                  </p>
                </div>
              )}

              {!restoring && engine.state === 'ready' && !showGoogle && !showGuest && (
                <div className="card max-w-lg text-left text-sm">
                  <p className="font-semibold mb-1">Sign-in isn&apos;t set up yet</p>
                  <p className="text-gray-400">
                    If you run this site, add your Google OAuth client ID as NEXT_PUBLIC_GOOGLE_CLIENT_ID
                    in Netlify and redeploy. To try the app first, set ALLOW_GUEST_LOGIN=true in Netlify
                    and redeploy.
                  </p>
                </div>
              )}

              {!restoring && engine.state === 'ready' && engine.google && !GOOGLE_CLIENT_ID && (
                <p className="text-sm text-amber-400 max-w-md">
                  Google sign-in is only half set up: add NEXT_PUBLIC_GOOGLE_CLIENT_ID in Netlify (same
                  value as GOOGLE_CLIENT_ID) and redeploy.
                </p>
              )}

              {signInError && <p className="text-sm text-red-400 max-w-md" role="alert">{signInError}</p>}
            </div>

            {/* Features Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-12">
              {features.map((feature, index) => (
                <div key={index} className="card text-left">
                  <div className="flex items-start gap-4">
                    <div className="p-3 bg-[var(--primary)] bg-opacity-20 rounded-lg text-[var(--primary)]">
                      {feature.icon}
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold mb-1">{feature.title}</h3>
                      <p className="text-sm text-gray-400">{feature.description}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </main>

        {/* Footer */}
        <footer className="border-t border-[var(--card-border)] py-6">
          <div className="max-w-6xl mx-auto px-4 flex flex-wrap items-center justify-between gap-2 text-sm text-gray-400">
            <p>Built for Catholic parishes and schools</p>
            <p>
              <a
                href="https://patreon.com/christreadaway"
                className="hover:text-[var(--primary)]"
                target="_blank"
                rel="noopener noreferrer"
              >
                Support on Patreon
              </a>
            </p>
          </div>
        </footer>
      </div>
    </GoogleOAuthProvider>
  );
}
