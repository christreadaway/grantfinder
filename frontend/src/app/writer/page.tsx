'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertCircle, CheckCircle, ChevronLeft, Copy, Download, FileText,
  Loader2, Pencil, Send, Target, Wand2,
} from 'lucide-react';
import api from '@/lib/api';

const RATING_COLORS: Record<string, string> = {
  strong: 'text-green-400 border-green-700',
  partial: 'text-yellow-400 border-yellow-700',
  weak: 'text-orange-400 border-orange-700',
  missing: 'text-red-400 border-red-700',
};

function WriterInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const appId = searchParams.get('id');

  const [state, setState] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guidelines, setGuidelines] = useState('');
  const [strategyText, setStrategyText] = useState('');
  const [intakeAnswers, setIntakeAnswers] = useState<Record<string, string>>({});
  const [refineInputs, setRefineInputs] = useState<Record<string, string>>({});
  const [voiceSample, setVoiceSample] = useState('');

  const refresh = useCallback(async () => {
    if (!appId) return;
    try {
      const data = await api.getApplication(appId);
      setState(data);
      if (data.fit_analysis && !strategyText) {
        setStrategyText(data.application.strategy || data.fit_analysis.recommended_strategy);
      }
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Failed to load application');
    }
  }, [appId, strategyText]);

  useEffect(() => {
    api.loadToken();
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId]);

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.detail || `${label} failed`);
    } finally {
      setBusy(null);
    }
  };

  const download = async (format: 'docx' | 'md' | 'txt' | 'form_map') => {
    setBusy(`export-${format}`);
    setError(null);
    try {
      const response = await api.exportApplication(appId!, format);
      const disposition = response.headers['content-disposition'] || '';
      const match = disposition.match(/filename="(.+?)"/);
      const filename = match ? match[1] : `application.${format === 'form_map' ? 'json' : format}`;
      const url = URL.createObjectURL(new Blob([response.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      await refresh();
    } catch (e: any) {
      // Blob error responses need decoding
      let detail = 'Export failed';
      try {
        detail = JSON.parse(await e.response.data.text()).detail;
      } catch { /* keep default */ }
      setError(detail);
    } finally {
      setBusy(null);
    }
  };

  if (!appId) {
    return <div className="p-8 text-gray-400">No application selected. Start from a match result in the dashboard.</div>;
  }
  if (!state) {
    return (
      <div className="p-8 flex items-center gap-2 text-gray-400">
        {error ? <><AlertCircle className="w-5 h-5 text-red-400" /> {error}</>
               : <><Loader2 className="w-5 h-5 animate-spin" /> Loading application...</>}
      </div>
    );
  }

  const app = state.application;
  const spec = state.grant_spec;
  const analysis = state.fit_analysis;
  const gaps = state.gaps || [];
  const blocking = state.open_blocking_gaps || [];
  const intake = state.intake_requests || [];
  const sections = state.sections || [];
  const scorecard = state.scorecard;
  const sectionSpecs: Record<string, any> = {};
  (spec?.required_sections || []).forEach((s: any) => { sectionSpecs[s.id] = s; });

  return (
    <div className="min-h-screen p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="card">
        <button onClick={() => router.push('/dashboard')} className="text-sm text-gray-500 hover:underline flex items-center gap-1 mb-3">
          <ChevronLeft className="w-4 h-4" /> Back to dashboard
        </button>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{app.grant_name}</h1>
            <p className="text-gray-400">{app.funder} · Deadline: {app.deadline || 'check guidelines'}</p>
          </div>
          <div className="text-right space-y-1">
            <span className="text-xs uppercase tracking-wide bg-gray-800 rounded px-2 py-1">{app.status}</span>
            {app.urgent && (
              <div className="text-red-400 text-sm flex items-center gap-1 justify-end">
                <AlertCircle className="w-4 h-4" /> Deadline soon — critical path
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-900/30 text-red-300 text-sm">{error}</div>
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
            <button className="btn btn-primary" disabled={busy !== null}
              onClick={() => run('spec', () => api.enrichGrantSpec(appId, guidelines || undefined))}>
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
            <ul className="list-disc ml-5 text-gray-300">
              {spec.required_sections.map((s: any) => (
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
          </div>
        )}
      </div>

      {/* Stage 2: Fit & Strategy */}
      {spec && (
        <div className="card">
          <h2 className="text-xl font-bold mb-2 flex items-center gap-2"><Target className="w-5 h-5" /> 2 · Fit, Gaps &amp; Strategy</h2>
          {!analysis ? (
            <button className="btn btn-primary" disabled={busy !== null}
              onClick={() => run('analyze', () => api.analyzeFit(appId))}>
              {busy === 'analyze' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Run Fit Analysis'}
            </button>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2">
                {analysis.fit_map.map((f: any, i: number) => (
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
                  <button className="btn btn-primary mt-2" disabled={busy !== null}
                    onClick={() => run('strategy', () => api.confirmStrategy(appId, strategyText))}>
                    {busy === 'strategy' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirm Strategy'}
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
            {gaps.map((g: any) => (
              <div key={g.id} className="flex items-start justify-between text-sm border border-gray-800 rounded p-2">
                <div>
                  <span className={`uppercase text-xs mr-2 ${g.severity === 'high' ? 'text-red-400' : 'text-yellow-400'}`}>{g.severity}</span>
                  {g.description}
                  <span className="text-gray-500 ml-2">→ {g.suggested_owner_role || 'unassigned'} · {g.status}</span>
                  {g.answer && <div className="text-gray-400 text-xs mt-1">Answer: {g.answer}</div>}
                </div>
                {['open', 'routed'].includes(g.status) && (
                  <button className="text-xs text-gray-400 hover:underline shrink-0 ml-2"
                    onClick={() => run('waive', () => api.waiveGap(appId, g.id, 'Proceeding without it'))}>
                    waive
                  </button>
                )}
              </div>
            ))}
          </div>
          {intake.length === 0 ? (
            <button className="btn btn-secondary" disabled={busy !== null}
              onClick={() => run('intake', () => api.generateIntake(appId))}>
              {busy === 'intake' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Generate Stakeholder Requests'}
            </button>
          ) : (
            <div className="space-y-4">
              {intake.map((req: any) => (
                <div key={req.id} className="border border-gray-800 rounded p-3 text-sm space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{req.stakeholder_role}</span>
                    <span className="text-xs text-gray-500">{req.status}</span>
                  </div>
                  <p className="text-gray-400">{req.framing}</p>
                  <details>
                    <summary className="cursor-pointer text-gray-400">Copy-paste email packet</summary>
                    <pre className="whitespace-pre-wrap bg-black/30 rounded p-2 mt-1 text-xs">{req.email_packet}</pre>
                    <button className="text-xs text-[var(--primary)] hover:underline flex items-center gap-1 mt-1"
                      onClick={() => navigator.clipboard.writeText(req.email_packet)}>
                      <Copy className="w-3 h-3" /> Copy email
                    </button>
                  </details>
                  {req.status !== 'answered' && req.status !== 'confirmed_gap' && (
                    <div className="space-y-2">
                      <textarea
                        placeholder="Paste the stakeholder's answer here..."
                        value={intakeAnswers[req.id] || ''}
                        onChange={(e) => setIntakeAnswers({ ...intakeAnswers, [req.id]: e.target.value })}
                        className="w-full h-16 bg-black/30 border border-gray-700 rounded p-2 text-xs"
                      />
                      <div className="flex gap-2">
                        <button className="btn btn-secondary text-xs" disabled={busy !== null || !(intakeAnswers[req.id] || '').trim()}
                          onClick={() => run('answer', () => api.answerIntake(appId, req.id, intakeAnswers[req.id], false))}>
                          Record Answer
                        </button>
                        <button className="text-xs text-gray-400 hover:underline" disabled={busy !== null}
                          onClick={() => run('answer', () => api.answerIntake(appId, req.id, intakeAnswers[req.id] || "We don't have that.", true))}>
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
              <button className="btn btn-secondary" disabled={busy !== null || !voiceSample.trim()}
                onClick={() => run('voice', () => api.analyzeVoice([voiceSample]))}>
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
          <button className="btn btn-primary mb-4" disabled={busy !== null || blocking.length > 0}
            onClick={() => run('draft', () => api.draftSections(appId))}>
            {busy === 'draft' ? <Loader2 className="w-4 h-4 animate-spin" /> : sections.length > 0 ? 'Redraft All Sections' : 'Draft All Sections'}
          </button>
          <div className="space-y-4">
            {sections.map((s: any) => {
              const specSection = sectionSpecs[s.section_id];
              return (
                <div key={s.section_id} className="border border-gray-800 rounded p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold">{s.title}</h3>
                    <span className={`text-xs ${s.over_limit ? 'text-red-400' : 'text-gray-500'}`}>
                      {s.word_count} words{specSection?.word_limit ? ` / ${specSection.word_limit} max` : ''}
                      {s.over_limit && ' — OVER LIMIT'}
                    </span>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm text-gray-300 bg-black/20 rounded p-3 mb-2">{s.current_draft}</pre>
                  {s.claims.filter((c: any) => c.flagged).length > 0 && (
                    <p className="text-yellow-400 text-xs mb-2">
                      ⚑ Unsupported claims: {s.claims.filter((c: any) => c.flagged).map((c: any) => c.claim).join('; ')}
                    </p>
                  )}
                  {s.banned_phrase_hits.length > 0 && (
                    <p className="text-red-400 text-xs mb-2">Banned phrases present: {s.banned_phrase_hits.join(', ')}</p>
                  )}
                  <div className="flex gap-2">
                    <input
                      placeholder='Refine: e.g. "tighten by 40 words", "warm this up", "lead with the outcome"'
                      value={refineInputs[s.section_id] || ''}
                      onChange={(e) => setRefineInputs({ ...refineInputs, [s.section_id]: e.target.value })}
                      className="flex-1 bg-black/30 border border-gray-700 rounded p-2 text-xs"
                    />
                    <button className="btn btn-secondary text-xs" disabled={busy !== null || !(refineInputs[s.section_id] || '').trim()}
                      onClick={() => run('refine', () => api.refineSection(appId, s.section_id, refineInputs[s.section_id]))}>
                      {busy === 'refine' ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Wand2 className="w-3 h-3" /> Refine</>}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stage 5: Score */}
      {sections.length > 0 && (
        <div className="card">
          <h2 className="text-xl font-bold mb-2">5 · Self-Score Against the Rubric</h2>
          <button className="btn btn-primary mb-4" disabled={busy !== null}
            onClick={() => run('score', () => api.scoreApplication(appId))}>
            {busy === 'score' ? <Loader2 className="w-4 h-4 animate-spin" /> : scorecard ? 'Re-Score Draft' : 'Score Draft'}
          </button>
          {scorecard && (
            <div className="space-y-3 text-sm">
              <div className="text-3xl font-bold">{Math.round(scorecard.overall_score)}<span className="text-lg text-gray-500">/100</span></div>
              <div className="p-3 rounded bg-yellow-900/20 text-yellow-300">
                <span className="font-semibold">Biggest lever:</span> {scorecard.top_fix}
              </div>
              {scorecard.per_criterion.map((c: any, i: number) => (
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
                {scorecard.compliance_results.map((c: any, i: number) => (
                  <div key={i}>
                    {c.passed ? '✓' : '✗'} {c.section} — {c.check} ({c.detail})
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
          <div className="flex flex-wrap gap-2">
            {([['docx', 'Word (.docx)'], ['md', 'Markdown'], ['txt', 'Portal paste-in (.txt)'], ['form_map', 'Form-field map (.json)']] as const).map(([fmt, label]) => (
              <button key={fmt} className="btn btn-secondary" disabled={busy !== null} onClick={() => download(fmt)}>
                {busy === `export-${fmt}` ? <Loader2 className="w-4 h-4 animate-spin" /> : label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function WriterPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-400">Loading...</div>}>
      <WriterInner />
    </Suspense>
  );
}
