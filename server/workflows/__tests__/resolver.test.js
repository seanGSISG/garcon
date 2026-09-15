import { afterAll, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTicketWorkflowId, TicketWorkflowResolver } from '../resolver.ts';
import { TICKET_WORKFLOW_LIMITS } from '../../../common/ticket-workflows.ts';

const directories = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-workflows-'));
  directories.push(directory);
  return directory;
}

async function writeFile(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, 'utf8');
}

async function createResolver(overrides = {}) {
  const home = await temporaryDirectory();
  const configDir = path.join(home, '.garcon');
  const skillRoot = path.join(home, '.agents', 'skills');
  const project = path.join(home, 'repo');
  const resolver = new TicketWorkflowResolver({
    configDir,
    homeDirectoryPath: home,
    skillRoots: [skillRoot],
    ...overrides,
  });
  return { resolver, configDir, skillRoot, project };
}

afterAll(async () => {
  await Promise.all(directories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('workflow identifiers', () => {
  it('accepts slugs and rejects traversal or separators', () => {
    expect(isTicketWorkflowId('implement')).toBe(true);
    expect(isTicketWorkflowId('to-tickets')).toBe(true);
    expect(isTicketWorkflowId('..')).toBe(false);
    expect(isTicketWorkflowId('../etc/passwd')).toBe(false);
    expect(isTicketWorkflowId('a/b')).toBe(false);
    expect(isTicketWorkflowId('Implement')).toBe(false);
    expect(isTicketWorkflowId('-lead')).toBe(false);
    expect(isTicketWorkflowId('x'.repeat(TICKET_WORKFLOW_LIMITS.idCodePoints + 1))).toBe(false);
  });
});

describe('ticket workflow resolution', () => {
  it('falls back to the bundled definition when nothing is installed', async () => {
    const { resolver, project } = await createResolver();
    const workflow = await resolver.resolve('implement', project);
    expect(workflow?.source.kind).toBe('bundled');
    expect(workflow?.source.path).toBeNull();
    expect(workflow?.body.length).toBeGreaterThan(0);
    expect(workflow?.body.startsWith('---')).toBe(false);
  });

  it('prefers a host skill over the bundled definition and strips frontmatter', async () => {
    const { resolver, skillRoot, project } = await createResolver();
    await writeFile(
      path.join(skillRoot, 'implement', 'SKILL.md'),
      '---\nname: implement\ndescription: "Implement from tickets."\n---\n\nFollow the house rules.\n',
    );
    const workflow = await resolver.resolve('implement', project);
    expect(workflow?.source.kind).toBe('skill');
    expect(workflow?.body).toBe('Follow the house rules.');
    expect(workflow?.title).toBe('Implement from tickets.');
    expect(workflow?.id).toBe('implement');
  });

  it('prefers a user definition over a host skill', async () => {
    const { resolver, configDir, skillRoot, project } = await createResolver();
    await writeFile(path.join(skillRoot, 'implement', 'SKILL.md'), 'Skill body.');
    await writeFile(path.join(configDir, 'workflows', 'implement.md'), 'User body.');
    const workflow = await resolver.resolve('implement', project);
    expect(workflow?.source.kind).toBe('user');
    expect(workflow?.body).toBe('User body.');
  });

  it('prefers a project definition over every other source', async () => {
    const { resolver, configDir, skillRoot, project } = await createResolver();
    await writeFile(path.join(skillRoot, 'implement', 'SKILL.md'), 'Skill body.');
    await writeFile(path.join(configDir, 'workflows', 'implement.md'), 'User body.');
    await writeFile(path.join(project, '.garcon', 'workflows', 'implement.md'), 'Project body.');
    const workflow = await resolver.resolve('implement', project);
    expect(workflow?.source.kind).toBe('project');
    expect(workflow?.body).toBe('Project body.');
  });

  it('skips a project scope when the launch has no project path', async () => {
    const { resolver, configDir } = await createResolver();
    await writeFile(path.join(configDir, 'workflows', 'implement.md'), 'User body.');
    const workflow = await resolver.resolve('implement', null);
    expect(workflow?.source.kind).toBe('user');
  });

  it('skips an oversized or empty candidate so a later source still wins', async () => {
    const { resolver, configDir, skillRoot, project } = await createResolver();
    await writeFile(
      path.join(configDir, 'workflows', 'implement.md'),
      'x'.repeat(TICKET_WORKFLOW_LIMITS.bodyBytes + 1),
    );
    await writeFile(path.join(skillRoot, 'implement', 'SKILL.md'), 'Skill body.');
    expect((await resolver.resolve('implement', project))?.source.kind).toBe('skill');

    await writeFile(path.join(skillRoot, 'triage', 'SKILL.md'), '---\nname: triage\n---\n');
    expect((await resolver.resolve('triage', project))?.source.kind).toBe('bundled');
  });

  it('refuses an unknown workflow and a traversing identifier', async () => {
    const { resolver, project } = await createResolver();
    expect(await resolver.resolve('nope', project)).toBeNull();
    expect(await resolver.resolve('../../etc/passwd', project)).toBeNull();
  });
});

describe('workflow reference expansion', () => {
  it('resolves the workflows a bundled body names', async () => {
    const { resolver, project } = await createResolver();
    const resolved = await resolver.resolveWithReferences('implement', project);
    const ids = resolved?.references.map((reference) => reference.id) ?? [];
    expect(ids).toContain('tdd');
    expect(ids).toContain('code-review');
    expect(ids).not.toContain('implement');
  });

  it('resolves each reference through the full precedence chain', async () => {
    const { resolver, configDir, project } = await createResolver();
    await writeFile(path.join(configDir, 'workflows', 'tdd.md'), 'House TDD rules.');
    const resolved = await resolver.resolveWithReferences('implement', project);
    const tdd = resolved?.references.find((reference) => reference.id === 'tdd');
    expect(tdd?.source.kind).toBe('user');
    expect(tdd?.body).toBe('House TDD rules.');
  });

  it('reports no references for a body that names none', async () => {
    const { resolver, configDir, project } = await createResolver();
    await writeFile(path.join(configDir, 'workflows', 'implement.md'), 'Just do the work.');
    const resolved = await resolver.resolveWithReferences('implement', project);
    expect(resolved?.references).toEqual([]);
  });

  it('refuses an unknown workflow', async () => {
    const { resolver, project } = await createResolver();
    expect(await resolver.resolveWithReferences('nope', project)).toBeNull();
  });
});
