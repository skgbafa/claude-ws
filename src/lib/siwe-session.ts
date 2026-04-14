/**
 * SIWE (Sign-In With Ethereum) session management
 *
 * Hosted deployments need SIWE state that survives request routing across
 * multiple handlers/processes. This module prefers stateless signed cookies
 * when a stable signing secret is available, and falls back to the legacy
 * in-memory stores only for single-process local development.
 */
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_TTL_MS = Number(process.env.SIWE_SESSION_TTL_MS) || 24 * 60 * 60 * 1000; // 24 hours default
const CLEANUP_INTERVAL_MS = 60 * 1000; // 60 seconds
const SIWE_NONCE_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;
const TOKEN_VERSION = 1;

export const SIWE_CHALLENGE_COOKIE_NAME = 'cw-siwe-challenge';
export const SIWE_SESSION_COOKIE_NAME = 'cw-session';

type SignedTokenKind = 'siwe-challenge' | 'siwe-session';

interface SignedTokenBase {
  v: number;
  kind: SignedTokenKind;
  address: string;
  exp: number;
}

interface SignedChallengeToken extends SignedTokenBase {
  kind: 'siwe-challenge';
  nonce: string;
  messageHash: string;
}

interface SignedSessionToken extends SignedTokenBase {
  kind: 'siwe-session';
}

function getSiweSigningSecret(): string | null {
  const secret =
    process.env.SIWE_SESSION_SECRET ||
    process.env.API_ACCESS_KEY ||
    null;

  if (!secret || secret.trim().length === 0) {
    return null;
  }

  return secret;
}

function isStatelessSiweEnabled(): boolean {
  return getSiweSigningSecret() !== null;
}

function toBase64Url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function safeCompareString(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);

  if (aBuffer.length !== bBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function signPayload(payload: SignedChallengeToken | SignedSessionToken): string {
  const secret = getSiweSigningSecret();
  if (!secret) {
    throw new Error('SIWE signing secret is not configured');
  }

  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

  return `${encodedPayload}.${signature}`;
}

function verifySignedPayload<T extends SignedChallengeToken | SignedSessionToken>(
  token: string,
  kind: SignedTokenKind
): T | null {
  const secret = getSiweSigningSecret();
  if (!secret) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

  if (!safeCompareString(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload).toString('utf8')) as T;
    if (payload.v !== TOKEN_VERSION || payload.kind !== kind) {
      return null;
    }
    if (typeof payload.address !== 'string' || payload.address.length === 0) {
      return null;
    }
    if (typeof payload.exp !== 'number' || payload.exp <= Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function hashSiweMessage(message: string): string {
  return crypto.createHash('sha256').update(message).digest('base64url');
}

// ---------------------------------------------------------------------------
// Legacy in-memory stores — fallback when no stable signing secret exists
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
  create(address: string, nonce?: string): string {
    if (isStatelessSiweEnabled()) {
      return nonce ?? crypto.randomUUID();
    }

    cleanExpiredChallenges();
    const selectedNonce = nonce ?? crypto.randomUUID();
    if (challenges.has(selectedNonce)) {
      throw new Error('Challenge nonce already exists');
    }
    challenges.set(selectedNonce, {
      nonce: selectedNonce,
      address: address.toLowerCase(),
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
    return selectedNonce;
  },

  /**
   * Verify a nonce exists, hasn't expired, and matches the expected address.
   * Deletes the nonce on success (single-use).
   * Returns true if valid.
   */
  verify(nonce: string, address: string): boolean {
    if (isStatelessSiweEnabled()) {
      return false;
    }

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

  /** Check whether a challenge nonce already exists. */
  has(nonce: string): boolean {
    if (isStatelessSiweEnabled()) {
      return false;
    }

    cleanExpiredChallenges();
    return challenges.has(nonce);
  },

  /** Number of active challenges (for diagnostics). */
  get size(): number {
    if (isStatelessSiweEnabled()) {
      return 0;
    }

    return challenges.size;
  },
};

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
    if (isStatelessSiweEnabled()) {
      return signPayload({
        v: TOKEN_VERSION,
        kind: 'siwe-session',
        address: address.toLowerCase(),
        exp: Date.now() + SESSION_TTL_MS,
      });
    }

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
    if (isStatelessSiweEnabled()) {
      const payload = verifySignedPayload<SignedSessionToken>(token, 'siwe-session');
      return payload?.address ?? null;
    }

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
    if (isStatelessSiweEnabled()) {
      return;
    }

    sessions.delete(token);
  },

  /** Number of active sessions (for diagnostics). */
  get size(): number {
    if (isStatelessSiweEnabled()) {
      return 0;
    }

    return sessions.size;
  },
};

// ---------------------------------------------------------------------------
// Stateless SIWE challenge helpers
// ---------------------------------------------------------------------------

export function createSiweChallengeCookieValue(
  address: string,
  nonce: string,
  message: string
): string | null {
  if (!isStatelessSiweEnabled()) {
    return null;
  }

  return signPayload({
    v: TOKEN_VERSION,
    kind: 'siwe-challenge',
    address: address.toLowerCase(),
    nonce,
    messageHash: hashSiweMessage(message),
    exp: Date.now() + CHALLENGE_TTL_MS,
  });
}

export function verifySiweChallengeCookie(
  challengeToken: string | undefined,
  message: string,
  address: string,
  nonce: string
): boolean {
  if (!isStatelessSiweEnabled()) {
    return challengeStore.verify(nonce, address);
  }

  if (!challengeToken) {
    return false;
  }

  const payload = verifySignedPayload<SignedChallengeToken>(
    challengeToken,
    'siwe-challenge'
  );

  if (!payload) {
    return false;
  }

  return (
    payload.address === address.toLowerCase() &&
    payload.nonce === nonce &&
    payload.messageHash === hashSiweMessage(message)
  );
}

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

/**
 * Check whether a caller-supplied SIWE nonce is valid.
 */
export function isValidSiweNonce(nonce: string): boolean {
  return SIWE_NONCE_PATTERN.test(nonce);
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
