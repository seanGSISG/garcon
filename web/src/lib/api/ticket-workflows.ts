import {
	parseTicketWorkflowResponse,
	type TicketWorkflowResponse,
} from '$shared/ticket-workflows';
import { apiGet } from './client.js';

/** Fetches the workflow body Garcon inlines into a ticket launch prompt. */
export async function fetchTicketWorkflow(
	id: string,
	project: string | null,
	signal?: AbortSignal,
): Promise<TicketWorkflowResponse> {
	const params = new URLSearchParams({ id });
	if (project) params.set('project', project);
	return parseTicketWorkflowResponse(
		await apiGet<unknown>(`/api/v1/ticket-workflows?${params.toString()}`, {
			signal,
			cache: 'no-store',
		}),
	);
}
