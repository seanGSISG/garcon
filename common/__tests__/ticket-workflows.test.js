import { describe, expect, it } from 'bun:test';
import {
  findWorkflowReferences,
  parseSkillDocument,
  renderTicketAgentBrief,
  TICKET_WORKFLOW_LIMITS,
} from '../ticket-workflows.ts';

function workflow(overrides = {}) {
  return {
    id: 'implement',
    title: 'Implement',
    body: 'Implement the work described in the tickets.',
    source: { kind: 'skill', path: '/skills/implement/SKILL.md' },
    ...overrides,
  };
}

function ticket(overrides = {}) {
  return {
    id: 'TKT-12',
    title: 'Add label matched boards',
    project: '/repo',
    description: 'Columns match labels.',
    priority: 2,
    labels: ['enhancement'],
    revision: 7,
    ...overrides,
  };
}

describe('skill document parsing', () => {
  it('splits frontmatter identity from the instruction body', () => {
    const parsed = parseSkillDocument(
      '---\nname: implement\ndescription: "Implement a piece of work."\ndisable-model-invocation: true\n---\n\nDo the work.\n',
    );
    expect(parsed).toEqual({
      name: 'implement',
      description: 'Implement a piece of work.',
      body: 'Do the work.',
    });
  });

  it('treats a document without frontmatter as a bare body', () => {
    expect(parseSkillDocument('  Do the work.  ')).toEqual({
      name: null,
      description: null,
      body: 'Do the work.',
    });
  });

  it('reports missing and blank frontmatter scalars as null', () => {
    const parsed = parseSkillDocument('---\nname:\nother: x\n---\nBody.');
    expect(parsed.name).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.body).toBe('Body.');
  });
});

describe('workflow references', () => {
  const known = ['tdd', 'code-review', 'triage', 'implement'];

  it('finds slash references that name a known workflow', () => {
    const found = findWorkflowReferences(
      'Use /tdd where possible. Once done, use /code-review to review the work.',
      known,
    );
    expect(found).toEqual(['tdd', 'code-review']);
  });

  it('ignores closing markup, paths, and unknown names', () => {
    expect(
      findWorkflowReferences(
        '</vertical-slice-rules> see .scratch/issues and http://x/tdd plus /unknown-thing',
        known,
      ),
    ).toEqual([]);
  });

  it('excludes the workflow naming itself and deduplicates', () => {
    expect(findWorkflowReferences('/implement then /tdd and /tdd again', known, 'implement')).toEqual([
      'tdd',
    ]);
  });

  it('caps the number of references', () => {
    const ids = Array.from({ length: TICKET_WORKFLOW_LIMITS.references + 3 }, (_, i) => `w${i}`);
    const found = findWorkflowReferences(ids.map((id) => `/${id}`).join(' '), ids);
    expect(found).toHaveLength(TICKET_WORKFLOW_LIMITS.references);
  });
});

describe('ticket agent brief', () => {
  it('leads with workflow instructions and never with a slash', () => {
    const prompt = renderTicketAgentBrief({ workflow: workflow(), ticket: ticket() });
    expect(prompt.startsWith('/')).toBe(false);
    expect(prompt.indexOf('Implement the work')).toBe(0);
    expect(prompt).toContain('## Ticket TKT-12: Add label matched boards');
    expect(prompt).toContain('Project: /repo');
    expect(prompt).toContain('Priority: P2');
    expect(prompt).toContain('Labels: enhancement');
    expect(prompt).toContain('Columns match labels.');
  });

  it('instructs the agent to claim the ticket at its current revision', () => {
    const prompt = renderTicketAgentBrief({ workflow: workflow(), ticket: ticket() });
    expect(prompt).toContain(
      '<garcon-ticket-claim ref="claim-tkt-12" ticket-id="TKT-12" expected-revision="7" />',
    );
  });

  it('omits optional facts that carry no value', () => {
    const prompt = renderTicketAgentBrief({
      workflow: workflow(),
      ticket: ticket({ labels: [], description: '   ' }),
    });
    expect(prompt).not.toContain('Labels:');
    expect(prompt).not.toContain('Blocked by:');
    expect(prompt).not.toContain('Columns match labels.');
  });

  it('surfaces blocking tickets with a warning instead of refusing to launch', () => {
    const prompt = renderTicketAgentBrief({
      workflow: workflow(),
      ticket: ticket(),
      blockedBy: ['TKT-9', 'TKT-10'],
    });
    expect(prompt).toContain('Blocked by: TKT-9, TKT-10');
    expect(prompt).toContain('still blocked');
  });

  it('caps the blocking list', () => {
    const blockedBy = Array.from({ length: TICKET_WORKFLOW_LIMITS.blockedBy + 5 }, (_, i) => `TKT-${i}`);
    const prompt = renderTicketAgentBrief({ workflow: workflow(), ticket: ticket(), blockedBy });
    expect(prompt).not.toContain(`TKT-${TICKET_WORKFLOW_LIMITS.blockedBy}`);
  });

  it('truncates an oversized workflow body but keeps the ticket brief intact', () => {
    const prompt = renderTicketAgentBrief({
      workflow: workflow({ body: 'x'.repeat(TICKET_WORKFLOW_LIMITS.bodyBytes + 1024) }),
      ticket: ticket(),
    });
    expect(prompt).toContain('[Workflow instructions truncated by Garcon.]');
    expect(prompt).toContain('## Ticket TKT-12: Add label matched boards');
  });

  it('appends referenced workflows after the brief', () => {
    const prompt = renderTicketAgentBrief({
      workflow: workflow({ body: 'Use /tdd where possible.' }),
      ticket: ticket(),
      references: [workflow({ id: 'tdd', body: 'Write the failing test first.' })],
    });
    expect(prompt).toContain('## Referenced workflows');
    expect(prompt).toContain('### tdd');
    expect(prompt).toContain('Write the failing test first.');
    expect(prompt.indexOf('## Ticket TKT-12')).toBeLessThan(prompt.indexOf('## Referenced workflows'));
  });

  it('omits the appendix when nothing is referenced', () => {
    const prompt = renderTicketAgentBrief({ workflow: workflow(), ticket: ticket(), references: [] });
    expect(prompt).not.toContain('## Referenced workflows');
  });

  it('keeps the rendered prompt within the agent prompt budget', () => {
    const prompt = renderTicketAgentBrief({
      workflow: workflow({ body: 'x'.repeat(TICKET_WORKFLOW_LIMITS.bodyBytes) }),
      ticket: ticket({ description: 'y'.repeat(TICKET_WORKFLOW_LIMITS.promptBytes) }),
    });
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
      TICKET_WORKFLOW_LIMITS.promptBytes,
    );
    expect(prompt).toContain('[Prompt truncated by Garcon.]');
  });
});
