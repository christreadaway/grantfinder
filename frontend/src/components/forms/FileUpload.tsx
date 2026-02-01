'use client'

import { useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { Upload, File, X } from 'lucide-react'
import { clsx } from 'clsx'

interface FileUploadProps {
  accept?: Record<string, string[]>
  multiple?: boolean
  files: File[]
  onFilesChange: (files: File[]) => void
  maxFiles?: number
  label?: string
  hint?: string
}

export function FileUpload({
  accept = {
    'application/pdf': ['.pdf'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    'text/plain': ['.txt'],
  },
  multiple = true,
  files,
  onFilesChange,
  maxFiles = 20,
  label = 'Upload files',
  hint,
}: FileUploadProps) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      const newFiles = [...files, ...acceptedFiles].slice(0, maxFiles)
      onFilesChange(newFiles)
    },
    [files, onFilesChange, maxFiles]
  )

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    multiple,
    maxFiles: maxFiles - files.length,
  })

  const removeFile = (index: number) => {
    const newFiles = files.filter((_, i) => i !== index)
    onFilesChange(newFiles)
  }

  return (
    <div className="space-y-3">
      {label && <label className="block text-sm font-medium text-gray-300">{label}</label>}

      <div
        {...getRootProps()}
        className={clsx(
          'border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors',
          {
            'border-blue-500 bg-blue-500/10': isDragActive,
            'border-gray-600 hover:border-gray-500': !isDragActive,
          }
        )}
      >
        <input {...getInputProps()} />
        <Upload className="w-10 h-10 mx-auto text-gray-400 mb-3" />
        {isDragActive ? (
          <p className="text-gray-300">Drop files here...</p>
        ) : (
          <div>
            <p className="text-gray-300">Drag & drop files here, or click to select</p>
            {hint && <p className="text-sm text-gray-500 mt-1">{hint}</p>}
          </div>
        )}
      </div>

      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((file, index) => (
            <li
              key={index}
              className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50 border border-gray-700"
            >
              <div className="flex items-center gap-3">
                <File className="w-5 h-5 text-gray-400" />
                <div>
                  <p className="text-sm text-gray-200">{file.name}</p>
                  <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeFile(index)}
                className="p-1 text-gray-400 hover:text-red-400 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
