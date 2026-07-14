# Design: Create-job modal dialog (Web UI)

Job: `9e44be91-5bd7-4efe-984e-8011461671e9`
Scope: `src/web/client/app.ts`, `src/web/client/styles.css` only. No server, route, or API changes.

## Requirements (from the human)

- Sidebar keeps only a "Create job" button; clicking it opens a large centered modal.
- Modal fields: goal as a generous multi-line textarea, cwd text input, optional id text input.
- "Confirm" submits (existing POST /api/jobs logic verbatim); "Cancel" closes with no API call.
- Esc and click-outside both cancel.
- Match the existing dark theme; no new runtime deps; don't touch job list/detail or tell/stop/kill.

## Approach: native `<dialog>` + `showModal()`

Use the native `<dialog>` element. Rationale:

- Zero dependencies; `showModal()` gives true modality (focus trap, inert background),
  automatic viewport centering, Esc-to-close, and a `::backdrop` pseudo-element — all for free.
- There is no existing modal/overlay pattern in the client to conform to, so nothing is
  contradicted by introducing `<dialog>`.
- Browser support is universal in current evergreen browsers; this UI already requires a
  modern browser (WebSockets, service worker, `backdrop-filter`).

**Constraint discovered in the code (drives several decisions below):** the gateway serves
the client with `new Bun.Transpiler(...).transformSync(...)` on the single file
(`src/web/server.ts:56-58`) — it transpiles, it does **not** bundle. `app.ts` therefore
cannot import helper modules; all new code must live inside `app.ts` itself. This also
constrains the testing options (see Testing strategy).

## DOM structure

All construction uses the existing helpers (`textEl`, `buttonEl`, `inputEl` at
`app.ts:76-107`), consistent with the rest of the file. Target structure:

```
<dialog class="create-dialog">            ← padding: 0 (important for outside-click, below)
  <form class="create-form create-form--modal">
    <h2 class="panel-title">Create job</h2>
    <textarea name="goal" placeholder="New job goal" class="create-form__goal">
    <input type="text" name="cwd" placeholder="cwd">
    <input type="text" name="id" placeholder="optional id">
    <div class="create-form__actions">
      <button type="button" class="create-form__cancel">Cancel</button>
      <button type="submit" class="create-form__submit">Confirm</button>
    </div>
  </form>
</dialog>
```

Concrete changes in `mountApp` (around `app.ts:268-283`):

1. `goalInput` changes from `inputEl("text", ...)` to a `document.createElement("textarea")`
   with the same `name`/`placeholder` (no `textareaEl` helper needed for a single use; the
   login form at app.ts:293-308 already builds one-off elements inline). Type changes from
   `HTMLInputElement` to `HTMLTextAreaElement`; `.value` usage is identical.
2. `cwdInput`, `idInput`, `createForm` stay as they are — the form just gets appended into
   the new `createDialog` instead of `sidebarInner`, plus the new actions row (Cancel +
   Confirm) replacing the single submit button. The submit button label becomes "Confirm".
3. New sidebar button: `const openCreateButton = buttonEl("Create job", "create-form__submit create-job-open")`
   (type "button"). `sidebarInner.append(openCreateButton, jobsHost)` replaces the current
   `sidebarInner.append(createForm, jobsHost)` at app.ts:283.
4. `shell.append(banner, content, createDialog)` — the dialog hangs off `shell`, outside
   `content`, so `refreshSession()`'s `content.replaceChildren(...)` swaps (app.ts:357,362)
   never orphan it.

## Behavior wiring

**Open:** `openCreateButton` click → `createDialog.showModal()`, then focus the goal
textarea (`goalInput.focus()`; `<dialog>` focuses the first focusable control by default,
which is the textarea anyway, but the explicit call makes intent clear and is robust to
field reordering).

**Submit (Confirm):** the existing `createForm` submit handler at app.ts:579-604 is reused
**verbatim** — same trim/guard, same `api<{ job }>("/api/jobs", ...)` call, same body
shaping, same field-clearing, same `refreshJobs`/`refreshDetail`/banner calls, same catch →
`showError`. The only addition is one line in the success path: `createDialog.close()`
after the inputs are cleared. On failure the dialog intentionally stays open (values
preserved, user can fix and retry); the error surfaces in the banner exactly as today —
the recommended semi-transparent backdrop keeps it visible. (Optional nicety, implementer's
call: mirror the message into a small `.create-form__error` element inside the modal, since
the banner sits behind the backdrop. Not required; the catch block otherwise stays as-is.)

**Cancel button:** `type="button"` (so it never triggers form submit), click →
`createDialog.close()`. No API call, no field clearing.

**Esc:** free with `showModal()` — the browser fires `cancel` then `close` and dismisses
the dialog. We add no `cancel` listener and never `preventDefault()` it. No code.

**Click outside:** the standard native-dialog pattern. With `showModal()`, clicks on
`::backdrop` are dispatched with `event.target === dialogElement`. Because the dialog
itself has `padding: 0` and the form (with its own padding) fills the entire dialog box,
`event.target === createDialog` is true *only* for backdrop clicks:

```ts
createDialog.addEventListener("click", (event) => {
  if (event.target === createDialog) createDialog.close();
});
```

Known minor edge (acceptable, standard for this pattern): starting a text-selection drag
inside the form and releasing over the backdrop can register as a dialog-targeted click and
close the modal. Values are preserved (below), so nothing is lost; not worth extra code.

**Field values across cancel/Esc:** preserved (we clear only on successful create, which is
the existing behavior). Rationale: a long goal text should survive an accidental Esc or
stray outside click. Stated as an explicit assumption — cheap to flip to clear-on-close if
the human prefers.

**Session loss while the modal is open:** in `refreshSession()`'s unauthenticated branch
(app.ts:350-359), add `createDialog.close()` alongside the existing teardown so the modal
doesn't sit on top of the login form.

## CSS

Additions to `styles.css`, reusing the existing dark-theme variables (`--panel`, `--text`,
`--border`, `--accent`, `--muted` from `:root` at lines 1-12) and extending the existing
`.create-form` rules (lines 105-176) rather than duplicating them:

```css
.create-dialog {
  padding: 0;                          /* required by the outside-click pattern */
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--panel);
  color: var(--text);
  width: min(680px, 92vw);
}
.create-dialog::backdrop {
  background: rgba(4, 8, 20, 0.65);    /* literal color: ::backdrop custom-property
                                          inheritance is inconsistent across engines */
}
.create-form--modal {
  border: none;                        /* panel chrome moves to the dialog element */
  background: transparent;
  padding: 1.4rem;
}
.create-form__goal {
  min-height: 12rem;
  resize: vertical;
}
.create-form__actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}
.create-form__cancel {
  background: rgba(8, 13, 28, 0.92);
  color: var(--text);
}
```

Plus two selector extensions to existing rules so the textarea and cancel button pick up
the established input/button chrome (radius, border, padding):

- line 115-122 group: add `.create-form textarea`
- line 124-129 group (`background/color/padding` for inputs): add `.create-form textarea`

The existing `.create-form input`/`button` rules apply inside the modal unchanged since the
form keeps the `.create-form` class. `.create-form__submit` (accent gradient) is reused for
both the sidebar "Create job" opener and the modal Confirm; add
`.create-job-open { width: 100%; }` if the opener needs to fill the sidebar column.
No changes to any other selector — job list, detail pane, and action forms are untouched.

## What "works end-to-end" means

Entry point: `agvsr web` gateway (or the equivalent dev startup) with a running daemon;
open the served UI in a browser, log in with the startup token. Success condition:

1. Sidebar shows only the "Create job" button (no inline inputs) plus the job list.
2. Click it → centered modal over a dimmed backdrop; goal textarea is large and focused.
3. Esc closes; reopen → click on the backdrop closes; reopen → Cancel closes. No POST is
   issued in any of these (verifiable in devtools network tab), and re-opening shows the
   previously typed values.
4. Fill goal + cwd, Confirm → modal closes, the new job appears in the list and its detail
   pane opens (existing post-create behavior: `currentJobId` set, `refreshJobs` +
   `refreshDetail`).
5. Confirm with a missing cwd → nothing happens (existing guard); Confirm with a bad cwd →
   error in banner, modal stays open with values intact.
6. Job list/detail rendering and tell/stop/kill are visually and behaviorally unchanged.

## Testing strategy

**Reality check (verified):** there is zero automated coverage of `src/web/client/app.ts`
today — all `test/web-*.test.ts` files are server-side (real daemon + gateway + fetch).
Additionally, the no-bundling constraint above means the client can't import (or be split
into) testable modules without changing how the gateway serves it, and `app.ts` exports
nothing (it self-executes behind an `if (typeof document !== "undefined")` guard at the
bottom of the file).

**What is already covered, for real:** the entire submit path that matters —
POST /api/jobs with session cookie + CSRF, body `{goal, cwd, id?}`, created-job response,
error responses — is exercised end-to-end against a real daemon and gateway in
`test/web-ops.test.ts` (job creation at lines ~221, ~262, ~289; CSRF-rejection at ~316) and
job listing/detail in `test/web-api.test.ts`. This design deliberately changes **nothing**
on that path: the handler body, `api()` helper, endpoint, and payload are byte-identical
except for one added `createDialog.close()`. So the real fetch/API logic retains its
existing real-server coverage without any new test.

**What is new and how it gets verified:** the only new logic is DOM wiring
(open/close/Esc/backdrop-click), and Esc + backdrop-click semantics are *native browser
behavior* of `<dialog>`/`showModal()` — precisely the part a DOM shim reproduces least
faithfully. Recommended plan:

1. **No new devDependency.** A happy-dom/jsdom route was considered and rejected: it would
   require (a) sign-off on a new dep, (b) refactoring `app.ts` to export a mount function
   (currently exports nothing), and (c) it still wouldn't faithfully test the two
   highest-risk behaviors (native Esc handling and `::backdrop` click targeting), which
   shims implement partially or not at all. We'd add infrastructure to test a simulation of
   the browser rather than the browser. This is the honest-path alternative the constraints
   explicitly allow.
2. **Manual verification via the `run` skill** against a real daemon + gateway + browser,
   walking the six-step end-to-end checklist above. QA verifies against the same checklist.
3. **Optional cheap regression guard** (implementer's discretion): extend the existing
   gateway asset test (or add one alongside it) asserting the served client JS transpiles
   and contains the `create-dialog` markers — catches accidental transpile breakage of the
   new code, real HTTP, no DOM shim. Low value, near-zero cost; fine to skip.

**Decision point for the human (flagged, not taken):** if automated DOM-interaction tests
are wanted despite the above, the concrete proposal is `happy-dom` +
`@happy-dom/global-registrator` as a devDependency, plus refactoring `app.ts` to export
`mountApp` behind the existing document guard. Needs explicit sign-off before
implementation; not recommended for this change.

## Implementation order

1. `app.ts`: swap goal input → textarea; build `createDialog`; move `createForm` into it;
   add actions row (Cancel + Confirm); add sidebar opener button; wire open/cancel/
   outside-click; add `createDialog.close()` to submit success path and to the
   unauthenticated branch of `refreshSession()`.
2. `styles.css`: add the `.create-dialog`, `::backdrop`, `.create-form--modal`,
   `.create-form__goal`, `.create-form__actions`, `.create-form__cancel`,
   `.create-job-open` rules; extend the two existing selector groups with
   `.create-form textarea`.
3. `oxlint` / `oxfmt`, `bun test` (existing suites must stay green — this change should
   not affect any of them).
4. Manual end-to-end verification per the checklist (run skill).

## Explicit assumptions

- Cancel/Esc/outside-click preserve typed values; only successful create clears them.
- Errors continue to surface in the banner (visible through the translucent backdrop);
  an in-modal error line is optional.
- Native `<dialog>` support is assumed (consistent with the app's existing browser floor).
- The "Confirm" button reuses the `.create-form__submit` accent style; the sidebar opener
  reuses it too, so the sidebar's primary action keeps today's visual weight.
