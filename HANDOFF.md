# Fork handoff: ticket boards and agent orchestration

Fork-local working document for `seanGSISG/garcon`. Not intended for an upstream
pull request; drop it from any branch proposed to `cfal/garcon`.

Last updated 2026-09-15.

## Where things stand

| | |
|---|---|
| Fork | `seanGSISG/garcon`, `origin`; `upstream` is `cfal/garcon` with push disabled |
| `main` | Clean mirror of upstream at `6fc1ad6c`. Keep it that way so rebases stay cheap. |
| Delivered | `feat/ticket-agent-launch` @ `c1a57937`, pushed |
| Upstreaming | Decided per feature. T-01 is plausibly upstreamable; the vendored skills under `server/workflows/bundled/` are not, and would need replacing with generic bodies first. |

### What T-01 delivered

An Implement action on ticket cards. It resolves a named workflow, renders a
launch prompt, and seeds a new chat with it through
`appShell.openNewChatDialog({ prefill })`. The user reviews and sends.

- `common/ticket-workflows.ts` - frontmatter parsing, reference finding, prompt rendering, byte clamping, wire contract
- `server/workflows/resolver.ts` - four-tier resolution, id validation, reference expansion
- `server/workflows/bundled/` - `implement`, `triage`, `to-tickets`, `tdd`, `code-review` vendored from `mattpocock/skills` @ `959a8e9f` (MIT, licence retained)
- `scripts/build-bundled-workflows.js` - generates `bundled-content.ts`; run `bun run build:workflows` after editing any bundled markdown
- `server/routes/ticket-workflows.ts` - `GET /api/v1/ticket-workflows?id=&project=`
- Web: `TicketCard` button, `TicketsPanel.implement()`, `api/ticket-workflows.ts`, `PortableSurfaceContent` wiring

Workflow resolution precedence, narrowest scope first:

1. `<project>/.garcon/workflows/<id>.md`
2. `<configDir>/workflows/<id>.md`
3. `<skillRoot>/<id>/SKILL.md` - defaults `~/.agents/skills`, `~/.claude/skills`
4. bundled in this repo

On this machine `implement` resolves to the real
`~/.agents/skills/implement/SKILL.md`, so there is no copy to drift. The bundled
tier exists for a compiled executable or a container, where no host skill library
is reachable.

## Constraints discovered, do not relearn these

- **Never lead a generated prompt with a slash.** `server/agents/registry.ts:640`
  throws `PREAMBLE_SLASH_COMMAND_BLOCKED` (422) when a new chat has pending
  preambles and the first input starts with a slash command.
- **`/implement` is not a Claude Code command on this machine.** The Matt Pocock
  library lives in `~/.agents/skills` (managed by `~/.agents/.skill-lock.json`)
  and is not linked into `~/.claude/skills`. Inlining the body is the portable
  fix, and it is also the only thing that works for Codex, opencode, amp, and
  cursor.
- **`ready` is already the to-tickets frontier.** `server/tickets/queries.ts:61`
  defines it as `status='open' AND assignee_key IS NULL AND unresolvedBlockers=0`.
  Do not reimplement it.
- **Blocking direction:** `source` blocks `target`. Blockers of ticket X are the
  links where `targetId === X.id` and `kind === 'blocks'`. Cycles are already
  rejected by `requireNoBlockingCycle`.
- **A ticket can be owned by a chat.** `TicketOwner` is
  `{kind:'chat',chatId} | {kind:'user',username}`, and the `claim` mutation sets
  the assignee and flips `open` to `in-progress` in one step. Letting the agent
  claim itself is what records the chat as owner.
- **`server/gh/` has no issue support.** It covers pull requests and CI status
  only. `runGh` / `runGhJson` in `server/gh/run.ts` are the bounded subprocess
  helpers to build on.
- **Board lanes are hardcoded.** `web/src/lib/tickets/catalog/ticket-collection.ts:25`
  returns `TICKET_STATUSES` filtered by the query. Labels have no lane
  representation today.
- **`chat-boards` is the precedent to mirror** for configurable columns. It is a
  tag-matched board for chats: `common/chat-boards.ts`, `server/chat-boards/`,
  `web/src/lib/chat-board/`.

## Environment quirks on cachy, not regressions

Two pre-existing test failure classes, both verified environmental:

| Symptom | Cause | Workaround |
|---|---|---|
| 4 failures in `server/git/__tests__/git-service.test.js` | global `tag.gpgSign=true`; a signed tag is annotated and needs a message | `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=tag.gpgsign GIT_CONFIG_VALUE_0=false bun run test:server` |
| 7 failures in `web/src/lib/utils/__tests__/relative-timestamp.logic.test.ts` | tests assume UTC, machine is `America/Denver` | `TZ=UTC bun run --cwd web test` gives 6166/6166 |

Quality gate, per `AGENTS.md`: `bun run check` and `bun run test`, plus
`bun run start --port 0` when server code changed. Never kill a running server;
start a new one on another port.

## Remaining work

Tracer-bullet slices, each demoable on its own. Blocking edges noted.

### T-02 Label-matched ticket boards: contract and store
**Blocked by:** none.
Mirror `common/chat-boards.ts` as `common/ticket-boards.ts`: a `TicketBoard` with
columns that match labels, `match` of `all` or `any`, plus normalisers and a
revision-guarded catalog. Add `server/ticket-boards/` (store, service, setup,
errors) modelled on `server/chat-boards/`, persisted per workspace as JSON with
the same atomic write and optimistic-revision pattern. Routes mirror
`server/routes/chat-boards.ts`.
Delivers: boards can be created, renamed, reordered, and deleted over HTTP, with
no UI yet.

### T-03 Board projection and column rendering
**Blocked by:** T-02.
Add `web/src/lib/ticket-board/` mirroring `web/src/lib/chat-board/`: a projection
that buckets tickets into columns by label match, a controller, and an
invalidation hub. Render it from the tickets panel as an alternative layout to
the existing status board, reusing `TicketCard`.
Delivers: tickets visible in label-defined columns with per-column counts.

### T-04 Drag between label columns
**Blocked by:** T-03.
The existing `ticketDropTarget` applies a status. Add the label equivalent: a
drop applies the target column's labels and removes the source column's, in one
mutation. Respect the exactly-one-category and exactly-one-state rule from the
triage vocabulary, and reject a drop that would produce two state labels.
Delivers: dragging a card moves it through the triage state machine.

### T-05 Triage vocabulary and preset board
**Blocked by:** T-03 (T-04 for the transition rules).
Model the canonical roles as a typed vocabulary in `common/`: categories `bug`
and `enhancement`, states `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`, with a configurable mapping to the actual label
strings a tracker uses. Ship a built-in Triage board preset whose columns are the
five states, plus a Frontier column backed by the existing `ready` query. Render
category and state distinctly on the card.
Delivers: the board matches the triage skill's model out of the box.

### T-06 GitHub issue read
**Blocked by:** none.
Extend `server/gh/` with issue support: typed `GhIssueSummary` and
`GhIssueDetail`, fetched through `runGhJson` (`gh issue list --json ...`,
`gh issue view`). Follow the existing mapper and error-classifier structure.
Note `gh` is already authenticated as `seanGSISG`.
Delivers: issues for the current repo can be listed and read server-side.

### T-07 Import issues into the ticket store
**Blocked by:** T-06.
Map an issue onto a ticket: labels to labels, open/closed to status and
resolution, assignee to owner, and the issue number to a stable external ref so
re-import updates rather than duplicates. Decide and document where the ref
lives, since `Ticket` has no external-id field today. Import is per project.
Delivers: the board shows real GitHub issues.

### T-08 Blocking edges from GitHub
**Blocked by:** T-07.
Derive `blocks` links from the issue graph: GitHub's sub-issue relationships
where present, otherwise parse the `## Blocked by` section the to-tickets
template writes. Create native `ticket_links`, letting `requireNoBlockingCycle`
reject anything malformed.
Delivers: the `ready` frontier is meaningful for imported issues, which is what
makes the Implement button pick the right work.

### T-09 Write back to GitHub
**Blocked by:** T-07.
Push label and state changes made in Garcon back to the issue. Needs a conflict
policy for an issue edited on both sides between syncs; decide it explicitly
rather than last-write-wins by accident.
Delivers: the board is a control surface, not just a view.

### T-10 Launch polish
**Blocked by:** T-01 only, so it can be picked up any time.
Deferred from T-01:
- A workflow picker, so a card can launch `triage` or `to-tickets` rather than
  always `implement`.
- Inline a skill's supporting documents. `tdd` references `mocking.md` and
  `tests.md`, and `triage` references `AGENT-BRIEF.md` and `OUT-OF-SCOPE.md`; all
  are vendored but only `SKILL.md` is inlined, so those markdown links dangle.
- Reference expansion recognises only bundled ids. A host-only skill named by a
  workflow body is left unresolved.
- No integration test covers the launch path end to end; coverage is unit-level
  on the renderer and resolver.

## Suggested order

T-06, T-07, T-08 first so the board has real data to design against, then T-02
through T-05 for the board itself. T-09 and T-10 last. T-02 is genuinely
independent, so it can run in parallel if you would rather see lanes sooner.
