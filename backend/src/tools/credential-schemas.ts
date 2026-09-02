import { z } from "zod";

// A tool's credential payload shape varies per tool (API key, OAuth token
// set, ...) and isn't declared anywhere centrally, so this only establishes
// the one invariant every payload actually needs: it's a JSON object, not
// some other JSON value.
export const CredentialPayloadSchema = z.record(z.string(), z.unknown());

export type CredentialPayload = z.infer<typeof CredentialPayloadSchema>;
