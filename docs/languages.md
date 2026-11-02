# Interface languages (English and Arabic)

Each user picks English or العربية in **Settings → Language**. The choice is kept per browser
(`localStorage` key `prowess-lang`) and applied before the first paint by `apps/web/public/theme-init.js`, which sets
`lang` and `dir` on the page. Arabic is right to left; numbers keep Western digits and dates use Arabic month names
(`ar-SA-u-nu-latn`).

## Where text lives

| Text | Where | How it is translated |
| --- | --- | --- |
| Interface (buttons, labels, cards, help, admin) | `apps/web/src/lib/messages/en.ts` and `ar.ts` | `t('key', vars)` from `useT()` / `useI18n()`. `ar.ts` is typed against `en.ts`, so a missing key fails the typecheck; a unit test also checks that placeholders match. Plurals use Intl plural forms (`one`, `two`, `few`, `many`, `other`). |
| Agent descriptions, starter cards, model tiers | `apps/orchestrator/config/agents.json`, `models.json` (`"i18n": { "ar": { … } }`) | The browser sends `Accept-Language`; the orchestrator answers `/workspace`, `/agents`, `/models` and `/help` in that language and falls back to English. Agent names (FICO, MM, SD, HCM) stay as they are. |
| Text the backend writes at run time (progress steps, process steps, table columns, follow-up buttons, tool titles, errors, process summaries) | `apps/web/src/lib/messages/server-ar.ts` | `translateServer(text)` looks the English sentence up; `patterns` and `answers` cover sentences with names or numbers. Unknown text is shown in English. **Add the Arabic here when you add a tool label, a column or an error message on the server.** |
| AI answers | `apps/orchestrator/src/llm/context.ts` (`LANGUAGE_RULE`) | With Arabic chosen, the system prompt tells the model to answer in Modern Standard Arabic and keep SAP values (numbers, codes, amounts, names) exactly as SAP returns them. |

A lint rule rejects English text written directly into a component (`apps/web/src/components/**`).

## Layout

Components use logical Tailwind classes (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `text-start`, `border-s`), so the
layout mirrors on its own. Icons that point somewhere (arrows, chevrons, panel toggles) carry `rtl:-scale-x-100`.
Codes, amounts and document numbers (`font-mono`, `tabular-nums`) are isolated so they keep their order inside Arabic
text, and every paragraph of an answer sets its own direction (`dir="auto"`). The Arabic face is IBM Plex Sans Arabic,
served with the site.

## Testing

`tests/e2e/arabic.spec.ts` switches to Arabic and checks the mirrored layout and the Arabic cards. The offline mock
model understands English questions only, so Arabic starter prompts give generic answers locally; use a real model
(SAP AI Core) to try Arabic conversations.

The Arabic text is a draft and should be reviewed by a native speaker for the business terms.
