// Workflow definitions Garcon inlines into a ticket launch prompt so an agent
// begins work with the same instructions a host skill would supply. Inlining
// keeps the prompt provider neutral: slash commands exist only on some
// providers, and a leading slash is rejected while preambles are pending.

import { GARCON_AGENT_PROMPT_MAX_BYTES } from './garcon-agent-request.js';
import type { TicketPriority } from './tickets.js';

export const TICKET_WORKFLOW_LIMITS = {
  idCodePoints: 64,
  titleCodePoints: 240,
  bodyBytes: 32 * 1024,
  promptBytes: GARCON_AGENT_PROMPT_MAX_BYTES,
  blockedBy: 20,
  references: 4,
} as const;

// Resolution precedence, narrowest scope first. A project or user file shadows a
// host skill, which in turn shadows the definition bundled with Garcon.
export const TICKET_WORKFLOW_SOURCE_KINDS = ['project', 'user', 'skill', 'bundled'] as const;
export type TicketWorkflowSourceKind = (typeof TICKET_WORKFLOW_SOURCE_KINDS)[number];

export interface TicketWorkflowSource {
  readonly kind: TicketWorkflowSourceKind;
  // Absolute path the body was read from, or null for a bundled definition.
  readonly path: string | null;
}

export interface TicketWorkflow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly source: TicketWorkflowSource;
}

export interface TicketBriefTicket {
  readonly id: string;
  readonly title: string;
  readonly project: string;
  readonly description: string | null;
  readonly priority: TicketPriority;
  readonly labels: readonly string[];
  // Carried so the agent can claim the ticket without first reading it back.
  readonly revision: number;
}

export interface TicketBriefInput {
  readonly workflow: TicketWorkflow;
  readonly ticket: TicketBriefTicket;
  // Identifiers of tickets that still gate this one. A non-empty list is
  // surfaced in the prompt rather than blocking the launch, because the
  // maintainer may be starting deliberately ahead of the frontier.
  readonly blockedBy?: readonly string[];
  // Workflows the primary body names. They are inlined too, because a provider
  // that cannot resolve a slash command cannot follow the reference either.
  readonly references?: readonly TicketWorkflow[];
}

// A slash-prefixed workflow id, rejecting anything preceded by a word character
// or an angle bracket so closing markup tags and path segments do not match.
const WORKFLOW_REFERENCE = /(?<![<\w])\/([a-z0-9][a-z0-9-]*)/g;

// Finds the workflows a body names. Matching against known identifiers is what
// separates a real reference from prose that merely looks like one.
export function findWorkflowReferences(
  body: string,
  knownIds: readonly string[],
  selfId?: string,
): readonly string[] {
  const known = new Set(knownIds);
  const found = new Set<string>();
  for (const match of body.matchAll(WORKFLOW_REFERENCE)) {
    const id = match[1];
    if (id && id !== selfId && known.has(id)) found.add(id);
  }
  return [...found].slice(0, TICKET_WORKFLOW_LIMITS.references);
}

export interface TicketWorkflowResponse {
  readonly workflow: TicketWorkflow;
  readonly references: readonly TicketWorkflow[];
}

function parseWorkflow(value: unknown): TicketWorkflow {
  if (!value || typeof value !== 'object') throw new TypeError('A workflow object is required.');
  const raw = value as Record<string, unknown>;
  const source = raw.source as Record<string, unknown> | undefined;
  const kind = source?.kind;
  if (typeof raw.id !== 'string' || typeof raw.title !== 'string' || typeof raw.body !== 'string') {
    throw new TypeError('A workflow requires id, title, and body strings.');
  }
  if (typeof kind !== 'string' || !(TICKET_WORKFLOW_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new TypeError('A workflow requires a known source kind.');
  }
  const path = source?.path;
  if (path !== null && typeof path !== 'string') throw new TypeError('A workflow source path must be a string or null.');
  return {
    id: raw.id,
    title: raw.title,
    body: raw.body,
    source: { kind: kind as TicketWorkflowSourceKind, path },
  };
}

export function parseTicketWorkflowResponse(value: unknown): TicketWorkflowResponse {
  if (!value || typeof value !== 'object') throw new TypeError('A workflow response is required.');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.references)) throw new TypeError('A workflow response requires a references array.');
  return {
    workflow: parseWorkflow(raw.workflow),
    references: raw.references.map(parseWorkflow),
  };
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export interface SkillDocument {
  readonly name: string | null;
  readonly description: string | null;
  readonly body: string;
}

// Splits a skill document into its frontmatter identity and instruction body.
// Only `name` and `description` are read; the remaining keys steer host skill
// loaders and carry no meaning once the body is inlined into a prompt.
export function parseSkillDocument(content: string): SkillDocument {
  const match = FRONTMATTER.exec(content);
  if (!match) return { name: null, description: null, body: content.trim() };
  const scalar = (key: string): string | null => {
    const found = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1] ?? '');
    const value = found?.[1]?.trim();
    if (!value) return null;
    const unquoted = /^(['"])([\s\S]*)\1$/.exec(value);
    return (unquoted?.[2] ?? value).trim() || null;
  };
  return {
    name: scalar('name'),
    description: scalar('description'),
    body: content.slice(match[0].length).trim(),
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// Trims to a byte budget on a character boundary, appending a notice so the
// agent knows the instructions it received were cut rather than complete.
function clampBytes(value: string, maxBytes: number, notice: string): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const budget = Math.max(0, maxBytes - utf8Bytes(notice));
  const encoded = new TextEncoder().encode(value).subarray(0, budget);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(encoded);
  return `${decoded.replace(/�+$/, '').trimEnd()}${notice}`;
}

export function ticketPriorityRef(priority: TicketPriority): string {
  return `P${priority}`;
}

// Renders the launch prompt: workflow instructions first so the agent knows how
// to work before it learns what to work on, then the ticket brief, then the
// protocol note that keeps the tracker current. Never begins with a slash.
export function renderTicketAgentBrief(input: TicketBriefInput): string {
  const { workflow, ticket } = input;
  const blockedBy = (input.blockedBy ?? []).slice(0, TICKET_WORKFLOW_LIMITS.blockedBy);
  const facts = [
    `Ticket: ${ticket.id}`,
    `Project: ${ticket.project}`,
    `Priority: ${ticketPriorityRef(ticket.priority)}`,
    ...(ticket.labels.length ? [`Labels: ${ticket.labels.join(', ')}`] : []),
    ...(blockedBy.length ? [`Blocked by: ${blockedBy.join(', ')}`] : []),
  ];
  const description = ticket.description?.trim();
  const references = (input.references ?? []).slice(0, TICKET_WORKFLOW_LIMITS.references);
  const sections = [
    clampBytes(
      workflow.body.trim(),
      TICKET_WORKFLOW_LIMITS.bodyBytes,
      '\n\n[Workflow instructions truncated by Garcon.]',
    ),
    `## Ticket ${ticket.id}: ${ticket.title}`,
    facts.join('\n'),
    ...(description ? [description] : []),
    ...(blockedBy.length
      ? ['This ticket is still blocked. Confirm with the maintainer before starting work that depends on the blocking tickets.']
      : []),
    // Claiming is left to the agent rather than done at launch: the claim then
    // records this chat as the assignee, which is the association the tracker wants.
    `Claim ${ticket.id} in Garcon before starting, so the tracker records this chat as its owner:\n\n`
      + `<garcon-ticket-claim ref="claim-${ticket.id.toLowerCase()}" ticket-id="${ticket.id}" expected-revision="${ticket.revision}" />\n\n`
      + 'Comment on it as you work, and close it once its acceptance criteria hold.',
    // The appendix trails the brief so a prompt trimmed to budget loses
    // supporting procedure rather than the ticket it is meant to deliver.
    ...(references.length
      ? [
        '## Referenced workflows',
        'The workflow above names these procedures. They are reproduced here because a slash command may not resolve on this provider.',
        ...references.map((reference) =>
          `### ${reference.id}\n\n${clampBytes(
            reference.body.trim(),
            TICKET_WORKFLOW_LIMITS.bodyBytes,
            '\n\n[Referenced workflow truncated by Garcon.]',
          )}`,
        ),
      ]
      : []),
  ];
  return clampBytes(
    sections.join('\n\n'),
    TICKET_WORKFLOW_LIMITS.promptBytes,
    '\n\n[Prompt truncated by Garcon.]',
  );
}
