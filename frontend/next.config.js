/** @type {import('next').NextConfig} */

// Netlify sets NETLIFY=true during builds. Without the backend URL, every
// visitor's browser would call http://localhost:8000, so fail the build loudly
// with the fix instead of shipping a site that can't reach its backend.
if (process.env.NETLIFY === 'true') {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || '';
  if (!apiUrl) {
    throw new Error(
      'NEXT_PUBLIC_API_URL is not set. In Netlify: Site configuration > Environment variables > ' +
      'add NEXT_PUBLIC_API_URL = your backend URL (https://....up.railway.app), then redeploy.'
    );
  }
  if (!apiUrl.startsWith('https://')) {
    throw new Error(
      `NEXT_PUBLIC_API_URL must start with https:// (got "${apiUrl}"). ` +
      'Browsers block an https site from calling an http backend.'
    );
  }
}

const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
}

module.exports = nextConfig
