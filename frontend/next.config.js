/** @type {import('next').NextConfig} */

// GrantFinder runs entirely on Netlify, on any plan: this Next.js app serves
// the website AND the engine (src/server, mounted at /api/*). AI steps run
// inside normal requests, or in the optional background function
// (netlify/background/) when GRANTFINDER_BACKGROUND_JOBS=true.
//
// Netlify sets NETLIFY=true during builds. SECRET_KEY signs every sign-in and
// encrypts saved Claude API keys, so refuse to build a site without it rather
// than ship one where nobody can sign in.
const onNetlify = process.env.NETLIFY === 'true';

if (onNetlify) {
  const secret = process.env.SECRET_KEY || '';
  if (!secret) {
    throw new Error(
      'SECRET_KEY is not set. In Netlify: Site configuration > Environment variables > add SECRET_KEY ' +
      '(at least 32 random characters; docs/deployment.md Step 2 shows how to make one), then redeploy.'
    );
  }
  if (secret.length < 32) {
    throw new Error(`SECRET_KEY must be at least 32 characters (it is ${secret.length}). Make a longer one and redeploy.`);
  }
}

const nextConfig = {
  reactStrictMode: true,
  // The old Python API accepted paths like /api/grants/ ; keep them working
  // instead of redirecting (a redirect would drop POST bodies in some clients).
  skipTrailingSlashRedirect: true,
  // Lets server code know it is running on Netlify (Blobs storage, background jobs).
  env: {
    GRANTFINDER_ON_NETLIFY: onNetlify ? 'true' : '',
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'lh3.googleusercontent.com' },
    ],
  },
}

module.exports = nextConfig
