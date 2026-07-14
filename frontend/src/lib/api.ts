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

  // Grant discovery endpoints
  async loadStarterDatabase() {
    const response = await this.client.post('/api/discovery/seed');
    return response.data;
  }

  async searchGrantsGov(keywords?: string[], maxResults?: number) {
    const response = await this.client.post('/api/discovery/grants-gov', {
      keywords,
      max_results: maxResults,
    });
    return response.data;
  }

  async webDiscovery(focus?: string) {
    const response = await this.client.post('/api/discovery/web-search', { focus });
    return response.data;
  }

  async getDiscoverySources() {
    const response = await this.client.get('/api/discovery/sources');
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

  // Writer module endpoints
  async createApplication(grantId: string) {
    const response = await this.client.post('/api/writer/applications', { grant_id: grantId });
    return response.data;
  }

  async getApplication(appId: string) {
    const response = await this.client.get(`/api/writer/applications/${appId}`);
    return response.data;
  }

  async enrichGrantSpec(appId: string, guidelinesText?: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/grant-spec`, {
      guidelines_text: guidelinesText || null,
    });
    return response.data;
  }

  async analyzeFit(appId: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/analyze`);
    return response.data;
  }

  async confirmStrategy(appId: string, strategy?: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/confirm-strategy`, {
      strategy: strategy || null,
    });
    return response.data;
  }

  async generateIntake(appId: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/intake/generate`);
    return response.data;
  }

  async answerIntake(appId: string, requestId: string, responseText: string, isConfirmedGap: boolean) {
    const response = await this.client.put(
      `/api/writer/applications/${appId}/intake/${requestId}/answer`,
      { response: responseText, is_confirmed_gap: isConfirmedGap },
    );
    return response.data;
  }

  async waiveGap(appId: string, gapId: string, reason?: string) {
    const response = await this.client.put(
      `/api/writer/applications/${appId}/gaps/${gapId}/waive`,
      { reason: reason || null },
    );
    return response.data;
  }

  async draftSections(appId: string, sectionId?: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/draft`, {
      section_id: sectionId || null,
    });
    return response.data;
  }

  async scoreApplication(appId: string) {
    const response = await this.client.post(`/api/writer/applications/${appId}/score`);
    return response.data;
  }

  async refineSection(appId: string, sectionId: string, instruction: string) {
    const response = await this.client.post(
      `/api/writer/applications/${appId}/sections/${sectionId}/refine`,
      { instruction },
    );
    return response.data;
  }

  async exportApplication(appId: string, format: 'docx' | 'md' | 'txt' | 'form_map') {
    const response = await this.client.post(
      `/api/writer/applications/${appId}/export`,
      { format },
      { responseType: 'blob' },
    );
    return response;
  }

  async analyzeVoice(samples: string[]) {
    const response = await this.client.post('/api/writer/voice/analyze', { samples });
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
