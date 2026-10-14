'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, Upload, Globe, FileText, MessageSquare, Play,
  CheckCircle, AlertCircle, Loader2, ChevronRight, Settings,
  LogOut, Database, BarChart3, Download, Bug, PenLine,
} from 'lucide-react';
import api, { onJobProgress } from '@/lib/api';
import { useStore } from '@/lib/store';

type SetupStep = 'api-key' | 'grants' | 'website' | 'questionnaire' | 'documents' | 'processing' | 'results';

interface ProcessingLog {
  timestamp: string;
  status: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

interface OrgBasics {
  organization_name: string;
  organization_type: string;
  city: string;
  state: string;
  diocese: string;
  student_count: string;
}

/** Netlify accepts uploads up to about 4 MB; checking here gives a clear message instantly. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const errorDetail = (error: any, fallback: string): string =>
  error?.response?.data?.detail || error?.message || fallback;

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
  const [discoveryFocus, setDiscoveryFocus] = useState('');
  const [churchUrl, setChurchUrl] = useState('');
  const [schoolUrl, setSchoolUrl] = useState('');
  const [websiteScanned, setWebsiteScanned] = useState(false);
  const [questionnaire, setQuestionnaire] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<number, any>>({});
  const [freeFormText, setFreeFormText] = useState('');
  const [documents, setDocuments] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLogs, setProcessingLogs] = useState<ProcessingLog[]>([]);
  // Long steps run as background jobs; show which one and its latest status line.
  const [busy, setBusy] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [applications, setApplications] = useState<any[]>([]);
  const [profileExists, setProfileExists] = useState(false);
  const [showBasics, setShowBasics] = useState(false);
  const [basics, setBasics] = useState<OrgBasics>({
    organization_name: '', organization_type: 'both', city: '', state: '', diocese: '', student_count: '',
  });
  const terminalRef = useRef<HTMLDivElement>(null);
  const resumedFor = useRef<string | null>(null);

  // Every engine call needs a session, so visitors without one go to sign-in
  useEffect(() => {
    const token = api.loadToken();
    if (!token) {
      router.replace('/');
      return;
    }
    if (!user) {
      api.getMe()
        .then(setUser)
        .catch(() => {
          api.clearToken();
          router.replace('/?expired=1');
        });
    }
  }, [user, setUser, router]);

  // Live status lines from background jobs ("Scoring grants 11-15 of 40")
  useEffect(() => onJobProgress((info) => setJobProgress(info.progress)), []);

  // Pick up where the user left off: saved key, grants, profile, results,
  // applications, and a matching run still in progress from before a reload.
  useEffect(() => {
    if (!user || resumedFor.current === user.id) return;
    resumedFor.current = user.id;
    (async () => {
      const [stats, profile, apps, latest, keyStatus, jobs] = await Promise.all([
        api.getGrantStats().catch(() => null),
        api.getProfile().catch(() => null),
        api.listApplications().catch(() => []),
        api.getLatestMatchResults().catch(() => null),
        api.getApiKeyStatus().catch(() => null),
        api.listJobs().catch(() => []),
      ]);
      if (stats?.total_grants) {
        setDiscoveredTotal(stats.total_grants);
        setGrantStats(stats);
      }
      if (profile) {
        setProfileExists(true);
        setBasics({
          organization_name: profile.organization_name || '',
          organization_type: profile.organization_type || 'both',
          city: profile.city || '',
          state: profile.state || '',
          diocese: profile.diocese || '',
          student_count: profile.student_count ? String(profile.student_count) : '',
        });
        if (profile.website_url) setChurchUrl(profile.website_url);
        if (profile.school_website_url) setSchoolUrl(profile.school_website_url);
        if (profile.free_form_notes) setFreeFormText(profile.free_form_notes);
      }
      setApplications(Array.isArray(apps) ? apps : []);
      if (latest && !matchResults) setMatchResults(latest);
      // Ask the engine (the signed-in user object can be from before the key was saved).
      if (keyStatus?.is_set ?? user.claude_api_key_set) {
        setApiKeySet(true);
        setCurrentStep((step) => (step === 'api-key' ? (stats?.total_grants ? 'website' : 'grants') : step));
      }
      const runningMatch = jobs.find((job) => job.kind === 'processing.match_grants' && (job.status === 'running' || job.status === 'queued'));
      if (runningMatch) {
        setCurrentStep('processing');
        setIsProcessing(true);
        setProcessingLogs([{
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
          status: 'info',
          message: 'Matching is still running from before; picking it back up...',
        }]);
        try {
          const results: any = await api.waitForJob(runningMatch.id, runningMatch.kind);
          setMatchResults(results);
          setIsProcessing(false);
          setCurrentStep('results');
        } catch (error: any) {
          setProcessingLogs((logs) => [...logs, {
            timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
            status: 'error',
            message: errorDetail(error, 'Matching failed. Run it again from the Documents step.'),
          }]);
          setIsProcessing(false);
        }
      }
    })();
  }, [user, matchResults, setMatchResults]);

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

  /** Run one user action with a busy label; failures show inline instead of alert boxes. */
  const runBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setJobProgress(null);
    setStepError(null);
    try {
      await fn();
    } catch (error: any) {
      console.error(`[GrantFinder] ${label} failed:`, error);
      setStepError(errorDetail(error, `${label} failed. Use "Copy debug report" and paste it into Claude Code.`));
    } finally {
      setBusy(null);
      setJobProgress(null);
    }
  };

  const goTo = (step: SetupStep) => {
    setStepError(null);
    setCurrentStep(step);
  };

  const copyDebugReport = async () => {
    setNotice(null);
    try {
      const report = await api.getDebugReport();
      try {
        await navigator.clipboard.writeText(report);
        setNotice('Debug report copied. Paste it into Claude Code.');
      } catch {
        // Clipboard blocked: download it instead.
        const url = URL.createObjectURL(new Blob([report], { type: 'text/markdown' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'grantfinder-debug-report.md';
        a.click();
        URL.revokeObjectURL(url);
        setNotice('Debug report downloaded (grantfinder-debug-report.md). Paste it into Claude Code.');
      }
    } catch (error: any) {
      setNotice(`Could not get the debug report: ${errorDetail(error, 'unknown error')}`);
    }
  };

  const handleApiKeySubmit = () =>
    runBusy('Saving your API key', async () => {
      if (!apiKey.trim().startsWith('sk-ant-')) {
        throw new Error('Invalid API key format. Claude API keys start with "sk-ant-"');
      }
      const result = await api.setApiKey(apiKey.trim());
      setApiKeySet(true);
      if (user) setUser({ ...user, claude_api_key_set: true });
      setApiKey('');
      if (result?.warning) setNotice(result.warning);
      goTo(discoveredTotal > 0 ? 'website' : 'grants');
    });

  const runDiscovery = async (source: 'seed' | 'grants_gov' | 'web_discovery') => {
    setDiscoveryBusy(source);
    setDiscoveryStatus(null);
    setJobProgress(null);
    try {
      let result;
      if (source === 'seed') {
        result = await api.loadStarterDatabase();
        setDiscoveryStatus(`Starter database loaded: ${result.added} grants added (${result.total_grants} total).`);
      } else if (source === 'grants_gov') {
        result = await api.searchGrantsGov();
        setDiscoveryStatus(`Grants.gov: found ${result.found}, added ${result.added} new (${result.total_grants} total).`);
      } else {
        result = await api.webDiscovery(discoveryFocus.trim() || undefined);
        setDiscoveryStatus(`AI web discovery: found ${result.found}, added ${result.added} new (${result.total_grants} total).`);
      }
      if (Array.isArray(result.notes) && result.notes.length) {
        setDiscoveryStatus((status) => `${status} ${result.notes.join(' ')}`);
      }
      setDiscoveredTotal(result.total_grants);
    } catch (error: any) {
      console.error(`Discovery (${source}) failed:`, error);
      setDiscoveryStatus(`Discovery failed: ${errorDetail(error, 'request failed')}`);
    } finally {
      setDiscoveryBusy(null);
      setJobProgress(null);
    }
  };

  const handleGrantUpload = () =>
    runBusy('Uploading your grant database', async () => {
      // A user-uploaded Excel is optional: discovery can fill the database.
      if (!grantFile) {
        if (discoveredTotal > 0) {
          setGrantStats((prev: any) => ({ ...(prev || {}), total_grants: discoveredTotal }));
          goTo('website');
        }
        return;
      }
      if (grantFile.size > MAX_UPLOAD_BYTES) {
        throw new Error(`${grantFile.name} is larger than 4 MB. Remove extra sheets or images and try again.`);
      }
      const result = await api.uploadGrantDatabase(grantFile);
      setGrantStats(result);
      setDiscoveredTotal(result.total_grants);
      goTo('website');
    });

  const loadQuestionnaire = async () => {
    const q = await api.generateQuestionnaire();
    setQuestionnaire(q);
    goTo('questionnaire');
  };

  const handleWebsiteScan = () =>
    runBusy('Scanning your website', async () => {
      if (!churchUrl && !schoolUrl) {
        throw new Error('Please enter at least one website URL');
      }
      try {
        await api.scanWebsite(churchUrl, schoolUrl);
      } catch (error: any) {
        setShowBasics(true);
        const detail = errorDetail(error, 'Website scan failed.');
        throw new Error(/by hand|skip/i.test(detail) ? detail : `${detail} Use "Enter the basics by hand" or "Skip to questions" below.`);
      }
      setWebsiteScanned(true);
      setProfileExists(true);
      setBusy('Writing your questions');
      await loadQuestionnaire();
    });

  const skipWebsiteScan = () => runBusy('Writing your questions', loadQuestionnaire);

  const saveBasics = () =>
    runBusy('Saving your organization basics', async () => {
      if (!basics.organization_name.trim() || !basics.state.trim()) {
        throw new Error('Please enter at least the organization name and state.');
      }
      const existing = await api.getProfile();
      const base = existing || { user_id: user?.id, organization_type: 'parish', city: '', state: '', sources: [] };
      const sources: string[] = Array.isArray(base.sources) ? base.sources : [];
      const studentCount = parseInt(basics.student_count, 10);
      await api.updateProfile({
        ...base,
        organization_name: basics.organization_name.trim(),
        organization_type: basics.organization_type,
        city: basics.city.trim(),
        state: basics.state.trim(),
        diocese: basics.diocese.trim() || null,
        student_count: Number.isFinite(studentCount) ? studentCount : base.student_count ?? null,
        has_school: basics.organization_type !== 'parish' ? true : Boolean(base.has_school),
        website_url: churchUrl || base.website_url || null,
        school_website_url: schoolUrl || base.school_website_url || null,
        sources: sources.includes('Entered by hand') ? sources : [...sources, 'Entered by hand'],
      });
      setProfileExists(true);
      setShowBasics(false);
      setBusy('Writing your questions');
      await loadQuestionnaire();
    });

  const handleQuestionnaireSubmit = () =>
    runBusy('Saving your answers', async () => {
      const answerArray = Object.entries(answers).map(([id, answer]) => ({
        question_id: parseInt(id),
        answer,
      }));
      await api.submitQuestionnaire(answerArray, freeFormText);
      setProfileExists(true);
      goTo('documents');
    });

  const handleWriteApplication = (grantId: string) =>
    runBusy('Opening the application writer', async () => {
      const app = await api.createApplication(grantId);
      router.push(`/writer?id=${app.id}`);
    });

  const handleDocumentUpload = (files: FileList | null) => {
    if (!files) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    Array.from(files).forEach((file) => {
      if (file.size > MAX_UPLOAD_BYTES) rejected.push(`${file.name} is larger than 4 MB`);
      else if (!/\.(pdf|docx|txt)$/i.test(file.name)) rejected.push(`${file.name} is not a PDF, DOCX, or TXT file`);
      else accepted.push(file);
    });
    setStepError(rejected.length ? `Skipped: ${rejected.join('; ')}. Split or shorten large files and add them again.` : null);
    setDocuments(prev => [...prev, ...accepted]);
  };

  const runMatching = async () => {
    setCurrentStep('processing');
    setIsProcessing(true);
    setProcessingLogs([]);
    setStepError(null);

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
            addLog('warning', `${doc.name}: extraction failed (${errorDetail(docError, 'error')}) — continuing`);
          }
        }
        setDocuments([]);
        setProfileExists(true);
      }

      // 2. Real matching run
      addLog('info', 'Scoring your grants and foundations against your profile...');
      addLog('info', 'Applying geographic and deadline hard filters, then AI scoring...');
      const results = await api.matchGrants();
      setMatchResults(results);

      addLog('success', '=== MATCHING COMPLETE ===');
      addLog('success', `${results.total_grants_evaluated} grants evaluated: ${results.excellent_matches} excellent, ${results.good_matches} good, ${results.possible_matches} possible`);

      setIsProcessing(false);
      await new Promise(r => setTimeout(r, 800));
      setCurrentStep('results');
    } catch (error: any) {
      addLog('error', errorDetail(error, 'Matching failed. Check that your API key is saved, then retry.'));
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
      let detail = 'Export failed';
      try {
        detail = JSON.parse(await error.response.data.text()).detail || detail;
      } catch { /* keep default */ }
      setStepError(detail);
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

  /** Steps the user may jump to: everything after the key is saved, results once they exist. */
  const canVisit = (id: string) => {
    if (busy || isProcessing) return false;
    if (id === 'api-key') return true;
    if (!apiKeySet) return false;
    if (id === 'processing') return false;
    if (id === 'results') return Boolean(matchResults);
    return true;
  };

  const busyBanner = busy && (
    <div className="mt-4 p-3 rounded bg-[var(--terminal-bg)] text-sm flex items-center gap-2" role="status">
      <Loader2 className="w-4 h-4 animate-spin text-[var(--primary)]" />
      <span>{busy}...{jobProgress ? ` ${jobProgress}` : ''}</span>
    </div>
  );

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
            <button
              onClick={copyDebugReport}
              className="text-sm text-gray-500 hover:text-white flex items-center gap-1"
              title="Copy a report of recent steps and errors to paste into Claude Code"
            >
              <Bug className="w-4 h-4" />
              <span className="hidden md:inline">Copy debug report</span>
            </button>
            <span className="text-sm text-gray-500">{user?.name || user?.email || ''}</span>
            <button
              onClick={() => {
                api.clearToken();
                setUser(null);
                setMatchResults(null);
                router.push('/');
              }}
              className="text-gray-500 hover:text-white"
              aria-label="Sign out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Progress Steps (click any available step to jump there) */}
      <div className="border-b border-[var(--card-border)] py-4">
        <div className="max-w-4xl mx-auto px-4 overflow-x-auto">
          <div className="flex items-center justify-between min-w-max md:min-w-0">
            {steps.map((step, index) => {
              const Icon = step.icon;
              const isActive = step.id === currentStep;
              const isComplete = index < currentStepIndex;
              const visitable = canVisit(step.id) && !isActive;
              return (
                <div key={step.id} className="flex items-center">
                  <button
                    type="button"
                    disabled={!visitable}
                    aria-label={step.label}
                    title={step.label}
                    onClick={() => goTo(step.id as SetupStep)}
                    className={`
                      flex items-center gap-2 px-3 py-2 rounded-lg
                      ${isActive ? 'bg-[var(--primary)] text-white' : ''}
                      ${isComplete ? 'text-[var(--accent)]' : 'text-gray-500'}
                      ${visitable ? 'hover:bg-gray-800 cursor-pointer' : 'cursor-default'}
                    `}
                  >
                    {isComplete ? (
                      <CheckCircle className="w-5 h-5" />
                    ) : (
                      <Icon className="w-5 h-5" />
                    )}
                    <span className="text-sm font-medium hidden md:inline">{step.label}</span>
                  </button>
                  {index < steps.length - 1 && (
                    <ChevronRight className="w-4 h-4 text-gray-600 mx-1 md:mx-2" />
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
          {notice && (
            <div className="mb-4 p-3 rounded bg-green-900/30 text-green-300 text-sm flex justify-between gap-4">
              <span>{notice}</span>
              <button onClick={() => setNotice(null)} className="text-green-200" aria-label="Dismiss">×</button>
            </div>
          )}

          {stepError && currentStep !== 'processing' && (
            <div className="sticky top-2 z-10 mb-4 p-3 rounded bg-red-950 border border-red-800 text-red-300 text-sm flex items-start gap-2" role="alert">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{stepError}</span>
            </div>
          )}

          {/* Saved applications: the fastest way back into the writer */}
          {applications.length > 0 && currentStep !== 'processing' && (
            <div className="card mb-6">
              <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
                <PenLine className="w-5 h-5" /> Your applications
              </h2>
              <div className="space-y-2">
                {applications.map((app: any) => (
                  <div key={app.id} className="flex items-center justify-between gap-4 text-sm">
                    <div>
                      <span className="font-medium">{app.grant_name}</span>
                      <span className="text-gray-500"> · {app.funder} · {app.status}</span>
                      {app.urgent && <span className="text-red-400"> · deadline soon</span>}
                    </div>
                    <button onClick={() => router.push(`/writer?id=${app.id}`)} className="btn btn-secondary text-sm">
                      Open →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 1: API Key */}
          {currentStep === 'api-key' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Enter Your Claude API Key</h2>
              <p className="text-gray-400 mb-6">
                GrantFinder uses Claude AI to analyze your documents and match grants.
                Your API key is encrypted and never shared.
              </p>
              {apiKeySet && (
                <p className="text-sm text-[var(--accent)] mb-4">
                  ✓ A key is already saved. Enter a new one only to replace it.
                </p>
              )}
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="input mb-4"
              />
              <button
                onClick={handleApiKeySubmit}
                disabled={!apiKey || Boolean(busy)}
                className="btn btn-primary w-full"
              >
                {busy ? 'Checking key...' : 'Continue'}
                <ChevronRight className="w-5 h-5" />
              </button>
              {apiKeySet && (
                <button onClick={() => goTo(discoveredTotal > 0 ? 'website' : 'grants')} className="btn btn-secondary w-full mt-3">
                  Keep my saved key
                </button>
              )}
              <p className="text-sm text-gray-500 mt-4 text-center">
                Get your API key at{' '}
                <a href="https://console.anthropic.com/" className="text-[var(--primary)]" target="_blank" rel="noopener noreferrer">
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

              <input
                type="text"
                value={discoveryFocus}
                onChange={(e) => setDiscoveryFocus(e.target.value)}
                placeholder="Optional focus for AI web discovery, e.g. teacher training in AI, playground equipment"
                className="input mb-6 text-sm"
              />

              {discoveryBusy && (
                <div className="mb-6 p-3 rounded bg-[var(--terminal-bg)] text-sm flex items-center gap-2" role="status">
                  <Loader2 className="w-4 h-4 animate-spin text-[var(--primary)]" />
                  <span>
                    {discoveryBusy === 'web_discovery' ? 'Claude is searching the web (this can take a few minutes)' : 'Working'}
                    ...{jobProgress ? ` ${jobProgress}` : ''}
                  </span>
                </div>
              )}

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
                  if (file && /\.xlsx?$/i.test(file.name)) {
                    setGrantFile(file);
                  } else if (file) {
                    setStepError(`${file.name} is not an Excel file. Save it as .xlsx and try again.`);
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
                disabled={(!grantFile && discoveredTotal === 0) || Boolean(busy) || discoveryBusy !== null}
                className="btn btn-primary w-full mt-6"
              >
                {grantFile ? 'Upload and Continue' : `Continue with ${discoveredTotal} Discovered Grants`}
                <ChevronRight className="w-5 h-5" />
              </button>
              {busyBanner}
            </div>
          )}

          {/* Step 3: Website URLs (or the basics by hand) */}
          {currentStep === 'website' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Enter Website URLs</h2>
              <p className="text-gray-400 mb-6">
                AI will scan your website(s) to understand your organization.
              </p>

              {(grantStats?.total_grants || discoveredTotal) > 0 && (
                <div className="bg-[var(--terminal-bg)] p-4 rounded-lg mb-6">
                  <p className="text-sm text-[var(--terminal-green)]">
                    ✓ {grantStats?.total_grants || discoveredTotal} grants in your database
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
                    placeholder="https://yourparish.org"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2">School Website (if separate)</label>
                  <input
                    type="url"
                    value={schoolUrl}
                    onChange={(e) => setSchoolUrl(e.target.value)}
                    placeholder="https://yourschool.org"
                    className="input"
                  />
                </div>
              </div>
              <button
                onClick={handleWebsiteScan}
                disabled={(!churchUrl && !schoolUrl) || Boolean(busy)}
                className="btn btn-primary w-full mt-6"
              >
                Scan Website
                <ChevronRight className="w-5 h-5" />
              </button>
              {websiteScanned && !busy && (
                <p className="text-sm text-[var(--accent)] mt-3">✓ Website scanned and added to your profile.</p>
              )}

              <div className="mt-6 pt-6 border-t border-[var(--card-border)]">
                <p className="text-sm text-gray-400 mb-3">
                  Some parish sites block automated reading. You can type the basics instead, or skip
                  straight to the questions{profileExists ? ' (your saved profile is kept)' : ''}.
                </p>
                <div className="flex gap-3">
                  <button onClick={() => setShowBasics((v) => !v)} disabled={Boolean(busy)} className="btn btn-secondary flex-1">
                    {showBasics ? 'Hide the basics form' : 'Enter the basics by hand'}
                  </button>
                  <button onClick={skipWebsiteScan} disabled={Boolean(busy)} className="btn btn-secondary flex-1">
                    Skip to questions
                  </button>
                </div>
                {showBasics && (
                  <div className="mt-4 grid gap-3 md:grid-cols-2">
                    <div className="md:col-span-2">
                      <label htmlFor="basics-name" className="block text-sm font-medium mb-1">Organization name *</label>
                      <input className="input" id="basics-name" value={basics.organization_name}
                        onChange={(e) => setBasics({ ...basics, organization_name: e.target.value })}
                        placeholder="[Parish Name] Catholic Church and School" />
                    </div>
                    <div>
                      <label htmlFor="basics-type" className="block text-sm font-medium mb-1">Type</label>
                      <select className="input" id="basics-type" value={basics.organization_type}
                        onChange={(e) => setBasics({ ...basics, organization_type: e.target.value })}>
                        <option value="both">Parish and school</option>
                        <option value="school">School</option>
                        <option value="parish">Parish</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="basics-diocese" className="block text-sm font-medium mb-1">Diocese</label>
                      <input className="input" id="basics-diocese" value={basics.diocese}
                        onChange={(e) => setBasics({ ...basics, diocese: e.target.value })} />
                    </div>
                    <div>
                      <label htmlFor="basics-city" className="block text-sm font-medium mb-1">City</label>
                      <input className="input" id="basics-city" value={basics.city}
                        onChange={(e) => setBasics({ ...basics, city: e.target.value })} />
                    </div>
                    <div>
                      <label htmlFor="basics-state" className="block text-sm font-medium mb-1">State *</label>
                      <input className="input" id="basics-state" value={basics.state} placeholder="TX"
                        onChange={(e) => setBasics({ ...basics, state: e.target.value })} />
                    </div>
                    <div>
                      <label htmlFor="basics-students" className="block text-sm font-medium mb-1">Number of students</label>
                      <input className="input" inputMode="numeric" id="basics-students" value={basics.student_count}
                        onChange={(e) => setBasics({ ...basics, student_count: e.target.value })} />
                    </div>
                    <div className="md:col-span-2">
                      <button onClick={saveBasics} disabled={Boolean(busy)} className="btn btn-primary w-full">
                        Save basics and continue
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {busyBanner}
            </div>
          )}

          {/* Step 4: Questionnaire */}
          {currentStep === 'questionnaire' && !questionnaire && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Answer a Few Questions</h2>
              <p className="text-gray-400 mb-6">
                Claude writes up to 20 questions based on the grants in your database.
              </p>
              <button onClick={skipWebsiteScan} disabled={Boolean(busy)} className="btn btn-primary w-full">
                Write my questions
                <ChevronRight className="w-5 h-5" />
              </button>
              <button onClick={() => goTo('documents')} disabled={Boolean(busy)} className="btn btn-secondary w-full mt-3">
                Skip to documents
              </button>
              {busyBanner}
            </div>
          )}
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
                    {(q.question_type === 'text' || !['boolean', 'select', 'multiselect'].includes(q.question_type)) && (
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
                    {q.question_type === 'multiselect' && (
                      <div className="flex flex-wrap gap-3">
                        {(q.options || []).map((opt: string) => {
                          const selected: string[] = Array.isArray(answers[q.id]) ? answers[q.id] : [];
                          const checked = selected.includes(opt);
                          return (
                            <label key={opt} className="flex items-center gap-2 text-sm">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setAnswers(prev => ({
                                  ...prev,
                                  [q.id]: checked ? selected.filter((o) => o !== opt) : [...selected, opt],
                                }))}
                              />
                              {opt}
                            </label>
                          );
                        })}
                      </div>
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
                disabled={Boolean(busy)}
                className="btn btn-primary w-full mt-6"
              >
                Continue
                <ChevronRight className="w-5 h-5" />
              </button>
              {busyBanner}
            </div>
          )}

          {/* Step 5: Documents */}
          {currentStep === 'documents' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Upload Documents (Optional)</h2>
              <p className="text-gray-400 mb-6">
                Upload bulletins, meeting minutes, prior grant reports, or other documents for deeper
                analysis. What Claude finds is added to your profile, and the application writer can cite it.
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
                <p className="mb-2">Drag and drop PDF, DOCX, or TXT files (up to 4 MB each)</p>
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
                disabled={Boolean(busy)}
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
                      {jobProgress && <span className="text-gray-400">{jobProgress}</span>}
                    </div>
                  )}
                </div>
              </div>
              {!isProcessing && processingLogs.some(l => l.status === 'error') && (
                <button onClick={() => goTo('documents')} className="btn btn-secondary w-full mt-4">
                  ← Back — fix the issue and retry
                </button>
              )}
            </div>
          )}

          {/* Step 7: Results */}
          {currentStep === 'results' && !matchResults && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Match Results</h2>
              <p className="text-gray-400 mb-4">No results yet. Run matching from the Documents step.</p>
              <button onClick={() => goTo('documents')} className="btn btn-primary w-full">Go to Documents</button>
            </div>
          )}
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
                {busyBanner}
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
                        {String(match.category || '').replace('_', ' ')}
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
                        disabled={Boolean(busy)}
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
