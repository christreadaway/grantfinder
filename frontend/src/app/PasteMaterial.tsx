'use client';

/**
 * Paste text instead of uploading a file: a past proposal that was funded, a funder's or
 * reviewer's comments, an analysis, notes. The text becomes a .txt file that goes through the
 * same upload and Claude reading as any document (processing.upload_document), so its key facts
 * land in the profile as evidence the fit analysis and every draft can cite. A first line says
 * what kind of material it is, so Claude reads a 2022 proposal's numbers as the 2022 numbers.
 */
import { useId, useState } from 'react';
import { ClipboardPaste, Loader2 } from 'lucide-react';

export const PASTE_KINDS = [
  {
    id: 'proposal',
    label: 'A past proposal that was funded',
    name: 'Funded proposal',
    intro: 'A grant proposal this school or parish wrote earlier that was funded. Its facts describe the school as of when it was written.',
  },
  {
    id: 'feedback',
    label: 'Funder or reviewer comments',
    name: 'Funder comments',
    intro: 'Comments from a funder or reviewer about a proposal from this school or parish.',
  },
  {
    id: 'analysis',
    label: 'An analysis, report or data',
    name: 'Analysis',
    intro: 'An analysis, report or data about this school or parish.',
  },
  {
    id: 'notes',
    label: 'Other notes',
    name: 'Notes',
    intro: 'Notes about this school or parish.',
  },
] as const;

export type PasteKind = (typeof PASTE_KINDS)[number]['id'];

/** What Claude reads per document; longer text is cut there (the result says how much was read). */
export const PASTE_READ_LIMIT = 60_000;
/** Netlify's upload limit, the same as for files. */
const PASTE_MAX_BYTES = 4 * 1024 * 1024;

/** A file name made from the title (or the kind), safe on every computer, not already taken. */
export function pastedFileName(title: string, kind: PasteKind, taken: readonly string[] = []): string {
  const fallback = PASTE_KINDS.find((k) => k.id === kind)?.name ?? 'Notes';
  const base = title.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).trim() || fallback;
  const used = new Set(taken.map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `${base} (pasted${n > 1 ? ` ${n}` : ''}).txt`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** The pasted text as a .txt file, with a first line saying what it is. */
export function pastedFile(text: string, title: string, kind: PasteKind, taken: readonly string[] = []): File {
  const intro = PASTE_KINDS.find((k) => k.id === kind)?.intro ?? '';
  const heading = [`What this is: ${intro}`, title.trim() ? `Title: ${title.trim()}` : ''].filter(Boolean).join('\n');
  return new File([`${heading}\n\n${text.trim()}\n`], pastedFileName(title, kind, taken), { type: 'text/plain' });
}

interface Props {
  /** The step's work is running (or the page is busy): nothing can be added. */
  disabled: boolean;
  /** Names already listed, so a second paste never shows up under the same name. */
  takenNames?: readonly string[];
  /** Adds the file; resolves true when it was taken (the box then empties). */
  onAdd: (file: File) => boolean | Promise<boolean>;
  buttonLabel: string;
  /** True while this box's own text is being added. */
  working?: boolean;
}

export default function PasteMaterial({ disabled, takenNames = [], onAdd, buttonLabel, working = false }: Props) {
  const id = useId();
  const [kind, setKind] = useState<PasteKind>('proposal');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const chars = text.trim().length;

  const add = async () => {
    if (disabled || !chars) return;
    const file = pastedFile(text, title, kind, takenNames);
    if (file.size > PASTE_MAX_BYTES) {
      setProblem('That is more than 4 MB of text. Split it into parts and add each one.');
      return;
    }
    setProblem(null);
    if (await onAdd(file)) {
      setText('');
      setTitle('');
    }
  };

  return (
    <details className="mt-4 rounded border border-gray-700 p-3" data-paste-material>
      <summary className="cursor-pointer text-sm font-medium flex items-center gap-2">
        <ClipboardPaste className="w-4 h-4 shrink-0" aria-hidden="true" />
        Or paste text: past proposals that were funded, comments, analyses, notes
      </summary>
      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap gap-2">
          <div className="text-sm text-gray-400 flex flex-col gap-1 min-w-0 flex-1 basis-56">
            <label htmlFor={`${id}-kind`}>What is it?</label>
            <select
              id={`${id}-kind`}
              value={kind}
              onChange={(e) => setKind(e.target.value as PasteKind)}
              disabled={disabled}
              className="bg-black/30 border border-gray-700 rounded p-2 text-sm text-white"
            >
              {PASTE_KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
          </div>
          <div className="text-sm text-gray-400 flex flex-col gap-1 min-w-0 flex-1 basis-56">
            <label htmlFor={`${id}-title`}>Name it (optional)</label>
            <input
              id={`${id}-title`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={disabled}
              maxLength={120}
              placeholder="e.g. 2024 library grant proposal"
              className="bg-black/30 border border-gray-700 rounded p-2 text-sm text-white"
            />
          </div>
        </div>
        <label className="sr-only" htmlFor={`${id}-text`}>Text to paste</label>
        <textarea
          id={`${id}-text`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={disabled}
          placeholder="Paste the text here..."
          className="w-full h-40 bg-black/30 border border-gray-700 rounded p-3 text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-gray-500" aria-live="polite">
            {chars.toLocaleString('en-US')} characters
            {chars > PASTE_READ_LIMIT
              ? ` - Claude reads the first ${PASTE_READ_LIMIT.toLocaleString('en-US')}. Add the rest as a second part.`
              : ''}
          </span>
          <button
            type="button"
            className="btn btn-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={disabled || !chars}
            onClick={() => void add()}
          >
            {working ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ClipboardPaste className="w-4 h-4" aria-hidden="true" />}
            {buttonLabel}
          </button>
        </div>
        {problem && <p role="alert" className="text-sm text-red-400">{problem}</p>}
      </div>
    </details>
  );
}
