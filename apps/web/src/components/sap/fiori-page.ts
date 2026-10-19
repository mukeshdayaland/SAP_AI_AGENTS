import type { BrowserPage } from '@prowess/contracts';

/**
 * Reading and operating a Fiori page that is served on the workspace's own
 * address, so the browser lets this page reach into the frame. Classic Fiori
 * apps (SAP GUI for HTML) nest frames of their own; those are walked too.
 */

const ELEMENTS =
  'input:not([type=hidden]):not([type=password]), textarea, select, button, a[href], [role=button], [role=tab], [role=link], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=menuitem], [role=textbox]';
/** Where SAP shows what went wrong or what was saved (ARIA roles, and the UI5 message controls). */
const MESSAGES = '[role=alert], [role=status], .sapMMsgStrip, .sapMMessageToast, .sapMMsgBoxText';
const MAX_ELEMENTS = 150;

/** An element of the page and the nested frames that lead to it, outermost first. */
export interface Found {
  el: HTMLElement;
  frames: HTMLIFrameElement[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function documents(frame: HTMLIFrameElement, frames: HTMLIFrameElement[] = []): { doc: Document; frames: HTMLIFrameElement[] }[] {
  let doc: Document | null = null;
  try {
    doc = frame.contentDocument;
  } catch {
    // a frame from another address: the browser keeps it closed
  }
  if (!doc) return [];
  return [{ doc, frames }, ...Array.from(doc.querySelectorAll('iframe')).flatMap((inner) => documents(inner, [...frames, inner]))];
}

function roleOf(el: HTMLElement): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'input') return type === 'checkbox' || type === 'radio' ? type : type === 'button' || type === 'submit' ? 'button' : 'textbox';
  return tag === 'textarea' ? 'textbox' : tag === 'select' ? 'combobox' : tag === 'a' ? 'link' : 'button';
}

function labelOf(el: HTMLElement): string {
  const doc = el.ownerDocument;
  const labelledBy = (el.getAttribute('aria-labelledby') ?? '')
    .split(/\s+/)
    .map((id) => (id ? doc.getElementById(id)?.textContent : ''))
    .join(' ');
  const forLabel = el.id ? doc.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : '';
  const own = /^(input|textarea|select)$/i.test(el.tagName) ? '' : el.textContent;
  return clean(el.getAttribute('aria-label') || labelledBy || forLabel || el.closest('label')?.textContent || own || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('name'), 120);
}

function valueOf(el: HTMLElement): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') return clean((el as HTMLSelectElement).selectedOptions[0]?.textContent, 200);
  if (tag === 'input' && /^(checkbox|radio)$/i.test(el.getAttribute('type') ?? '')) return (el as HTMLInputElement).checked ? 'checked' : 'not checked';
  if (tag === 'input' || tag === 'textarea') return clean((el as HTMLInputElement).value, 200);
  const state = el.getAttribute('aria-selected') ?? el.getAttribute('aria-checked');
  return state === 'true' ? 'selected' : undefined;
}

const isLocked = (el: HTMLElement) => (el as HTMLInputElement).disabled === true || (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true';

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && el.ownerDocument.defaultView?.getComputedStyle(el).visibility !== 'hidden';
}

/** The page as the agent gets it, and which element each `ref` stands for. */
export function readPage(frame: HTMLIFrameElement): { page: BrowserPage; refs: Map<string, Found> } {
  const docs = documents(frame);
  const refs = new Map<string, Found>();
  const elements: BrowserPage['elements'] = [];
  const messages: string[] = [];
  for (const { doc, frames } of docs) {
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(ELEMENTS))) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (!isVisible(el)) continue;
      const label = labelOf(el);
      const role = roleOf(el).slice(0, 20);
      if (!label && role !== 'textbox' && role !== 'combobox') continue;
      const ref = `e${elements.length + 1}`;
      const value = valueOf(el);
      refs.set(ref, { el, frames });
      elements.push({ ref, role, label, ...(value !== undefined && { value }), ...(isLocked(el) && { disabled: true }) });
    }
    for (const el of Array.from(doc.querySelectorAll<HTMLElement>(MESSAGES))) {
      const said = clean(el.textContent, 400);
      if (said && isVisible(el) && messages.length < 20 && !messages.includes(said)) messages.push(said);
    }
  }
  const top = docs[0]?.doc;
  const location = top?.location ? `${top.location.pathname}${top.location.hash}` : '';
  return { page: { title: clean(top?.title, 200), location: location.slice(0, 300), messages, elements }, refs };
}

/** Where the element is, measured from the top-left corner of the outermost frame. */
export function boxOf({ el, frames }: Found): Box {
  const own = el.getBoundingClientRect();
  let x = own.left;
  let y = own.top;
  for (const frame of frames) {
    const outer = frame.getBoundingClientRect();
    x += outer.left;
    y += outer.top;
  }
  return { x, y, w: own.width, h: own.height };
}

/** Enters a value the way a user's typing would, so the app's own checks run. False when the field does not take it. */
export function typeInto(el: HTMLElement, text: string): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view || isLocked(el)) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const wanted = text.trim().toLowerCase();
    const option = Array.from((el as HTMLSelectElement).options).find((o) => o.value.toLowerCase() === wanted || clean(o.textContent, 200).toLowerCase() === wanted);
    if (!option) return false;
    (el as HTMLSelectElement).value = option.value;
  } else if (tag === 'input' || tag === 'textarea') {
    el.focus();
    // Through the element's own setter: frameworks that wrap `value` otherwise miss the change.
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el) as object, 'value')?.set;
    if (setter) setter.call(el, text);
    else (el as HTMLInputElement).value = text;
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
  } else {
    return false;
  }
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
  return true;
}

const COMMITS = /\b(save|post|release|submit|send|delete|remove|approve|reject|confirm|create|book|execute|reverse|cancel|pay|clear|ok|yes)\b/i;

/** Whether the user must allow this click first: anything that may save, post or delete, and anything without a name. */
export function needsConsent(role: string, label: string): boolean {
  if (role === 'tab') return false;
  return !label || COMMITS.test(label);
}
