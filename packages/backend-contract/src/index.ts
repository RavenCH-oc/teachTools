export const BACKEND_CONTRACT_VERSION = 1 as const;

/**
 * Phase 1 marker only. The production SessionBackend contract is specified in
 * docs/backend-contract.md and is intentionally deferred to a later phase.
 */
export type BackendContractMarker = {
  name: "SessionBackend";
  version: typeof BACKEND_CONTRACT_VERSION;
};
