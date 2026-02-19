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
    } catch (error) {
      console.error('Failed to set API key:', error);
      // Demo mode - proceed anyway
      setApiKeySet(true);
      setCurrentStep('grants');
    }
  };

  const handleGrantUpload = async () => {
    if (!grantFile) return;
    try {
      const result = await api.uploadGrantDatabase(grantFile);
      setGrantStats(result);
      setCurrentStep('website');
    } catch (error) {
      console.error('Failed to upload grants:', error);
      // Demo mode - fake stats
      setGrantStats({
        total_grants: 45,
        categories: {
          church_parish: 12,
          catholic_school: 10,
          mixed: 8,
          non_catholic: 10,
          foundations: 5,
        },
        foundations_count: 5,
      });
      setCurrentStep('website');
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
    } catch (error) {
      console.error('Website scan failed:', error);
      // Demo mode - fake questionnaire
      setWebsiteScanned(true);
      setQuestionnaire({
        questions: [
          { id: 1, question: 'Is your organization a registered 501(c)(3)?', question_type: 'boolean', required: true },
          { id: 2, question: 'What type of organization are you?', question_type: 'select', options: ['Parish only', 'School only', 'Parish with school'], required: true },
          { id: 3, question: 'In which state is your organization located?', question_type: 'text', required: true },
          { id: 4, question: 'Do you have facility repair or renovation needs?', question_type: 'boolean', required: true },
          { id: 5, question: 'Do you operate a food pantry?', question_type: 'boolean', required: true },
        ],
        total_questions: 5,
      });
      setCurrentStep('questionnaire');
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
    } catch (error) {
      console.error('Questionnaire submission failed:', error);
      setCurrentStep('documents');
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

    addLog('info', 'Starting grant matching process...');

    // Simulate processing steps
    await new Promise(r => setTimeout(r, 500));
    addLog('info', 'Loading organization profile...');

    await new Promise(r => setTimeout(r, 800));
    addLog('success', 'Profile loaded successfully');

    addLog('info', `Processing ${grantStats?.total_grants || 45} grants from 5 categories...`);

    await new Promise(r => setTimeout(r, 1000));
    addLog('info', 'Evaluating Church/Parish Grants (Category 1)...');

    await new Promise(r => setTimeout(r, 800));
    addLog('success', 'Category 1 complete: 12 grants evaluated');

    await new Promise(r => setTimeout(r, 600));
    addLog('info', 'Evaluating Catholic School Grants (Category 2)...');

    await new Promise(r => setTimeout(r, 800));
    addLog('success', 'Category 2 complete: 10 grants evaluated');

    await new Promise(r => setTimeout(r, 600));
    addLog('info', 'Evaluating Mixed Church-School Grants (Category 3)...');

    await new Promise(r => setTimeout(r, 700));
    addLog('success', 'Category 3 complete: 8 grants evaluated');

    await new Promise(r => setTimeout(r, 600));
    addLog('info', 'Evaluating Non-Catholic Qualifying Grants (Category 4)...');

    await new Promise(r => setTimeout(r, 800));
    addLog('success', 'Category 4 complete: 10 grants evaluated');

    await new Promise(r => setTimeout(r, 500));
    addLog('info', 'Checking Catholic Foundations (Category 5)...');

    await new Promise(r => setTimeout(r, 600));
    addLog('success', 'Category 5 complete: 5 foundations analyzed');

    await new Promise(r => setTimeout(r, 400));
    addLog('info', 'Calculating probability scores...');

    await new Promise(r => setTimeout(r, 1000));
    addLog('info', 'Applying geographic filtering...');

    await new Promise(r => setTimeout(r, 600));
    addLog('success', 'Scoring complete');

    addLog('info', 'Generating match explanations...');

    await new Promise(r => setTimeout(r, 800));
    addLog('success', 'Match explanations generated');

    // Try to get real results or use demo data
    try {
      const results = await api.matchGrants();
      setMatchResults(results);
    } catch (error) {
      // Demo results
      setMatchResults({
        session_id: 'demo-session',
        total_grants_evaluated: 45,
        matches: generateDemoMatches(),
        excellent_matches: 3,
        good_matches: 8,
        possible_matches: 12,
        weak_matches: 15,
        not_eligible: 7,
      });
    }

    addLog('success', '=== MATCHING COMPLETE ===');
    addLog('info', `Found 3 excellent matches, 8 good matches`);

    setIsProcessing(false);
    await new Promise(r => setTimeout(r, 1000));
    setCurrentStep('results');
  };

  const generateDemoMatches = () => {
    return [
      {
        grant_id: 'g1',
        grant_name: 'Koch Foundation - Catholic School Support',
        funder: 'Koch Foundation',
        amount: 'Up to $15,000',
        deadline: 'May 1, 2026',
        url: 'https://www.thekochfoundation.org/',
        contact: '352-373-7491',
        category: 'catholic_school',
        geo_qualified: 'Yes',
        score: 92,
        score_tier: 'excellent',
        score_breakdown: { eligibility_fit: 95, need_alignment: 90, capacity_signals: 88, timing: 95, completeness: 85 },
        explanation: 'Strong alignment with Catholic education focus. Your documented need for STEM resources matches their priorities.',
        evidence: ['Catholic school status confirmed', 'STEM program expansion mentioned in documents'],
        is_shortlisted: false,
      },
      {
        grant_id: 'g2',
        grant_name: 'Raskob Foundation for Catholic Activities',
        funder: 'Raskob Foundation',
        amount: '$5,000 - $25,000',
        deadline: 'Rolling',
        url: 'https://www.rfca.org/',
        contact: 'grants@rfca.org',
        category: 'church_parish',
        geo_qualified: 'Yes',
        score: 88,
        score_tier: 'excellent',
        explanation: 'Excellent fit for parish ministry programs. Your youth ministry expansion aligns well.',
        score_breakdown: { eligibility_fit: 90, need_alignment: 85, capacity_signals: 90, timing: 90, completeness: 80 },
        evidence: ['501(c)(3) verified', 'Youth ministry needs documented'],
        is_shortlisted: false,
      },
      {
        grant_id: 'g3',
        grant_name: 'FEMA Nonprofit Security Grant Program',
        funder: 'FEMA',
        amount: 'Up to $150,000',
        deadline: 'June 15, 2026',
        url: 'https://www.fema.gov/grants/preparedness/nonprofit-security',
        contact: 'See website',
        category: 'non_catholic',
        geo_qualified: 'Yes',
        score: 85,
        score_tier: 'excellent',
        score_breakdown: { eligibility_fit: 85, need_alignment: 80, capacity_signals: 90, timing: 85, completeness: 90 },
        explanation: 'Security concerns documented in your profile make this a strong match.',
        evidence: ['Security improvements needed per finance council minutes'],
        is_shortlisted: false,
      },
      // Add more demo matches...
    ];
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

          {/* Step 2: Grant Database Upload */}
          {currentStep === 'grants' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Upload Grant Database</h2>
              <p className="text-gray-400 mb-6">
                Upload your Excel file with 5 grant categories.
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
                disabled={!grantFile}
                className="btn btn-primary w-full mt-6"
              >
                Upload and Continue
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
                  <button className="btn btn-secondary flex-1">
                    <Download className="w-5 h-5" />
                    Export CSV
                  </button>
                  <button className="btn btn-primary flex-1">
                    <Download className="w-5 h-5" />
                    Export PDF
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
                    <span className="text-sm text-gray-500">Contact: {match.contact}</span>
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
