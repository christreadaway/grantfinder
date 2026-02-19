import axios from 'axios'

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Add auth token to requests
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
  }
  return config
})

// Handle auth errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        window.location.href = '/'
      }
    }
    return Promise.reject(error)
  }
)

export default api

// Auth
export const getGoogleAuthUrl = () => api.get<{ auth_url: string }>('/auth/google')
export const googleCallback = (code: string) =>
  api.post<{ access_token: string; user: any }>('/auth/google/callback', null, { params: { code } })

// Users
export const getCurrentUser = () => api.get('/users/me')
export const updateUser = (data: { name?: string; api_key?: string }) =>
  api.put('/users/me', data)

// Organizations
export const getOrganizations = () => api.get('/organizations/')
export const createOrganization = (data: { name: string; church_website?: string; school_website?: string }) =>
  api.post('/organizations/', data)
export const getOrganization = (id: number) => api.get(`/organizations/${id}`)
export const updateOrganization = (id: number, data: any) => api.put(`/organizations/${id}`, data)
export const deleteOrganization = (id: number) => api.delete(`/organizations/${id}`)
export const generateProfile = (orgId: number) => api.post(`/organizations/${orgId}/generate-profile`)

// Grants
export const getGrantDatabases = () => api.get('/grants/databases')
export const uploadGrantDatabase = (file: File, name?: string) => {
  const formData = new FormData()
  formData.append('file', file)
  if (name) formData.append('name', name)
  return api.post('/grants/databases/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}
export const getGrants = (dbId: number) => api.get(`/grants/databases/${dbId}`)
export const deleteGrantDatabase = (dbId: number) => api.delete(`/grants/databases/${dbId}`)
export const generateQuestionnaire = (dbId: number) => api.post(`/grants/databases/${dbId}/generate-questionnaire`)

// Documents
export const getDocuments = (orgId: number) => api.get(`/documents/${orgId}`)
export const uploadDocuments = (orgId: number, files: File[]) => {
  const formData = new FormData()
  files.forEach((file) => formData.append('files', file))
  return api.post(`/documents/${orgId}/upload`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}
export const deleteDocument = (orgId: number, docId: number) =>
  api.delete(`/documents/${orgId}/${docId}`)

// Matching
export const getMatchingSession = (sessionId: number) => api.get(`/matching/sessions/${sessionId}`)
export const exportResults = (sessionId: number, format: 'markdown' | 'csv' | 'json') =>
  api.get(`/matching/sessions/${sessionId}/export/${format}`, {
    responseType: format === 'json' ? 'json' : 'blob',
  })

// SSE endpoints (for streaming)
export const getScanWebsiteUrl = (orgId: number) => `${API_URL}/api/organizations/${orgId}/scan-website`
export const getProcessDocumentsUrl = (orgId: number) => `${API_URL}/api/documents/${orgId}/process`
export const getMatchingUrl = (orgId: number, grantDbId: number) =>
  `${API_URL}/api/matching/${orgId}/match?grant_database_id=${grantDbId}`
