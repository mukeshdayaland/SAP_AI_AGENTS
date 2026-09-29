'use client';

import type { AttachmentRef } from '@prowess/contracts';
import { ArrowUp, FileText, Paperclip, Square, X } from 'lucide-react';
import { forwardRef, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react';
import type { ApiError} from '@/lib/api';
import { api } from '@/lib/api';
import type { SendKey } from '@/lib/prefs';
import { Spinner, cx } from '../ui/primitives';

export interface ComposerHandle {
  focus(): void;
  setText(text: string): void;
}

interface Props {
  streaming: boolean;
  attachmentsEnabled: boolean;
  accept: string[];
  sendKey: SendKey;
  agentLabel: string;
  onSend: (text: string, attachments: AttachmentRef[]) => void;
  onStop: () => void;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer({ streaming, attachmentsEnabled, accept, sendKey, agentLabel, onSend, onStop }, ref) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRef[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        resize();
      });
    },
  }));

  const resize = () => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  };

  const canSend = text.trim().length > 0 && !streaming && uploading === 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text.trim(), attachments);
    setText('');
    setAttachments([]);
    setError(null);
    requestAnimationFrame(resize);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (sendKey === 'enter' ? !e.shiftKey && !mod : mod) {
      e.preventDefault();
      submit();
    }
  };

  const upload = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    for (const file of [...files].slice(0, 5 - attachments.length)) {
      setUploading((n) => n + 1);
      try {
        const ref = await api.upload(file);
        setAttachments((a) => [...a, ref]);
      } catch (err) {
        setError((err as ApiError).error?.message ?? 'Upload failed.');
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="rounded-2xl border border-line-strong bg-elevated shadow-lift transition-colors focus-within:border-brand">
        {(attachments.length > 0 || uploading > 0) && (
          <ul className="flex flex-wrap gap-2 px-3 pt-3" aria-label="Attachments">
            {attachments.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-muted py-1 pl-2 pr-1 text-xs text-ink">
                <FileText size={13} aria-hidden className="text-brand" />
                <span className="max-w-48 truncate">{a.fileName}</span>
                <button type="button" aria-label={`Remove ${a.fileName}`} onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))} className="rounded p-0.5 text-ink-3 hover:bg-surface hover:text-ink">
                  <X size={12} />
                </button>
              </li>
            ))}
            {uploading > 0 && (
              <li className="inline-flex items-center gap-2 px-2 text-xs text-ink-3">
                <Spinner /> Uploading and scanning…
              </li>
            )}
          </ul>
        )}
        <label htmlFor="prowess-prompt" className="sr-only">
          Message {agentLabel}
        </label>
        <textarea
          id="prowess-prompt"
          ref={textarea}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            resize();
          }}
          onKeyDown={onKeyDown}
          placeholder="Ask Prowess AI…"
          aria-describedby="prowess-prompt-hint"
          className="block max-h-[40vh] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-ink placeholder:text-ink-3 focus:outline-none"
        />
        <div className="flex items-center justify-between px-2.5 pb-2.5">
          <div className="flex items-center gap-1">
            {attachmentsEnabled && (
              <>
                <input ref={fileInput} type="file" multiple accept={accept.join(',')} className="sr-only" tabIndex={-1} onChange={(e) => upload(e.target.files)} aria-hidden />
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={attachments.length >= 5}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] text-ink-3 hover:bg-muted hover:text-ink disabled:opacity-40"
                >
                  <Paperclip size={15} aria-hidden /> Attach
                </button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span id="prowess-prompt-hint" className="hidden text-[11px] text-ink-3 sm:inline">
              {sendKey === 'enter' ? 'Enter to send · Shift + Enter for new line' : 'Ctrl/⌘ + Enter to send'}
            </span>
            {streaming ? (
              <button type="button" onClick={onStop} aria-label="Stop generating" className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-bg transition-opacity hover:opacity-85">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                className={cx('flex h-9 w-9 items-center justify-center rounded-xl transition-colors', canSend ? 'bg-brand text-on-brand hover:bg-brand-hover' : 'bg-muted text-ink-3')}
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 px-2 text-[13px] text-error">
          {error}
        </p>
      )}
      <p className="mt-2 text-center text-[11px] text-ink-3">AI can make mistakes. SAP remains the system of record — verify important figures.</p>
    </div>
  );
});
