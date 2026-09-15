import type { TicketWorkflowResponse } from '../../common/ticket-workflows.js';
import { getConfigDir, getHomeDirectoryPath } from '../config.js';
import { TicketDomainError } from '../tickets/errors.js';
import { ticketErrorResponse, ticketJson, requireTicketPrincipal } from '../tickets/http.js';
import { TicketWorkflowResolver } from '../workflows/resolver.js';
import type { RouteHandler, RouteMap } from '../lib/http-route-types.js';
import { markRouteNoStore } from '../lib/http-route.js';

function authenticated(handler: RouteHandler): RouteHandler {
  return markRouteNoStore(async (request, url, server, context) => {
    try {
      requireTicketPrincipal(context);
      request.signal.throwIfAborted();
      return await handler(request, url, server, context);
    } catch (error) {
      return ticketErrorResponse(error);
    }
  });
}

// Serves the instruction body Garcon inlines into a ticket launch prompt. The
// project path only widens resolution to a repository-local definition, so an
// unreadable or absent one simply falls through to the next source.
export function createTicketWorkflowRoutes(
  resolver = new TicketWorkflowResolver({
    configDir: getConfigDir(),
    homeDirectoryPath: getHomeDirectoryPath(),
  }),
): RouteMap {
  return {
    '/api/v1/ticket-workflows': {
      GET: authenticated(async (_request, url) => {
        const id = url.searchParams.get('id');
        if (!id) {
          throw new TicketDomainError('TICKET_VALIDATION_FAILED', 'A workflow id is required.');
        }
        const resolved = await resolver.resolveWithReferences(id, url.searchParams.get('project'));
        if (!resolved) {
          throw new TicketDomainError('TICKET_NOT_FOUND', `No workflow named ${id} is available.`);
        }
        return ticketJson({
          workflow: resolved.workflow,
          references: resolved.references,
        } satisfies TicketWorkflowResponse);
      }),
    },
  };
}
