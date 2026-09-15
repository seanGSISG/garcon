import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  findWorkflowReferences,
  parseSkillDocument,
  TICKET_WORKFLOW_LIMITS,
  type TicketWorkflow,
  type TicketWorkflowSourceKind,
} from '../../common/ticket-workflows.js';
import { hasNodeErrorCode } from '../lib/errors.js';
import { bundledTicketWorkflow, bundledTicketWorkflowIds } from './bundled.js';

// Conventional locations for host agent skill libraries. Absent directories are
// skipped, so listing one costs nothing on a machine that does not use it.
export const DEFAULT_SKILL_ROOTS = ['.agents/skills', '.claude/skills'] as const;

const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]*$/;

export function isTicketWorkflowId(value: string): boolean {
  return (
    value.length <= TICKET_WORKFLOW_LIMITS.idCodePoints
    && WORKFLOW_ID.test(value)
    && !value.includes('--')
  );
}

export interface TicketWorkflowResolverOptions {
  readonly configDir: string;
  readonly homeDirectoryPath: string;
  // Absolute, or relative to the home directory. Defaults to the conventional roots.
  readonly skillRoots?: readonly string[];
}

interface Candidate {
  readonly kind: TicketWorkflowSourceKind;
  readonly path: string;
}

// Reads a candidate file, returning null when it is absent, unreadable, or
// larger than the inline budget. A too-large skill is skipped rather than
// truncated here so a smaller definition later in the chain can still win.
async function readCandidate(candidate: Candidate): Promise<TicketWorkflow | null> {
  let raw: string;
  try {
    const handle = await fs.stat(candidate.path);
    if (!handle.isFile() || handle.size > TICKET_WORKFLOW_LIMITS.bodyBytes) return null;
    raw = await fs.readFile(candidate.path, 'utf8');
  } catch (error) {
    if (hasNodeErrorCode(error, 'ENOENT') || hasNodeErrorCode(error, 'ENOTDIR')
      || hasNodeErrorCode(error, 'EACCES') || hasNodeErrorCode(error, 'EISDIR')) return null;
    throw error;
  }
  const document = parseSkillDocument(raw);
  if (!document.body) return null;
  const id = path.basename(candidate.path, '.md');
  return {
    id: document.name ?? id,
    title: document.description ?? document.name ?? id,
    body: document.body,
    source: { kind: candidate.kind, path: candidate.path },
  };
}

// Resolves a named workflow to the instruction body Garcon inlines into a ticket
// launch prompt, narrowest scope first.
export class TicketWorkflowResolver {
  readonly #configDir: string;
  readonly #skillRoots: readonly string[];

  constructor(options: TicketWorkflowResolverOptions) {
    this.#configDir = options.configDir;
    this.#skillRoots = (options.skillRoots ?? DEFAULT_SKILL_ROOTS).map((root) =>
      path.isAbsolute(root) ? root : path.join(options.homeDirectoryPath, root),
    );
  }

  #candidates(id: string, projectPath: string | null): readonly Candidate[] {
    return [
      ...(projectPath
        ? [{ kind: 'project' as const, path: path.join(projectPath, '.garcon', 'workflows', `${id}.md`) }]
        : []),
      { kind: 'user' as const, path: path.join(this.#configDir, 'workflows', `${id}.md`) },
      ...this.#skillRoots.map((root) => ({ kind: 'skill' as const, path: path.join(root, id, 'SKILL.md') })),
    ];
  }

  async resolve(id: string, projectPath: string | null): Promise<TicketWorkflow | null> {
    if (!isTicketWorkflowId(id)) return null;
    for (const candidate of this.#candidates(id, projectPath)) {
      const workflow = await readCandidate(candidate);
      // The resolved identity is reported under the requested id so a skill whose
      // frontmatter name drifts from its directory still answers the request.
      if (workflow) return { ...workflow, id };
    }
    return bundledTicketWorkflow(id);
  }

  // Resolves a workflow together with the workflows its body names. Only bundled
  // identifiers are recognised as references, so a host-only skill outside that
  // set is left for the provider to resolve; each recognised reference is still
  // resolved through the full precedence chain.
  async resolveWithReferences(
    id: string,
    projectPath: string | null,
  ): Promise<{ workflow: TicketWorkflow; references: readonly TicketWorkflow[] } | null> {
    const workflow = await this.resolve(id, projectPath);
    if (!workflow) return null;
    const references: TicketWorkflow[] = [];
    for (const referenceId of findWorkflowReferences(workflow.body, bundledTicketWorkflowIds(), id)) {
      const resolved = await this.resolve(referenceId, projectPath);
      if (resolved) references.push(resolved);
    }
    return { workflow, references };
  }
}
