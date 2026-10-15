'use client';

/**
 * The application writer: one page that takes a grant application from the
 * funder's requirements to an exported file.
 *
 * Every AI step runs on the server as a background job (lib/api.ts waits for
 * it and reports progress); this page shows what is running, keeps typed text
 * safe across a reload (sessionStorage, this tab only), and never sends
 * anything to a funder: emails are copy-paste and export is a download.
 */
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle, Bug, CheckCircle, ChevronLeft, Copy, Download, FileText, Globe, History,
  Loader2, Paperclip, Pencil, RotateCcw, Save, Send, Target, Wand2,
} from 'lucide-react';
import api, { blobErrorDetail, errorDetail, isSessionEnded, onJobProgress } from '@/lib/api';
import { copyText, saveFile } from '@/lib/download';
import ApplicationChecklist, { type ChecklistAction } from './ApplicationChecklist';
import type {
  Application, FitAnalysis, FunderProfile, FunderRecordView, Gap, GrantSpec, IntakeRequest, RequiredSection, Scorecard, SectionDraft,
} from '@/server/types';

/** What GET /api/writer/applications/:id returns (routes/writer.ts getApplicationState). */
interface WriterState {
  application: Application;
  has_voice_profile: boolean;
  voice_style_guidelines: string | null;
  grant_spec: GrantSpec | null;
  fit_analysis: FitAnalysis | null;
  gaps: Gap[];
  open_blocking_gaps: Gap[];
  intake_requests: IntakeRequest[];
  sections: SectionDraft[];
  missing_sections: Array<{ id: string; title: string }>;
  stale_section_ids: string[];
  scorecard: Scorecard | null;
  /** What this funder has actually funded: notes, files, web research and the profile built from them. */
  funder_profile?: FunderRecordView | null;
  /** The fit analysis came before the funder profile (re-run it to use the profile). */
  funder_profile_newer_than_fit?: boolean;
}

type ExportFormat = 'docx' | 'md' | 'txt' | 'form_map';

const EXPORTS: Array<[ExportFormat, string]> = [
  ['docx', 'Word (.docx)'],
  ['md', 'Markdown'],
  ['txt', 'Portal paste-in (.txt)'],
  ['form_map', 'Form-field map (.json)'],
];

/** Application status (types.ts ApplicationStatus) in plain words. */
const APP_STATUS_LABELS: Record<string, string> = {
  analysis: 'Reading requirements',
  intake: 'Gathering information',
  drafting: 'Drafting',
  review: 'Reviewing the draft',
  export: 'Ready to export',
};

/** Gap status in plain words. */
const GAP_STATUS_LABELS: Record<string, string> = {
  open: 'open',
  routed: 'asked',
  answered: 'answered',
  confirmed_gap: "they don't have it",
  waived: 'waived',
};

/** Stakeholder request status in plain words. */
const REQUEST_STATUS_LABELS: Record<string, string> = {
  draft: 'not sent yet',
  sent: 'sent',
  answered: 'answered',
  confirmed_gap: "they don't have it",
};

/** Background job kind -> busy label, to pick a running step back up after a reload. */
const JOB_BUSY: Record<string, string> = {
  'writer.grant_spec': 'spec',
  'writer.funder_research': 'funder-research',
  'writer.funder_profile': 'funder',
  'writer.analyze': 'analyze',
  'writer.intake_generate': 'intake',
  'writer.voice_analyze': 'voice',
  'writer.draft': 'draft',
  'writer.refine': 'refine',
  'writer.score': 'score',
};

/** What each busy label means to a person watching the screen. */
const BUSY_LABELS: Record<string, string> = {
  spec: 'Reading the grant requirements',
  funder: 'Building the funder profile',
  'funder-research': 'Researching the funder on the web, then building its profile',
  'funder-file': 'Reading the file, then building the funder profile',
  'funder-remove': 'Removing the file',
  material: 'Reading the document and adding its facts to your profile',
  analyze: 'Comparing your profile to what the funder scores',
  strategy: 'Saving your strategy',
  waive: 'Updating the gap',
  intake: 'Writing stakeholder requests',
  answer: 'Saving the answer to your profile',
  voice: 'Learning your voice',
  draft: 'Drafting (a few minutes for a full application)',
  refine: 'Refining the section',
  edit: 'Saving your edit',
  restore: 'Restoring the earlier version',
  score: 'Scoring the draft against the rubric',
};

const RATING_COLORS: Record<string, string> = {
  strong: 'text-green-400 border-green-700',
  partial: 'text-yellow-400 border-yellow-700',
  weak: 'text-orange-400 border-orange-700',
  missing: 'text-red-400 border-red-700',
};

/** Disabled buttons look disabled (the shared .btn style has no :disabled look). */
const OFF = 'disabled:opacity-50 disabled:cursor-not-allowed';

/** Notices that report a problem (e.g. "Could not read <url> (HTTP 403)...") show amber, not green. */
const WARNING_NOTICE = /^(Could not|Couldn't|No guidelines|No facts|Not drafted|Left out|Still in|Web research|Your pasted notes|Only part|Only the first)/;

/** Files added on this page: the same limits as profile documents (Netlify accepts uploads up to about 4 MB). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Cards the Application Checklist can bring into view: below a sticky banner, and focusable for keyboard users. */
const TARGET = 'scroll-mt-24 focus:outline-none';
/** Pasted funder notes kept (FUNDER_NOTES_LIMIT in services/writer.ts). */
const FUNDER_NOTES_LIMIT = 60_000;
/** The file input's label shows the keyboard focus ring (the input itself is visually hidden). */
const FILE_LABEL_FOCUS =
  'peer-focus-visible:outline-2 peer-focus-visible:outline-solid peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--primary)]';

/** File size for messages, rounded up so a file just over the limit never reads "4.0 MB (limit 4 MB)". */
const megabytes = (bytes: number): string => (Math.ceil(bytes / 104857.6) / 10).toFixed(1);

/** Why a chosen file can't be added (PDF, Word or text up to 4 MB), or null when it can. */
function fileProblem(file: File): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is ${megabytes(file.size)} MB (limit 4 MB). Save just the pages that matter as a new PDF, or paste the text instead.`;
  }
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) return `${file.name} is not a PDF, Word (.docx), or text (.txt) file.`;
  if (file.size === 0) return `${file.name} is empty (0 bytes). Check that you picked the right file.`;
  return null;
}

/** Facts a document upload found for the writer (processing.upload_document's key_facts). */
function keyFactsOf(result: unknown): number {
  const facts = result && typeof result === 'object' ? (result as { key_facts?: unknown }).key_facts : null;
  return Array.isArray(facts) ? facts.length : 0;
}

/** Bring a part of the page into view and move the keyboard focus there (the checklist's buttons). False when it isn't on the page. */
function reveal(target: Element | null, focusTarget?: Element | null, block: ScrollLogicalPosition = 'start'): boolean {
  if (!(target instanceof HTMLElement)) return false;
  target.scrollIntoView({ behavior: 'smooth', block });
  const focusable = focusTarget instanceof HTMLElement ? focusTarget : target;
  focusable.focus({ preventScroll: true });
  return true;
}

const GUIDELINES_FILE_HELP = 'Guidelines file: PDF, Word (.docx) or text, up to 4 MB. Text in the box above is read first.';

/** Only real web addresses become links. */
function webUrl(text: string): string | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** "[NEEDS INPUT: ...]" markers drafting leaves where a fact was missing (same pattern as services/writer.ts). */
const NEEDS_INPUT = /\[NEEDS INPUT[^\]]*\]/gi;

/** Long funder questions fold away. */
const LONG_PROMPT = 220;

function busyText(busy: string): string {
  return BUSY_LABELS[busy] || (busy.startsWith('export-') ? 'Preparing your file' : 'Working');
}

/** Same rule as countWords in services/writer.ts (Python's len(text.split())). */
function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Same rule as countChars in services/writer.ts: code points, so an emoji or accented letter counts once. */
function countChars(text: string): number {
  return Array.from(text).length;
}

function placeholdersIn(text: string): string[] {
  return text.match(NEEDS_INPUT) ?? [];
}

/** The section a step's result is about (a refine returns the revised section). */
function sectionIdOf(result: unknown): string | null {
  const id = result && typeof result === 'object' ? (result as { section_id?: unknown }).section_id : null;
  return typeof id === 'string' && id ? id : null;
}

/** A step's own message, e.g. {note: "Could not read <url>..."}. */
function noteOf(result: unknown): string | null {
  if (result && typeof result === 'object' && 'note' in result) {
    const note = (result as { note?: unknown }).note;
    if (typeof note === 'string' && note.trim()) return note;
  }
  return null;
}

/** A refusal the person can act on (4xx: a rule, a missing step) is a warning in the console; anything else is an error. */
function logFailure(message: string, error: unknown): void {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) console.warn(message, error);
  else console.error(message, error);
}

/** The value a plain map holds for a key (never an inherited one such as "constructor"). */
function own<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Line breaks as the engine saves them, so "the same text" means the same thing here and there. */
function plainBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

// =============================================================================
// Typed text kept across a reload (sessionStorage: this tab, this application)
// =============================================================================

interface Unsaved {
  guidelines: string;
  /** A strategy edited but not saved yet. */
  strategy: string;
  intakeAnswers: Record<string, string>;
  refineInputs: Record<string, string>;
  voiceSample: string;
  /** section id -> text of an edit not saved yet (present = the section is in edit mode) */
  edits: Record<string, string>;
  /** section id -> the saved text when Edit was clicked (shows when a redraft or another tab changed it since) */
  editBases: Record<string, string>;
  /** Funder history notes typed but not saved yet. */
  funderNotes: string;
}

const NOTHING_UNSAVED: Unsaved = {
  guidelines: '', strategy: '', intakeAnswers: {}, refineInputs: {}, voiceSample: '', edits: {}, editBases: {}, funderNotes: '',
};
const unsavedKey = (appId: string) => `grantfinder.writer.unsaved.${appId}`;
let storageWarned = false;

function textMap(value: unknown, keepBlank: boolean): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && (keepBlank || entry[1].trim() !== ''));
  return Object.fromEntries(entries);
}

function readUnsaved(appId: string | null): Unsaved {
  if (!appId || typeof window === 'undefined') return NOTHING_UNSAVED;
  try {
    const raw = window.sessionStorage.getItem(unsavedKey(appId));
    if (!raw) return NOTHING_UNSAVED;
    const data = JSON.parse(raw) as Record<string, unknown> | null;
    return {
      guidelines: typeof data?.guidelines === 'string' ? data.guidelines : '',
      strategy: typeof data?.strategy === 'string' ? data.strategy : '',
      intakeAnswers: textMap(data?.intakeAnswers, false),
      refineInputs: textMap(data?.refineInputs, false),
      voiceSample: typeof data?.voiceSample === 'string' ? data.voiceSample : '',
      edits: textMap(data?.edits, true),
      editBases: textMap(data?.editBases, true),
      funderNotes: typeof data?.funderNotes === 'string' ? data.funderNotes : '',
    };
  } catch (error) {
    console.warn('[GrantFinder] Could not read the text kept from before the reload:', error);
    return NOTHING_UNSAVED;
  }
}

function writeUnsaved(appId: string, unsaved: Unsaved): void {
  const kept: Unsaved = {
    guidelines: unsaved.guidelines,
    strategy: unsaved.strategy,
    intakeAnswers: textMap(unsaved.intakeAnswers, false),
    refineInputs: textMap(unsaved.refineInputs, false),
    voiceSample: unsaved.voiceSample,
    edits: unsaved.edits,
    // A base only matters while its edit box is open.
    editBases: Object.fromEntries(Object.entries(unsaved.editBases).filter(([id]) => own(unsaved.edits, id) !== undefined)),
    funderNotes: unsaved.funderNotes,
  };
  const empty = !kept.guidelines.trim() && !kept.strategy.trim() && !kept.voiceSample.trim() && !Object.keys(kept.intakeAnswers).length &&
    !Object.keys(kept.refineInputs).length && !Object.keys(kept.edits).length && !kept.funderNotes.trim();
  try {
    if (empty) window.sessionStorage.removeItem(unsavedKey(appId));
    else window.sessionStorage.setItem(unsavedKey(appId), JSON.stringify(kept));
  } catch (error) {
    // Private browsing or a full storage: typing still works, it just won't survive a reload.
    if (!storageWarned) console.warn('[GrantFinder] Could not keep typed text for a reload:', error);
    storageWarned = true;
  }
}

// =============================================================================
// Small pieces
// =============================================================================

/** The funder's own question for a section; a long one folds away. */
function FunderAsks({ prompt }: { prompt: string }) {
  const text = prompt.trim();
  if (!text) return null;
  if (text.length <= LONG_PROMPT) return <p className="text-xs text-gray-400 mb-2 break-words">Funder asks: {text}</p>;
  return (
    <details className="text-xs text-gray-400 mb-2">
      <summary className="cursor-pointer break-words">
        Funder asks: {text.slice(0, 160).trimEnd()}... <span className="underline">show the full question</span>
      </summary>
      <p className="whitespace-pre-wrap break-words mt-1">{text}</p>
    </details>
  );
}

/** Live counts for a hand edit, by the engine's rules, against the section's limit. */
function EditCounts({ text, limits }: { text: string; limits?: RequiredSection }) {
  const words = countWords(text);
  const chars = countChars(text);
  const over = Boolean((limits?.word_limit && words > limits.word_limit) || (limits?.char_limit && chars > limits.char_limit));
  return (
    <span className={`text-xs ${over ? 'text-red-400' : 'text-gray-500'}`}>
      Your edit: {words} words{limits?.word_limit ? ` / ${limits.word_limit} max` : ''}
      {' · '}{chars}{limits?.char_limit ? ` / ${limits.char_limit}` : ''} characters
      {over && '. Over the limit: shorten it before you export.'}
    </span>
  );
}

/** A short titled list (nothing when empty). */
function ProfileList({ title, items, className = '' }: { title: string; items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={className}>
      <h3 className="font-semibold mb-1">{title}</h3>
      <ul className="list-disc ml-5 space-y-0.5">
        {items.map((item, i) => <li key={i} className="break-words">{item}</li>)}
      </ul>
    </div>
  );
}

/** The funder profile: what this funder has actually funded, and how to position the application. */
function FunderProfileView({ profile, outdated }: { profile: FunderProfile; outdated: boolean }) {
  const patterns = profile.giving_patterns;
  const ask = profile.ask_recommendation;
  const comparables = profile.comparable_grants || [];
  const facts: Array<[string, string]> = [
    ['Typical award', `${patterns.typical_range || 'Not shown in the material'}${patterns.median_award ? ` (median ${patterns.median_award})` : ''}`],
    ...(patterns.grants_per_year ? [['Grants a year', patterns.grants_per_year] as [string, string]] : []),
    ...(patterns.geography ? [['Where they give', patterns.geography] as [string, string]] : []),
    ...((patterns.recipient_types || []).length ? [['Who they fund', patterns.recipient_types.join(', ')] as [string, string]] : []),
  ];
  return (
    <div className="mt-4 pt-3 border-t border-gray-800 space-y-4 text-sm" data-funder-profile="">
      {outdated && (
        <p className="text-amber-300">
          Your notes, files or research changed after this profile was built. Click &quot;Build Funder Profile&quot; to update it.
        </p>
      )}
      {profile.summary && <p className="text-gray-200 break-words">{profile.summary}</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-gray-400">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {ask ? (
        <div className="rounded border border-[var(--primary)] bg-black/30 p-3">
          <div className="font-semibold">Suggested ask: {ask.range}</div>
          <p className="text-gray-300 mt-1 break-words">{ask.rationale}</p>
        </div>
      ) : (
        <p className="text-gray-400">No ask amount suggested: the material does not show enough award sizes.</p>
      )}
      {comparables.length > 0 && (
        <div>
          <h3 className="font-semibold mb-1">Comparable grants they made</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-xs border-collapse">
              <thead>
                <tr className="text-left text-gray-400">
                  <th scope="col" className="py-1 pr-2 font-normal">Recipient</th>
                  <th scope="col" className="py-1 pr-2 font-normal">Year</th>
                  <th scope="col" className="py-1 pr-2 font-normal">Amount</th>
                  <th scope="col" className="py-1 pr-2 font-normal">Purpose</th>
                  <th scope="col" className="py-1 font-normal">Why comparable</th>
                </tr>
              </thead>
              <tbody>
                {comparables.map((grantMade, i) => (
                  <tr key={i} className="border-t border-gray-800 align-top">
                    <td className="py-1 pr-2">
                      {grantMade.recipient}
                      {!grantMade.verified && (
                        <span className="block text-amber-300">Not found in your material. Check it before you rely on it.</span>
                      )}
                    </td>
                    <td className="py-1 pr-2">{grantMade.year || '-'}</td>
                    <td className="py-1 pr-2">{grantMade.amount || '-'}</td>
                    <td className="py-1 pr-2">{grantMade.purpose}</td>
                    <td className="py-1">{grantMade.why_comparable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ProfileList title="What they fund" items={(profile.priorities || []).map((p) => (p.evidence ? `${p.priority} (${p.evidence})` : p.priority))} />
      {(profile.exclusions || []).length > 0 && (
        <ProfileList title="What they don't fund" items={profile.exclusions}
          className="rounded border border-red-800 bg-red-950/40 text-red-200 p-2" />
      )}
      <ProfileList title="How they decide" items={profile.process_requirements || []} />
      <ProfileList title="How to position this application" items={profile.positioning || []} />
      {(profile.language_cues || []).length > 0 && (
        <p><span className="font-semibold">Words they use:</span> {profile.language_cues.join(' · ')}</p>
      )}
      <ProfileList title="Not shown in the material" items={profile.unknowns || []} className="text-gray-400" />
      {(profile.sources || []).length > 0 && (
        <div>
          <h3 className="font-semibold mb-1">Sources</h3>
          <ul className="space-y-0.5">
            {profile.sources.map((source, i) => {
              const href = webUrl(source);
              return (
                <li key={i} className="break-all">
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--primary)] hover:underline">{source}</a>
                  ) : source}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="text-xs text-gray-500">Built {new Date(profile.generated_at).toLocaleString()}</p>
    </div>
  );
}

// =============================================================================
// The page
// =============================================================================

function WriterInner({ appId }: { appId: string | null }) {
  const router = useRouter();
  // Text typed before a reload, kept until the step it belongs to succeeds.
  const [restored] = useState(() => readUnsaved(appId));

  const [state, setState] = useState<WriterState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  /** The section a per-section step (refine, redraft, edit, restore) is working on. */
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState<string | null>(null);
  const [guidelines, setGuidelines] = useState(restored.guidelines);
  const [strategyText, setStrategyText] = useState(restored.strategy);
  const [intakeAnswers, setIntakeAnswers] = useState(restored.intakeAnswers);
  const [refineInputs, setRefineInputs] = useState(restored.refineInputs);
  const [voiceSample, setVoiceSample] = useState(restored.voiceSample);
  const [edits, setEdits] = useState(restored.edits);
  const [editBases, setEditBases] = useState(restored.editBases);
  const [funderNotes, setFunderNotes] = useState(restored.funderNotes);
  /** A document was added here after the fit analysis: offer to re-run it. */
  const [materialAdded, setMaterialAdded] = useState(false);
  const [emailCopy, setEmailCopy] = useState<Record<string, 'copied' | 'failed'>>({});

  // Live status lines from background jobs ("Drafting section 2 of 6: Need")
  useEffect(() => onJobProgress((info) => setJobProgress(info.progress)), []);

  // The strategy counts as unsaved only when it differs from the saved one (or the
  // recommended one before confirming). While loading, keep whatever was restored.
  const savedStrategy = state ? state.application.strategy || state.fit_analysis?.recommended_strategy || '' : null;
  const unsavedStrategy = savedStrategy === null || (strategyText.trim() && strategyText.trim() !== savedStrategy.trim()) ? strategyText : '';
  // Funder notes count as unsaved only when they differ from the saved notes.
  const savedFunderNotes = state ? state.funder_profile?.notes_text ?? '' : null;
  const unsavedFunderNotes = savedFunderNotes === null || plainBreaks(funderNotes) !== plainBreaks(savedFunderNotes) ? funderNotes : '';

  // Typed text survives a reload of this tab.
  useEffect(() => {
    if (appId) {
      writeUnsaved(appId, {
        guidelines, strategy: unsavedStrategy, intakeAnswers, refineInputs, voiceSample, edits, editBases, funderNotes: unsavedFunderNotes,
      });
    }
  }, [appId, guidelines, unsavedStrategy, intakeAnswers, refineInputs, voiceSample, edits, editBases, unsavedFunderNotes]);

  // Sections whose edit box is open with text that differs from the saved text:
  // drafting, scoring and export would ignore that text, so they wait for Save or Cancel.
  const unsavedEdits = (state?.sections || []).filter((s) => {
    const text = own(edits, s.section_id);
    return text !== undefined && plainBreaks(text) !== plainBreaks(s.current_draft);
  });
  const hasUnsavedEdits = unsavedEdits.length > 0;

  // Closing or reloading the tab with an unsaved edit asks first.
  useEffect(() => {
    if (!hasUnsavedEdits) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ''; // older browsers show the prompt only when this is set
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedEdits]);

  const applyState = useCallback((data: WriterState) => {
    setState(data);
    const analysis = data.fit_analysis;
    if (analysis) setStrategyText((current) => current || data.application.strategy || analysis.recommended_strategy || '');
    // The saved funder notes fill an empty box (text typed before a reload wins).
    const savedNotes = data.funder_profile?.notes_text ?? '';
    if (savedNotes) setFunderNotes((current) => current || savedNotes);
  }, []);

  /**
   * Reload the application. quiet (after a step): never replace the error that
   * step showed; only say the page could not refresh when nothing else is shown.
   */
  const refresh = useCallback(async (quiet = false) => {
    if (!appId) return;
    try {
      applyState(await api.getApplication(appId));
    } catch (e) {
      console.warn('[GrantFinder] Could not refresh the application:', e);
      const message = errorDetail(e, 'Could not load the latest version of this application.');
      if (quiet) setError((current) => current ?? `Couldn't refresh this page: ${message} Reload the page to see the latest.`);
      else setError(message);
    }
  }, [appId, applyState]);

  /** A step started before a reload keeps running on the server: show it and wait, instead of starting (and paying for) it again. */
  const resumeRunningStep = useCallback(async (isCancelled: () => boolean) => {
    if (!appId) return;
    let jobs: Awaited<ReturnType<typeof api.listJobs>>;
    try {
      jobs = await api.listJobs();
    } catch (e) {
      console.warn('[GrantFinder] Could not check for a step still running:', e);
      return;
    }
    const running = jobs.find((job) => job.application_id === appId && (job.status === 'running' || job.status === 'queued'));
    if (!running || isCancelled()) return;
    const label = JOB_BUSY[running.kind] || 'draft';
    setBusy(label);
    setJobProgress(running.progress);
    try {
      const result = await api.waitForJob(running.id, running.kind);
      const note = noteOf(result);
      if (note) setNotice(note);
      // A refine that finished in the background used the instruction kept from before
      // the reload: clear it (unless the person has typed a new one since).
      const refinedId = running.kind === 'writer.refine' ? sectionIdOf(result) : null;
      if (refinedId) {
        const keptInstruction = own(restored.refineInputs, refinedId);
        setRefineInputs((current) => (own(current, refinedId) === keptInstruction ? without(current, refinedId) : current));
      }
    } catch (e) {
      logFailure(`[GrantFinder] writer step "${label}" failed:`, e);
      setError(errorDetail(e, 'That step failed.'));
    } finally {
      await refresh(true);
      setBusy(null);
      setJobProgress(null);
    }
  }, [appId, refresh, restored]);

  // Load the application first; only once that worked, look for a step still running.
  useEffect(() => {
    if (!appId) return;
    api.loadToken();
    let cancelled = false;
    api.getApplication(appId)
      .then((data: WriterState) => {
        if (cancelled) return;
        applyState(data);
        void resumeRunningStep(() => cancelled);
      })
      .catch((e) => {
        if (cancelled) return;
        if (isSessionEnded(e)) {
          // lib/api.ts already sends the person back to sign in.
          console.warn('[GrantFinder] Session ended while loading the application; returning to sign-in.');
          return;
        }
        logFailure('[GrantFinder] Failed to load application:', e);
        setLoadError(errorDetail(e, 'Failed to load application'));
      });
    return () => {
      cancelled = true;
    };
  }, [appId, loadAttempt, applyState, resumeRunningStep]);

  if (!appId) {
    return (
      <div className="p-8 space-y-4 text-gray-400">
        <p>No application selected. Start from a match result in the dashboard.</p>
        <button className="btn btn-secondary" onClick={() => router.push('/dashboard')}>
          <ChevronLeft className="w-4 h-4" /> Back to dashboard
        </button>
      </div>
    );
  }
  if (!state) {
    if (loadError) {
      return (
        <div className="p-8 space-y-4">
          <p className="flex items-start gap-2 text-red-300" role="alert">
            <AlertCircle className="w-5 h-5 shrink-0" /> <span>{loadError}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => { setLoadError(null); setLoadAttempt((n) => n + 1); }}>
              Try again
            </button>
            <button className="btn btn-secondary" onClick={() => router.push('/dashboard')}>
              <ChevronLeft className="w-4 h-4" /> Back to dashboard
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="p-8 flex items-center gap-2 text-gray-400">
        <Loader2 className="w-5 h-5 animate-spin" /> Loading application...
      </div>
    );
  }

  const app = state.application;
  const spec = state.grant_spec;
  const analysis = state.fit_analysis;
  const gaps = state.gaps || [];
  const blocking = state.open_blocking_gaps || [];
  const sections = state.sections || [];
  const missingSections = state.missing_sections || [];
  const staleIds = state.stale_section_ids || [];
  const scorecard = state.scorecard;
  const sectionSpecs = new Map((spec?.required_sections || []).map((section) => [section.id, section]));
  const openGaps = gaps.filter((gap) => gap.status === 'open');
  // Requests about gaps a re-analysis replaced are hidden (answers already recorded stay in the profile).
  // A request that never had a gap id was not replaced by anything, so it stays.
  const currentGapIds = new Set(gaps.map((gap) => gap.id));
  const intake = (state.intake_requests || []).filter((req) => {
    const ids = req.gap_ids || [];
    return ids.length === 0 || ids.some((gapId) => currentGapIds.has(gapId));
  });
  // A strategy edited after "Strategy confirmed" is saved before any drafting, so it is never silently ignored.
  const strategyChanged = Boolean(app.strategy_confirmed && strategyText.trim() && strategyText.trim() !== (app.strategy || '').trim());
  const exportable = sections.filter((s) => !staleIds.includes(s.section_id));
  const placeholderTotal = exportable.reduce((sum, s) => sum + placeholdersIn(s.current_draft).length, 0);
  const unsupportedTotal = exportable.reduce((sum, s) => sum + (s.claims || []).filter((c) => c.flagged).length, 0);
  const noticeIsWarning = notice !== null && WARNING_NOTICE.test(notice);
  const rankedFixes = scorecard?.ranked_fixes || [];
  const strengthLeads = analysis?.strength_leads || [];
  const unsavedTitles = unsavedEdits.map((s) => s.title).join(', ');
  const unsavedWhere = unsavedEdits.length === 1 ? 'that section' : 'those sections';
  const unsavedExportMessage = hasUnsavedEdits
    ? `Unsaved changes in ${unsavedTitles}: click Save on ${unsavedWhere} (or Cancel) before you export.`
    : '';
  const funderRecord = state.funder_profile ?? null;
  const funderFiles = funderRecord?.source_files ?? [];
  const canBuildFunder = Boolean(funderNotes.trim() || funderFiles.length || (funderRecord?.research_chars ?? 0) > 0);
  // The fit analysis recommends a strategy that differs from the one in use (e.g. after a re-run with the funder history).
  const recommended = analysis?.recommended_strategy?.trim() ?? '';
  const otherRecommendation = Boolean(
    app.strategy_confirmed && recommended && recommended !== (app.strategy || '').trim() && recommended !== strategyText.trim(),
  );

  /**
   * Run one step: busy banner, errors shown, and the page reloaded either way
   * (a long step that stops early still saves what it finished). True when it worked.
   */
  const run = async (label: string, fn: () => Promise<unknown>, onSuccess?: (result: unknown) => string | null): Promise<boolean> => {
    setBusy(label);
    setError(null);
    setNotice(null);
    setJobProgress(null);
    let ok = false;
    try {
      const result = await fn();
      ok = true;
      // e.g. "Could not read <url> (HTTP 403); requirements were inferred. Paste the guidelines..."
      const message = noteOf(result) || onSuccess?.(result) || null;
      if (message) setNotice(message);
    } catch (e) {
      logFailure(`[GrantFinder] writer step "${label}" failed:`, e);
      setError(errorDetail(e, `${BUSY_LABELS[label] || 'That step'} failed.`));
    } finally {
      await refresh(true);
      setBusy(null);
      setJobProgress(null);
    }
    return ok;
  };

  /** A step for one section (its buttons show the spinner). */
  const forSection = async (sectionId: string, task: () => Promise<boolean>): Promise<boolean> => {
    setActiveSection(sectionId);
    try {
      return await task();
    } finally {
      setActiveSection(null);
    }
  };

  const analyzeRequirements = async (text: string | undefined) => {
    if (await run('spec', () => api.enrichGrantSpec(appId, text))) setGuidelines('');
  };

  /** Re-running replaces the gap list, so it asks first (every "Re-run fit analysis" button). */
  const rerunFit = () => {
    if (!window.confirm('Re-running the fit analysis replaces the current gap list. Answers you recorded stay in your profile and are used in the new analysis. Continue?')) return;
    void (async () => {
      if (await run('analyze', () => api.analyzeFit(appId))) setMaterialAdded(false);
    })();
  };

  /** Analyze the requirements from a guidelines file; text in the paste box is read first. */
  const addGuidelinesFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy !== null) return;
    const problem = fileProblem(file);
    if (problem) {
      setNotice(null);
      setError(problem);
      return;
    }
    void (async () => {
      if (await run('spec', () => api.enrichGrantSpecFromFile(appId, file, guidelines), () => `Read the requirements from "${file.name}".`)) {
        setGuidelines('');
      }
    })();
  };

  /** Add a document's facts to the profile as evidence, so drafts can cite them (the same reading as the dashboard's documents). */
  const addMaterial = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy !== null) return;
    const problem = fileProblem(file);
    if (problem) {
      setNotice(null);
      setError(problem);
      return;
    }
    let facts = 0;
    void (async () => {
      const ok = await run('material', () => api.uploadDocument(file), (result) => {
        facts = keyFactsOf(result);
        return facts > 0
          ? `"${file.name}": ${facts} fact${facts === 1 ? '' : 's'} added for the writer.`
          : `No facts the writer can cite were found in "${file.name}".`;
      });
      if (ok && facts > 0) setMaterialAdded(true);
    })();
  };

  /** What the Application Checklist's buttons do. Steps run only as their own buttons would; approvals stay with the person. */
  const checklistAction = (action: ChecklistAction) => {
    if (busy !== null) return;
    const byId = (id: string) => document.getElementById(id);
    switch (action) {
      case 'analyze-requirements': {
        // Never runs by itself: the person may want to paste or add the guidelines first.
        const card = byId('writer-requirements');
        const details = card?.querySelector('details');
        if (details) details.open = true;
        reveal(card, card?.querySelector('textarea'));
        return;
      }
      case 'run-fit':
        if (!spec) {
          reveal(byId('writer-requirements'));
          return;
        }
        reveal(byId('writer-fit'));
        if (analysis) rerunFit(); // replaces the gap list, so it asks first
        else void run('analyze', () => api.analyzeFit(appId));
        return;
      case 'confirm-strategy': {
        // A human approval gate: bring the strategy up to read and confirm; the page never confirms it.
        const box = byId('writer-strategy');
        if (!reveal(box, box, 'center')) reveal(byId(spec ? 'writer-fit' : 'writer-requirements'));
        return;
      }
      case 'draft-missing':
        if (!app.strategy_confirmed) {
          const box = byId('writer-strategy');
          if (!reveal(box, box, 'center')) reveal(byId(spec ? 'writer-fit' : 'writer-requirements'));
          return;
        }
        reveal(byId('writer-draft'));
        // The Draft card says why when drafting has to wait (open high gaps, unsaved edits).
        if (blocking.length > 0 || hasUnsavedEdits) return;
        if (sections.length === 0) void draftSections();
        else if (missingSections.length > 0) void draftSections(undefined, true);
        return;
      case 'score':
        if (sections.length === 0 || hasUnsavedEdits) {
          reveal(byId(sections.length ? 'writer-draft' : 'writer-requirements'));
          return;
        }
        reveal(byId('writer-score'));
        void run('score', () => api.scoreApplication(appId));
        return;
      case 'export':
        reveal(byId('writer-export'));
        return;
      default: {
        const anchor = action.slice('scroll:'.length);
        const target = anchor.startsWith('section-')
          ? document.querySelector(`[data-section-id="${CSS.escape(anchor.slice('section-'.length))}"]`)
          : byId(anchor);
        if (!reveal(target)) console.warn(`[GrantFinder] The checklist pointed at something not on this page: ${anchor}`);
      }
    }
  };

  /** Build the funder profile from the notes in the box (saved with it), the files and earlier research; or research the web first. */
  const buildFunder = (researchWeb: boolean) =>
    run(researchWeb ? 'funder-research' : 'funder', () => api.buildFunderProfile(appId, funderNotes, researchWeb),
      () => 'Funder profile built. The fit analysis, drafting and scoring use it from now on.');

  /** Add a file to the funder history (the notes in the box are saved with it), then build the profile again. */
  const addFunderFile = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || busy !== null) return;
    const problem = fileProblem(file);
    if (problem) {
      setNotice(null);
      setError(problem);
      return;
    }
    void run('funder-file', () => api.uploadFunderFile(appId, file, funderNotes), () => `Added "${file.name}" and built the funder profile again.`);
  };

  const removeFunderFile = (name: string) => {
    if (!window.confirm(`Remove "${name}" from the funder history? Click "Build Funder Profile" afterwards to update the profile.`)) return;
    void run('funder-remove', () => api.removeFunderFile(appId, name), () => `Removed "${name}". Click "Build Funder Profile" to update the profile.`);
  };

  /** Every drafting button: saves an edited strategy first, then drafts. */
  const draftSections = (sectionId?: string, onlyMissing = false) =>
    run('draft', async () => {
      if (strategyChanged) await api.confirmStrategy(appId, strategyText);
      return api.draftSections(appId, sectionId, onlyMissing);
    });

  const redraftAll = () => {
    if (sections.length > 0 && !window.confirm('Redraft every section from scratch? The current text, including your refinements and edits, is replaced (earlier versions are kept in the history).')) return;
    void draftSections();
  };

  const refine = (s: SectionDraft) =>
    forSection(s.section_id, async () => {
      // A refusal (e.g. another step still running) shows as an error and keeps the instruction.
      const ok = await run('refine', () => api.refineSection(appId, s.section_id, own(refineInputs, s.section_id) ?? ''));
      if (ok) setRefineInputs((current) => without(current, s.section_id));
      return ok;
    });

  /** Open the edit box with the saved text, and remember that text to notice later changes. */
  const startEdit = (s: SectionDraft) => {
    setEdits((current) => ({ ...current, [s.section_id]: s.current_draft }));
    setEditBases((current) => ({ ...current, [s.section_id]: s.current_draft }));
  };

  const closeEdit = (sectionId: string) => {
    setEdits((current) => without(current, sectionId));
    setEditBases((current) => without(current, sectionId));
  };

  /** The saved text changed after Edit was clicked (a redraft, a restore, or another tab). */
  const savedTextMoved = (s: SectionDraft) => {
    const base = own(editBases, s.section_id);
    return base !== undefined && plainBreaks(base) !== plainBreaks(s.current_draft);
  };

  const saveEdit = (s: SectionDraft) => {
    if (savedTextMoved(s)) {
      if (!window.confirm(`The saved text of "${s.title}" changed after you started editing (a redraft or another tab). Save your text anyway? The newer text stays in Earlier versions.`)) return;
      // Asked once: the newer text is now the one this edit replaces.
      setEditBases((current) => ({ ...current, [s.section_id]: s.current_draft }));
    }
    return forSection(s.section_id, async () => {
      const ok = await run('edit', () => api.editSection(appId, s.section_id, own(edits, s.section_id) ?? ''), () => `Saved your edit to "${s.title}".`);
      if (ok) closeEdit(s.section_id);
      return ok;
    });
  };

  /** Cancel asks first when the person typed something (compared with the text the box started from). */
  const cancelEdit = (s: SectionDraft) => {
    const typed = own(edits, s.section_id) ?? '';
    const startedFrom = own(editBases, s.section_id) ?? s.current_draft;
    if (plainBreaks(typed) !== plainBreaks(startedFrom) &&
      !window.confirm(`Throw away your changes to "${s.title}"? They are not saved and cannot be recovered.`)) return;
    closeEdit(s.section_id);
  };

  const restoreVersion = (s: SectionDraft, text: string) => {
    if (!window.confirm(`Put this earlier version back as the text of "${s.title}"? The current text is kept in the earlier versions.`)) return;
    void forSection(s.section_id, () =>
      run('restore', () => api.editSection(appId, s.section_id, text), () => `Restored an earlier version of "${s.title}".`),
    );
  };

  const recordAnswer = async (req: IntakeRequest, confirmedGap: boolean) => {
    const typed = intakeAnswers[req.id] || '';
    const ok = await run('answer', () => api.answerIntake(appId, req.id, confirmedGap ? typed || "We don't have that." : typed, confirmedGap));
    if (ok) setIntakeAnswers((current) => without(current, req.id));
  };

  const captureVoice = async () => {
    if (await run('voice', () => api.analyzeVoice([voiceSample]))) setVoiceSample('');
  };

  const copyEmail = async (req: IntakeRequest) => {
    const copied = await copyText(req.email_packet);
    if (!copied) console.warn('[GrantFinder] The browser would not copy the email packet.');
    setEmailCopy((current) => ({ ...current, [req.id]: copied ? 'copied' : 'failed' }));
    if (copied) {
      window.setTimeout(() => setEmailCopy((current) => (current[req.id] === 'copied' ? without(current, req.id) : current)), 2000);
    }
  };

  const copyDebugBundle = async () => {
    setNotice(null);
    let bundle: string;
    try {
      bundle = await api.getApplicationDebugBundle(appId);
    } catch (e) {
      logFailure('[GrantFinder] Could not load the debug bundle:', e);
      setNotice(`Could not copy the debug bundle: ${errorDetail(e, 'unknown error')}`);
      return;
    }
    if (await copyText(bundle)) {
      setNotice('Debug bundle copied. Paste it into Claude Code.');
      return;
    }
    // The browser refused the clipboard: hand it over as a file instead.
    console.warn('[GrantFinder] The browser would not copy the debug bundle; downloading it instead.');
    try {
      saveFile(bundle, 'grantfinder-debug-bundle.md', 'text/markdown');
      setNotice('Debug bundle downloaded (grantfinder-debug-bundle.md). Paste it into Claude Code.');
    } catch (e) {
      console.error('[GrantFinder] Could not download the debug bundle:', e);
      setNotice('Could not copy the debug bundle: the browser blocked both copying and downloading.');
    }
  };

  const download = async (format: ExportFormat) => {
    if (unsavedExportMessage) {
      // The file would hold the saved text, not what is in the open edit box.
      setError(unsavedExportMessage);
      return;
    }
    setBusy(`export-${format}`);
    setError(null);
    setNotice(null);
    try {
      const response = await api.exportApplication(appId, format);
      const disposition = String(response.headers['content-disposition'] ?? '');
      const match = disposition.match(/filename="(.+?)"/);
      const filename = match ? match[1] : `application.${format === 'form_map' ? 'json' : format}`;
      saveFile(response.data, filename);
      let exportNotice = '';
      try {
        exportNotice = decodeURIComponent(String(response.headers['x-grantfinder-notice'] ?? ''));
      } catch {
        exportNotice = String(response.headers['x-grantfinder-notice'] ?? '');
      }
      // e.g. "Not drafted yet (marked in the file): ..." or "Still in the file: 2 [NEEDS INPUT] placeholder(s)..."
      setNotice(exportNotice ? `${exportNotice} Downloaded ${filename}.` : `Downloaded ${filename}.`);
    } catch (e) {
      logFailure(`[GrantFinder] export ${format} failed:`, e);
      setError(await blobErrorDetail(e, 'Export failed.'));
    } finally {
      await refresh(true);
      setBusy(null);
    }
  };

  /** "Add the guidelines as a file" (card 1, before and after the first analysis). */
  const guidelinesFileInput = (
    <>
      <input id="writer-guidelines-file" type="file" accept=".pdf,.docx,.txt" className="sr-only peer" disabled={busy !== null}
        onChange={(e) => {
          addGuidelinesFile(e.target.files);
          e.target.value = ''; // the same file can be chosen again
        }} />
      <label htmlFor="writer-guidelines-file" aria-disabled={busy !== null ? true : undefined}
        className={`btn btn-secondary cursor-pointer ${FILE_LABEL_FOCUS}`}>
        <Paperclip className="w-4 h-4" /> Add the guidelines as a file
      </label>
    </>
  );

  const renderSection = (s: SectionDraft) => {
    const stale = staleIds.includes(s.section_id);
    // Limits belong to the question this draft answers; a stale draft has none.
    const limits = stale ? undefined : sectionSpecs.get(s.section_id);
    const editing = own(edits, s.section_id) !== undefined;
    const editText = own(edits, s.section_id) ?? '';
    const refineText = own(refineInputs, s.section_id) ?? '';
    const flagged = (s.claims || []).filter((c) => c.flagged);
    const placeholders = placeholdersIn(s.current_draft);
    const versions = s.versions || [];
    const mine = activeSection === s.section_id;
    return (
      <div key={s.section_id} data-section-id={s.section_id} tabIndex={-1} className={`border border-gray-800 rounded p-3 ${TARGET}`}>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 mb-1">
          <h3 className="font-semibold">
            {s.title}
            {stale && (
              <span className="ml-2 text-xs text-yellow-400 font-normal">no longer in the requirements (not exported)</span>
            )}
          </h3>
          <span className={`text-xs ${s.over_limit ? 'text-red-400' : 'text-gray-500'}`}>
            {s.word_count} words{limits?.word_limit ? ` / ${limits.word_limit} max` : ''}
            {limits?.char_limit ? ` · ${s.char_count} / ${limits.char_limit} characters` : ''}
            {s.over_limit && ' — OVER LIMIT'}
          </span>
        </div>
        {limits?.prompt ? <FunderAsks prompt={limits.prompt} /> : null}
        {editing ? (
          <div className="mb-2 space-y-2">
            <textarea
              aria-label={`Edit ${s.title}`}
              value={editText}
              readOnly={busy !== null}
              onChange={(e) => {
                const value = e.target.value;
                setEdits((current) => ({ ...current, [s.section_id]: value }));
              }}
              className="w-full h-72 bg-black/30 border border-gray-700 rounded p-3 text-sm"
            />
            {savedTextMoved(s) && (
              <p className="text-amber-400 text-xs">
                The saved text changed after you started editing (a redraft or another tab). Save replaces it; the newer
                text stays in Earlier versions. Cancel shows it.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <EditCounts text={editText} limits={limits} />
              <div className="flex gap-2">
                <button className={`btn btn-primary text-xs ${OFF}`} disabled={busy !== null || !editText.trim()}
                  title={editText.trim() ? 'Save this text as the section' : 'The section cannot be empty'}
                  onClick={() => void saveEdit(s)}>
                  {busy === 'edit' && mine ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
                </button>
                <button className={`btn btn-secondary text-xs ${OFF}`} disabled={busy !== null}
                  onClick={() => cancelEdit(s)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words text-sm text-gray-300 bg-black/20 rounded p-3 mb-2">{s.current_draft}</pre>
        )}
        {placeholders.length > 0 && (
          <p className="text-amber-400 text-xs mb-2 break-words">Fill in before you submit: {placeholders.join('; ')}</p>
        )}
        {flagged.length > 0 && (
          <p className="text-yellow-400 text-xs mb-2">
            ⚑ Unsupported claims: {flagged.map((c) => c.claim).join('; ')}
            {versions.length > 0 ? ' (checked on the first draft)' : ''}
          </p>
        )}
        {s.banned_phrase_hits.length > 0 && (
          <p className="text-red-400 text-xs mb-2">Banned phrases present: {s.banned_phrase_hits.join(', ')}</p>
        )}
        {(s.compliance_notes || []).length > 0 && (
          <ul className="text-gray-500 text-xs mb-2 list-disc ml-4">
            {s.compliance_notes.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <input
            aria-label={`Refine ${s.title}`}
            placeholder='Refine: e.g. "tighten by 40 words", "warm this up", "lead with the outcome"'
            value={refineText}
            onChange={(e) => {
              const value = e.target.value;
              setRefineInputs((current) => ({ ...current, [s.section_id]: value }));
            }}
            className="flex-1 min-w-[12rem] bg-black/30 border border-gray-700 rounded p-2 text-xs"
          />
          <button className={`btn btn-secondary text-xs ${OFF}`}
            disabled={busy !== null || editing || !refineText.trim()}
            onClick={() => void refine(s)}>
            {busy === 'refine' && mine ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Wand2 className="w-3 h-3" /> Refine</>}
          </button>
          <button className={`btn btn-secondary text-xs ${OFF}`} disabled={busy !== null || editing || blocking.length > 0 || hasUnsavedEdits}
            title={hasUnsavedEdits ? 'Save or cancel the open edit first' : 'Write this section again from scratch'}
            onClick={() => void forSection(s.section_id, () => draftSections(s.section_id))}>
            {busy === 'draft' && mine && <Loader2 className="w-3 h-3 animate-spin" />} Redraft
          </button>
          {!editing && (
            <button className={`btn btn-secondary text-xs ${OFF}`} disabled={busy !== null} title="Change the text yourself"
              onClick={() => startEdit(s)}>
              <Pencil className="w-3 h-3" /> Edit
            </button>
          )}
        </div>
        {versions.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-gray-400">Earlier versions ({versions.length})</summary>
            <ol className="mt-2 space-y-3">
              {versions.map((text, index) => ({ text, number: index + 1 })).reverse().map(({ text, number }) => (
                <li key={number} className="space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-gray-500">
                    <span>Version {number}{number === versions.length ? ' (newest)' : ''} · {countWords(text)} words</span>
                    <button className={`flex items-center gap-1 text-[var(--primary)] hover:underline ${OFF}`}
                      disabled={busy !== null || editing}
                      title={editing ? 'Save or cancel your edit first' : 'Make this the current text again'}
                      onClick={() => restoreVersion(s, text)}>
                      <RotateCcw className="w-3 h-3" /> Restore this version
                    </button>
                  </div>
                  <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words bg-black/20 border border-gray-800 rounded p-2 text-gray-400">
                    {text}
                  </div>
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="card">
        <div className="flex items-center justify-between gap-2 mb-3">
          <button onClick={() => router.push('/dashboard')} className="text-sm text-gray-500 hover:underline flex items-center gap-1">
            <ChevronLeft className="w-4 h-4" /> Back to dashboard
          </button>
          <button onClick={() => void copyDebugBundle()} disabled={busy !== null}
            className={`text-sm text-gray-500 hover:text-white flex items-center gap-1 ${OFF}`}
            title="Copy this application's AI call log and errors to paste into Claude Code">
            <Bug className="w-4 h-4" /> Copy debug bundle
          </button>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold">{app.grant_name}</h1>
            <p className="text-gray-400">{app.funder} · Deadline: {app.deadline || 'check guidelines'}</p>
          </div>
          <div className="text-right space-y-1">
            <span className="text-xs bg-gray-800 rounded px-2 py-1">{APP_STATUS_LABELS[app.status] || app.status}</span>
            {app.urgent && (
              <div className="text-red-400 text-sm flex items-center gap-1 justify-end">
                <AlertCircle className="w-4 h-4" /> Deadline soon — critical path
              </div>
            )}
          </div>
        </div>
      </div>

      {(busy || notice || error) && (
        <div className="sticky top-2 z-10 space-y-2">
          {busy && (
            <div className="p-3 rounded bg-[var(--terminal-bg)] border border-gray-800 text-sm flex items-center gap-2" role="status">
              <Loader2 className="w-4 h-4 animate-spin text-[var(--primary)]" />
              <span>{busyText(busy)}...{jobProgress ? ` ${jobProgress}` : ''}</span>
            </div>
          )}
          {notice && !busy && (
            <div className={`p-3 rounded border text-sm flex justify-between gap-4 ${noticeIsWarning
              ? 'bg-amber-950 border-amber-800 text-amber-200'
              : 'bg-green-950 border-green-800 text-green-300'}`}>
              <span className="break-words">{notice}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
            </div>
          )}
          {error && !busy && (
            <div className="p-3 rounded bg-red-950 border border-red-800 text-red-300 text-sm flex justify-between gap-4" role="alert">
              <span className="break-words">{error}</span>
              <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
            </div>
          )}
        </div>
      )}

      {/* What is done, what is left, where the gaps are, and the next step */}
      <ApplicationChecklist appId={appId} state={state} busy={busy !== null} onAction={checklistAction} />

      {/* Stage 1: Grant Spec */}
      <div id="writer-requirements" tabIndex={-1} className={`card ${TARGET}`}>
        <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><FileText className="w-5 h-5" /> 1 · Grant Requirements</h2>
        {!spec ? (
          <>
            <p className="text-gray-400 text-sm mb-3">
              Paste the full grant guidelines if you have them (best results). Leave blank to work from the grant record and its website.
            </p>
            <textarea
              aria-label="Grant guidelines"
              value={guidelines}
              onChange={(e) => setGuidelines(e.target.value)}
              placeholder="Paste guidelines / RFP text here (optional)..."
              className="w-full h-32 bg-black/30 border border-gray-700 rounded p-3 text-sm mb-3"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button className={`btn btn-primary ${OFF}`} disabled={busy !== null}
                onClick={() => void analyzeRequirements(guidelines || undefined)}>
                {busy === 'spec' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Analyze Requirements'}
              </button>
              {guidelinesFileInput}
            </div>
            <p className="text-xs text-gray-500 mt-2">{GUIDELINES_FILE_HELP}</p>
          </>
        ) : (
          <div className="space-y-3 text-sm">
            <div>
              <span className="font-semibold">{spec.required_sections.length} required sections</span>
              {spec.rubric_source === 'inferred' && (
                <span className="ml-2 text-yellow-400">rubric INFERRED — verify against actual guidelines</span>
              )}
            </div>
            {spec.rubric_source === 'inferred' && (
              <p className="text-yellow-300">
                These requirements were inferred, not read from the funder&apos;s guidelines. For an exact
                spec, paste the guidelines below and re-analyze.
              </p>
            )}
            <ul className="list-disc ml-5 text-gray-300">
              {spec.required_sections.map((s) => (
                <li key={s.id}>
                  {s.title}
                  {s.word_limit ? ` (max ${s.word_limit} words)` : s.char_limit ? ` (max ${s.char_limit} chars)` : ''}
                </li>
              ))}
            </ul>
            {spec.format_constraints.length > 0 && (
              <p className="text-gray-400">Format: {spec.format_constraints.join(' · ')}</p>
            )}
            {spec.deliverables.length > 0 && (
              <p className="text-gray-400">Deliverables: {spec.deliverables.join(' · ')}</p>
            )}
            <details open={spec.rubric_source === 'inferred'}>
              <summary className="cursor-pointer text-gray-400">Paste guidelines and re-analyze</summary>
              <textarea
                aria-label="Grant guidelines"
                value={guidelines}
                onChange={(e) => setGuidelines(e.target.value)}
                placeholder="Paste guidelines / RFP text here..."
                className="w-full h-32 bg-black/30 border border-gray-700 rounded p-3 text-sm my-2"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button className={`btn btn-secondary ${OFF}`} disabled={busy !== null || !guidelines.trim()}
                  onClick={() => void analyzeRequirements(guidelines)}>
                  {busy === 'spec' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Re-analyze Requirements'}
                </button>
                {guidelinesFileInput}
              </div>
              <p className="text-xs text-gray-500 mt-2">{GUIDELINES_FILE_HELP}</p>
            </details>
          </div>
        )}
      </div>

      {/* Stage 1b: Funder History (what the funder has actually funded) */}
      {spec && (
        <div className="card">
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><History className="w-5 h-5" /> 1b · Funder History</h2>
          <p className="text-gray-400 text-sm mb-3">
            Match this application to what the funder has actually funded, not only to the written guidelines.
            Add what you know, or let Claude search the web. The fit analysis, drafting and scoring then use the funder profile.
          </p>
          <textarea
            aria-label="Funder history notes"
            value={funderNotes}
            onChange={(e) => setFunderNotes(e.target.value)}
            placeholder="Paste what you know about this funder: past grantees, annual report or 990-PF grant lists, notes from calls, feedback on past applications"
            className="w-full h-32 bg-black/30 border border-gray-700 rounded p-3 text-sm"
          />
          {funderNotes.length > FUNDER_NOTES_LIMIT && (
            <p className="text-xs text-amber-300 mt-1">
              That is more than {FUNDER_NOTES_LIMIT.toLocaleString('en-US')} characters; only the first {FUNDER_NOTES_LIMIT.toLocaleString('en-US')} are kept. Add a long grant list as a file instead.
            </p>
          )}
          {funderFiles.length > 0 && (
            <ul className="text-sm space-y-1 mt-2" aria-label="Funder files">
              {funderFiles.map((file) => (
                <li key={file.name} className="flex flex-wrap items-center gap-x-2">
                  <FileText className="w-4 h-4 text-gray-500 shrink-0" />
                  <span className="break-all">{file.name}</span>
                  <span className="text-xs text-gray-500">{file.chars.toLocaleString('en-US')} characters</span>
                  <button className={`text-xs text-gray-400 hover:underline ${OFF}`} disabled={busy !== null}
                    aria-label={`Remove ${file.name}`} onClick={() => removeFunderFile(file.name)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            <button className={`btn btn-primary ${OFF}`} disabled={busy !== null || !canBuildFunder} onClick={() => void buildFunder(false)}>
              {(busy === 'funder' || busy === 'funder-file') && <Loader2 className="w-4 h-4 animate-spin" />} Build Funder Profile
            </button>
            <input id="writer-funder-file" type="file" accept=".pdf,.docx,.txt" className="sr-only peer" disabled={busy !== null}
              onChange={(e) => {
                addFunderFile(e.target.files);
                e.target.value = ''; // the same file can be chosen again
              }} />
            <label htmlFor="writer-funder-file" aria-disabled={busy !== null ? true : undefined}
              className={`btn btn-secondary cursor-pointer ${FILE_LABEL_FOCUS}`}>
              <Paperclip className="w-4 h-4" /> Add a file
            </label>
            <button className={`btn btn-secondary ${OFF}`} disabled={busy !== null} onClick={() => void buildFunder(true)}>
              {busy === 'funder-research' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />} Research the web and build
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Files: PDF, Word (.docx) or text, up to 4 MB. &quot;Research the web and build&quot; uses Claude&apos;s web search on your own
            Claude API key (a few searches, about 1 cent each, plus the usual Claude cost).
          </p>
          {state.funder_profile_newer_than_fit && analysis && (
            <div className="mt-3 p-3 rounded border bg-amber-950 border-amber-800 text-amber-200 text-sm flex flex-wrap items-center justify-between gap-2">
              <span>The fit analysis and strategy were made before this funder profile. Re-run the fit analysis so they use what this funder has funded.</span>
              <button className={`btn btn-secondary ${OFF}`} disabled={busy !== null} onClick={rerunFit}>Update the fit analysis now</button>
            </div>
          )}
          {funderRecord?.profile && (
            <FunderProfileView profile={funderRecord.profile} outdated={funderRecord.profile_outdated} />
          )}
        </div>
      )}

      {/* Stage 2: Fit & Strategy */}
      {spec && (
        <div id="writer-fit" tabIndex={-1} className={`card ${TARGET}`}>
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><Target className="w-5 h-5" /> 2 · Fit, Gaps &amp; Strategy</h2>
          {!analysis ? (
            <button className={`btn btn-primary ${OFF}`} disabled={busy !== null}
              onClick={() => void run('analyze', () => api.analyzeFit(appId))}>
              {busy === 'analyze' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Run Fit Analysis'}
            </button>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2">
                {analysis.fit_map.map((f, i) => (
                  <div key={i} className={`border rounded p-2 text-sm ${RATING_COLORS[f.rating] || ''}`}>
                    <span className="font-semibold uppercase text-xs mr-2">{f.rating}</span>
                    {f.criterion_name}
                    {f.evidence.length > 0 && (
                      <div className="text-gray-400 text-xs mt-1">Evidence: {f.evidence.join('; ')}</div>
                    )}
                    {f.missing && <div className="text-gray-400 text-xs mt-1">Missing: {f.missing}</div>}
                  </div>
                ))}
              </div>
              <button className={`text-xs text-gray-400 hover:underline ${OFF}`} disabled={busy !== null} onClick={rerunFit}>
                Re-run fit analysis (after adding answers or documents)
              </button>
              {strengthLeads.length > 0 && (
                <div className="text-sm text-gray-300">
                  <span className="font-semibold">Lead with:</span> {strengthLeads.join(' · ')}
                </div>
              )}
              {analysis.honesty_ledger.length > 0 && (
                <div className="text-sm text-gray-300">
                  <span className="font-semibold">Name honestly (don&apos;t hide):</span> {analysis.honesty_ledger.join(' · ')}
                </div>
              )}
              <div>
                <label htmlFor="writer-strategy" className="text-sm font-semibold block mb-1">Narrative strategy (edit before confirming)</label>
                <textarea
                  id="writer-strategy"
                  value={strategyText}
                  onChange={(e) => setStrategyText(e.target.value)}
                  className="w-full h-24 bg-black/30 border border-gray-700 rounded p-3 text-sm"
                />
                {!app.strategy_confirmed ? (
                  <button className={`btn btn-primary mt-2 ${OFF}`} disabled={busy !== null}
                    onClick={() => void run('strategy', () => api.confirmStrategy(appId, strategyText))}>
                    {busy === 'strategy' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm Strategy'}
                  </button>
                ) : strategyChanged ? (
                  <button className={`btn btn-primary mt-2 ${OFF}`} disabled={busy !== null}
                    onClick={() => void run('strategy', () => api.confirmStrategy(appId, strategyText))}>
                    Save strategy changes (used for the next drafts)
                  </button>
                ) : (
                  <p className="text-green-400 text-sm mt-2 flex items-center gap-1"><CheckCircle className="w-4 h-4" /> Strategy confirmed</p>
                )}
                {otherRecommendation && (
                  <details className="text-sm mt-2">
                    <summary className="cursor-pointer text-gray-400">See the strategy the fit analysis recommends</summary>
                    <p className="text-gray-300 whitespace-pre-wrap break-words mt-1">{analysis.recommended_strategy}</p>
                    <button className={`btn btn-secondary mt-2 ${OFF}`} disabled={busy !== null}
                      onClick={() => setStrategyText(analysis.recommended_strategy)}>
                      Use this strategy
                    </button>
                  </details>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stage 3: Gaps & Stakeholder Intake */}
      {analysis && gaps.length > 0 && (
        <div id="missing-info" tabIndex={-1} className={`card ${TARGET}`}>
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><Send className="w-5 h-5" /> 3 · Missing Info &amp; Stakeholders</h2>
          <div className="space-y-2 mb-4">
            {gaps.map((g) => (
              <div key={g.id} className="flex items-start justify-between text-sm border border-gray-800 rounded p-2">
                <div>
                  <span className={`uppercase text-xs mr-2 ${g.severity === 'high' ? 'text-red-400' : 'text-yellow-400'}`}>{g.severity}</span>
                  {g.description}
                  <span className="text-gray-500 ml-2">
                    → {g.suggested_owner_role || 'unassigned'} · {GAP_STATUS_LABELS[g.status] || g.status}
                    {g.status === 'confirmed_gap' && <span className="text-gray-600"> (confirmed_gap)</span>}
                  </span>
                  {g.answer && <div className="text-gray-400 text-xs mt-1">Answer: {g.answer}</div>}
                </div>
                {['open', 'routed'].includes(g.status) && (
                  <button className={`text-xs text-gray-400 hover:underline shrink-0 ml-2 ${OFF}`} disabled={busy !== null}
                    onClick={() => void run('waive', () => api.waiveGap(appId, g.id, 'Proceeding without it'))}>
                    waive
                  </button>
                )}
              </div>
            ))}
          </div>
          {openGaps.length > 0 && (
            <button className={`btn btn-secondary mb-4 ${OFF}`} disabled={busy !== null}
              onClick={() => void run('intake', () => api.generateIntake(appId))}>
              {busy === 'intake' ? <Loader2 className="w-4 h-4 animate-spin" />
                : intake.length === 0 ? 'Generate Stakeholder Requests' : `Write requests for the ${openGaps.length} open gap(s)`}
            </button>
          )}
          {intake.length > 0 && (
            <div className="space-y-4">
              {intake.map((req) => (
                <div key={req.id} data-intake-id={req.id} className="border border-gray-800 rounded p-3 text-sm space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{req.stakeholder_role}</span>
                    <span className="text-xs text-gray-500">{REQUEST_STATUS_LABELS[req.status] || req.status}</span>
                  </div>
                  <p className="text-gray-400">{req.framing}</p>
                  <details>
                    <summary className="cursor-pointer text-gray-400">Copy-paste email packet</summary>
                    <pre className="whitespace-pre-wrap break-words bg-black/30 rounded p-2 mt-1 text-xs">{req.email_packet}</pre>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <button className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1"
                        onClick={() => void copyEmail(req)}>
                        <Copy className="w-3 h-3" /> Copy email
                      </button>
                      <span className="text-xs" aria-live="polite">
                        {emailCopy[req.id] === 'copied' && <span className="text-green-400">Copied</span>}
                        {emailCopy[req.id] === 'failed' && (
                          <span className="text-amber-400">Couldn&apos;t copy. Select the text and copy it.</span>
                        )}
                      </span>
                    </div>
                  </details>
                  {req.status !== 'answered' && req.status !== 'confirmed_gap' && (
                    <div className="space-y-2">
                      <textarea
                        aria-label={`Answer from ${req.stakeholder_role}`}
                        placeholder="Paste the stakeholder's answer here..."
                        value={intakeAnswers[req.id] || ''}
                        onChange={(e) => {
                          const value = e.target.value;
                          setIntakeAnswers((current) => ({ ...current, [req.id]: value }));
                        }}
                        className="w-full h-16 bg-black/30 border border-gray-700 rounded p-2 text-xs"
                      />
                      <div className="flex gap-2">
                        <button className={`btn btn-secondary text-xs ${OFF}`} disabled={busy !== null || !(intakeAnswers[req.id] || '').trim()}
                          onClick={() => void recordAnswer(req, false)}>
                          Record Answer
                        </button>
                        <button className={`text-xs text-gray-400 hover:underline ${OFF}`} disabled={busy !== null}
                          onClick={() => void recordAnswer(req, true)}>
                          They don&apos;t have it
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* More material for the writer: a document's facts become profile evidence that drafts can cite */}
      {spec && (
        <div id="writer-materials" className="card">
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><Paperclip className="w-5 h-5" /> Add Materials</h2>
          <p className="text-gray-400 text-sm mb-3">
            Add a document (budget, prior report, letters, data) so drafts can cite it. Claude reads it and adds its key facts to
            your profile, where the fit analysis and every draft can use them.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input id="writer-material-file" type="file" accept=".pdf,.docx,.txt" className="sr-only peer" disabled={busy !== null}
              onChange={(e) => {
                addMaterial(e.target.files);
                e.target.value = ''; // the same file can be chosen again
              }} />
            <label htmlFor="writer-material-file" aria-disabled={busy !== null ? true : undefined}
              className={`btn btn-secondary cursor-pointer ${FILE_LABEL_FOCUS}`}>
              {busy === 'material' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />} Add a document
            </label>
            <span className="text-xs text-gray-500">PDF, Word (.docx) or text, up to 4 MB.</span>
          </div>
          {materialAdded && analysis && (
            <div className="mt-3 p-3 rounded border bg-amber-950 border-amber-800 text-amber-200 text-sm flex flex-wrap items-center justify-between gap-2">
              <span>The fit analysis was made before this document. Re-run it so the gaps and strategy can use the new facts.</span>
              <button className={`btn btn-secondary ${OFF}`} disabled={busy !== null} onClick={rerunFit}>Update the fit analysis to use it</button>
            </div>
          )}
        </div>
      )}

      {/* Voice profile (improves drafting; optional but recommended) */}
      {app.strategy_confirmed && (
        <div className="card">
          <h2 className="text-xl font-bold mb-2">Your Voice {state.has_voice_profile && <span className="text-green-400 text-sm font-normal">✓ captured</span>}</h2>
          {state.has_voice_profile ? (
            <p className="text-gray-400 text-sm">{state.voice_style_guidelines}</p>
          ) : (
            <>
              <p className="text-gray-400 text-sm mb-2">
                Paste 1-2 things your organization actually wrote (a newsletter intro, a pastor&apos;s letter, an about page).
                Drafts will match your real voice instead of a generic one.
              </p>
              <textarea
                aria-label="Writing sample"
                value={voiceSample}
                onChange={(e) => setVoiceSample(e.target.value)}
                placeholder="Paste a writing sample here..."
                className="w-full h-24 bg-black/30 border border-gray-700 rounded p-3 text-sm mb-2"
              />
              <button className={`btn btn-secondary ${OFF}`} disabled={busy !== null || !voiceSample.trim()}
                onClick={() => void captureVoice()}>
                {busy === 'voice' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Capture Voice'}
              </button>
            </>
          )}
        </div>
      )}

      {/* Stage 4: Draft */}
      {app.strategy_confirmed && (
        <div id="writer-draft" tabIndex={-1} className={`card ${TARGET}`}>
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><Pencil className="w-5 h-5" /> 4 · Draft</h2>
          {blocking.length > 0 && (
            <p className="text-yellow-400 text-sm mb-3">
              {blocking.length} high-severity gap(s) must be answered, marked &quot;don&apos;t have it&quot;, or waived before drafting.
            </p>
          )}
          {strategyChanged && (
            <p className="text-amber-300 text-sm mb-3">
              You changed the strategy above. It will be saved and used the next time you draft.
            </p>
          )}
          {hasUnsavedEdits && (
            <p className="text-amber-300 text-sm mb-3">
              Unsaved changes in {unsavedTitles}: click Save on {unsavedWhere} (or Cancel) before you draft, score or export.
            </p>
          )}
          {sections.length > 0 && missingSections.length > 0 && (
            <div className="mb-3 px-3 py-2 rounded border border-yellow-800 text-yellow-300 text-sm">
              Not drafted yet: {missingSections.map((m) => m.title).join(', ')}.
              <button className={`btn btn-primary text-xs ml-3 ${OFF}`} disabled={busy !== null || blocking.length > 0 || hasUnsavedEdits}
                onClick={() => void draftSections(undefined, true)}>
                Draft missing sections
              </button>
            </div>
          )}
          <button className={`btn btn-primary mb-4 ${OFF}`} disabled={busy !== null || blocking.length > 0 || hasUnsavedEdits} onClick={redraftAll}>
            {busy === 'draft' && activeSection === null && <Loader2 className="w-4 h-4 animate-spin" />}
            {sections.length > 0 ? 'Redraft All Sections' : 'Draft All Sections'}
          </button>
          <div className="space-y-4">
            {sections.map(renderSection)}
          </div>
        </div>
      )}

      {/* Stage 5: Score */}
      {sections.length > 0 && (
        <div id="writer-score" tabIndex={-1} className={`card ${TARGET}`}>
          <h2 className="text-xl font-bold mb-2">5 · Self-Score Against the Rubric</h2>
          <button className={`btn btn-primary mb-4 ${OFF}`} disabled={busy !== null || hasUnsavedEdits}
            onClick={() => void run('score', () => api.scoreApplication(appId))}>
            {busy === 'score' ? <Loader2 className="w-4 h-4 animate-spin" /> : scorecard ? 'Re-Score Draft' : 'Score Draft'}
          </button>
          {scorecard && (
            <div className="space-y-3 text-sm">
              <div className="text-3xl font-bold">{Math.round(scorecard.overall_score)}<span className="text-lg text-gray-500">/100</span></div>
              <div className="p-3 rounded bg-yellow-900/20 text-yellow-300">
                <span className="font-semibold">Biggest lever:</span> {scorecard.top_fix}
              </div>
              {rankedFixes.length > 0 && (
                <div>
                  <p className="font-semibold mb-1">Ranked fixes</p>
                  <ol className="list-decimal ml-5 space-y-1 text-gray-300">
                    {rankedFixes.map((fix, i) => <li key={i}>{fix}</li>)}
                  </ol>
                </div>
              )}
              {scorecard.per_criterion.map((c, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs mb-1">
                    <span>{c.criterion_name}</span><span>{Math.round(c.score)}</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded">
                    <div className="h-2 rounded bg-[var(--primary)]" style={{ width: `${c.score}%` }} />
                  </div>
                  {c.commentary && <p className="text-gray-500 text-xs mt-1">{c.commentary}</p>}
                </div>
              ))}
              <div className="text-xs text-gray-400">
                {(scorecard.compliance_results || []).map((c, i) => (
                  <div key={i}>
                    {c.passed ? '✓' : '✗'} {String(c.section ?? '')} — {String(c.check ?? '')} ({String(c.detail ?? '')})
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stage 6: Export */}
      {sections.length > 0 && (
        <div id="writer-export" tabIndex={-1} className={`card ${TARGET}`}>
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><Download className="w-5 h-5" /> 6 · Export</h2>
          <p className="text-gray-400 text-sm mb-3">
            Final human gate: you review, you submit. Nothing is sent to the funder automatically.
          </p>
          {(placeholderTotal > 0 || unsupportedTotal > 0) && (
            <p role="note" className="mb-3 px-3 py-2 rounded border border-amber-800 bg-amber-950/40 text-amber-300 text-sm">
              Still in the draft: {placeholderTotal} [NEEDS INPUT] placeholder(s) and {unsupportedTotal} unsupported claim(s).
              {' '}They will appear in the exported file; fix them before you submit.
            </p>
          )}
          {hasUnsavedEdits && (
            <p role="alert" className="mb-3 px-3 py-2 rounded border border-red-800 bg-red-950/40 text-red-300 text-sm">
              {unsavedExportMessage}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {EXPORTS.map(([fmt, label]) => (
              <button key={fmt} className={`btn btn-secondary ${OFF}`} disabled={busy !== null || hasUnsavedEdits} onClick={() => void download(fmt)}>
                {busy === `export-${fmt}` ? <Loader2 className="w-4 h-4 animate-spin" /> : label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** A different ?id= is a different application: start fresh (with that application's kept text). */
function WriterRoute() {
  const appId = useSearchParams().get('id');
  return <WriterInner key={appId ?? ''} appId={appId} />;
}

export default function WriterPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-400">Loading...</div>}>
      <WriterRoute />
    </Suspense>
  );
}
