/**
 * Deterministic test vectors for SCL core tests.
 * 4-dimensional for simplicity. All normalized.
 */

// Orthogonal basis vectors
export const V_IDENTITY = [1, 0, 0, 0]      // "I am Plexo"
export const V_OPERATOR = [0, 1, 0, 0]      // "Dustin is my operator"
export const V_CODING = [0, 0, 1, 0]        // "coding domain"
export const V_DEVOPS = [0, 0, 0, 1]        // "devops domain"

// Mixed vectors (known similarities)
export const V_IDENTITY_CLOSE = [0.98, 0.1, 0.1, 0.1]    // Close to IDENTITY (~0.94 cosine)
// For drift: must be within refinementThreshold (0.3) but beyond spiritDriftThreshold (0.15)
// cos(V_IDENTITY, V_IDENTITY_DRIFT) ≈ 0.84 → distance ≈ 0.16 (> 0.15, < 0.3)
export const V_IDENTITY_DRIFT = [0.8, 0.3, 0.3, 0.3]
export const V_CODING_DEVOPS = [0, 0, 0.7, 0.7]           // Between coding and devops
export const V_OPERATOR_CLOSE = [0.1, 0.95, 0.1, 0.1]     // Close to OPERATOR

// Far from everything
export const V_UNRELATED = [-1, -1, -1, -1]

// Zero vector
export const V_ZERO = [0, 0, 0, 0]

// Workspace IDs
export const TEST_WORKSPACE = 'test-workspace-001'
