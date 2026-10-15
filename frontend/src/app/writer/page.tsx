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
  AlertCircle, Bug, CheckCircle, ChevronLeft, Copy, Download, FileText,
  Loader2, Pencil, RotateCcw, Save, Send, Target, Wand2,
} from 'lucide-react';
import api, { blobErrorDetail, errorDetail, isSessionEnded, onJobProgress } from '@/lib/api';
import { copyText, saveFile } from '@/lib/download';
import type {
  Application, FitAnalysis, Gap, GrantSpec, IntakeRequest, RequiredSection, Scorecard, SectionDraft,
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
const WARNING_NOTICE = /^(Could not|Couldn't|No guidelines|Not drafted|Left out|Still in)/;

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

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

// =============================================================================
// Typed text kept across a reload (sessionStorage: this tab, this application)
// =============================================================================

interface Unsaved {
  guidelines: string;
  intakeAnswers: Record<string, string>;
  refineInputs: Record<string, string>;
  voiceSample: string;
  /** section id -> text of an edit not saved yet (present = the section is in edit mode) */
  edits: Record<string, string>;
}

const NOTHING_UNSAVED: Unsaved = { guidelines: '', intakeAnswers: {}, refineInputs: {}, voiceSample: '', edits: {} };
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
      intakeAnswers: textMap(data?.intakeAnswers, false),
      refineInputs: textMap(data?.refineInputs, false),
      voiceSample: typeof data?.voiceSample === 'string' ? data.voiceSample : '',
      edits: textMap(data?.edits, true),
    };
  } catch (error) {
    console.warn('[GrantFinder] Could not read the text kept from before the reload:', error);
    return NOTHING_UNSAVED;
  }
}

function writeUnsaved(appId: string, unsaved: Unsaved): void {
  const kept: Unsaved = {
    guidelines: unsaved.guidelines,
    intakeAnswers: textMap(unsaved.intakeAnswers, false),
    refineInputs: textMap(unsaved.refineInputs, false),
    voiceSample: unsaved.voiceSample,
    edits: unsaved.edits,
  };
  const empty = !kept.guidelines.trim() && !kept.voiceSample.trim() && !Object.keys(kept.intakeAnswers).length &&
    !Object.keys(kept.refineInputs).length && !Object.keys(kept.edits).length;
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
  const [strategyText, setStrategyText] = useState('');
  const [intakeAnswers, setIntakeAnswers] = useState(restored.intakeAnswers);
  const [refineInputs, setRefineInputs] = useState(restored.refineInputs);
  const [voiceSample, setVoiceSample] = useState(restored.voiceSample);
  const [edits, setEdits] = useState(restored.edits);
  const [emailCopy, setEmailCopy] = useState<Record<string, 'copied' | 'failed'>>({});

  // Live status lines from background jobs ("Drafting section 2 of 6: Need")
  useEffect(() => onJobProgress((info) => setJobProgress(info.progress)), []);

  // Typed text survives a reload of this tab.
  useEffect(() => {
    if (appId) writeUnsaved(appId, { guidelines, intakeAnswers, refineInputs, voiceSample, edits });
  }, [appId, guidelines, intakeAnswers, refineInputs, voiceSample, edits]);

  const applyState = useCallback((data: WriterState) => {
    setState(data);
    const analysis = data.fit_analysis;
    if (analysis) setStrategyText((current) => current || data.application.strategy || analysis.recommended_strategy || '');
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
      const note = noteOf(await api.waitForJob(running.id, running.kind));
      if (note) setNotice(note);
    } catch (e) {
      logFailure(`[GrantFinder] writer step "${label}" failed:`, e);
      setError(errorDetail(e, 'That step failed.'));
    } finally {
      await refresh(true);
      setBusy(null);
      setJobProgress(null);
    }
  }, [appId, refresh]);

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
      const ok = await run('refine', () => api.refineSection(appId, s.section_id, refineInputs[s.section_id] || ''));
      if (ok) setRefineInputs((current) => without(current, s.section_id));
      return ok;
    });

  const saveEdit = (s: SectionDraft) =>
    forSection(s.section_id, async () => {
      const ok = await run('edit', () => api.editSection(appId, s.section_id, edits[s.section_id] ?? ''), () => `Saved your edit to "${s.title}".`);
      if (ok) setEdits((current) => without(current, s.section_id));
      return ok;
    });

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

  const renderSection = (s: SectionDraft) => {
    const stale = staleIds.includes(s.section_id);
    // Limits belong to the question this draft answers; a stale draft has none.
    const limits = stale ? undefined : sectionSpecs.get(s.section_id);
    const editing = Object.prototype.hasOwnProperty.call(edits, s.section_id);
    const editText = edits[s.section_id] ?? '';
    const flagged = (s.claims || []).filter((c) => c.flagged);
    const placeholders = placeholdersIn(s.current_draft);
    const versions = s.versions || [];
    const mine = activeSection === s.section_id;
    return (
      <div key={s.section_id} data-section-id={s.section_id} className="border border-gray-800 rounded p-3">
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
            <div className="flex flex-wrap items-center justify-between gap-2">
              <EditCounts text={editText} limits={limits} />
              <div className="flex gap-2">
                <button className={`btn btn-primary text-xs ${OFF}`} disabled={busy !== null || !editText.trim()}
                  title={editText.trim() ? 'Save this text as the section' : 'The section cannot be empty'}
                  onClick={() => void saveEdit(s)}>
                  {busy === 'edit' && mine ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
                </button>
                <button className={`btn btn-secondary text-xs ${OFF}`} disabled={busy !== null}
                  onClick={() => setEdits((current) => without(current, s.section_id))}>
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
            placeholder='Refine: e.g. "tighten by 40 words", "warm this up", "lead with the outcome"'
            value={refineInputs[s.section_id] || ''}
            onChange={(e) => {
              const value = e.target.value;
              setRefineInputs((current) => ({ ...current, [s.section_id]: value }));
            }}
            className="flex-1 min-w-[12rem] bg-black/30 border border-gray-700 rounded p-2 text-xs"
          />
          <button className={`btn btn-secondary text-xs ${OFF}`}
            disabled={busy !== null || editing || !(refineInputs[s.section_id] || '').trim()}
            onClick={() => void refine(s)}>
            {busy === 'refine' && mine ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Wand2 className="w-3 h-3" /> Refine</>}
          </button>
          <button className={`btn btn-secondary text-xs ${OFF}`} disabled={busy !== null || editing || blocking.length > 0}
            title="Write this section again from scratch"
            onClick={() => void forSection(s.section_id, () => draftSections(s.section_id))}>
            {busy === 'draft' && mine && <Loader2 className="w-3 h-3 animate-spin" />} Redraft
          </button>
          {!editing && (
            <button className={`btn btn-secondary text-xs ${OFF}`} disabled={busy !== null} title="Change the text yourself"
              onClick={() => setEdits((current) => ({ ...current, [s.section_id]: s.current_draft }))}>
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

      {/* Stage 1: Grant Spec */}
      <div className="card">
        <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><FileText className="w-5 h-5" /> 1 · Grant Requirements</h2>
        {!spec ? (
          <>
            <p className="text-gray-400 text-sm mb-3">
              Paste the full grant guidelines if you have them (best results). Leave blank to work from the grant record and its website.
            </p>
            <textarea
              value={guidelines}
              onChange={(e) => setGuidelines(e.target.value)}
              placeholder="Paste guidelines / RFP text here (optional)..."
              className="w-full h-32 bg-black/30 border border-gray-700 rounded p-3 text-sm mb-3"
            />
            <button className={`btn btn-primary ${OFF}`} disabled={busy !== null}
              onClick={() => void analyzeRequirements(guidelines || undefined)}>
              {busy === 'spec' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Analyze Requirements'}
            </button>
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
                value={guidelines}
                onChange={(e) => setGuidelines(e.target.value)}
                placeholder="Paste guidelines / RFP text here..."
                className="w-full h-32 bg-black/30 border border-gray-700 rounded p-3 text-sm my-2"
              />
              <button className={`btn btn-secondary ${OFF}`} disabled={busy !== null || !guidelines.trim()}
                onClick={() => void analyzeRequirements(guidelines)}>
                {busy === 'spec' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Re-analyze Requirements'}
              </button>
            </details>
          </div>
        )}
      </div>

      {/* Stage 2: Fit & Strategy */}
      {spec && (
        <div className="card">
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
              <button className={`text-xs text-gray-400 hover:underline ${OFF}`} disabled={busy !== null}
                onClick={() => {
                  if (window.confirm('Re-running the fit analysis replaces the current gap list. Answers you recorded stay in your profile and are used in the new analysis. Continue?')) {
                    void run('analyze', () => api.analyzeFit(appId));
                  }
                }}>
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
                <label className="text-sm font-semibold block mb-1">Narrative strategy (edit before confirming)</label>
                <textarea
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
              </div>
            </div>
          )}
        </div>
      )}

      {/* Stage 3: Gaps & Stakeholder Intake */}
      {analysis && gaps.length > 0 && (
        <div className="card">
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
        <div className="card">
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
          {sections.length > 0 && missingSections.length > 0 && (
            <div className="mb-3 px-3 py-2 rounded border border-yellow-800 text-yellow-300 text-sm">
              Not drafted yet: {missingSections.map((m) => m.title).join(', ')}.
              <button className={`btn btn-primary text-xs ml-3 ${OFF}`} disabled={busy !== null || blocking.length > 0}
                onClick={() => void draftSections(undefined, true)}>
                Draft missing sections
              </button>
            </div>
          )}
          <button className={`btn btn-primary mb-4 ${OFF}`} disabled={busy !== null || blocking.length > 0} onClick={redraftAll}>
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
        <div className="card">
          <h2 className="text-xl font-bold mb-2">5 · Self-Score Against the Rubric</h2>
          <button className={`btn btn-primary mb-4 ${OFF}`} disabled={busy !== null}
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
        <div className="card">
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
          <div className="flex flex-wrap gap-2">
            {EXPORTS.map(([fmt, label]) => (
              <button key={fmt} className={`btn btn-secondary ${OFF}`} disabled={busy !== null} onClick={() => void download(fmt)}>
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
