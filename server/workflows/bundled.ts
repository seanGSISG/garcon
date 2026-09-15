import type { TicketWorkflow } from '../../common/ticket-workflows.js';
import { BUNDLED_TICKET_WORKFLOWS } from './bundled-content.js';

export { BUNDLED_TICKET_WORKFLOWS };

export function bundledTicketWorkflow(id: string): TicketWorkflow | null {
  return BUNDLED_TICKET_WORKFLOWS.find((workflow) => workflow.id === id) ?? null;
}

export function bundledTicketWorkflowIds(): readonly string[] {
  return BUNDLED_TICKET_WORKFLOWS.map((workflow) => workflow.id);
}
