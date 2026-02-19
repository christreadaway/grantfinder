'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { GoogleOAuthProvider, GoogleLogin } from '@react-oauth/google';
import { Search, FileText, BarChart3, Download, ChevronRight } from 'lucide-react';
import api from '@/lib/api';
import { useStore } from '@/lib/store';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || '';

export default function Home() {
  const router = useRouter();
  const { setUser } = useStore();

  useEffect(() => {
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
  }, [router, setUser]);

  const handleGoogleSuccess = async (credentialResponse: any) => {
    try {
      const data = await api.googleAuth(credentialResponse.credential);
      setUser(data.user);
      router.push('/dashboard');
    } catch (error) {
      console.error('Auth failed:', error);
    }
  };

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
      title: 'Export Results',
      description: 'Download your ranked matches as PDF, CSV, or Markdown',
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

            {/* Google Sign In */}
            <div className="flex justify-center mb-12">
              {GOOGLE_CLIENT_ID ? (
                <GoogleLogin
                  onSuccess={handleGoogleSuccess}
                  onError={() => console.log('Login Failed')}
                  theme="filled_black"
                  size="large"
                  text="continue_with"
                  shape="pill"
                />
              ) : (
                <button
                  onClick={() => router.push('/dashboard')}
                  className="btn btn-primary text-lg px-8 py-3"
                >
                  Get Started (Demo Mode)
                  <ChevronRight className="w-5 h-5" />
                </button>
              )}
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
