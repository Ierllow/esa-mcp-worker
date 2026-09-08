import { z } from "zod";
import {
  ImplementationImpactDecision,
  ImplementationReviewArea,
  RepositoryChangeOperation,
} from "../core/constants";
import { DomainStatus, ErrorSource, ToolError } from "../core/errors";
import { IMPLEMENTATION_REVIEW_GUIDANCE } from "./github-implementation-review";

export const GITHUB_WRITE_META = {
  "openai/toolInvocation/invoking": "実装変更を準備しています",
  "openai/toolInvocation/invoked": "実装変更を準備しました",
};

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/i).describe("Full 40-character Git commit or blob SHA.");
const reviewItemSchema = z.object({
  decision: z.enum(ImplementationImpactDecision),
  note: z.string().min(1).max(500).describe("Concrete reason for the decision, including the file or behavior checked."),
});
const implementationReviewSchema = z.object({
  runtime_behavior: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.RuntimeBehavior]),
  tool_contract: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.ToolContract]),
  configuration: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.Configuration]),
  auth_security: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.AuthSecurity]),
  errors_audit: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.ErrorsAudit]),
  performance: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.Performance]),
  tests: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.Tests]),
  documentation: reviewItemSchema.describe(IMPLEMENTATION_REVIEW_GUIDANCE[ImplementationReviewArea.Documentation]),
}).describe("Required coding checklist. Assess every area even when the decision is not_affected.");
const repositoryChangeSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal(RepositoryChangeOperation.Upsert),
    path: z.string().min(1).max(300),
    expected_blob_sha: shaSchema.optional().describe("Required for an existing file; omit only for a new file."),
    content: z.string().describe("Complete new file content."),
  }),
  z.object({
    operation: z.literal(RepositoryChangeOperation.Delete),
    path: z.string().min(1).max(300),
    expected_blob_sha: shaSchema,
  }),
]);
export const GITHUB_SCHEMAS = { shaSchema, implementationReviewSchema, repositoryChangeSchema };

export function requireRepositoryWriteConfirmation(confirmWrite: boolean) {
  if (!confirmWrite) {
    throw new ToolError({
      source: ErrorSource.WriteConfirmation,
      domainStatus: DomainStatus.WriteConfirmationRequired,
      message: "Set confirm_write to true to perform this repository write operation.",
      messageJa: "GitHub repositoryへの書き込みにはconfirm_write: trueが必要です。",
    });
  }
}
