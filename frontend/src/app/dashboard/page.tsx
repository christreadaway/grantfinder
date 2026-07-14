'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, Upload, Globe, FileText, MessageSquare, Play,
  CheckCircle, AlertCircle, Loader2, ChevronRight, Settings,
  LogOut, Database, BarChart3, Download
} from 'lucide-react';
import api from '@/lib/api';
import { useStore } from '@/lib/store';

type SetupStep = 'api-key' | 'grants' | 'website' | 'questionnaire' | 'documents' | 'processing' | 'results';

interface ProcessingLog {
  timestamp: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export default function Dashboard() {
  const router = useRouter();
  const { user, setUser, matchResults, setMatchResults } = useStore();
  const [currentStep, setCurrentStep] = useState<SetupStep>('api-key');
  const [apiKey, setApiKey] = useState('');
  const [apiKeySet, setApiKeySet] = useState(false);
  const [grantFile, setGrantFile] = useState<File | null>(null);
  const [grantStats, setGrantStats] = useState<any>(null);
  const [discoveredTotal, setDiscoveredTotal] = useState(0);
  const [discoveryStatus, setDiscoveryStatus] = useState<string | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState<string | null>(null);
  const [churchUrl, setChurchUrl] = useState('');
  const [schoolUrl, setSchoolUrl] = useState('');
  const [websiteScanned, setWebsiteScanned] = useState(false);
  const [questionnaire, setQuestionnaire] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<number, any>>({});
  const [freeFormText, setFreeFormText] = useState('');
  const [documents, setDocuments] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLogs, setProcessingLogs] = useState<ProcessingLog[]>([]);
  const terminalRef = useRef<HTMLDivElement>(null);

  // Check auth status on mount
  useEffect(() => {
    const token = api.loadToken();
    if (!token && !user) {
      // Demo mode - create fake user
      setUser({
        id: 'demo-user',
        email: 'demo@example.com',
        name: 'Demo User',
        claude_api_key_set: false,
      });
    }
  }, [user, setUser]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [processingLogs]);

  const addLog = (status: ProcessingLog['status'], message: string) => {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    setProcessingLogs(prev => [...prev, { timestamp, status, message }]);
  };

  const handleApiKeySubmit = async () => {
    if (!apiKey.startsWith('sk-ant-')) {
      alert('Invalid API key format. Claude API keys start with "sk-ant-"');
      return;
    }
    try {
      await api.setApiKey(apiKey);
      setApiKeySet(true);
      setCurrentStep('grants');
    } catch (error: any) {
      console.error('Failed to set API key:', error);
      alert(error?.response?.data?.detail || 'Could not save the API key — is the backend reachable? (Check that you are signed in.)');
    }
  };

  const runDiscovery = async (source: 'seed' | 'grants_gov' | 'web_discovery') => {
    setDiscoveryBusy(source);
    setDiscoveryStatus(null);
    try {
      let result;
      if (source === 'seed') {
        result = await api.loadStarterDatabase();
        setDiscoveryStatus(`Starter database loaded: ${result.added} grants added (${result.total_grants} total).`);
      } else if (source === 'grants_gov') {
        result = await api.searchGrantsGov();
        setDiscoveryStatus(`Grants.gov: found ${result.found}, added ${result.added} new (${result.total_grants} total).`);
      } else {
        result = await api.webDiscovery();
        setDiscoveryStatus(`AI web discovery: found ${result.found}, added ${result.added} new (${result.total_grants} total).`);
      }
      setDiscoveredTotal(result.total_grants);
    } catch (error: any) {
      console.error(`Discovery (${source}) failed:`, error);
      const detail = error?.response?.data?.detail || 'request failed — is the backend running?';
      setDiscoveryStatus(`Discovery failed: ${detail}`);
    } finally {
      setDiscoveryBusy(null);
    }
  };

  const handleGrantUpload = async () => {
    // A user-uploaded Excel is now optional: discovery can fill the database.
    if (!grantFile) {
      if (discoveredTotal > 0) {
        setGrantStats({ total_grants: discoveredTotal });
        setCurrentStep('website');
      }
      return;
    }
    try {
      const result = await api.uploadGrantDatabase(grantFile);
      setGrantStats(result);
      setCurrentStep('website');
    } catch (error: any) {
      console.error('Failed to upload grants:', error);
      alert(error?.response?.data?.detail || 'Grant database upload failed — check the file format and that the backend is running.');
    }
  };

  const handleWebsiteScan = async () => {
    if (!churchUrl && !schoolUrl) {
      alert('Please enter at least one website URL');
      return;
    }
    try {
      await api.scanWebsite(churchUrl, schoolUrl);
      setWebsiteScanned(true);
      // Generate questionnaire
      const q = await api.generateQuestionnaire();
      setQuestionnaire(q);
      setCurrentStep('questionnaire');
    } catch (error: any) {
      console.error('Website scan failed:', error);
      alert(error?.response?.data?.detail || 'Website scan or questionnaire generation failed — check the URL and your API key.');
    }
  };

  const handleQuestionnaireSubmit = async () => {
    const answerArray = Object.entries(answers).map(([id, answer]) => ({
      question_id: parseInt(id),
      answer,
    }));
    try {
      await api.submitQuestionnaire(answerArray, freeFormText);
      setCurrentStep('documents');
    } catch (error: any) {
      console.error('Questionnaire submission failed:', error);
      alert(error?.response?.data?.detail || 'Could not save your answers — they matter for matching, so please retry.');
    }
  };

  const handleWriteApplication = async (grantId: string) => {
    try {
      const app = await api.createApplication(grantId);
      router.push(`/writer?id=${app.id}`);
    } catch (error: any) {
      console.error('Failed to create application:', error);
      alert(error?.response?.data?.detail || 'Could not start the application — is the backend running?');
    }
  };

  const handleDocumentUpload = (files: FileList | null) => {
    if (!files) return;
    setDocuments(prev => [...prev, ...Array.from(files)]);
  };

  const runMatching = async () => {
    setCurrentStep('processing');
    setIsProcessing(true);
    setProcessingLogs([]);

    try {
      // 1. Upload and extract every document for real - this is where the AI
      // catches the "playground equipment is 30 years old" class of signals.
      if (documents.length > 0) {
        addLog('info', `Processing ${documents.length} document(s)...`);
        for (const doc of documents) {
          addLog('info', `Reading ${doc.name}...`);
          try {
            const extraction = await api.uploadDocument(doc);
            const found =
              (extraction.facility_needs?.length || 0) +
              (extraction.program_needs?.length || 0) +
              (extraction.security_concerns?.length || 0);
            addLog('success', `${doc.name}: ${found} grant-relevant item(s) extracted`);
            [...(extraction.facility_needs || []), ...(extraction.program_needs || []), ...(extraction.security_concerns || [])]
              .slice(0, 4)
              .forEach((item: string) => addLog('info', `  → ${item}`));
          } catch (docError: any) {
            addLog('warning', `${doc.name}: extraction failed (${docError?.response?.data?.detail || 'error'}) — continuing`);
          }
        }
      }

      // 2. Real matching run
      addLog('info', `Scoring ${grantStats?.total_grants || 'all'} grants against your profile...`);
      addLog('info', 'Applying geographic and deadline hard filters, then AI scoring...');
      const results = await api.matchGrants();
      setMatchResults(results);

      addLog('success', '=== MATCHING COMPLETE ===');
      addLog('success', `${results.total_grants_evaluated} grants evaluated: ${results.excellent_matches} excellent, ${results.good_matches} good, ${results.possible_matches} possible`);

      setIsProcessing(false);
      await new Promise(r => setTimeout(r, 800));
      setCurrentStep('results');
    } catch (error: any) {
      const detail = error?.response?.data?.detail || 'Matching failed — is the backend reachable and your API key set?';
      addLog('error', detail);
      setIsProcessing(false);
    }
  };

  const downloadResults = async (format: 'csv' | 'md') => {
    if (!matchResults?.session_id) return;
    try {
      const blob = await api.exportResults(matchResults.session_id, format, true);
      const url = URL.createObjectURL(new Blob([blob]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `grant_matches.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      alert(error?.response?.data?.detail || 'Export failed');
    }
  };
  const steps = [
    { id: 'api-key', label: 'API Key', icon: Settings },
    { id: 'grants', label: 'Grant Database', icon: Database },
    { id: 'website', label: 'Website', icon: Globe },
    { id: 'questionnaire', label: 'Questions', icon: MessageSquare },
    { id: 'documents', label: 'Documents', icon: FileText },
    { id: 'processing', label: 'Processing', icon: Play },
    { id: 'results', label: 'Results', icon: BarChart3 },
  ];

  const currentStepIndex = steps.findIndex(s => s.id === currentStep);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-[var(--card-border)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-[var(--primary)] rounded-lg flex items-center justify-center">
              <Search className="w-5 h-5 text-white" />
            </div>
            <span className="text-xl font-bold">GrantFinder AI</span>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{user?.email || 'Demo Mode'}</span>
            <button
              onClick={() => {
                api.clearToken();
                setUser(null);
                router.push('/');
              }}
              className="text-gray-500 hover:text-white"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Progress Steps */}
      <div className="border-b border-[var(--card-border)] py-4">
        <div className="max-w-4xl mx-auto px-4">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => {
              const Icon = step.icon;
              const isActive = step.id === currentStep;
              const isComplete = index < currentStepIndex;
              return (
                <div key={step.id} className="flex items-center">
                  <div className={`
                    flex items-center gap-2 px-3 py-2 rounded-lg
                    ${isActive ? 'bg-[var(--primary)] text-white' : ''}
                    ${isComplete ? 'text-[var(--accent)]' : 'text-gray-500'}
                  `}>
                    {isComplete ? (
                      <CheckCircle className="w-5 h-5" />
                    ) : (
                      <Icon className="w-5 h-5" />
                    )}
                    <span className="text-sm font-medium hidden md:inline">{step.label}</span>
                  </div>
                  {index < steps.length - 1 && (
                    <ChevronRight className="w-4 h-4 text-gray-600 mx-2" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 py-8">
        <div className="max-w-3xl mx-auto px-4">
          {/* Step 1: API Key */}
          {currentStep === 'api-key' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Enter Your Claude API Key</h2>
              <p className="text-gray-400 mb-6">
                GrantFinder uses Claude AI to analyze your documents and match grants.
                Your API key is encrypted and never shared.
              </p>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="input mb-4"
              />
              <button
                onClick={handleApiKeySubmit}
                disabled={!apiKey}
                className="btn btn-primary w-full"
              >
                Continue
                <ChevronRight className="w-5 h-5" />
              </button>
              <p className="text-sm text-gray-500 mt-4 text-center">
                Get your API key at{' '}
                <a href="https://console.anthropic.com/" className="text-[var(--primary)]" target="_blank">
                  console.anthropic.com
                </a>
              </p>
            </div>
          )}

          {/* Step 2: Grant Database — discovery + optional upload */}
          {currentStep === 'grants' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Build Your Grant Database</h2>
              <p className="text-gray-400 mb-6">
                Discover grants automatically, upload your own Excel file, or both.
                Everything merges into one database with duplicates removed.
              </p>

              <div className="grid gap-3 mb-6">
                <button
                  onClick={() => runDiscovery('seed')}
                  disabled={discoveryBusy !== null}
                  className="btn btn-secondary w-full flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Database className="w-5 h-5" />
                    Load Starter Database
                  </span>
                  <span className="text-sm text-gray-400">
                    {discoveryBusy === 'seed' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Curated Catholic + secular grants'}
                  </span>
                </button>
                <button
                  onClick={() => runDiscovery('grants_gov')}
                  disabled={discoveryBusy !== null}
                  className="btn btn-secondary w-full flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Globe className="w-5 h-5" />
                    Search Grants.gov
                  </span>
                  <span className="text-sm text-gray-400">
                    {discoveryBusy === 'grants_gov' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Live federal opportunities'}
                  </span>
                </button>
                <button
                  onClick={() => runDiscovery('web_discovery')}
                  disabled={discoveryBusy !== null}
                  className="btn btn-secondary w-full flex items-center justify-between"
                >
                  <span className="flex items-center gap-2">
                    <Search className="w-5 h-5" />
                    AI Web Discovery
                  </span>
                  <span className="text-sm text-gray-400">
                    {discoveryBusy === 'web_discovery' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Claude searches the web (uses your API key)'}
                  </span>
                </button>
              </div>

              {discoveryStatus && (
                <div className={`mb-6 p-3 rounded text-sm ${discoveryStatus.startsWith('Discovery failed') ? 'bg-red-900/30 text-red-300' : 'bg-green-900/30 text-green-300'}`}>
                  {discoveryStatus}
                </div>
              )}

              <p className="text-gray-500 text-sm mb-3">
                Optional: upload your own Excel file with the 5 grant categories.
              </p>
              <div
                className={`dropzone ${grantFile ? 'active' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files[0];
                  if (file?.name.endsWith('.xlsx') || file?.name.endsWith('.xls')) {
                    setGrantFile(file);
                  }
                }}
              >
                <Upload className="w-12 h-12 text-gray-500 mx-auto mb-4" />
                {grantFile ? (
                  <p className="text-[var(--accent)]">{grantFile.name}</p>
                ) : (
                  <>
                    <p className="mb-2">Drag and drop your Excel file here</p>
                    <p className="text-sm text-gray-500">or</p>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={(e) => setGrantFile(e.target.files?.[0] || null)}
                      className="hidden"
                      id="grant-file"
                    />
                    <label htmlFor="grant-file" className="btn btn-secondary mt-4 cursor-pointer">
                      Browse Files
                    </label>
                  </>
                )}
              </div>
              <button
                onClick={handleGrantUpload}
                disabled={!grantFile && discoveredTotal === 0}
                className="btn btn-primary w-full mt-6"
              >
                {grantFile ? 'Upload and Continue' : `Continue with ${discoveredTotal} Discovered Grants`}
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Step 3: Website URLs */}
          {currentStep === 'website' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Enter Website URLs</h2>
              <p className="text-gray-400 mb-6">
                AI will scan your website(s) to understand your organization.
              </p>

              {grantStats && (
                <div className="bg-[var(--terminal-bg)] p-4 rounded-lg mb-6">
                  <p className="text-sm text-[var(--terminal-green)]">
                    ✓ Loaded {grantStats.total_grants} grants across 5 categories
                  </p>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium mb-2">Church/Parish Website</label>
                  <input
                    type="url"
                    value={churchUrl}
                    onChange={(e) => setChurchUrl(e.target.value)}
                    placeholder="https://sttheresa.org"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">School Website (if separate)</label>
                  <input
                    type="url"
                    value={schoolUrl}
                    onChange={(e) => setSchoolUrl(e.target.value)}
                    placeholder="https://sttheresaschool.org"
                    className="input"
                  />
                </div>
              </div>
              <button
                onClick={handleWebsiteScan}
                disabled={!churchUrl && !schoolUrl}
                className="btn btn-primary w-full mt-6"
              >
                Scan Website
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Step 4: Questionnaire */}
          {currentStep === 'questionnaire' && questionnaire && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Answer a Few Questions</h2>
              <p className="text-gray-400 mb-6">
                These questions help us match you with the right grants.
              </p>
              <div className="space-y-6">
                {questionnaire.questions.map((q: any) => (
                  <div key={q.id}>
                    <label className="block font-medium mb-2">
                      {q.question}
                      {q.required && <span className="text-red-500 ml-1">*</span>}
                    </label>
                    {q.question_type === 'boolean' && (
                      <div className="flex gap-4">
                        <button
                          onClick={() => setAnswers(prev => ({ ...prev, [q.id]: true }))}
                          className={`btn ${answers[q.id] === true ? 'btn-primary' : 'btn-secondary'}`}
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setAnswers(prev => ({ ...prev, [q.id]: false }))}
                          className={`btn ${answers[q.id] === false ? 'btn-primary' : 'btn-secondary'}`}
                        >
                          No
                        </button>
                      </div>
                    )}
                    {q.question_type === 'text' && (
                      <input
                        type="text"
                        value={answers[q.id] || ''}
                        onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                        className="input"
                      />
                    )}
                    {q.question_type === 'select' && (
                      <select
                        value={answers[q.id] || ''}
                        onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                        className="input"
                      >
                        <option value="">Select...</option>
                        {q.options?.map((opt: string) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    )}
                  </div>
                ))}
                <div>
                  <label className="block font-medium mb-2">
                    Anything else we should know? (Optional)
                  </label>
                  <textarea
                    value={freeFormText}
                    onChange={(e) => setFreeFormText(e.target.value)}
                    className="input min-h-[100px]"
                    placeholder="Tell us about any specific needs, upcoming projects, or challenges..."
                  />
                </div>
              </div>
              <button
                onClick={handleQuestionnaireSubmit}
                className="btn btn-primary w-full mt-6"
              >
                Continue
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Step 5: Documents */}
          {currentStep === 'documents' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Upload Documents (Optional)</h2>
              <p className="text-gray-400 mb-6">
                Upload bulletins, meeting minutes, or other documents for deeper analysis.
              </p>
              <div
                className="dropzone"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDocumentUpload(e.dataTransfer.files);
                }}
              >
                <FileText className="w-12 h-12 text-gray-500 mx-auto mb-4" />
                <p className="mb-2">Drag and drop PDF, DOCX, or TXT files</p>
                <input
                  type="file"
                  accept=".pdf,.docx,.txt"
                  multiple
                  onChange={(e) => handleDocumentUpload(e.target.files)}
                  className="hidden"
                  id="doc-files"
                />
                <label htmlFor="doc-files" className="btn btn-secondary mt-4 cursor-pointer">
                  Browse Files
                </label>
              </div>
              {documents.length > 0 && (
                <div className="mt-4 space-y-2">
                  {documents.map((doc, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <CheckCircle className="w-4 h-4 text-[var(--accent)]" />
                      {doc.name}
                    </div>
                  ))}
                </div>
              )}
              <button
                onClick={runMatching}
                className="btn btn-primary w-full mt-6"
              >
                {documents.length > 0 ? 'Process Documents & Find Matches' : 'Skip & Find Matches'}
                <Play className="w-5 h-5" />
              </button>
            </div>
          )}

          {/* Step 6: Processing */}
          {currentStep === 'processing' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Finding Your Grants</h2>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot red"></div>
                  <div className="terminal-dot yellow"></div>
                  <div className="terminal-dot green"></div>
                  <span className="text-sm text-gray-500 ml-2">grantfinder-ai</span>
                </div>
                <div className="terminal-body" ref={terminalRef}>
                  {processingLogs.map((log, i) => (
                    <div key={i} className="terminal-line">
                      <span className="terminal-timestamp">[{log.timestamp}]</span>
                      <span className={`terminal-status ${log.status}`}>
                        {log.status === 'success' && '✓'}
                        {log.status === 'info' && '→'}
                        {log.status === 'warning' && '⚠'}
                        {log.status === 'error' && '✗'}
                      </span>
                      <span>{log.message}</span>
                    </div>
                  ))}
                  {isProcessing && (
                    <div className="terminal-line">
                      <Loader2 className="w-4 h-4 animate-spin text-[var(--primary)]" />
                    </div>
                  )}
                </div>
              </div>
              {!isProcessing && processingLogs.some(l => l.status === 'error') && (
                <button onClick={() => setCurrentStep('documents')} className="btn btn-secondary w-full mt-4">
                  ← Back — fix the issue and retry
                </button>
              )}
            </div>
          )}

          {/* Step 7: Results */}
          {currentStep === 'results' && matchResults && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="card">
                <h2 className="text-2xl font-bold mb-4">Match Results</h2>
                <div className="grid grid-cols-5 gap-4 mb-6">
                  <div className="text-center">
                    <div className="text-3xl font-bold text-[var(--score-excellent)]">
                      {matchResults.excellent_matches}
                    </div>
                    <div className="text-sm text-gray-500">Excellent</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-[var(--score-good)]">
                      {matchResults.good_matches}
                    </div>
                    <div className="text-sm text-gray-500">Good</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-[var(--score-possible)]">
                      {matchResults.possible_matches}
                    </div>
                    <div className="text-sm text-gray-500">Possible</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-[var(--score-weak)]">
                      {matchResults.weak_matches}
                    </div>
                    <div className="text-sm text-gray-500">Weak</div>
                  </div>
                  <div className="text-center">
                    <div className="text-3xl font-bold text-gray-500">
                      {matchResults.not_eligible}
                    </div>
                    <div className="text-sm text-gray-500">Not Eligible</div>
                  </div>
                </div>
                <div className="flex gap-4">
                  <button onClick={() => downloadResults('csv')} className="btn btn-secondary flex-1">
                    <Download className="w-5 h-5" />
                    Export CSV
                  </button>
                  <button onClick={() => downloadResults('md')} className="btn btn-primary flex-1">
                    <Download className="w-5 h-5" />
                    Export Report (Markdown)
                  </button>
                </div>
              </div>

              {/* Match List */}
              {matchResults.matches.map((match: any) => (
                <div key={match.grant_id} className="card">
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <h3 className="text-lg font-bold">{match.grant_name}</h3>
                      <p className="text-gray-500">{match.funder}</p>
                    </div>
                    <span className={`score-badge ${match.score_tier}`}>
                      {match.score}%
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-4 mb-4 text-sm">
                    <div>
                      <span className="text-gray-500">Amount:</span>
                      <span className="ml-2 font-medium">{match.amount}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Deadline:</span>
                      <span className="ml-2 font-medium">{match.deadline}</span>
                    </div>
                    <div>
                      <span className="text-gray-500">Category:</span>
                      <span className="ml-2 font-medium capitalize">
                        {match.category.replace('_', ' ')}
                      </span>
                    </div>
                  </div>
                  <p className="text-gray-400 mb-4">{match.explanation}</p>
                  <div className="flex items-center justify-between">
                    <a
                      href={match.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--primary)] text-sm hover:underline"
                    >
                      Visit Grant Website →
                    </a>
                    <div className="flex items-center gap-4">
                      <span className="text-sm text-gray-500">Contact: {match.contact}</span>
                      <button
                        onClick={() => handleWriteApplication(match.grant_id)}
                        className="btn btn-primary text-sm"
                      >
                        Write Application →
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
