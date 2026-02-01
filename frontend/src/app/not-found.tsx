import Link from 'next/link'

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-gray-100">404</h1>
        <p className="text-gray-400">Page not found</p>
        <Link href="/" className="text-blue-400 hover:underline">
          Return home
        </Link>
      </div>
    </div>
  )
}
