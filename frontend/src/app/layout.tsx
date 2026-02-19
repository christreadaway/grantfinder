import type { Metadata } from 'next'
import { Toaster } from 'react-hot-toast'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'GrantFinder AI',
  description: 'AI-powered grant matching for Catholic parishes and schools',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-gray-900 text-gray-100">
        <Providers>
          {children}
          <Toaster
            position="bottom-right"
            toastOptions={{
              style: {
                background: '#1f2937',
                color: '#f3f4f6',
                border: '1px solid #374151',
              },
            }}
          />
        </Providers>
      </body>
    </html>
  )
}
