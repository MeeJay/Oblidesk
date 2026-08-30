/**
 * problems.api.ts — the problem record, its root-cause analysis, and the
 * recurrence detector's inbox.
 *
 * Three things here are not the usual CRUD and are worth stating up front:
 *
 *   • There are TWO row versions in this module and they are not
 *     interchangeable. `Problem.rowVersion` is `problems.row_version`; the
 *     ticket header carries `tickets.row_version` under
 *     `ProblemWithRelations.ticket.rowVersion`. They are separate concurrency
 *     domains on purpose (HARD RULE 7): the RCA workshop must not 409 the team
 *     lead editing the ticket subject. Every mutation below states which one it
 *     wants in its signature, and sending the wrong one looks like it works
 *     until two people open the page.
 *
 *   • A refusal is not an error message. `POST .../known-error/publish`,
 *     `.../state` and `.../confirm` answer 422 with `blockers`, produced by the
 *     SAME shared evaluator the client already ran to grey the button out
 *     (HARD RULE 12). `blockersOf()` unwraps them so the panel can list what is
 *     missing instead of showing a stack trace.
 *
 *   • The list is PAGE-paginated, not keyset. That is deliberate and differs
 *     from `tickets.api.ts`: the problem board is a few dozen rows a team looks
 *     at once a week, not a hundred-thousand-row queue an agent lives in, and a
 *     total the footer can print is worth more here than a stable window.
 */

import apiClient, {
  rowVersionHeader,
  toApiError,
  toQuery,
  unwrap,
  type Envelope,
} from './client';
import type {
  AcceptProblemCandidateRequest,
  AddProblemAlertSignatureRequest,
  AddProblemCauseEvidenceRequest,
  CascadeIncidentSnapshot,
  ChangeProblemAnalysisStateRequest,
  ConfirmProblemCauseRequest,
  CreateProblemAnalysisRequest,
  CreateProblemCauseRequest,
  KnownErrorSuggestion,
  LinkIncidentsRequest,
  Problem,
  ProblemAlertSignature,
  ProblemAnalysisWithCauses,
  ProblemCandidate,
  ProblemCandidateState,
  ProblemCandidateWithTickets,
  ProblemCascadeRequest,
  ProblemCascadeResult,
  ProblemCause,
  ProblemCauseEvidence,
  ProblemClosurePolicy,
  ProblemConflict,
  ProblemDetectionRunOutcome,
  ProblemListQuery,
  ProblemRequirement,
  ProblemWithRelations,
  PromoteIncidentRequest,
  PublishKnownErrorRequest,
  PublishKnownErrorToKbRequest,
  RejectProblemCandidateRequest,
  RetireKnownErrorRequest,
  UnlinkIncidentsRequest,
  UpdateProblemAnalysisRequest,
  UpdateProblemCauseRequest,
  UpdateProblemRequest,
  VerifyWorkaroundRequest,
} from '@oblidesk/shared';

// ═════════════════════════════════════════════════════════════════════════════
// Page shapes
// ═════════════════════════════════════════════════════════════════════════════

export interface ProblemPage {
  items: ProblemWithRelations[];
  total: number;
  page: number;
  limit: number;
}

interface ProblemPageEnvelope extends Envelope<ProblemWithRelations[]> {
  total?: number;
  page?: number;
  limit?: number;
}

export interface CandidatePage {
  items: ProblemCandidateWithTickets[];
  total: number;
}

interface CandidatePageEnvelope extends Envelope<ProblemCandidateWithTickets[]> {
  total?: number;
}

export interface CandidateListQuery {
  state?: ProblemCandidateState | ProblemCandidateState[];
  minScore?: number;
  page?: number;
  limit?: number;
}

export interface KnownErrorSuggestQuery {
  subject: string;
  primaryCiId?: number | null;
  ciIds?: number[];
  sourceApp?: string | null;
  dedupeKey?: string | null;
  excludeTicketId?: number | null;
  limit?: number;
}

/** What `POST /:ticketId/incidents` reports back, skipped rows included. */
export interface LinkIncidentsResult {
  problem: Problem;
  linked: number[];
  skipped: Array<{ ticketId: number; reason: string }>;
}

export interface UnlinkIncidentsResult {
  problem: Problem;
  unlinked: number[];
}

export interface PublishToKbResult {
  problem: ProblemWithRelations;
  kbArticleId: number;
}

// ═════════════════════════════════════════════════════════════════════════════
// Typed failures
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The 409 body on a `problems.row_version` mismatch, already unwrapped from the
 * `ApiError` payload. The caller MUST rebase on `current` — swallowing this is
 * how one agent's workaround erases another's.
 */
export function problemConflictOf(error: unknown): ProblemConflict | null {
  const payload = (error as { payload?: Record<string, unknown> })?.payload;
  if (!payload) return null;
  const current = payload.current as ProblemWithRelations | undefined;
  if (!current) return null;
  return {
    code: 'version_conflict',
    current,
    conflictingFields: (payload.conflictingFields as string[] | undefined) ?? [],
  };
}

/**
 * The 422 body of a refused gate. These are the very requirements the client
 * already computed with the shared evaluator, so the two always agree; reading
 * them back matters when the server saw something the client could not (a
 * capability that changed under the session, a cause confirmed elsewhere).
 */
export function blockersOf(error: unknown): ProblemRequirement[] | null {
  const payload = (error as { payload?: Record<string, unknown> })?.payload;
  const blockers = payload?.blockers as ProblemRequirement[] | undefined;
  return Array.isArray(blockers) ? blockers : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// API
// ═════════════════════════════════════════════════════════════════════════════

export const problemsApi = {
  // ── The board ─────────────────────────────────────────────────────────────

  async list(query: ProblemListQuery = {}): Promise<ProblemPage> {
    try {
      const res = await apiClient.get<ProblemPageEnvelope>('/problems', {
        params: toQuery({ ...query }),
      });
      const body = res.data;
      const items = unwrap<ProblemWithRelations[]>(body) ?? [];
      return {
        items,
        total: body.total ?? items.length,
        page: body.page ?? query.page ?? 1,
        limit: body.limit ?? query.limit ?? items.length,
      };
    } catch (error) {
      throw toApiError(error);
    }
  },

  async get(problemTicketId: number): Promise<ProblemWithRelations> {
    try {
      const res = await apiClient.get<Envelope<ProblemWithRelations>>(
        `/problems/${problemTicketId}`,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Promotion creates a NEW ticket carrying `record_type = 'problem'` and links
   * the incident to it; the incident keeps its number, its SLA and its thread.
   * Nothing about it is flipped in place.
   */
  async promote(payload: PromoteIncidentRequest): Promise<ProblemWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ProblemWithRelations>>('/problems/promote', payload);
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Inline autosave, one field per call, validating nothing (HARD RULE 12).
   * `baseRowVersion` is `problems.row_version`.
   */
  async update(
    problemTicketId: number,
    payload: UpdateProblemRequest,
  ): Promise<ProblemWithRelations> {
    try {
      const res = await apiClient.patch<Envelope<ProblemWithRelations>>(
        `/problems/${problemTicketId}`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Linked incidents ──────────────────────────────────────────────────────

  /**
   * The linked incidents with the facts the cascade classifier keys off, so the
   * page can run `planClosureCascade()` locally and re-plan the instant the
   * policy select changes, without a round trip per keystroke.
   */
  async listIncidents(
    problemTicketId: number,
    params: { page?: number; limit?: number } = {},
  ): Promise<CascadeIncidentSnapshot[]> {
    try {
      const res = await apiClient.get<Envelope<CascadeIncidentSnapshot[]>>(
        `/problems/${problemTicketId}/incidents`,
        { params: toQuery({ ...params }) },
      );
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async linkIncidents(
    problemTicketId: number,
    payload: LinkIncidentsRequest,
  ): Promise<LinkIncidentsResult> {
    try {
      const res = await apiClient.post<Envelope<LinkIncidentsResult>>(
        `/problems/${problemTicketId}/incidents`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async unlinkIncidents(
    problemTicketId: number,
    payload: UnlinkIncidentsRequest,
  ): Promise<UnlinkIncidentsResult> {
    try {
      const res = await apiClient.delete<Envelope<UnlinkIncidentsResult>>(
        `/problems/${problemTicketId}/incidents`,
        { data: payload },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Workaround and known error ────────────────────────────────────────────

  async verifyWorkaround(
    problemTicketId: number,
    payload: VerifyWorkaroundRequest,
  ): Promise<ProblemWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ProblemWithRelations>>(
        `/problems/${problemTicketId}/workaround/verify`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** 422 with `blockers` when the shared evaluator refuses. See `blockersOf`. */
  async publishKnownError(
    problemTicketId: number,
    payload: PublishKnownErrorRequest,
  ): Promise<ProblemWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ProblemWithRelations>>(
        `/problems/${problemTicketId}/known-error/publish`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async retireKnownError(
    problemTicketId: number,
    payload: RetireKnownErrorRequest,
  ): Promise<ProblemWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ProblemWithRelations>>(
        `/problems/${problemTicketId}/known-error/retire`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * Seeds a KB article from the problem and links it. The two then live
   * independently: there is no synchronisation in either direction, ever, and
   * the UI must not pretend otherwise.
   */
  async publishToKb(
    problemTicketId: number,
    payload: PublishKnownErrorToKbRequest,
  ): Promise<PublishToKbResult> {
    try {
      const res = await apiClient.post<Envelope<PublishToKbResult>>(
        `/problems/${problemTicketId}/known-error/kb`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * The intake banner's three weapons, in decreasing certainty: a CI match, a
   * declared alert dedupe key, then text. Never throws loudly enough to
   * interrupt an intake form.
   */
  async suggestKnownErrors(query: KnownErrorSuggestQuery): Promise<KnownErrorSuggestion[]> {
    try {
      const res = await apiClient.get<Envelope<KnownErrorSuggestion[]>>(
        '/problems/known-errors/suggest',
        { params: toQuery({ ...query }) },
      );
      return unwrap(res.data) ?? [];
    } catch {
      return [];
    }
  },

  // ── Alert signatures ──────────────────────────────────────────────────────

  async listSignatures(problemTicketId: number): Promise<ProblemAlertSignature[]> {
    try {
      const res = await apiClient.get<Envelope<ProblemAlertSignature[]>>(
        `/problems/${problemTicketId}/signatures`,
      );
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async addSignature(
    problemTicketId: number,
    payload: AddProblemAlertSignatureRequest,
  ): Promise<ProblemAlertSignature> {
    try {
      const res = await apiClient.post<Envelope<ProblemAlertSignature>>(
        `/problems/${problemTicketId}/signatures`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async removeSignature(problemTicketId: number, signatureId: number): Promise<number> {
    try {
      const res = await apiClient.delete<Envelope<{ removed: number }>>(
        `/problems/${problemTicketId}/signatures/${signatureId}`,
      );
      return unwrap(res.data).removed;
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Root-cause analysis ───────────────────────────────────────────────────

  /** Newest first. Superseded analyses come back exactly as they were concluded. */
  async listAnalyses(problemTicketId: number): Promise<ProblemAnalysisWithCauses[]> {
    try {
      const res = await apiClient.get<Envelope<ProblemAnalysisWithCauses[]>>(
        `/problems/${problemTicketId}/analyses`,
      );
      return unwrap(res.data) ?? [];
    } catch (error) {
      throw toApiError(error);
    }
  },

  async createAnalysis(
    problemTicketId: number,
    payload: CreateProblemAnalysisRequest,
  ): Promise<ProblemAnalysisWithCauses> {
    try {
      const res = await apiClient.post<Envelope<ProblemAnalysisWithCauses>>(
        `/problems/${problemTicketId}/analyses`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** `baseRowVersion` is `problem_analyses.row_version`. */
  async updateAnalysis(
    problemTicketId: number,
    analysisId: number,
    payload: UpdateProblemAnalysisRequest,
  ): Promise<ProblemAnalysisWithCauses> {
    try {
      const res = await apiClient.patch<Envelope<ProblemAnalysisWithCauses>>(
        `/problems/${problemTicketId}/analyses/${analysisId}`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** THE completeness gate. 422 carries `blockers`; 409 carries the current row. */
  async changeAnalysisState(
    problemTicketId: number,
    analysisId: number,
    payload: ChangeProblemAnalysisStateRequest,
  ): Promise<ProblemAnalysisWithCauses> {
    try {
      const res = await apiClient.post<Envelope<ProblemAnalysisWithCauses>>(
        `/problems/${problemTicketId}/analyses/${analysisId}/state`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── Cause nodes ───────────────────────────────────────────────────────────

  /** Depth is derived server-side from the parent. Never send one. */
  async createCause(
    problemTicketId: number,
    analysisId: number,
    payload: CreateProblemCauseRequest,
  ): Promise<ProblemCause> {
    try {
      const res = await apiClient.post<Envelope<ProblemCause>>(
        `/problems/${problemTicketId}/analyses/${analysisId}/causes`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** `baseRowVersion` is `problem_causes.row_version`. */
  async updateCause(
    problemTicketId: number,
    causeId: number,
    payload: UpdateProblemCauseRequest,
  ): Promise<ProblemCause> {
    try {
      const res = await apiClient.patch<Envelope<ProblemCause>>(
        `/problems/${problemTicketId}/causes/${causeId}`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async deleteCause(problemTicketId: number, causeId: number): Promise<number> {
    try {
      const res = await apiClient.delete<Envelope<{ removed: number }>>(
        `/problems/${problemTicketId}/causes/${causeId}`,
      );
      return unwrap(res.data).removed;
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * `confirmed` and `refuted` cost evidence, a named method and a named human.
   * An automation actor can never reach them, which is why this route exists
   * separately from the autosaving PATCH above.
   */
  async confirmCause(
    problemTicketId: number,
    causeId: number,
    payload: ConfirmProblemCauseRequest,
  ): Promise<ProblemCause> {
    try {
      const res = await apiClient.post<Envelope<ProblemCause>>(
        `/problems/${problemTicketId}/causes/${causeId}/confirm`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async addCauseEvidence(
    problemTicketId: number,
    causeId: number,
    payload: AddProblemCauseEvidenceRequest,
  ): Promise<ProblemCauseEvidence> {
    try {
      const res = await apiClient.post<Envelope<ProblemCauseEvidence>>(
        `/problems/${problemTicketId}/causes/${causeId}/evidence`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async removeCauseEvidence(
    problemTicketId: number,
    causeId: number,
    evidenceId: number,
  ): Promise<number> {
    try {
      const res = await apiClient.delete<Envelope<{ removed: number }>>(
        `/problems/${problemTicketId}/causes/${causeId}/evidence/${evidenceId}`,
      );
      return unwrap(res.data).removed;
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── The closure cascade ───────────────────────────────────────────────────

  /** Writes nothing, logs nothing. The plan the page shows before anyone clicks. */
  async previewCascade(
    problemTicketId: number,
    policy?: ProblemClosurePolicy,
  ): Promise<ProblemCascadeResult> {
    try {
      const res = await apiClient.get<Envelope<ProblemCascadeResult>>(
        `/problems/${problemTicketId}/cascade`,
        { params: toQuery({ policy }) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  async runCascade(
    problemTicketId: number,
    payload: ProblemCascadeRequest,
  ): Promise<ProblemCascadeResult> {
    try {
      const res = await apiClient.post<Envelope<ProblemCascadeResult>>(
        `/problems/${problemTicketId}/cascade`,
        payload,
        { headers: rowVersionHeader(payload.baseRowVersion) },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  // ── The recurrence detector's inbox ───────────────────────────────────────

  async listCandidates(query: CandidateListQuery = {}): Promise<CandidatePage> {
    try {
      const res = await apiClient.get<CandidatePageEnvelope>('/problems/candidates', {
        params: toQuery({ ...query }),
      });
      const body = res.data;
      const items = unwrap<ProblemCandidateWithTickets[]>(body) ?? [];
      return { items, total: body.total ?? items.length };
    } catch (error) {
      throw toApiError(error);
    }
  },

  async getCandidate(candidateId: number): Promise<ProblemCandidateWithTickets> {
    try {
      const res = await apiClient.get<Envelope<ProblemCandidateWithTickets>>(
        `/problems/candidates/${candidateId}`,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Accepting a card opens the problem and links every contributing incident. */
  async acceptCandidate(
    candidateId: number,
    payload: AcceptProblemCandidateRequest,
  ): Promise<ProblemWithRelations> {
    try {
      const res = await apiClient.post<Envelope<ProblemWithRelations>>(
        `/problems/candidates/${candidateId}/accept`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /**
   * The rejected row is the headstone and is never deleted: it is what silences
   * the signature for the cooldown, and what lets the detector come back when
   * the evidence has materially worsened.
   */
  async rejectCandidate(
    candidateId: number,
    payload: RejectProblemCandidateRequest,
  ): Promise<ProblemCandidate> {
    try {
      const res = await apiClient.post<Envelope<ProblemCandidate>>(
        `/problems/candidates/${candidateId}/reject`,
        payload,
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },

  /** Manual kick of one detection pass. Hourly by default, server-side. */
  async runDetection(dryRun = false): Promise<ProblemDetectionRunOutcome> {
    try {
      const res = await apiClient.post<Envelope<ProblemDetectionRunOutcome>>(
        '/problems/candidates/run',
        { dryRun },
      );
      return unwrap(res.data);
    } catch (error) {
      throw toApiError(error);
    }
  },
};

export default problemsApi;
