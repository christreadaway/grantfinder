'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Settings, Upload, Building2, ArrowRight } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/hooks/useAuth'
import { useAppStore } from '@/lib/store'
import {
  updateUser,
  createOrganization,
  getOrganizations,
  uploadGrantDatabase,
  getGrantDatabases,
} from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card'
import { FileUpload } from '@/components/forms/FileUpload'
import type { Organization, GrantDatabase } from '@/types'

export default function SetupPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const { setCurrentOrganization, setCurrentGrantDatabase } = useAppStore()

  // Form state
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [orgName, setOrgName] = useState('')
  const [churchWebsite, setChurchWebsite] = useState('')
  const [schoolWebsite, setSchoolWebsite] = useState('')
  const [grantFiles, setGrantFiles] = useState<File[]>([])

  // Existing data
  const [organizations, setOrganizations] = useState<Organization[]>([])
  const [grantDatabases, setGrantDatabases] = useState<GrantDatabase[]>([])
  const [selectedOrg, setSelectedOrg] = useState<Organization | null>(null)
  const [selectedDb, setSelectedDb] = useState<GrantDatabase | null>(null)

  // Loading states
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSavingKey, setIsSavingKey] = useState(false)

  useEffect(() => {
    if (user) {
      setHasApiKey(user.has_api_key)
      loadExistingData()
    }
  }, [user])

  const loadExistingData = async () => {
    try {
      const [orgsResponse, grantsResponse] = await Promise.all([
        getOrganizations(),
        getGrantDatabases(),
      ])
      setOrganizations(orgsResponse.data)
      setGrantDatabases(grantsResponse.data)
    } catch (error) {
      console.error('Failed to load existing data:', error)
    }
  }

  const handleSaveApiKey = async () => {
    if (!apiKey.trim()) return

    setIsSavingKey(true)
    try {
      await updateUser({ api_key: apiKey })
      setHasApiKey(true)
      setApiKey('')
      toast.success('API key saved securely')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to save API key')
    } finally {
      setIsSavingKey(false)
    }
  }

  const handleContinue = async () => {
    if (!hasApiKey) {
      toast.error('Please add your Claude API key')
      return
    }

    setIsSubmitting(true)
    try {
      // Create or select organization
      let org = selectedOrg
      if (!org && orgName.trim()) {
        const response = await createOrganization({
          name: orgName,
          church_website: churchWebsite || undefined,
          school_website: schoolWebsite || undefined,
        })
        org = response.data
      }

      if (!org) {
        toast.error('Please create or select an organization')
        setIsSubmitting(false)
        return
      }

      // Upload grant database if provided
      let grantDb = selectedDb
      if (!grantDb && grantFiles.length > 0) {
        const response = await uploadGrantDatabase(grantFiles[0])
        grantDb = response.data
      }

      if (!grantDb) {
        toast.error('Please upload a grant database')
        setIsSubmitting(false)
        return
      }

      // Set current state and navigate
      setCurrentOrganization(org)
      setCurrentGrantDatabase(grantDb)
      router.push('/context')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || 'Failed to continue')
    } finally {
      setIsSubmitting(false)
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Welcome, {user?.name}!</h1>
            <p className="text-gray-400">Let's get you set up</p>
          </div>
          <Button variant="ghost" size="sm">
            <Settings className="w-4 h-4 mr-2" />
            Settings
          </Button>
        </div>

        {/* Step 1: API Key */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-sm">
                1
              </span>
              Claude API Key
            </CardTitle>
            <CardDescription>
              Your key is stored securely and used only for your requests
            </CardDescription>
          </CardHeader>
          <CardContent>
            {hasApiKey ? (
              <div className="flex items-center justify-between p-3 rounded-lg bg-green-900/20 border border-green-700">
                <span className="text-green-400">✓ API key configured</span>
                <Button variant="ghost" size="sm" onClick={() => setHasApiKey(false)}>
                  Change
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <Input
                  type="password"
                  placeholder="sk-ant-api03-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
                <div className="flex items-center justify-between">
                  <a
                    href="https://console.anthropic.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-blue-400 hover:underline"
                  >
                    Get an API key from Anthropic →
                  </a>
                  <Button onClick={handleSaveApiKey} isLoading={isSavingKey} disabled={!apiKey.trim()}>
                    Save Key
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 2: Organization */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-sm">
                2
              </span>
              Your Organization
            </CardTitle>
            <CardDescription>Tell us about your parish or school</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {organizations.length > 0 && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-300">
                  Select existing organization
                </label>
                <select
                  value={selectedOrg?.id || ''}
                  onChange={(e) => {
                    const org = organizations.find((o) => o.id === parseInt(e.target.value))
                    setSelectedOrg(org || null)
                  }}
                  className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-gray-100"
                >
                  <option value="">Create new organization...</option>
                  {organizations.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {!selectedOrg && (
              <div className="space-y-4">
                <Input
                  label="Organization Name"
                  placeholder="St. Theresa Catholic Church"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                />
                <Input
                  label="Church Website (optional)"
                  placeholder="https://sttheresa.org"
                  value={churchWebsite}
                  onChange={(e) => setChurchWebsite(e.target.value)}
                />
                <Input
                  label="School Website (optional)"
                  placeholder="https://sttheresaschool.org"
                  value={schoolWebsite}
                  onChange={(e) => setSchoolWebsite(e.target.value)}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Step 3: Grant Database */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-sm">
                3
              </span>
              Grant Database
            </CardTitle>
            <CardDescription>Upload your Excel file with grant opportunities</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {grantDatabases.length > 0 && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-300">
                  Select existing database
                </label>
                <select
                  value={selectedDb?.id || ''}
                  onChange={(e) => {
                    const db = grantDatabases.find((d) => d.id === parseInt(e.target.value))
                    setSelectedDb(db || null)
                  }}
                  className="w-full rounded-lg border border-gray-600 bg-gray-800 px-4 py-2 text-gray-100"
                >
                  <option value="">Upload new database...</option>
                  {grantDatabases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name} ({db.grant_count} grants)
                    </option>
                  ))}
                </select>
              </div>
            )}

            {!selectedDb && (
              <FileUpload
                accept={{ 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] }}
                multiple={false}
                files={grantFiles}
                onFilesChange={setGrantFiles}
                maxFiles={1}
                hint="Excel file (.xlsx) with grant opportunities"
              />
            )}
          </CardContent>
        </Card>

        {/* Continue Button */}
        <Button
          onClick={handleContinue}
          isLoading={isSubmitting}
          size="lg"
          className="w-full"
          disabled={!hasApiKey || (!selectedOrg && !orgName) || (!selectedDb && grantFiles.length === 0)}
        >
          Continue
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </div>
    </div>
  )
}
