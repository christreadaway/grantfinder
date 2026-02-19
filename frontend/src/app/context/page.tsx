'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Globe, FileText, MessageSquare, HelpCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/hooks/useAuth'
import { useSSE } from '@/hooks/useSSE'
import { useAppStore } from '@/lib/store'
import {
  updateOrganization,
  generateQuestionnaire,
  uploadDocuments,
  getDocuments,
  getScanWebsiteUrl,
  getProcessDocumentsUrl,
} from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card'
import { FileUpload } from '@/components/forms/FileUpload'
import { Questionnaire } from '@/components/forms/Questionnaire'
import { Terminal } from '@/components/terminal/Terminal'
import type { Question, Document as DocType } from '@/types'

export default function ContextPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const { currentOrganization, currentGrantDatabase, setCurrentOrganization } = useAppStore()
  const { lines, isConnected, connect, clearLines } = useSSE()

  // State
  const [activeTab, setActiveTab] = useState<'website' | 'questionnaire' | 'freeform' | 'documents'>('website')
  const [questions, setQuestions] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Record<string, any>>({})
  const [freeFormNotes, setFreeFormNotes] = useState('')
  const [docFiles, setDocFiles] = useState<File[]>([])
  const [uploadedDocs, setUploadedDocs] = useState<DocType[]>([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [websiteScanned, setWebsiteScanned] = useState(false)
  const [docsProcessed, setDocsProcessed] = useState(false)

  useEffect(() => {
    if (!currentOrganization || !currentGrantDatabase) {
      router.push('/setup')
      return
    }

    // Load questionnaire
    loadQuestionnaire()
    // Load existing answers
    if (currentOrganization.questionnaire_answers) {
      setAnswers(currentOrganization.questionnaire_answers)
    }
    if (currentOrganization.free_form_notes) {
      setFreeFormNotes(currentOrganization.free_form_notes)
    }
    if (currentOrganization.website_extracted) {
      setWebsiteScanned(true)
    }
    // Load documents
    loadDocuments()
  }, [currentOrganization, currentGrantDatabase, router])

  const loadQuestionnaire = async () => {
    if (!currentGrantDatabase) return
    try {
      const response = await generateQuestionnaire(currentGrantDatabase.id)
      setQuestions(response.data.questions || [])
    } catch (error) {
      console.error('Failed to load questionnaire:', error)
    }
  }

  const loadDocuments = async () => {
    if (!currentOrganization) return
    try {
      const response = await getDocuments(currentOrganization.id)
      setUploadedDocs(response.data)
      if (response.data.some((d: DocType) => (d.extracted_needs?.length ?? 0) > 0)) {
        setDocsProcessed(true)
      }
    } catch (error) {
      console.error('Failed to load documents:', error)
    }
  }

  const handleScanWebsite = async () => {
    if (!currentOrganization) return
    if (!currentOrganization.church_website && !currentOrganization.school_website) {
      toast.error('No website URLs configured')
      return
    }

    setIsProcessing(true)
    clearLines()

    const token = localStorage.getItem('token')
    const url = `${getScanWebsiteUrl(currentOrganization.id)}`

    try {
      const eventSource = new EventSource(`${url}`, {
        withCredentials: false,
      })

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'complete') {
            setWebsiteScanned(true)
            setIsProcessing(false)
            eventSource.close()
            toast.success('Website scan complete')
          }
        } catch (e) {
          console.error('Parse error:', e)
        }
      }

      eventSource.onerror = () => {
        setIsProcessing(false)
        eventSource.close()
      }

      connect(url, {
        onComplete: () => {
          setWebsiteScanned(true)
          setIsProcessing(false)
        },
      })
    } catch (error) {
      setIsProcessing(false)
      toast.error('Failed to scan website')
    }
  }

  const handleUploadDocs = async () => {
    if (!currentOrganization || docFiles.length === 0) return

    try {
      const response = await uploadDocuments(currentOrganization.id, docFiles)
      setUploadedDocs(response.data.documents)
      setDocFiles([])
      toast.success(response.data.message)
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to upload documents')
    }
  }

  const handleProcessDocs = async () => {
    if (!currentOrganization) return

    setIsProcessing(true)
    clearLines()

    connect(getProcessDocumentsUrl(currentOrganization.id), {
      onComplete: () => {
        setDocsProcessed(true)
        setIsProcessing(false)
        loadDocuments()
      },
    })
  }

  const handleSaveAndContinue = async () => {
    if (!currentOrganization) return

    try {
      await updateOrganization(currentOrganization.id, {
        questionnaire_answers: answers,
        free_form_notes: freeFormNotes,
      })
      router.push('/profile')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to save')
    }
  }

  if (authLoading || !currentOrganization) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  const tabs = [
    { id: 'website', label: 'Website', icon: Globe },
    { id: 'questionnaire', label: 'Questionnaire', icon: HelpCircle },
    { id: 'freeform', label: 'Tell Us More', icon: MessageSquare },
    { id: 'documents', label: 'Documents', icon: FileText },
  ] as const

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Tell us about your parish</h1>
            <p className="text-gray-400">{currentOrganization.name}</p>
          </div>
          <Button variant="ghost" onClick={() => router.push('/setup')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-gray-700 pb-2 overflow-x-auto">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="min-h-[400px]">
          {activeTab === 'website' && (
            <Card>
              <CardHeader>
                <CardTitle>Website Scanning</CardTitle>
                <CardDescription>
                  AI will crawl your website to learn about your organization
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {currentOrganization.church_website && (
                  <p className="text-gray-300">Church: {currentOrganization.church_website}</p>
                )}
                {currentOrganization.school_website && (
                  <p className="text-gray-300">School: {currentOrganization.school_website}</p>
                )}

                {!currentOrganization.church_website && !currentOrganization.school_website && (
                  <p className="text-gray-400">No website URLs configured. You can add them in Setup.</p>
                )}

                {(currentOrganization.church_website || currentOrganization.school_website) && (
                  <>
                    {websiteScanned ? (
                      <div className="p-4 rounded-lg bg-green-900/20 border border-green-700">
                        <p className="text-green-400">✓ Website scanned successfully</p>
                      </div>
                    ) : (
                      <Button onClick={handleScanWebsite} isLoading={isProcessing}>
                        <Globe className="w-4 h-4 mr-2" />
                        Scan Website
                      </Button>
                    )}
                  </>
                )}

                {lines.length > 0 && (
                  <Terminal title="Website Scanning" lines={lines} isActive={isProcessing} />
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === 'questionnaire' && (
            <Card>
              <CardHeader>
                <CardTitle>Smart Questionnaire</CardTitle>
                <CardDescription>
                  Questions based on what grants in your database actually require
                </CardDescription>
              </CardHeader>
              <CardContent>
                {questions.length > 0 ? (
                  <Questionnaire
                    questions={questions}
                    answers={answers}
                    onAnswersChange={setAnswers}
                  />
                ) : (
                  <p className="text-gray-400">Loading questionnaire...</p>
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === 'freeform' && (
            <Card>
              <CardHeader>
                <CardTitle>Tell Us More</CardTitle>
                <CardDescription>
                  What's happening at your parish? Projects, needs, or plans you're thinking about?
                </CardDescription>
              </CardHeader>
              <CardContent>
                <textarea
                  value={freeFormNotes}
                  onChange={(e) => setFreeFormNotes(e.target.value)}
                  placeholder="We're hoping to renovate the gym next year. The AC in the school has been failing. Father wants to explore security cameras after some incidents in the parking lot..."
                  className="w-full h-48 rounded-lg border border-gray-600 bg-gray-800 px-4 py-3 text-gray-100 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
              </CardContent>
            </Card>
          )}

          {activeTab === 'documents' && (
            <Card>
              <CardHeader>
                <CardTitle>Document Uploads</CardTitle>
                <CardDescription>
                  Bulletins, meeting minutes, newsletters, strategic plans
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FileUpload
                  files={docFiles}
                  onFilesChange={setDocFiles}
                  hint="PDF, DOCX, or TXT files"
                />

                {docFiles.length > 0 && (
                  <Button onClick={handleUploadDocs}>Upload Documents</Button>
                )}

                {uploadedDocs.length > 0 && (
                  <div className="space-y-4">
                    <h4 className="font-medium text-gray-300">Uploaded Documents</h4>
                    <ul className="space-y-2">
                      {uploadedDocs.map((doc) => (
                        <li
                          key={doc.id}
                          className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50 border border-gray-700"
                        >
                          <span className="text-gray-200">{doc.filename}</span>
                          <span
                            className={`text-sm ${
                              doc.status === 'completed' ? 'text-green-400' : 'text-gray-400'
                            }`}
                          >
                            {doc.status}
                          </span>
                        </li>
                      ))}
                    </ul>

                    {!docsProcessed && (
                      <Button onClick={handleProcessDocs} isLoading={isProcessing}>
                        <FileText className="w-4 h-4 mr-2" />
                        Process Documents with AI
                      </Button>
                    )}

                    {docsProcessed && (
                      <div className="p-4 rounded-lg bg-green-900/20 border border-green-700">
                        <p className="text-green-400">✓ Documents processed</p>
                      </div>
                    )}
                  </div>
                )}

                {lines.length > 0 && activeTab === 'documents' && (
                  <Terminal title="Document Processing" lines={lines} isActive={isProcessing} />
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Continue Button */}
        <div className="flex justify-end pt-4 border-t border-gray-700">
          <Button onClick={handleSaveAndContinue} size="lg">
            Process & Review Profile
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    </div>
  )
}
