'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ArrowRight, Edit3, Plus, X, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import { useAuth } from '@/hooks/useAuth'
import { useSSE } from '@/hooks/useSSE'
import { useAppStore } from '@/lib/store'
import { generateProfile, getOrganization } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/Card'
import { Terminal } from '@/components/terminal/Terminal'
import type { OrganizationProfile, ExtractedNeed } from '@/types'

export default function ProfilePage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const { currentOrganization, setCurrentOrganization } = useAppStore()
  const { lines, addLine, clearLines } = useSSE()

  const [profile, setProfile] = useState<OrganizationProfile | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [editingNeeds, setEditingNeeds] = useState(false)
  const [needs, setNeeds] = useState<ExtractedNeed[]>([])

  useEffect(() => {
    if (!currentOrganization) {
      router.push('/setup')
      return
    }

    if (currentOrganization.profile_json) {
      setProfile(currentOrganization.profile_json as OrganizationProfile)
      setNeeds(currentOrganization.profile_json.needs_and_projects || [])
    } else {
      handleGenerateProfile()
    }
  }, [currentOrganization, router])

  const handleGenerateProfile = async () => {
    if (!currentOrganization) return

    setIsGenerating(true)
    clearLines()
    addLine('Loading organization data...', 'status')

    try {
      addLine('Synthesizing profile with AI...', 'status')
      const response = await generateProfile(currentOrganization.id)
      const newProfile = response.data as OrganizationProfile

      addLine('Profile generated successfully', 'success')
      setProfile(newProfile)
      setNeeds(newProfile.needs_and_projects || [])

      // Refresh organization data
      const orgResponse = await getOrganization(currentOrganization.id)
      setCurrentOrganization(orgResponse.data)
    } catch (error: any) {
      addLine('Failed to generate profile', 'error')
      toast.error(error.response?.data?.detail || 'Failed to generate profile')
    } finally {
      setIsGenerating(false)
    }
  }

  const removeNeed = (index: number) => {
    setNeeds(needs.filter((_, i) => i !== index))
  }

  const handleContinue = () => {
    router.push('/results')
  }

  if (authLoading || !currentOrganization) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    )
  }

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-100">Parish Profile</h1>
            <p className="text-gray-400">Review what we learned about your organization</p>
          </div>
          <Button variant="ghost" onClick={() => router.push('/context')}>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back
          </Button>
        </div>

        {/* Generating State */}
        {isGenerating && (
          <Terminal title="Generating Profile" lines={lines} isActive={isGenerating} />
        )}

        {/* Profile Content */}
        {profile && !isGenerating && (
          <>
            {/* Organization Facts */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Organization Facts</CardTitle>
                  <Button variant="ghost" size="sm">
                    <Edit3 className="w-4 h-4 mr-2" />
                    Edit
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {profile.organization_facts.is_501c3 && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />
                      501(c)(3) organization
                    </li>
                  )}
                  {profile.organization_facts.in_catholic_directory && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />
                      Listed in Official Catholic Directory
                    </li>
                  )}
                  {profile.organization_facts.diocese && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />
                      {profile.organization_facts.diocese}, {profile.organization_facts.state}
                    </li>
                  )}
                  {profile.organization_facts.type === 'parish_with_school' && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />
                      Parish with school ({profile.organization_facts.school_grades})
                    </li>
                  )}
                  {profile.organization_facts.student_count && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />
                      {profile.organization_facts.student_count} students
                    </li>
                  )}
                  {profile.organization_facts.parish_families && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />~{profile.organization_facts.parish_families} registered families
                    </li>
                  )}
                  {profile.organization_facts.building_age_years && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />
                      Building is {profile.organization_facts.building_age_years} years old
                    </li>
                  )}
                  {profile.organization_facts.location_type && (
                    <li className="flex items-center gap-2 text-gray-300">
                      <Check className="w-4 h-4 text-green-400" />
                      {profile.organization_facts.location_type.charAt(0).toUpperCase() +
                        profile.organization_facts.location_type.slice(1)}{' '}
                      location
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>

            {/* Needs & Projects */}
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Needs & Projects Identified</CardTitle>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingNeeds(!editingNeeds)}
                  >
                    <Edit3 className="w-4 h-4 mr-2" />
                    {editingNeeds ? 'Done' : 'Edit'}
                  </Button>
                </div>
                <CardDescription>
                  These are the needs we identified from your inputs
                </CardDescription>
              </CardHeader>
              <CardContent>
                {needs.length === 0 ? (
                  <p className="text-gray-400">No needs identified yet</p>
                ) : (
                  <div className="space-y-4">
                    {/* Group by source type */}
                    {['document', 'website', 'questionnaire', 'free_form'].map((sourceType) => {
                      const typeNeeds = needs.filter((n) => n.source_type === sourceType)
                      if (typeNeeds.length === 0) return null

                      const labels: Record<string, string> = {
                        document: 'From your documents',
                        website: 'From your website',
                        questionnaire: 'From questionnaire',
                        free_form: 'From your notes',
                      }

                      return (
                        <div key={sourceType}>
                          <h4 className="text-sm font-medium text-gray-400 mb-2">
                            {labels[sourceType]}
                          </h4>
                          <ul className="space-y-2">
                            {typeNeeds.map((need, index) => (
                              <li
                                key={index}
                                className="flex items-start justify-between p-3 rounded-lg bg-gray-800/50 border border-gray-700"
                              >
                                <div className="flex-1">
                                  <p className="text-gray-200">{need.need}</p>
                                  {need.quote && (
                                    <p className="text-sm text-gray-500 mt-1 italic">
                                      "{need.quote}"
                                    </p>
                                  )}
                                  <p className="text-xs text-gray-500 mt-1">— {need.source}</p>
                                </div>
                                {editingNeeds && (
                                  <button
                                    onClick={() => removeNeed(needs.indexOf(need))}
                                    className="ml-2 p-1 text-gray-400 hover:text-red-400"
                                  >
                                    <X className="w-4 h-4" />
                                  </button>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )
                    })}
                  </div>
                )}

                {editingNeeds && (
                  <Button variant="outline" size="sm" className="mt-4">
                    <Plus className="w-4 h-4 mr-2" />
                    Add Another Need
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Capacity Indicators */}
            {profile.capacity_indicators && (
              <Card>
                <CardHeader>
                  <CardTitle>Capacity Indicators</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid md:grid-cols-2 gap-4">
                    {profile.capacity_indicators.active_ministries > 0 && (
                      <div className="p-3 rounded-lg bg-gray-800/50 border border-gray-700">
                        <p className="text-gray-400 text-sm">Active Ministries</p>
                        <p className="text-xl font-semibold text-gray-100">
                          {profile.capacity_indicators.active_ministries}
                        </p>
                      </div>
                    )}
                    {profile.capacity_indicators.programs.length > 0 && (
                      <div className="p-3 rounded-lg bg-gray-800/50 border border-gray-700">
                        <p className="text-gray-400 text-sm">Programs</p>
                        <p className="text-gray-200">
                          {profile.capacity_indicators.programs.slice(0, 3).join(', ')}
                          {profile.capacity_indicators.programs.length > 3 && '...'}
                        </p>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Special Characteristics */}
            {profile.special_characteristics && profile.special_characteristics.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Special Characteristics</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-2">
                    {profile.special_characteristics.map((char, index) => (
                      <li key={index} className="flex items-center gap-2 text-gray-300">
                        <span className="text-blue-400">•</span>
                        {char}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Continue Button */}
        <div className="flex justify-between pt-4 border-t border-gray-700">
          <Button variant="outline" onClick={handleGenerateProfile} disabled={isGenerating}>
            Regenerate Profile
          </Button>
          <Button onClick={handleContinue} size="lg" disabled={!profile || isGenerating}>
            Find Matching Grants
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </div>
      </div>
    </div>
  )
}
