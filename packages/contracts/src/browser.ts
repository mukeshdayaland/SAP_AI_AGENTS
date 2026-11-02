import { z } from 'zod';

/**
 * What the agent asks the Fiori pane to do. The pane works in the page the
 * user has open, under the user's own SAP sign-in, and answers every action
 * with `POST /api/v1/browser/results`.
 */
export type BrowserAction =
  | { id: string; kind: 'read' }
  | { id: string; kind: 'point'; ref: string; note: string }
  | { id: string; kind: 'type'; ref: string; text: string; note: string }
  | { id: string; kind: 'click'; ref: string; note: string };

const text = (max: number) => z.string().max(max);

/** The page as the agent sees it: what can be read, filled or clicked. Password fields are never included. */
export const BrowserPageSchema = z.object({
  title: text(200),
  location: text(300),
  /** Messages SAP shows on the page: errors, warnings, confirmations. */
  messages: z.array(text(400)).max(20),
  elements: z
    .array(
      z.object({
        ref: z.string().regex(/^e\d{1,4}$/),
        role: text(20),
        label: text(120),
        value: text(200).optional(),
        disabled: z.boolean().optional(),
      }),
    )
    .max(150),
});
export type BrowserPage = z.infer<typeof BrowserPageSchema>;

export const BrowserActionResultSchema = z.object({
  id: z.string().regex(/^b_[A-Za-z0-9_-]{8,40}$/),
  ok: z.boolean(),
  /** Why the action was not carried out, in words for the agent. */
  message: text(300).optional(),
  page: BrowserPageSchema.optional(),
});
export type BrowserActionResult = z.infer<typeof BrowserActionResultSchema>;
