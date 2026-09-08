import { ImplementationReviewArea, type ImplementationImpactDecision } from "../core/constants";

export type ImplementationReviewItem = {
  decision: ImplementationImpactDecision;
  note: string;
};

export type ImplementationReview = Record<ImplementationReviewArea, ImplementationReviewItem>;

export const IMPLEMENTATION_REVIEW_GUIDANCE: Record<ImplementationReviewArea, string> = {
  [ImplementationReviewArea.RuntimeBehavior]: "Check entry points, data flow, edge cases, and backward compatibility.",
  [ImplementationReviewArea.ToolContract]: "Check tool names, schemas, descriptions, result shapes, and client catalog changes.",
  [ImplementationReviewArea.Configuration]: "Check environment variables, bindings, deployment settings, and setup migration.",
  [ImplementationReviewArea.AuthSecurity]: "Check credential scope, storage, authorization boundaries, redaction, and protected paths.",
  [ImplementationReviewArea.ErrorsAudit]: "Check domain status, Japanese messages, safe details, and audit metadata.",
  [ImplementationReviewArea.Performance]: "Check request count, concurrency, payload size, caching, and normal-path overhead.",
  [ImplementationReviewArea.Tests]: "Check success, failure, conflict, and regression coverage at the appropriate scope.",
  [ImplementationReviewArea.Documentation]: "Check README, reference, setup, and canonical esa operation guidance.",
};
