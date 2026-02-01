'use client'

import { forwardRef } from 'react'
import { clsx } from 'clsx'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, hint, id, ...props }, ref) => {
    const inputId = id || label?.toLowerCase().replace(/\s/g, '-')

    return (
      <div className="space-y-1">
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-gray-300">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={clsx(
            'block w-full rounded-lg border bg-gray-800 px-4 py-2 text-gray-100',
            'placeholder:text-gray-500',
            'focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900',
            {
              'border-gray-600 focus:border-blue-500 focus:ring-blue-500': !error,
              'border-red-500 focus:border-red-500 focus:ring-red-500': error,
            },
            className
          )}
          {...props}
        />
        {hint && !error && <p className="text-sm text-gray-500">{hint}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    )
  }
)

Input.displayName = 'Input'
