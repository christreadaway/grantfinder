'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  Search, Upload, Globe, FileText, MessageSquare, Play,
  CheckCircle, AlertCircle, Loader2, ChevronRight, Settings,
  LogOut, Database, BarChart3, Download, Bug, PenLine, XCircle, Star,
} from 'lucide-react';
import api, { blobErrorDetail, errorDetail, isSessionEnded, onJobProgress } from '@/lib/api';
import { copyText, saveFile } from '@/lib/download';
import { useStore } from '@/lib/store';

type SetupStep = 'api-key' | 'grants' | 'website' | 'questionnaire' | 'documents' | 'processing' | 'results';
type DiscoverySource = 'seed' | 'grants_gov' | 'web_discovery';
type ExportFormat = 'csv' | 'md';
type MatchResultsData = NonNullable<ReturnType<typeof useStore.getState>['matchResults']>;
type JobSummary = Awaited<ReturnType<typeof api.listJobs>>[number];

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

/** One question as the engine writes it (services/ai.ts parseQuestionnaire). */
interface Question {
  id: number;
  question: string;
  /** "text" | "boolean" | "select" | "multiselect" */
  question_type: string;
  options?: string[] | null;
  required?: boolean;
}

interface Questionnaire {
  questions: Question[];
  total_questions?: number;
}

/** What a question holds on screen: true/false for yes/no, a list for multiple choice, text otherwise. */
type AnswerValue = string | boolean | string[];

/** profile.questionnaire_answers: every answer the engine has saved, matched by the question's text. */
interface SavedAnswer {
  question: string;
  answer: unknown;
}

/** The parts of the saved organization profile this page reads. */
interface SavedProfile {
  organization_name?: string | null;
  organization_type?: string | null;
  city?: string | null;
  state?: string | null;
  diocese?: string | null;
  student_count?: number | null;
  has_school?: boolean;
  website_url?: string | null;
  school_website_url?: string | null;
  free_form_notes?: string | null;
  questionnaire_answers?: unknown;
  sources?: unknown;
  [field: string]: unknown;
}

interface GrantStats {
  total_grants: number;
  [field: string]: unknown;
}

interface ApplicationSummary {
  id: string;
  grant_id?: string;
  grant_name: string;
  funder: string;
  status: string;
  urgent?: boolean;
}

/** An uploaded document's findings (key_facts: facts the application writer can cite, when the engine sends them). */
interface DocumentExtraction {
  facility_needs?: string[];
  program_needs?: string[];
  security_concerns?: string[];
  key_facts?: string[];
}

interface DocumentResult {
  ok: boolean;
  message: string;
}

interface DiscoveryResult {
  found?: number;
  added: number;
  total_grants: number;
  notes?: string[];
}

/** Netlify accepts uploads up to about 4 MB; checking here gives a clear message instantly. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const BIG_FILE_HELP =
  'For a big report, make a text copy: in Word use File > Save As > Plain Text (.txt); for a PDF, select all the text (Ctrl+A or Cmd+A), copy it, paste it into a new document and save that as .txt, then add the .txt here. You can also paste key facts into "Anything else we should know?" on the Questions step (after the questions are written).';

const CONNECTION_PROBLEM =
  "Can't reach GrantFinder right now. Check your internet connection, then try again. Your work is saved.";

const STORAGE_BLOCKED =
  'This browser is blocking site storage: keep this tab open, and export your work before you close it.';

const GUEST_SIGN_OUT_WARNING =
  "You are signed in as a guest. After you sign out, this work (applications, profile, saved key) can't be opened again. Export what you need first. Sign out anyway?";

/** How long the session check and the reads that reopen saved work may take before "Try again" is offered. */
const SESSION_CHECK_TIMEOUT_MS = 20_000;
const RESUME_TIMEOUT_MS = 30_000;

/** The session this browser replaced or signed out of, kept so lost guest work can still be recovered by hand. */
const PREVIOUS_TOKEN_KEY = 'auth_token_previous';

/** Application statuses (server/types.ts ApplicationStatus) in plain words. */
const APPLICATION_STATUS_LABELS: Record<string, string> = {
  analysis: 'Reading requirements',
  intake: 'Gathering information',
  drafting: 'Drafting',
  review: 'Reviewing the draft',
  export: 'Ready to export',
};

/** Keyboard focus ring for a "Browse Files" label that sits right after its (visually hidden) file input. */
const FILE_LABEL_FOCUS =
  'peer-focus-visible:outline-2 peer-focus-visible:outline-solid peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--primary)]';

const STEPS: Array<{ id: SetupStep; label: string; icon: typeof Settings }> = [
  { id: 'api-key', label: 'API Key', icon: Settings },
  { id: 'grants', label: 'Grant Database', icon: Database },
  { id: 'website', label: 'Website', icon: Globe },
  { id: 'questionnaire', label: 'Questions', icon: MessageSquare },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'processing', label: 'Processing', icon: Play },
  { id: 'results', label: 'Results', icon: BarChart3 },
];

// =============================================================================
// Helpers
// =============================================================================

function logLine(status: ProcessingLog['status'], message: string): ProcessingLog {
  return { timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }), status, message };
}

/** Reject with a timeout error (worded by errorDetail) if the engine doesn't answer in time. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('GrantFinder took too long to answer.'), { code: 'ETIMEDOUT' }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const questionKey = (text: unknown): string => String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** How a question is shown: unknown types, and choices without options, are plain text boxes. */
function questionType(q: Question): 'boolean' | 'select' | 'multiselect' | 'text' {
  if (q.question_type === 'boolean') return 'boolean';
  if ((q.question_type === 'select' || q.question_type === 'multiselect') && q.options?.length) return q.question_type;
  return 'text';
}

/** A saved answer in the shape this question's input needs, or undefined when it doesn't fit. */
function toAnswerValue(q: Question, value: unknown): AnswerValue | undefined {
  if (value === null || value === undefined) return undefined;
  const type = questionType(q);
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['yes', 'true', 'y', '1'].includes(text)) return true;
    if (['no', 'false', 'n', '0'].includes(text)) return false;
    return undefined;
  }
  const options = q.options ?? [];
  const option = (text: unknown) => options.find((o) => o.trim().toLowerCase() === String(text).trim().toLowerCase());
  if (type === 'multiselect') {
    let picked: unknown[] = [];
    if (Array.isArray(value)) picked = value;
    else if (typeof value === 'string') picked = option(value) ? [value] : value.split(/\s*[,;]\s*/);
    const chosen = Array.from(new Set(picked.map(option).filter((o): o is string => Boolean(o))));
    return chosen.length ? chosen : undefined;
  }
  if (type === 'select') return option(Array.isArray(value) ? value[0] : value);
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return undefined;
}

/** Answers for these questions taken from earlier ones with the same question text. */
function prefillAnswers(questions: Question[], earlier: SavedAnswer[]): Record<number, AnswerValue> {
  const byText = new Map<string, unknown>();
  for (const item of earlier) {
    const key = questionKey(item.question);
    if (key) byText.set(key, item.answer);
  }
  const prefilled: Record<number, AnswerValue> = {};
  for (const q of questions) {
    const key = questionKey(q.question);
    if (!byText.has(key)) continue;
    const value = toAnswerValue(q, byText.get(key));
    if (value !== undefined) prefilled[q.id] = value;
  }
  return prefilled;
}

const isBlank = (value: AnswerValue | undefined): boolean =>
  value === undefined || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && value.length === 0);

/**
 * Earlier answers with the ones on screen laid over them, matched by question
 * text the way the engine saves them (a blank answer never erases an earlier one).
 */
function mergeAnswers(earlier: SavedAnswer[], questions: Question[], answers: Record<number, AnswerValue>): SavedAnswer[] {
  const merged = new Map<string, SavedAnswer>();
  for (const item of earlier) {
    const key = questionKey(item.question);
    if (key) merged.set(key, item);
  }
  for (const q of questions) {
    const value = answers[q.id];
    const key = questionKey(q.question);
    if (key && !isBlank(value)) merged.set(key, { question: q.question, answer: value });
  }
  return Array.from(merged.values());
}

function savedAnswersFrom(profile: SavedProfile | null): SavedAnswer[] {
  const list = Array.isArray(profile?.questionnaire_answers) ? profile.questionnaire_answers : [];
  return list.filter(
    (item): item is SavedAnswer => Boolean(item) && typeof item === 'object' && typeof (item as SavedAnswer).question === 'string',
  );
}

/** A questionnaire the page can show (odd entries dropped, options always a list of text), or null. */
function questionnaireFrom(data: unknown): Questionnaire | null {
  const list = (data as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(list)) return null;
  const questions: Question[] = list
    .filter((q): q is Question => Boolean(q) && typeof q === 'object' && typeof (q as Question).id === 'number' && typeof (q as Question).question === 'string')
    .map((q) => ({
      id: q.id,
      question: q.question,
      question_type: typeof q.question_type === 'string' ? q.question_type : 'text',
      // Trimmed and de-duplicated: a repeated option would be two checkboxes that toggle together.
      options: Array.isArray(q.options)
        ? Array.from(new Set(q.options.filter((o): o is string => typeof o === 'string').map((o) => o.trim()).filter(Boolean)))
        : null,
      required: Boolean(q.required),
    }));
  return questions.length ? { questions, total_questions: questions.length } : null;
}

const uniqueNames = (names: string[]) => Array.from(new Set(names.filter(Boolean)));

/** File names of documents already added to the profile (sources like "Document: minutes.pdf"). */
function documentNamesFrom(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  return uniqueNames(
    sources
      .filter((source): source is string => typeof source === 'string' && source.startsWith('Document: '))
      .map((source) => source.slice('Document: '.length).trim()),
  );
}

function findingsOf(extraction: DocumentExtraction): string[] {
  return [...(extraction.facility_needs || []), ...(extraction.program_needs || []), ...(extraction.security_concerns || [])];
}

const factCount = (extraction: DocumentExtraction): number =>
  Array.isArray(extraction.key_facts) ? extraction.key_facts.length : 0;

/** A document's line in the Documents step after it was read... */
function documentAdded(name: string, extraction: DocumentExtraction): DocumentResult {
  const facts = factCount(extraction);
  return { ok: true, message: `${name}: ${findingsOf(extraction).length} grant-relevant item(s) found${facts > 0 ? `, ${facts} fact(s) for the writer` : ''}` };
}

/** ...or when it couldn't be (it stays in the list, to try again or remove). */
function documentFailed(name: string, error: unknown): DocumentResult {
  return { ok: false, message: `${name}: ${errorDetail(error, 'could not be added. Try it again.')}` };
}

/** File size for messages, rounded up so a file just over the limit never reads "4.0 MB (limit 4 MB)". */
const megabytes = (bytes: number): string => (Math.ceil(bytes / 104857.6) / 10).toFixed(1);

/** Only real web addresses get a "Visit Grant Website" link. */
function webUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

const statusLabel = (status: unknown): string => APPLICATION_STATUS_LABELS[String(status)] ?? String(status ?? '');

// -----------------------------------------------------------------------------
// Match results: deadlines, top picks, sorting
// -----------------------------------------------------------------------------

/**
 * A match as the engine sends it when results are read: with its next due
 * date, days left and whether it has passed, worked out for today. (A
 * matching run's own result doesn't have them until the results are read back.)
 */
type MatchItem = MatchResultsData['matches'][number] & {
  next_deadline?: string | null;
  days_left?: number | null;
  deadline_passed?: boolean;
};

type ResultsSort = 'best' | 'deadline';

interface ResultsView {
  sort: ResultsSort;
  hideNotEligible: boolean;
}

/** How the person last chose to see the results (this browser only). */
const RESULTS_VIEW_KEY = 'grantfinder_results_view';
const DEFAULT_RESULTS_VIEW: ResultsView = { sort: 'best', hideNotEligible: false };
const TOP_PICKS = 5;

function readResultsView(): ResultsView {
  if (typeof window === 'undefined') return DEFAULT_RESULTS_VIEW;
  try {
    const saved = JSON.parse(window.localStorage.getItem(RESULTS_VIEW_KEY) || 'null') as Partial<ResultsView> | null;
    return { sort: saved?.sort === 'deadline' ? 'deadline' : 'best', hideNotEligible: saved?.hideNotEligible === true };
  } catch {
    return DEFAULT_RESULTS_VIEW;
  }
}

function saveResultsView(view: ResultsView) {
  try {
    window.localStorage.setItem(RESULTS_VIEW_KEY, JSON.stringify(view));
  } catch (error) {
    console.warn('[GrantFinder] Could not remember how to show the results in this browser:', error);
  }
}

const daysLeftOf = (match: MatchItem): number | null => (typeof match.days_left === 'number' ? match.days_left : null);
const isRolling = (match: MatchItem): boolean => /rolling/i.test(String(match.deadline ?? ''));

/** "Oct 15, 2026" for a YYYY-MM-DD date (a calendar date, so no time zone can shift it a day). */
function formatDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function daysLeftText(days: number): string {
  if (days <= 0) return 'Last day';
  return days === 1 ? '1 day left' : `${days} days left`;
}

/** Red within two weeks, amber within about six weeks, gray after that. */
function deadlineTone(days: number): 'soon' | 'near' | 'later' {
  return days <= 14 ? 'soon' : days <= 45 ? 'near' : 'later';
}

/** When a top pick is due, in words. */
function dueText(match: MatchItem): string {
  const days = daysLeftOf(match);
  if (match.next_deadline && days !== null && days >= 0) return `Due ${formatDate(match.next_deadline)} · ${daysLeftText(days)}`;
  if (isRolling(match)) return 'Rolling';
  return "Check the funder's site";
}

const byScore = (a: MatchItem, b: MatchItem): number => (b.score ?? 0) - (a.score ?? 0);

/** Soonest open deadline first, then rolling or unknown ones, then passed ones; ties by score. */
function byDeadline(a: MatchItem, b: MatchItem): number {
  const rank = (m: MatchItem) => (m.deadline_passed ? 2 : daysLeftOf(m) !== null ? 0 : 1);
  const [ra, rb] = [rank(a), rank(b)];
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (daysLeftOf(a) ?? 0) - (daysLeftOf(b) ?? 0) || byScore(a, b);
  if (ra === 2) return (daysLeftOf(b) ?? 0) - (daysLeftOf(a) ?? 0) || byScore(a, b);
  return byScore(a, b);
}

/**
 * Grants worth applying to first: excellent or good matches whose deadline
 * hasn't passed (possible ones fill in when there are fewer than five),
 * soonest deadline first, then best score.
 */
function topPicksOf(matches: MatchItem[]): MatchItem[] {
  const open = matches.filter((m) => !m.deadline_passed);
  const strong = open.filter((m) => m.score_tier === 'excellent' || m.score_tier === 'good');
  const possible = open.filter((m) => m.score_tier === 'possible').sort(byDeadline);
  const pool = strong.length >= TOP_PICKS ? strong : [...strong, ...possible.slice(0, TOP_PICKS - strong.length)];
  return [...pool].sort(byDeadline).slice(0, TOP_PICKS);
}

/** "N days left" on a match card: nothing for rolling or unknown deadlines. */
function DeadlineBadge({ match }: { match: MatchItem }) {
  if (match.deadline_passed) return <span className="deadline-badge past">Past deadline</span>;
  const days = daysLeftOf(match);
  if (days === null) return null;
  return <span className={`deadline-badge ${deadlineTone(days)}`}>{daysLeftText(days)}</span>;
}

/** The user id inside a session token. Not verified: only used to decide whether to warn or what to keep. */
function tokenSubject(token: string | null | undefined): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof claims?.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

const isGuestToken = (token: string | null | undefined): boolean => Boolean(tokenSubject(token)?.startsWith('guest_'));

/** The session in this browser: the saved token, or (storage blocked) the one held in this tab. */
function currentSessionToken(): string | null {
  try {
    return api.loadToken();
  } catch {
    return null;
  }
}

/** Keep the session being signed out of, but never replace a kept guest session (its only key) with a non-guest one. */
function keepPreviousToken(token: string | null) {
  if (!token) return;
  try {
    const kept = window.localStorage.getItem(PREVIOUS_TOKEN_KEY);
    if (kept && kept !== token && isGuestToken(kept) && !isGuestToken(token)) return;
    window.localStorage.setItem(PREVIOUS_TOKEN_KEY, token);
  } catch (error) {
    console.warn('[GrantFinder] Could not keep a copy of the session before signing out:', error);
  }
}

/** Answers on screen worth saving: not blank, each with the question text the person saw. */
function answersToSubmit(questions: Question[], answers: Record<number, AnswerValue>) {
  return questions
    .filter((q) => !isBlank(answers[q.id]))
    .map((q) => ({ question_id: q.id, answer: answers[q.id], question: q.question }));
}

/** The answers on screen that differ from what the engine already saved for the same question text. */
function unsavedAnswers(questions: Question[], answers: Record<number, AnswerValue>, saved: SavedAnswer[]) {
  const savedByText = new Map(saved.map((item) => [questionKey(item.question), item.answer]));
  const byId = new Map(questions.map((q) => [q.id, q]));
  return answersToSubmit(questions, answers).filter((item) => {
    const key = questionKey(item.question);
    const q = byId.get(item.question_id);
    if (!q || !savedByText.has(key)) return true;
    // Compared the way it was filled in on screen ("No" saved, the No button shown).
    return JSON.stringify(toAnswerValue(q, savedByText.get(key))) !== JSON.stringify(item.answer);
  });
}

const hasHttpResponse = (error: unknown): boolean =>
  typeof (error as { response?: { status?: unknown } } | null)?.response?.status === 'number';

/** What the "Try again" banner says: the engine's own words when it answered, else a connection problem. */
function problemText(errors: unknown[]): string {
  const answered = errors.find(hasHttpResponse);
  return answered ? `${errorDetail(answered, CONNECTION_PROBLEM)} Your work is saved.` : CONNECTION_PROBLEM;
}

/** "a, b and c" */
function listInWords(items: string[]): string {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Shown when the dashboard opens with only part of the saved work (after "Try again" also failed). */
const partialLoadNotice = (missing: string[]) =>
  `Some saved work couldn't be loaded right now: ${listInWords(missing)}. What loaded is shown below. Nothing is lost; reload the page in a few minutes to see the rest.`;

// Values only the browser knows: React reads them on every render and once more after mounting.
const subscribeNowhere = () => () => {};
const serverSnapshotFalse = () => false;
/** The browser refused to store the session, so it lives only in this tab. */
const sessionNotStoredSnapshot = () => !api.isSessionStored();

// =============================================================================
// Page
// =============================================================================

export default function Dashboard() {
  const router = useRouter();
  const { user, setUser, matchResults, setMatchResults } = useStore();
  const userId = user?.id ?? null;
  const signedIn = Boolean(user);
  const [currentStep, setCurrentStep] = useState<SetupStep>('api-key');
  // True until the saved key status, grants, profile, results and applications are read.
  const [restoring, setRestoring] = useState(true);
  /** What the "Try again" banner says when the saved work couldn't be read (null: no banner). */
  const [connectionProblem, setConnectionProblem] = useState<string | null>(null);
  /** Shown when the page opened with only part of the saved work. */
  const [partialNotice, setPartialNotice] = useState<string | null>(null);
  const storageBlocked = useSyncExternalStore(subscribeNowhere, sessionNotStoredSnapshot, serverSnapshotFalse);
  const [sessionCheck, setSessionCheck] = useState(0);
  const [resumeKey, setResumeKey] = useState(0);
  const [apiKey, setApiKey] = useState('');
  const [apiKeySet, setApiKeySet] = useState(false);
  const [grantFile, setGrantFile] = useState<File | null>(null);
  const [grantStats, setGrantStats] = useState<GrantStats | null>(null);
  const [discoveredTotal, setDiscoveredTotal] = useState(0);
  const [discoveryStatus, setDiscoveryStatus] = useState<string | null>(null);
  const [discoveryBusy, setDiscoveryBusy] = useState<DiscoverySource | null>(null);
  const [discoveryFocus, setDiscoveryFocus] = useState('');
  const [churchUrl, setChurchUrl] = useState('');
  const [schoolUrl, setSchoolUrl] = useState('');
  const [websiteScanned, setWebsiteScanned] = useState(false);
  const [questionnaire, setQuestionnaire] = useState<Questionnaire | null>(null);
  const [answers, setAnswers] = useState<Record<number, AnswerValue>>({});
  const [savedAnswers, setSavedAnswers] = useState<SavedAnswer[]>([]);
  const [freeFormText, setFreeFormText] = useState('');
  const [documents, setDocuments] = useState<File[]>([]);
  const [profileDocs, setProfileDocs] = useState<string[]>([]);
  const [docResults, setDocResults] = useState<DocumentResult[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingLogs, setProcessingLogs] = useState<ProcessingLog[]>([]);
  // Long steps run as background jobs; show which one and its latest status line.
  const [busy, setBusy] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  // Sort order and "Hide not eligible" for the results (remembered in this browser; shown only after restoring).
  const [resultsView, setResultsView] = useState<ResultsView>(readResultsView);
  const [applications, setApplications] = useState<ApplicationSummary[]>([]);
  const [profileExists, setProfileExists] = useState(false);
  const [showBasics, setShowBasics] = useState(false);
  const [basics, setBasics] = useState<OrgBasics>({
    organization_name: '', organization_type: 'both', city: '', state: '', diocese: '', student_count: '',
  });
  const terminalRef = useRef<HTMLDivElement>(null);
  const resumedFor = useRef<string | null>(null);
  /** Set by "Try again": if the saved work still can't all be read, open with what did load. */
  const retried = useRef(false);

  // The latest router, so endSession never changes (the reload below must not restart because of it).
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);

  /** The engine said the session is over (401): forget it and explain on the sign-in page. */
  const endSession = useCallback(() => {
    try {
      api.clearToken();
    } catch (error) {
      console.warn('[GrantFinder] Could not forget the ended session:', error);
    }
    routerRef.current.replace('/?expired=1');
  }, []);

  // Every engine call needs a session, so visitors without one go to sign-in.
  // Only a 401 ends the session here: a Wi-Fi blip or a Netlify error keeps the
  // token (for a guest it is the only key to their work) and offers "Try again".
  useEffect(() => {
    let token: string | null = null;
    try {
      token = api.loadToken();
    } catch (error) {
      console.warn('[GrantFinder] Could not read the saved session in this browser:', error);
    }
    if (!token) {
      router.replace('/');
      return;
    }
    if (signedIn) return;
    let active = true;
    withTimeout(api.getMe(), SESSION_CHECK_TIMEOUT_MS)
      .then((me) => {
        if (active) setUser(me);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isSessionEnded(error)) {
          console.warn('[GrantFinder] The session has ended; returning to sign-in.');
          endSession();
          return;
        }
        console.error(`[GrantFinder] Could not check the session (attempt ${sessionCheck + 1}); it is kept for the next try:`, error);
        setConnectionProblem(problemText([error]));
      });
    return () => {
      active = false;
    };
  }, [signedIn, setUser, router, endSession, sessionCheck]);

  // Live status lines from background jobs ("Scoring grants 11-15 of 40")
  useEffect(() => onJobProgress((info) => setJobProgress(info.progress)), []);

  // A file dropped outside a drop zone would make the browser open it and leave this page.
  useEffect(() => {
    const keepPage = (event: DragEvent) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
    };
    window.addEventListener('dragover', keepPage);
    window.addEventListener('drop', keepPage);
    return () => {
      window.removeEventListener('dragover', keepPage);
      window.removeEventListener('drop', keepPage);
    };
  }, []);

  // Pick up where the user left off: saved key, grants, profile, questions,
  // results, applications, and a matching run still in progress from before a
  // reload. On a first failure nothing is shown (a hiccup must never look like
  // lost work) and "Try again" (resumeKey) reads it all again; if that fails
  // too, the page opens with what did load and says what is missing.
  // Keyed on the user's id (not the user object, which changes when the key
  // is saved) and cancelled when the user changes, so a late answer can never
  // put another account's results on screen.
  useEffect(() => {
    if (!userId) return;
    const runKey = `${userId}#${resumeKey}`;
    if (resumedFor.current === runKey) return;
    resumedFor.current = runKey;
    let active = true;
    (async () => {
      const failures: Array<{ part: string; error: unknown }> = [];
      const read = <T,>(part: string, request: Promise<T>, fallback: T): Promise<T> =>
        withTimeout(request, RESUME_TIMEOUT_MS).catch((error: unknown) => {
          failures.push({ part, error });
          return fallback;
        });
      // Nice to have: without them there is just no pick-up of a running step, or no saved questions.
      const optional = <T,>(what: string, request: Promise<T>, fallback: T): Promise<T> =>
        withTimeout(request, RESUME_TIMEOUT_MS).catch((error: unknown) => {
          if (!isSessionEnded(error)) console.warn(`[GrantFinder] Could not load ${what}; carrying on without it:`, error);
          return fallback;
        });
      const [stats, profile, apps, latest, keyStatus, jobs, savedQuestions] = await Promise.all([
        read<GrantStats | null>('your grant database', api.getGrantStats(), null),
        read<SavedProfile | null>('your organization profile', api.getProfile(), null),
        read<ApplicationSummary[]>('your applications', api.listApplications(), []),
        read<MatchResultsData | null>('your match results', api.getLatestMatchResults(), null),
        read<{ is_set?: boolean } | null>('whether your Claude key is saved', api.getApiKeyStatus(), null),
        optional<JobSummary[]>('steps still running from before', api.listJobs(), []),
        optional<unknown>('the saved questions', api.getSavedQuestionnaire(), null),
      ]);
      if (!active) return;
      if (failures.some((failure) => isSessionEnded(failure.error))) {
        // /api/auth/api-key/status is an auth route, so lib/api leaves its 401 to the page.
        endSession();
        return;
      }
      if (failures.length) {
        console.error('[GrantFinder] Could not read all of the saved work:', failures);
        if (!retried.current) {
          setConnectionProblem(problemText(failures.map((failure) => failure.error)));
          return;
        }
        setPartialNotice(partialLoadNotice(failures.map((failure) => failure.part)));
      }

      let runningMatch: JobSummary | undefined;
      try {
        // What decides the step first: the key, grants, results, questions and applications.
        const totalGrants = typeof stats?.total_grants === 'number' ? stats.total_grants : 0;
        if (stats && totalGrants > 0) {
          setDiscoveredTotal(totalGrants);
          setGrantStats(stats);
        }
        setApplications(Array.isArray(apps) ? apps : []);
        // This account's saved results only (never whatever an earlier session left in the store).
        setMatchResults(latest);
        const saved = questionnaireFrom(savedQuestions);
        // Ask the engine (the signed-in user object can be from before the key was saved).
        if (keyStatus?.is_set ?? useStore.getState().user?.claude_api_key_set) {
          setApiKeySet(true);
          setCurrentStep((step) => (step === 'api-key'
            ? (latest ? 'results' : saved ? 'questionnaire' : totalGrants > 0 ? 'website' : 'grants')
            : step));
        }
        runningMatch = (Array.isArray(jobs) ? jobs : []).find(
          (job) => job.kind === 'processing.match_grants' && (job.status === 'running' || job.status === 'queued'),
        );
        if (runningMatch) {
          setCurrentStep('processing');
          setIsProcessing(true);
          setProcessingLogs([logLine('info', 'Matching is still running from before; picking it back up...')]);
        }

        const earlierAnswers = savedAnswersFrom(profile);
        setSavedAnswers(earlierAnswers);
        if (profile) {
          setProfileExists(true);
          setBasics({
            organization_name: String(profile.organization_name || ''),
            organization_type: String(profile.organization_type || 'both'),
            city: String(profile.city || ''),
            state: String(profile.state || ''),
            diocese: String(profile.diocese || ''),
            student_count: profile.student_count ? String(profile.student_count) : '',
          });
          if (profile.website_url) setChurchUrl(String(profile.website_url));
          if (profile.school_website_url) setSchoolUrl(String(profile.school_website_url));
          if (profile.free_form_notes) setFreeFormText(String(profile.free_form_notes));
          setProfileDocs(documentNamesFrom(profile.sources));
        }
        // The last questions Claude wrote come back without a new AI call, with earlier answers filled in.
        if (saved) {
          setQuestionnaire(saved);
          setAnswers(prefillAnswers(saved.questions, earlierAnswers));
        }
      } catch (error) {
        // Unexpected saved data must never leave the page stuck on "Opening your saved work...".
        console.error('[GrantFinder] Some saved work could not be shown:', error);
      }
      setRestoring(false);
      if (!runningMatch) return;
      try {
        const finished = (await api.waitForJob(runningMatch.id, runningMatch.kind)) as MatchResultsData;
        if (!active) return;
        setMatchResults(finished);
        // Read back, the saved results carry each grant's next deadline and days left.
        const saved: MatchResultsData | null = await api.getLatestMatchResults().catch(() => null);
        if (!active) return;
        if (saved?.session_id === finished.session_id) setMatchResults(saved);
        setIsProcessing(false);
        setCurrentStep('results');
      } catch (error) {
        if (!active || isSessionEnded(error)) return; // signed out, or lib/api is already returning to sign-in
        console.error('[GrantFinder] Matching from before the reload failed:', error);
        setProcessingLogs((logs) => [...logs, logLine('error', errorDetail(error, 'Matching failed. Run it again from the Documents step.'))]);
        setIsProcessing(false);
      }
    })();
    return () => {
      active = false;
      // Let the next run (another account, "Try again", or StrictMode's second mount) start fresh.
      resumedFor.current = null;
    };
  }, [userId, resumeKey, setMatchResults, endSession]);

  // Auto-scroll terminal
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [processingLogs]);

  const addLog = (status: ProcessingLog['status'], message: string) => {
    setProcessingLogs((prev) => [...prev, logLine(status, message)]);
  };

  /** "Try again" after the engine couldn't be reached: check the session, then read the saved work again. */
  const retryConnection = () => {
    retried.current = true;
    setConnectionProblem(null);
    setRestoring(true);
    if (user) setResumeKey((n) => n + 1);
    else setSessionCheck((n) => n + 1);
  };

  /** Run one user action with a busy label; failures show inline instead of alert boxes. */
  const runBusy = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setJobProgress(null);
    setStepError(null);
    try {
      await fn();
    } catch (error) {
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

  const signOut = () => {
    const token = currentSessionToken();
    // The user record may not have loaded (no connection): the stored token still says whether it is a guest.
    const guest = user ? user.id.startsWith('guest_') : isGuestToken(token);
    if (guest && !window.confirm(GUEST_SIGN_OUT_WARNING)) return;
    keepPreviousToken(token);
    try {
      api.clearToken();
    } catch (error) {
      console.warn('[GrantFinder] Could not forget the session in this browser:', error);
    }
    setUser(null);
    setMatchResults(null);
    router.push('/');
  };

  const copyDebugReport = async () => {
    setNotice(null);
    let report: string;
    try {
      report = await api.getDebugReport();
    } catch (error) {
      console.error('[GrantFinder] Could not get the debug report:', error);
      setNotice(`Could not get the debug report: ${errorDetail(error, 'unknown error')}`);
      return;
    }
    if (await copyText(report)) {
      setNotice('Debug report copied. Paste it into Claude Code.');
      return;
    }
    // Clipboard blocked: download it instead.
    console.warn('[GrantFinder] The browser blocked copying; downloading the debug report instead.');
    saveFile(report, 'grantfinder-debug-report.md', 'text/markdown;charset=utf-8');
    setNotice('Debug report downloaded (grantfinder-debug-report.md). Paste it into Claude Code.');
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

  const runDiscovery = async (source: DiscoverySource) => {
    setDiscoveryBusy(source);
    setDiscoveryStatus(null);
    setJobProgress(null);
    try {
      let result: DiscoveryResult;
      let summary: string;
      if (source === 'seed') {
        result = await api.loadStarterDatabase();
        summary = `Starter database loaded: ${result.added} grants added (${result.total_grants} total).`;
      } else if (source === 'grants_gov') {
        result = await api.searchGrantsGov();
        summary = `Grants.gov: found ${result.found}, added ${result.added} new (${result.total_grants} total).`;
      } else {
        result = await api.webDiscovery(discoveryFocus.trim() || undefined);
        summary = `AI web discovery: found ${result.found}, added ${result.added} new (${result.total_grants} total).`;
      }
      const notes = Array.isArray(result.notes) ? result.notes.join(' ') : '';
      setDiscoveryStatus(notes ? `${summary} ${notes}` : summary);
      setDiscoveredTotal(result.total_grants);
    } catch (error) {
      console.error(`[GrantFinder] Discovery (${source}) failed:`, error);
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
          setGrantStats((prev) => ({ ...(prev || {}), total_grants: discoveredTotal }));
          goTo('website');
        }
        return;
      }
      if (grantFile.size > MAX_UPLOAD_BYTES) {
        throw new Error(`${grantFile.name} is larger than 4 MB. Remove extra sheets or images and try again.`);
      }
      const uploaded = grantFile;
      const result: GrantStats = await api.uploadGrantDatabase(uploaded);
      setGrantStats(result);
      setDiscoveredTotal(result.total_grants);
      setGrantFile((current) => (current === uploaded ? null : current));
      goTo('website');
    });

  /**
   * Have Claude write questions, filling in earlier answers (saved or on screen)
   * wherever the question text matches. The new questions replace the saved
   * ones, so answers typed on screen and not saved yet are saved first.
   */
  const loadQuestionnaire = async () => {
    const shown = questionnaire?.questions ?? [];
    const unsaved = unsavedAnswers(shown, answers, savedAnswers);
    if (unsaved.length) {
      setBusy('Saving your answers');
      await api.submitQuestionnaire(unsaved, freeFormText);
      setSavedAnswers((earlier) => mergeAnswers(earlier, shown, answers));
      setProfileExists(true);
      setBusy('Writing your questions');
    }
    const earlier = mergeAnswers(savedAnswers, shown, answers);
    const fresh = questionnaireFrom(await api.generateQuestionnaire());
    if (!fresh) throw new Error('Claude did not write any questions. Please try again.');
    setQuestionnaire(fresh);
    setAnswers(prefillAnswers(fresh.questions, earlier));
    goTo('questionnaire');
  };

  const writeQuestions = () => runBusy('Writing your questions', loadQuestionnaire);

  const handleWebsiteScan = () =>
    runBusy('Scanning your website', async () => {
      if (!churchUrl && !schoolUrl) {
        throw new Error('Please enter at least one website URL');
      }
      try {
        await api.scanWebsite(churchUrl, schoolUrl);
      } catch (error) {
        if (isSessionEnded(error)) throw error;
        setShowBasics(true);
        const detail = errorDetail(error, 'Website scan failed.');
        throw new Error(/by hand|skip/i.test(detail) ? detail : `${detail} Use "Enter the basics by hand" or "Skip to questions" below.`);
      }
      setWebsiteScanned(true);
      setProfileExists(true);
      setBusy('Writing your questions');
      await loadQuestionnaire();
    });

  const saveBasics = () =>
    runBusy('Saving your organization basics', async () => {
      if (!basics.organization_name.trim() || !basics.state.trim()) {
        throw new Error('Please enter at least the organization name and state.');
      }
      const existing: SavedProfile | null = await api.getProfile();
      const base: SavedProfile = existing || { user_id: user?.id, organization_type: 'parish', city: '', state: '', sources: [] };
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
      const questions = questionnaire?.questions ?? [];
      // Only questions on screen, each with the text the person saw (the engine saves answers by question text).
      const answerArray = questions
        .filter((q) => Object.prototype.hasOwnProperty.call(answers, q.id))
        .map((q) => ({ question_id: q.id, answer: answers[q.id], question: q.question }));
      await api.submitQuestionnaire(answerArray, freeFormText);
      // The engine keeps earlier answers and updates these by question text; mirror that here.
      setSavedAnswers((earlier) => mergeAnswers(earlier, questions, answers));
      setProfileExists(true);
      goTo('documents');
    });

  const handleWriteApplication = (grantId: string) =>
    runBusy('Opening the application writer', async () => {
      const app = await api.createApplication(grantId);
      router.push(`/writer?id=${app.id}`);
    });

  const handleDocumentUpload = (files: FileList | null) => {
    // While documents are being read the list can't change (a file added now would be skipped or lost).
    if (!files || !files.length || busy) return;
    const accepted: File[] = [];
    const rejected: string[] = [];
    let anyTooBig = false;
    Array.from(files).forEach((file) => {
      if (file.size > MAX_UPLOAD_BYTES) {
        anyTooBig = true;
        rejected.push(`${file.name} is ${megabytes(file.size)} MB (limit 4 MB)`);
      } else if (!/\.(pdf|docx|txt)$/i.test(file.name)) {
        rejected.push(`${file.name} is not a PDF, DOCX, or TXT file`);
      } else {
        accepted.push(file);
      }
    });
    setStepError(rejected.length ? `Skipped: ${rejected.join('; ')}.${anyTooBig ? ` ${BIG_FILE_HELP}` : ''}` : null);
    if (accepted.length) setDocResults([]);
    // The same file picked twice is only processed once.
    setDocuments((prev) => [
      ...prev,
      ...accepted.filter((file, i) =>
        !prev.some((p) => p.name === file.name && p.size === file.size) &&
        accepted.findIndex((other) => other.name === file.name && other.size === file.size) === i),
    ]);
  };

  /** Take the documents that were read off the list (failed ones stay, to try again or remove) and show them as in the profile. */
  const finishDocuments = (succeeded: File[]) => {
    if (!succeeded.length) return;
    setDocuments((queue) => queue.filter((file) => !succeeded.includes(file)));
    setProfileDocs((names) => uniqueNames([...names, ...succeeded.map((file) => file.name)]));
    setProfileExists(true);
  };

  /** Add the queued documents to the profile (for matching later and for the writer) without matching now. */
  const addDocumentsOnly = () =>
    runBusy('Adding documents to your profile', async () => {
      const queued = documents;
      const results: DocumentResult[] = [];
      const succeeded: File[] = [];
      setDocResults([]);
      for (const [index, doc] of queued.entries()) {
        setBusy(`Adding ${doc.name} to your profile (${index + 1} of ${queued.length})`);
        setJobProgress(null);
        try {
          const extraction: DocumentExtraction = await api.uploadDocument(doc);
          results.push(documentAdded(doc.name, extraction));
          succeeded.push(doc);
        } catch (error) {
          if (isSessionEnded(error)) throw error;
          console.error(`[GrantFinder] Adding ${doc.name} failed:`, error);
          results.push(documentFailed(doc.name, error));
        }
        setDocResults([...results]);
      }
      finishDocuments(succeeded);
    });

  const runMatching = async () => {
    setCurrentStep('processing');
    setIsProcessing(true);
    setProcessingLogs([]);
    setStepError(null);
    setDocResults([]);

    try {
      // 1. Upload and extract every document for real - this is where the AI
      // catches the "playground equipment is 30 years old" class of signals.
      if (documents.length > 0) {
        addLog('info', `Processing ${documents.length} document(s)...`);
        const results: DocumentResult[] = [];
        const succeeded: File[] = [];
        for (const doc of documents) {
          addLog('info', `Reading ${doc.name}...`);
          try {
            const extraction: DocumentExtraction = await api.uploadDocument(doc);
            const findings = findingsOf(extraction);
            addLog('success', `${doc.name}: ${findings.length} grant-relevant item(s) extracted`);
            findings.slice(0, 4).forEach((item) => addLog('info', `  → ${item}`));
            const facts = factCount(extraction);
            if (facts > 0) addLog('info', `  → ${facts} fact(s) for the application writer`);
            results.push(documentAdded(doc.name, extraction));
            succeeded.push(doc);
          } catch (docError) {
            if (isSessionEnded(docError)) throw docError;
            console.error(`[GrantFinder] Reading ${doc.name} failed:`, docError);
            addLog('warning', `${doc.name}: extraction failed (${errorDetail(docError, 'error')}) — continuing`);
            results.push(documentFailed(doc.name, docError));
          }
        }
        // Shown back on the Documents step; a file that failed stays in its list.
        setDocResults(results);
        finishDocuments(succeeded);
      }

      // 2. Real matching run
      addLog('info', 'Scoring your grants and foundations against your profile...');
      addLog('info', 'Applying geographic and deadline hard filters, then AI scoring...');
      const results: MatchResultsData = await api.matchGrants();
      setMatchResults(results);

      addLog('success', '=== MATCHING COMPLETE ===');
      addLog('success', `${results.total_grants_evaluated} grants evaluated: ${results.excellent_matches} excellent, ${results.good_matches} good, ${results.possible_matches} possible`);
      // Read back, the saved results carry each grant's next deadline and days left (worked out when read).
      try {
        const saved: MatchResultsData | null = await api.getLatestMatchResults();
        if (saved?.session_id === results.session_id) setMatchResults(saved);
      } catch (error) {
        if (!isSessionEnded(error)) console.warn('[GrantFinder] Could not read the deadlines for the new results; they show after a reload:', error);
      }

      setIsProcessing(false);
      await new Promise((r) => setTimeout(r, 800));
      setCurrentStep('results');
    } catch (error) {
      console.error('[GrantFinder] Matching failed:', error);
      addLog('error', errorDetail(error, 'Matching failed. Check that your API key is saved, then retry.'));
      setIsProcessing(false);
    }
  };

  const updateResultsView = (change: Partial<ResultsView>) => {
    const next = { ...resultsView, ...change };
    setResultsView(next);
    saveResultsView(next);
  };

  /** The application already started for this grant, if any. */
  const applicationFor = (grantId: string) => applications.find((app) => app.grant_id === grantId);

  const downloadResults = async (format: ExportFormat) => {
    if (!matchResults?.session_id || exporting) return;
    setExporting(format);
    setStepError(null);
    try {
      const data = await api.exportResults(matchResults.session_id, format, true);
      saveFile(data, `grant_matches.${format}`, format === 'csv' ? 'text/csv;charset=utf-8' : 'text/markdown;charset=utf-8');
    } catch (error) {
      console.error(`[GrantFinder] Export (${format}) failed:`, error);
      setStepError(await blobErrorDetail(error, 'The export failed. Please try again.'));
    } finally {
      setExporting(null);
    }
  };

  const currentStepIndex = STEPS.findIndex((s) => s.id === currentStep);

  /** Steps the user may jump to: everything after the key is saved, results once they exist. */
  const canVisit = (id: SetupStep) => {
    if (restoring || busy || isProcessing) return false;
    if (id === 'api-key') return true;
    if (!apiKeySet) return false;
    if (id === 'processing') return false;
    if (id === 'results') return Boolean(matchResults);
    return true;
  };

  const busyBanner = busy && (
    <div className="mt-4 p-3 rounded bg-[var(--terminal-bg)] text-sm flex items-center gap-2" role="status">
      <Loader2 className="w-4 h-4 shrink-0 animate-spin text-[var(--primary)]" aria-hidden="true" />
      <span className="min-w-0 break-words">{busy}...{jobProgress ? ` ${jobProgress}` : ''}</span>
    </div>
  );

  const questions = questionnaire?.questions ?? [];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-[var(--card-border)]">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 shrink-0 bg-[var(--primary)] rounded-lg flex items-center justify-center">
              <Search className="w-5 h-5 text-white" aria-hidden="true" />
            </div>
            <span className="text-lg sm:text-xl font-bold truncate">GrantFinder AI</span>
          </div>
          <div className="flex items-center gap-3 sm:gap-4 shrink-0">
            <button
              type="button"
              onClick={copyDebugReport}
              className="text-sm text-gray-400 hover:text-white flex items-center gap-1"
              title="Copy a report of recent steps and errors to paste into Claude Code"
              aria-label="Copy debug report"
            >
              <Bug className="w-4 h-4" aria-hidden="true" />
              <span className="hidden md:inline">Copy debug report</span>
            </button>
            <span className="text-sm text-gray-400 truncate max-w-[7rem] sm:max-w-[14rem]">{user?.name || user?.email || ''}</span>
            <button
              type="button"
              onClick={signOut}
              className="text-gray-400 hover:text-white"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      {/* Progress Steps (click any available step to jump there) */}
      <div className="border-b border-[var(--card-border)] py-4">
        <div className="max-w-4xl mx-auto px-4 overflow-x-auto">
          <div className="flex items-center justify-between min-w-max md:min-w-0">
            {STEPS.map((step, index) => {
              const Icon = step.icon;
              const isActive = !restoring && step.id === currentStep;
              const isComplete = !restoring && index < currentStepIndex;
              const visitable = canVisit(step.id);
              const tone = isActive
                ? 'bg-[var(--primary)] text-white'
                : isComplete
                  ? 'text-[var(--accent)]'
                  : visitable
                    ? 'text-gray-300'
                    : 'text-gray-500';
              return (
                <div key={step.id} className="flex items-center">
                  <button
                    type="button"
                    disabled={!visitable}
                    aria-label={step.label}
                    aria-current={isActive ? 'step' : undefined}
                    title={step.label}
                    onClick={() => {
                      if (!isActive) goTo(step.id);
                    }}
                    className={`flex items-center gap-2 px-2 sm:px-3 py-2 rounded-lg ${tone} ${visitable && !isActive ? 'hover:bg-gray-800 cursor-pointer' : 'cursor-default'}`}
                  >
                    {isComplete ? (
                      <CheckCircle className="w-5 h-5" aria-hidden="true" />
                    ) : (
                      <Icon className="w-5 h-5" aria-hidden="true" />
                    )}
                    <span className="text-sm font-medium hidden md:inline">{step.label}</span>
                  </button>
                  {index < STEPS.length - 1 && (
                    <ChevronRight className="hidden sm:block w-4 h-4 text-gray-600 mx-1 md:mx-2" aria-hidden="true" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 py-6 sm:py-8">
        <div className="max-w-3xl mx-auto px-4">
          {storageBlocked && (
            <div className="mb-4 p-3 rounded bg-amber-950/60 border border-amber-800 text-amber-200 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{STORAGE_BLOCKED}</span>
            </div>
          )}

          {connectionProblem && (
            <div className="mb-4 p-3 rounded bg-red-950 border border-red-800 text-red-300 text-sm" role="alert">
              <p className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">{connectionProblem}</span>
              </p>
              <button type="button" onClick={retryConnection} className="btn btn-secondary text-sm mt-3">
                Try again
              </button>
            </div>
          )}

          {partialNotice && !restoring && (
            <div className="mb-4 p-3 rounded bg-amber-950/60 border border-amber-800 text-amber-200 text-sm flex justify-between gap-4" aria-live="polite">
              <span className="min-w-0 break-words">{partialNotice}</span>
              <button type="button" onClick={() => setPartialNotice(null)} className="text-amber-100 shrink-0" aria-label="Dismiss">×</button>
            </div>
          )}

          {notice && (
            <div className="mb-4 p-3 rounded bg-green-900/30 text-green-300 text-sm flex justify-between gap-4" aria-live="polite">
              <span className="min-w-0 break-words">{notice}</span>
              <button type="button" onClick={() => setNotice(null)} className="text-green-200 shrink-0" aria-label="Dismiss">×</button>
            </div>
          )}

          {stepError && currentStep !== 'processing' && !restoring && (
            <div className="sticky top-2 z-10 mb-4 p-3 rounded bg-red-950 border border-red-800 text-red-300 text-sm flex items-start gap-2" role="alert">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">{stepError}</span>
            </div>
          )}

          {restoring && (
            <div className="card text-gray-400 flex items-center gap-2" role="status">
              <Loader2 className="w-5 h-5 shrink-0 animate-spin text-[var(--primary)]" aria-hidden="true" />
              <span>Opening your saved work...</span>
            </div>
          )}

          {/* Saved applications: the fastest way back into the writer */}
          {!restoring && applications.length > 0 && currentStep !== 'processing' && (
            <div className="card mb-6">
              <h2 className="text-lg font-bold mb-3 flex items-center gap-2">
                <PenLine className="w-5 h-5" aria-hidden="true" /> Your applications
              </h2>
              <div className="space-y-3">
                {applications.map((app) => (
                  <div key={app.id} className="flex items-center justify-between gap-3 text-sm">
                    <div className="min-w-0 break-words">
                      <span className="font-medium">{app.grant_name}</span>
                      <span className="text-gray-400"> · {app.funder} · {statusLabel(app.status)}</span>
                      {app.urgent && <span className="text-red-400"> · deadline soon</span>}
                    </div>
                    <button type="button" onClick={() => router.push(`/writer?id=${app.id}`)} className="btn btn-secondary text-sm shrink-0">
                      Open →
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 1: API Key */}
          {!restoring && currentStep === 'api-key' && (
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
                aria-label="Claude API key"
                autoComplete="off"
                className="input mb-4"
              />
              <button
                type="button"
                onClick={handleApiKeySubmit}
                disabled={!apiKey || Boolean(busy)}
                className="btn btn-primary w-full"
              >
                {busy ? 'Checking key...' : 'Continue'}
                <ChevronRight className="w-5 h-5" aria-hidden="true" />
              </button>
              {apiKeySet && (
                <button type="button" onClick={() => goTo(discoveredTotal > 0 ? 'website' : 'grants')} className="btn btn-secondary w-full mt-3">
                  Keep my saved key
                </button>
              )}
              <p className="text-sm text-gray-400 mt-4 text-center">
                Get your API key at{' '}
                <a href="https://console.anthropic.com/" className="text-[var(--primary)]" target="_blank" rel="noopener noreferrer">
                  console.anthropic.com
                </a>
              </p>
            </div>
          )}

          {/* Step 2: Grant Database — discovery + optional upload */}
          {!restoring && currentStep === 'grants' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Build Your Grant Database</h2>
              <p className="text-gray-400 mb-6">
                Discover grants automatically, upload your own Excel file, or both.
                Everything merges into one database with duplicates removed.
              </p>

              <div className="grid gap-3 mb-6">
                <button
                  type="button"
                  onClick={() => runDiscovery('seed')}
                  disabled={discoveryBusy !== null}
                  className="btn btn-secondary w-full flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <Database className="w-5 h-5 shrink-0" aria-hidden="true" />
                    Load Starter Database
                  </span>
                  <span className="text-sm text-gray-400">
                    {discoveryBusy === 'seed' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : 'Curated Catholic + secular grants'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => runDiscovery('grants_gov')}
                  disabled={discoveryBusy !== null}
                  className="btn btn-secondary w-full flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <Globe className="w-5 h-5 shrink-0" aria-hidden="true" />
                    Search Grants.gov
                  </span>
                  <span className="text-sm text-gray-400">
                    {discoveryBusy === 'grants_gov' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : 'Live federal opportunities'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => runDiscovery('web_discovery')}
                  disabled={discoveryBusy !== null}
                  className="btn btn-secondary w-full flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-left"
                >
                  <span className="flex items-center gap-2">
                    <Search className="w-5 h-5 shrink-0" aria-hidden="true" />
                    AI Web Discovery
                  </span>
                  <span className="text-sm text-gray-400">
                    {discoveryBusy === 'web_discovery' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : 'Claude searches the web (uses your API key)'}
                  </span>
                </button>
              </div>

              <input
                type="text"
                value={discoveryFocus}
                onChange={(e) => setDiscoveryFocus(e.target.value)}
                placeholder="Optional focus for AI web discovery, e.g. teacher training in AI, playground equipment"
                aria-label="Optional focus for AI web discovery"
                className="input mb-6 text-sm"
              />

              {discoveryBusy && (
                <div className="mb-6 p-3 rounded bg-[var(--terminal-bg)] text-sm flex items-center gap-2" role="status">
                  <Loader2 className="w-4 h-4 shrink-0 animate-spin text-[var(--primary)]" aria-hidden="true" />
                  <span className="min-w-0 break-words">
                    {discoveryBusy === 'web_discovery' ? 'Claude is searching the web (this can take a few minutes)' : 'Working'}
                    ...{jobProgress ? ` ${jobProgress}` : ''}
                  </span>
                </div>
              )}

              {discoveryStatus && (
                <div className={`mb-6 p-3 rounded text-sm break-words ${discoveryStatus.startsWith('Discovery failed') ? 'bg-red-900/30 text-red-300' : 'bg-green-900/30 text-green-300'}`}>
                  {discoveryStatus}
                </div>
              )}

              <p className="text-gray-400 text-sm mb-3">
                Optional: upload your own Excel file with the 5 grant categories.
              </p>
              <div
                className={`dropzone relative ${grantFile ? 'active' : ''}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (busy) return; // the upload in progress uses the file already chosen
                  const file = e.dataTransfer.files[0];
                  if (file && /\.xlsx?$/i.test(file.name)) {
                    setStepError(null);
                    setGrantFile(file);
                  } else if (file) {
                    setStepError(`${file.name} is not an Excel file. Save it as .xlsx and try again.`);
                  }
                }}
              >
                <Upload className="w-12 h-12 text-gray-500 mx-auto mb-4" aria-hidden="true" />
                {grantFile ? (
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <p className="text-[var(--accent)] min-w-0 break-words">{grantFile.name}</p>
                    <button
                      type="button"
                      onClick={() => setGrantFile(null)}
                      disabled={Boolean(busy)}
                      className="btn btn-secondary text-sm"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="mb-2">Drag and drop your Excel file here</p>
                    <p className="text-sm text-gray-400">or</p>
                    <input
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={(e) => setGrantFile(e.target.files?.[0] || null)}
                      disabled={Boolean(busy)}
                      className="sr-only peer"
                      id="grant-file"
                    />
                    <label
                      htmlFor="grant-file"
                      aria-disabled={busy ? true : undefined}
                      className={`btn btn-secondary mt-4 cursor-pointer ${FILE_LABEL_FOCUS}`}
                    >
                      Browse Files
                    </label>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={handleGrantUpload}
                disabled={(!grantFile && discoveredTotal === 0) || Boolean(busy) || discoveryBusy !== null}
                className="btn btn-primary w-full mt-6"
              >
                {grantFile ? 'Upload and Continue' : `Continue with ${discoveredTotal} Discovered Grants`}
                <ChevronRight className="w-5 h-5 shrink-0" aria-hidden="true" />
              </button>
              {busyBanner}
            </div>
          )}

          {/* Step 3: Website URLs (or the basics by hand) */}
          {!restoring && currentStep === 'website' && (
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
                  <label htmlFor="church-url" className="block text-sm font-medium mb-2">Church/Parish Website</label>
                  <input
                    id="church-url"
                    type="url"
                    value={churchUrl}
                    onChange={(e) => setChurchUrl(e.target.value)}
                    placeholder="https://yourparish.org"
                    className="input"
                  />
                </div>
                <div>
                  <label htmlFor="school-url" className="block text-sm font-medium mb-2">School Website (if separate)</label>
                  <input
                    id="school-url"
                    type="url"
                    value={schoolUrl}
                    onChange={(e) => setSchoolUrl(e.target.value)}
                    placeholder="https://yourschool.org"
                    className="input"
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={handleWebsiteScan}
                disabled={(!churchUrl && !schoolUrl) || Boolean(busy)}
                className="btn btn-primary w-full mt-6"
              >
                Scan Website
                <ChevronRight className="w-5 h-5" aria-hidden="true" />
              </button>
              {websiteScanned && !busy && (
                <p className="text-sm text-[var(--accent)] mt-3">✓ Website scanned and added to your profile.</p>
              )}

              <div className="mt-6 pt-6 border-t border-[var(--card-border)]">
                <p className="text-sm text-gray-400 mb-3">
                  Some parish sites block automated reading. You can type the basics instead, or skip
                  straight to the questions{profileExists ? ' (your saved profile is kept)' : ''}.
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <button type="button" onClick={() => setShowBasics((v) => !v)} disabled={Boolean(busy)} className="btn btn-secondary sm:flex-1">
                    {showBasics ? 'Hide the basics form' : 'Enter the basics by hand'}
                  </button>
                  {questionnaire ? (
                    // The saved questions: no new AI call, and nothing already answered is replaced.
                    <button type="button" onClick={() => goTo('questionnaire')} disabled={Boolean(busy)} className="btn btn-secondary sm:flex-1">
                      Go to my questions
                    </button>
                  ) : (
                    <button type="button" onClick={writeQuestions} disabled={Boolean(busy)} className="btn btn-secondary sm:flex-1">
                      Skip to questions
                    </button>
                  )}
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
                      <button type="button" onClick={saveBasics} disabled={Boolean(busy)} className="btn btn-primary w-full">
                        Save basics and continue
                        <ChevronRight className="w-5 h-5" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
              {busyBanner}
            </div>
          )}

          {/* Step 4: Questionnaire */}
          {!restoring && currentStep === 'questionnaire' && !questionnaire && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Answer a Few Questions</h2>
              <p className="text-gray-400 mb-6">
                Claude writes up to 20 questions based on the grants in your database.
              </p>
              <button type="button" onClick={writeQuestions} disabled={Boolean(busy)} className="btn btn-primary w-full">
                Write my questions
                <ChevronRight className="w-5 h-5" aria-hidden="true" />
              </button>
              <button type="button" onClick={() => goTo('documents')} disabled={Boolean(busy)} className="btn btn-secondary w-full mt-3">
                Skip to documents
              </button>
              {busyBanner}
            </div>
          )}
          {!restoring && currentStep === 'questionnaire' && questionnaire && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Answer a Few Questions</h2>
              <p className="text-gray-400 mb-6">
                These questions help us match you with the right grants.
              </p>
              <div className="space-y-6">
                {questions.map((q) => {
                  const type = questionType(q);
                  const inputId = `q-${q.id}`;
                  const labelId = `q-${q.id}-label`;
                  const value = answers[q.id];
                  return (
                    <div key={q.id}>
                      <label
                        id={labelId}
                        htmlFor={type === 'text' || type === 'select' ? inputId : undefined}
                        className="block font-medium mb-2 break-words"
                      >
                        {q.question}
                        {q.required && <span className="text-red-500 ml-1">*</span>}
                      </label>
                      {type === 'boolean' && (
                        <div className="flex gap-4" role="group" aria-labelledby={labelId}>
                          <button
                            type="button"
                            aria-pressed={value === true}
                            disabled={Boolean(busy)}
                            onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: true }))}
                            className={`btn ${value === true ? 'btn-primary' : 'btn-secondary'}`}
                          >
                            Yes
                          </button>
                          <button
                            type="button"
                            aria-pressed={value === false}
                            disabled={Boolean(busy)}
                            onClick={() => setAnswers((prev) => ({ ...prev, [q.id]: false }))}
                            className={`btn ${value === false ? 'btn-primary' : 'btn-secondary'}`}
                          >
                            No
                          </button>
                        </div>
                      )}
                      {type === 'text' && (
                        <input
                          id={inputId}
                          type="text"
                          value={typeof value === 'string' ? value : ''}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                          disabled={Boolean(busy)}
                          className="input"
                        />
                      )}
                      {type === 'select' && (
                        <select
                          id={inputId}
                          value={typeof value === 'string' ? value : ''}
                          onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }))}
                          disabled={Boolean(busy)}
                          className="input"
                        >
                          <option value="">Select...</option>
                          {(q.options ?? []).map((opt) => (
                            <option key={opt} value={opt}>{opt}</option>
                          ))}
                        </select>
                      )}
                      {type === 'multiselect' && (
                        <div className="flex flex-wrap gap-3" role="group" aria-labelledby={labelId}>
                          {(q.options ?? []).map((opt) => {
                            const checked = Array.isArray(value) && value.includes(opt);
                            return (
                              <label key={opt} className="flex items-center gap-2 text-sm min-w-0">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={Boolean(busy)}
                                  onChange={() => setAnswers((prev) => {
                                    const selected = Array.isArray(prev[q.id]) ? (prev[q.id] as string[]) : [];
                                    return {
                                      ...prev,
                                      [q.id]: selected.includes(opt) ? selected.filter((o) => o !== opt) : [...selected, opt],
                                    };
                                  })}
                                />
                                <span className="min-w-0 break-words">{opt}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                <div>
                  <label htmlFor="q-notes" className="block font-medium mb-2">
                    Anything else we should know? (Optional)
                  </label>
                  <textarea
                    id="q-notes"
                    value={freeFormText}
                    onChange={(e) => setFreeFormText(e.target.value)}
                    disabled={Boolean(busy)}
                    className="input min-h-[100px]"
                    placeholder="Tell us about any specific needs, upcoming projects, or challenges..."
                  />
                </div>
              </div>
              <button
                type="button"
                onClick={handleQuestionnaireSubmit}
                disabled={Boolean(busy)}
                className="btn btn-primary w-full mt-6"
              >
                Continue
                <ChevronRight className="w-5 h-5" aria-hidden="true" />
              </button>
              <button type="button" onClick={writeQuestions} disabled={Boolean(busy)} className="btn btn-secondary w-full mt-3">
                Write new questions
              </button>
              <p className="text-sm text-gray-400 mt-2 text-center">
                Claude writes a fresh set. Answers you already gave are filled in where the questions match.
              </p>
              {busyBanner}
            </div>
          )}

          {/* Step 5: Documents */}
          {!restoring && currentStep === 'documents' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Upload Documents (Optional)</h2>
              <p className="text-gray-400 mb-6">
                Upload bulletins, meeting minutes, prior grant reports, or other documents for deeper
                analysis. What Claude finds is added to your profile, and the application writer can cite it.
              </p>
              {profileDocs.length > 0 && (
                <p className="text-sm text-gray-400 mb-4 break-words">
                  Already in your profile: {profileDocs.join(', ')}
                </p>
              )}
              <div
                className="dropzone relative"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDocumentUpload(e.dataTransfer.files);
                }}
              >
                <FileText className="w-12 h-12 text-gray-500 mx-auto mb-4" aria-hidden="true" />
                <p className="mb-2">Drag and drop PDF, DOCX, or TXT files (up to 4 MB each)</p>
                <input
                  type="file"
                  accept=".pdf,.docx,.txt"
                  multiple
                  onChange={(e) => {
                    handleDocumentUpload(e.target.files);
                    e.target.value = ''; // so the same file can be picked again later
                  }}
                  disabled={Boolean(busy)}
                  className="sr-only peer"
                  id="doc-files"
                />
                <label
                  htmlFor="doc-files"
                  aria-disabled={busy ? true : undefined}
                  className={`btn btn-secondary mt-4 cursor-pointer ${FILE_LABEL_FOCUS}`}
                >
                  Browse Files
                </label>
              </div>
              {documents.length > 0 && (
                <div className="mt-4">
                  <p className="text-sm text-gray-400 mb-2">Waiting to be added:</p>
                  <ul className="space-y-2">
                    {documents.map((doc, i) => (
                      <li key={`${doc.name}-${i}`} className="flex items-center gap-2 text-sm">
                        <FileText className="w-4 h-4 shrink-0 text-gray-400" aria-hidden="true" />
                        <span className="min-w-0 break-words">{doc.name}</span>
                        <button
                          type="button"
                          onClick={() => setDocuments((queue) => queue.filter((file) => file !== doc))}
                          disabled={Boolean(busy)}
                          aria-label={`Remove ${doc.name}`}
                          className="ml-auto shrink-0 text-gray-400 hover:text-white underline disabled:opacity-45 disabled:no-underline disabled:cursor-not-allowed"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                type="button"
                onClick={runMatching}
                disabled={Boolean(busy)}
                className="btn btn-primary w-full mt-6"
              >
                {documents.length > 0 ? 'Process Documents & Find Matches' : 'Skip & Find Matches'}
                <Play className="w-5 h-5 shrink-0" aria-hidden="true" />
              </button>
              {documents.length > 0 && (
                <button type="button" onClick={addDocumentsOnly} disabled={Boolean(busy)} className="btn btn-secondary w-full mt-3">
                  Add to my profile only (no new matching)
                </button>
              )}
              {docResults.length > 0 && (
                <ul className="mt-4 space-y-1 text-sm" aria-live="polite">
                  {docResults.map((result, i) => (
                    <li key={i} className={`flex items-start gap-2 ${result.ok ? 'text-[var(--accent)]' : 'text-red-300'}`}>
                      {result.ok
                        ? <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                        : <XCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />}
                      <span className="min-w-0 break-words">{result.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {busyBanner}
            </div>
          )}

          {/* Step 6: Processing */}
          {!restoring && currentStep === 'processing' && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Finding Your Grants</h2>
              <div className="terminal">
                <div className="terminal-header">
                  <div className="terminal-dot red"></div>
                  <div className="terminal-dot yellow"></div>
                  <div className="terminal-dot green"></div>
                  <span className="text-sm text-gray-400 ml-2">grantfinder-ai</span>
                </div>
                <div className="terminal-body" ref={terminalRef} role="log" aria-live="polite">
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
                      <Loader2 className="w-4 h-4 shrink-0 animate-spin text-[var(--primary)]" aria-hidden="true" />
                      {jobProgress && <span className="text-gray-400">{jobProgress}</span>}
                    </div>
                  )}
                </div>
              </div>
              {!isProcessing && processingLogs.some((l) => l.status === 'error') && (
                <button type="button" onClick={() => goTo('documents')} className="btn btn-secondary w-full mt-4">
                  ← Back — fix the issue and retry
                </button>
              )}
            </div>
          )}

          {/* Step 7: Results */}
          {!restoring && currentStep === 'results' && !matchResults && (
            <div className="card">
              <h2 className="text-2xl font-bold mb-4">Match Results</h2>
              <p className="text-gray-400 mb-4">No results yet. Run matching from the Documents step.</p>
              <button type="button" onClick={() => goTo('documents')} className="btn btn-primary w-full">Go to Documents</button>
            </div>
          )}
          {!restoring && currentStep === 'results' && matchResults && (
            <div className="space-y-6">
              {/* Summary */}
              <div className="card">
                <h2 className="text-2xl font-bold mb-4">Match Results</h2>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-x-2 gap-y-4 sm:gap-4 mb-6">
                  <div className="text-center">
                    <div className="text-2xl sm:text-3xl font-bold text-[var(--score-excellent)]">
                      {matchResults.excellent_matches}
                    </div>
                    <div className="text-xs sm:text-sm text-gray-400">Excellent</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl sm:text-3xl font-bold text-[var(--score-good)]">
                      {matchResults.good_matches}
                    </div>
                    <div className="text-xs sm:text-sm text-gray-400">Good</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl sm:text-3xl font-bold text-[var(--score-possible)]">
                      {matchResults.possible_matches}
                    </div>
                    <div className="text-xs sm:text-sm text-gray-400">Possible</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl sm:text-3xl font-bold text-[var(--score-weak)]">
                      {matchResults.weak_matches}
                    </div>
                    <div className="text-xs sm:text-sm text-gray-400">Weak</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl sm:text-3xl font-bold text-gray-500">
                      {matchResults.not_eligible}
                    </div>
                    <div className="text-xs sm:text-sm text-gray-400">Not Eligible</div>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
                  <button
                    type="button"
                    onClick={() => downloadResults('csv')}
                    disabled={exporting !== null}
                    className="btn btn-secondary sm:flex-1"
                  >
                    {exporting === 'csv'
                      ? <Loader2 className="w-5 h-5 shrink-0 animate-spin" aria-hidden="true" />
                      : <Download className="w-5 h-5 shrink-0" aria-hidden="true" />}
                    Export CSV
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadResults('md')}
                    disabled={exporting !== null}
                    className="btn btn-primary sm:flex-1"
                  >
                    {exporting === 'md'
                      ? <Loader2 className="w-5 h-5 shrink-0 animate-spin" aria-hidden="true" />
                      : <Download className="w-5 h-5 shrink-0" aria-hidden="true" />}
                    Export Report (Markdown)
                  </button>
                </div>
                {busyBanner}
              </div>

              {/* Top picks: what to apply to first, with when it is due and where to look */}
              {(() => {
                const picks = topPicksOf(matchResults.matches as MatchItem[]);
                return (
                  <div className="card">
                    <h2 className="text-lg font-bold mb-1 flex items-center gap-2">
                      <Star className="w-5 h-5 shrink-0 text-[var(--score-good)]" aria-hidden="true" /> Top picks
                    </h2>
                    <p className="text-sm text-gray-400 mb-4">
                      Your strongest matches whose deadline is still open, soonest deadline first.
                    </p>
                    {picks.length === 0 ? (
                      <p className="text-sm text-gray-400">
                        No strong match with an open deadline right now. Look through the full list below.
                      </p>
                    ) : (
                      <ol className="space-y-4">
                        {picks.map((match) => {
                          const pickUrl = webUrl(match.url);
                          const days = daysLeftOf(match);
                          const started = Boolean(applicationFor(match.grant_id));
                          const action = started ? 'Open application' : 'Start application';
                          return (
                            <li key={match.grant_id} className="border-t border-[var(--card-border)] pt-4 first:border-t-0 first:pt-0">
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 break-words">
                                  <p className="font-semibold">{match.grant_name}</p>
                                  <p className="text-sm text-gray-400">{match.funder}</p>
                                </div>
                                <span className={`score-badge shrink-0 ${match.score_tier}`}>{match.score}%</span>
                              </div>
                              <p className={`mt-1 text-sm ${days !== null && days >= 0 ? `due-text ${deadlineTone(days)}` : 'text-gray-400'}`}>
                                {dueText(match)}
                              </p>
                              <div className="mt-3 flex flex-wrap gap-2">
                                {pickUrl && (
                                  <a
                                    href={pickUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn btn-secondary text-sm"
                                    aria-label={`Investigate ${match.grant_name} (opens the funder's site in a new tab)`}
                                  >
                                    Investigate
                                  </a>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleWriteApplication(match.grant_id)}
                                  disabled={Boolean(busy)}
                                  className="btn btn-primary text-sm"
                                  aria-label={`${action}: ${match.grant_name}`}
                                >
                                  {action}
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                );
              })()}

              {/* How to list the matches (remembered in this browser) */}
              {(() => {
                const all = matchResults.matches as MatchItem[];
                const hidden = resultsView.hideNotEligible ? all.filter((m) => m.score_tier === 'not_eligible').length : 0;
                return (
                  <div className="rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                    <div className="flex items-center gap-2">
                      <label htmlFor="results-sort" className="text-gray-400">Sort by</label>
                      <select
                        id="results-sort"
                        value={resultsView.sort}
                        onChange={(e) => updateResultsView({ sort: e.target.value === 'deadline' ? 'deadline' : 'best' })}
                        className="results-select"
                      >
                        <option value="best">Best match</option>
                        <option value="deadline">Deadline soonest</option>
                      </select>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={resultsView.hideNotEligible}
                        onChange={(e) => updateResultsView({ hideNotEligible: e.target.checked })}
                      />
                      Hide not eligible
                    </label>
                    {hidden > 0 && (
                      <p className="w-full text-gray-400" aria-live="polite">
                        {hidden === 1 ? '1 grant you are not eligible for is hidden.' : `${hidden} grants you are not eligible for are hidden.`}
                      </p>
                    )}
                  </div>
                );
              })()}

              {/* Match List */}
              {(matchResults.matches as MatchItem[])
                .filter((match) => !(resultsView.hideNotEligible && match.score_tier === 'not_eligible'))
                .sort(resultsView.sort === 'deadline' ? byDeadline : byScore)
                .map((match) => {
                const grantUrl = webUrl(match.url);
                return (
                  <div key={match.grant_id} className="card">
                    <div className="flex items-start justify-between gap-3 mb-4">
                      <div className="min-w-0 break-words">
                        <h3 className="text-lg font-bold">{match.grant_name}</h3>
                        <p className="text-gray-400">{match.funder}</p>
                      </div>
                      <span className={`score-badge shrink-0 ${match.score_tier}`}>
                        {match.score}%
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 mb-4 text-sm">
                      <div className="min-w-0 break-words">
                        <span className="text-gray-400">Amount:</span>
                        <span className="ml-2 font-medium">{match.amount}</span>
                      </div>
                      <div className="min-w-0 break-words">
                        <span className="text-gray-400">Deadline:</span>
                        <span className="ml-2 font-medium">{match.deadline}</span>
                        {(match.deadline_passed || daysLeftOf(match) !== null) && (
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {match.next_deadline && !match.deadline_passed && (
                              <span className="text-xs text-gray-400">Next due {formatDate(match.next_deadline)}</span>
                            )}
                            <DeadlineBadge match={match} />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 break-words">
                        <span className="text-gray-400">Category:</span>
                        <span className="ml-2 font-medium capitalize">
                          {String(match.category || '').replace('_', ' ')}
                        </span>
                      </div>
                    </div>
                    <p className="text-gray-400 mb-4 break-words">{match.explanation}</p>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      {grantUrl && (
                        <a
                          href={grantUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--primary)] text-sm hover:underline"
                        >
                          Visit Grant Website →
                        </a>
                      )}
                      <div className="flex flex-wrap items-center gap-3 min-w-0 ml-auto">
                        {match.contact && (
                          <span className="text-sm text-gray-400 min-w-0 break-words">Contact: {match.contact}</span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleWriteApplication(match.grant_id)}
                          disabled={Boolean(busy)}
                          className="btn btn-primary text-sm"
                        >
                          Write Application →
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
