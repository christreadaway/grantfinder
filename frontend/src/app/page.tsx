'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { Search, FileText, BarChart3, Download, ChevronRight } from 'lucide-react';
import api from '@/lib/api';
import { useStore } from '@/lib/store';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

type EngineStatus =
  | { state: 'checking' }
  | { state: 'ready'; google: boolean; guest: boolean }
  | { state: 'unreachable' };

const describeError = (error: unknown): string => {
  const e = error as { response?: { data?: { detail?: string } }; message?: string } | null;
  return e?.response?.data?.detail || e?.message || 'unknown error';
};

export default function Home() {
  const router = useRouter();
  const { setUser } = useStore();
  const [engine, setEngine] = useState<EngineStatus>({ state: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [guestBusy, setGuestBusy] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('expired') === '1') {
      setNotice('Your session ended. Please sign in again; your saved work is still here.');
    }

    // Check for existing token
    const token = api.loadToken();
    if (token) {
      api.getMe().then((user) => {
        setUser(user);
        router.push('/dashboard');
      }).catch(() => {
        api.clearToken();
      });
    }

    // Ask the engine (this site's /api) which sign-in methods it offers.
    // Failure here means the site's functions are not running or misconfigured.
    api.getAuthOptions()
      .then((options) => setEngine({ state: 'ready', google: options.google, guest: options.guest }))
      .catch((error) => {
        console.error('[GrantFinder] The engine at /api/auth/options did not answer:', error);
        setEngine({ state: 'unreachable' });
      });
  }, [router, setUser]);

  const handleGoogleSuccess = async (credentialResponse: any) => {
    setSignInError(null);
    try {
      const data = await api.googleAuth(credentialResponse.credential);
      setUser(data.user);
      router.push('/dashboard');
    } catch (error) {
      console.error('[GrantFinder] Google sign-in failed:', error);
      setSignInError(`Google sign-in failed: ${describeError(error)}`);
    }
  };

  const handleGuest = async () => {
    setSignInError(null);
    setGuestBusy(true);
    try {
      const data = await api.guestAuth();
      setUser(data.user);
      router.push('/dashboard');
    } catch (error) {
      console.error('[GrantFinder] Guest sign-in failed:', error);
      setSignInError(`Guest sign-in failed: ${describeError(error)}`);
    } finally {
      setGuestBusy(false);
    }
  };

  // NEXT_PUBLIC_GOOGLE_CLIENT_ID serves both the button and the engine's check.
  const showGoogle = Boolean(GOOGLE_CLIENT_ID) && engine.state === 'ready' && engine.google;
  const showGuest = engine.state === 'ready' && engine.guest;

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
                <Search className="w-5 h-5 text-white" />
              </div>
              <span className="text-xl font-bold">GrantFinder AI</span>
            </div>
            <span className="text-sm text-gray-500">v2.6</span>
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
              {notice && <p className="text-sm text-amber-400 max-w-md">{notice}</p>}

              {engine.state === 'checking' && (
                <p className="text-sm text-gray-500">Connecting to GrantFinder...</p>
              )}

              {engine.state === 'unreachable' && (
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
                <button
                  onClick={handleGuest}
                  disabled={guestBusy}
                  className={`btn ${showGoogle ? 'btn-secondary' : 'btn-primary'} text-lg px-8 py-3`}
                >
                  {guestBusy ? 'Starting...' : 'Continue as guest'}
                  <ChevronRight className="w-5 h-5" />
                </button>
              )}

              {engine.state === 'ready' && !showGoogle && !showGuest && (
                <div className="card max-w-lg text-left text-sm">
                  <p className="font-semibold mb-1">Sign-in isn&apos;t set up yet</p>
                  <p className="text-gray-400">
                    If you run this site, add your Google OAuth client ID as NEXT_PUBLIC_GOOGLE_CLIENT_ID
                    in Netlify and redeploy. To try the app first, set ALLOW_GUEST_LOGIN=true in Netlify
                    and redeploy.
                  </p>
                </div>
              )}

              {engine.state === 'ready' && engine.google && !GOOGLE_CLIENT_ID && (
                <p className="text-sm text-amber-400 max-w-md">
                  Google sign-in is only half set up: add NEXT_PUBLIC_GOOGLE_CLIENT_ID in Netlify (same
                  value as GOOGLE_CLIENT_ID) and redeploy.
                </p>
              )}

              {signInError && <p className="text-sm text-red-400 max-w-md">{signInError}</p>}
            </div>

            {/* Features Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-12">
              {features.map((feature, index) => (
                <div key={index} className="card text-left">
                  <div className="flex items-start gap-4">
                    <div className="p-3 bg-[var(--primary)] bg-opacity-20 rounded-lg text-[var(--primary)]">
                      {feature.icon}
                    </div>
                    <div>
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
          <div className="max-w-6xl mx-auto px-4 flex items-center justify-between text-sm text-gray-500">
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
