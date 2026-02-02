/**
 * API client for GrantFinder AI backend
 */
import axios, { AxiosInstance } from 'axios';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

class ApiClient {
  private client: AxiosInstance;
  private token: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add auth interceptor
    this.client.interceptors.request.use((config) => {
      if (this.token) {
        config.headers.Authorization = `Bearer ${this.token}`;
      }
      return config;
    });
  }

  setToken(token: string) {
    this.token = token;
    if (typeof window !== 'undefined') {
      localStorage.setItem('auth_token', token);
    }
  }

  loadToken() {
    if (typeof window !== 'undefined') {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  clearToken() {
    this.token = null;
    if (typeof window !== 'undefined') {
      localStorage.removeItem('auth_token');
    }
  }

  // Auth endpoints
  async googleAuth(credential: string) {
    const response = await this.client.post('/api/auth/google', { credential });
    this.setToken(response.data.access_token);
    return response.data;
  }

  async getMe() {
    const response = await this.client.get('/api/auth/me');
    return response.data;
  }

  async setApiKey(apiKey: string) {
    const response = await this.client.post('/api/auth/api-key', { api_key: apiKey });
    return response.data;
  }

  async getApiKeyStatus() {
    const response = await this.client.get('/api/auth/api-key/status');
    return response.data;
  }

  // Grant endpoints
  async uploadGrantDatabase(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.client.post('/api/grants/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  }

  async getGrants(category?: string) {
    const params = category ? { category } : {};
    const response = await this.client.get('/api/grants/', { params });
    return response.data;
  }

  async getGrantStats() {
    const response = await this.client.get('/api/grants/stats');
    return response.data;
  }

  // Processing endpoints
  async scanWebsite(churchUrl?: string, schoolUrl?: string) {
    const response = await this.client.post('/api/processing/scan-website', {
      church_url: churchUrl,
      school_url: schoolUrl,
    });
    return response.data;
  }

  async generateQuestionnaire() {
    const response = await this.client.post('/api/processing/generate-questionnaire');
    return response.data;
  }

  async submitQuestionnaire(answers: any[], freeFormText?: string) {
    const response = await this.client.post('/api/processing/submit-questionnaire', {
      answers,
      free_form_text: freeFormText,
    });
    return response.data;
  }

  async uploadDocument(file: File) {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.client.post('/api/processing/upload-document', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return response.data;
  }

  async getProfile() {
    const response = await this.client.get('/api/processing/profile');
    return response.data;
  }

  async updateProfile(profile: any) {
    const response = await this.client.put('/api/processing/profile', profile);
    return response.data;
  }

  async matchGrants() {
    const response = await this.client.post('/api/processing/match-grants');
    return response.data;
  }

  // Export endpoints
  async exportResults(sessionId: string, format: 'csv' | 'md' | 'pdf', includeAll: boolean = false) {
    const response = await this.client.post('/api/export/', {
      session_id: sessionId,
      format,
      include_all_matches: includeAll,
    }, { responseType: 'blob' });
    return response.data;
  }
}

export const api = new ApiClient();
export default api;
