/**
 * SIWE (Sign-In With Ethereum) session management
 *
 * Manages challenge nonces and session tokens for SIWE authentication.
 * All state is in-memory with TTL-based expiry and periodic cleanup.
 */
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = Number(process.env.SIWE_SESSION_TTL_MS) || 24 * 60 * 60 * 1000; // 24 hours default
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds

// ---------------------------------------------------------------------------
// Challenge store — nonce management for SIWE sign-in
// ---------------------------------------------------------------------------

interface ChallengeEntry {
  nonce: string;
  address: string;
  expiresAt: number;
}

const challenges = new Map<string, ChallengeEntry>();

function cleanExpiredChallenges(): void {
  const now = Date.now();
  for (const [nonce, entry] of challenges) {
    if (entry.expiresAt <= now) {
      challenges.delete(nonce);
    }
  }
}

export const challengeStore = {
  /**
   * Create a new challenge nonce for the given address.
   * Returns the nonce string.
   */
  create(address: string): string {
    cleanExpiredChallenges();
    const nonce = crypto.randomUUID();
    challenges.set(nonce, {
      nonce,
      address: address.toLowerCase(),
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return nonce;
  },

  /**
   * Verify a nonce exists, hasn't expired, and matches the expected address.
   * Deletes the nonce on success (single-use).
   * Returns true if valid.
   */
  verify(nonce: string, address: string): boolean {
    const entry = challenges.get(nonce);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      challenges.delete(nonce);
      return false;
    }
    if (entry.address !== address.toLowerCase()) {
      return false;
    }
    // Single-use: delete after successful verification
    challenges.delete(nonce);
    return true;
  },

  /** Number of active challenges (for diagnostics). */
  get size(): number {
    return challenges.size;
  },
};

// ---------------------------------------------------------------------------
// Session store — token management for authenticated sessions
// ---------------------------------------------------------------------------

interface SessionEntry {
  token: string;
  address: string;
  expiresAt: number;
}

const sessions = new Map<string, SessionEntry>();

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [token, entry] of sessions) {
    if (entry.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

export const sessionStore = {
  /**
   * Create a new session for the given address.
   * Returns the session token (hex string).
   */
  create(address: string): string {
    cleanExpiredSessions();
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, {
      token,
      address: address.toLowerCase(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return token;
  },

  /**
   * Verify a session token is valid and not expired.
   * Returns the associated address, or null if invalid.
   */
  verify(token: string): string | null {
    const entry = sessions.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      sessions.delete(token);
      return null;
    }
    return entry.address;
  },

  /**
   * Revoke a session token.
   */
  revoke(token: string): void {
    sessions.delete(token);
  },

  /** Number of active sessions (for diagnostics). */
  get size(): number {
    return sessions.size;
  },
};

// ---------------------------------------------------------------------------
// Accepted addresses
// ---------------------------------------------------------------------------

/**
 * Parse OPENKEY_ACCEPTED_ADDRESSES env var into a Set of lowercase addresses.
 * Returns an empty set if the env var is not set or empty.
 */
export function getAcceptedAddresses(): Set<string> {
  const raw = process.env.OPENKEY_ACCEPTED_ADDRESSES;
  if (!raw || raw.trim().length === 0) return new Set();
  return new Set(
    raw
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter((a) => a.length > 0)
  );
}

/**
 * Check whether SIWE auth is configured (at least one accepted address).
 */
export function isSiweEnabled(): boolean {
  return getAcceptedAddresses().size > 0;
}

// ---------------------------------------------------------------------------
// Periodic cleanup
// ---------------------------------------------------------------------------

const cleanupTimer = setInterval(() => {
  cleanExpiredChallenges();
  cleanExpiredSessions();
}, CLEANUP_INTERVAL_MS);

// Don't keep the process alive just for cleanup
cleanupTimer.unref();
