import { NextRequest, NextResponse } from 'next/server';
import { createAuthVerificationService } from '@agentic-sdk/services/auth-verification';
import {
  isSiweEnabled,
  sessionStore,
  SIWE_SESSION_COOKIE_NAME,
} from '@/lib/siwe-session';

const authService = createAuthVerificationService(process.env.API_ACCESS_KEY);

/**
 * Verify API key endpoint
 * POST /api/auth/verify
 * Body: { apiKey: string }
 * Returns: { valid: boolean, authRequired: boolean, siweEnabled: boolean }
 *
 * Also accepts session cookie verification — if a valid cw-session cookie
 * is present, returns valid: true.
 */
export async function POST(request: NextRequest) {
  try {
    const siweEnabled = isSiweEnabled();
    const apiKeyAuthEnabled = authService.isAuthEnabled();
    const authRequired = apiKeyAuthEnabled || siweEnabled;

    if (!authRequired) {
      return NextResponse.json({ valid: true, authRequired: false, siweEnabled });
    }

    // Check session cookie first
    const sessionToken = request.cookies.get(SIWE_SESSION_COOKIE_NAME)?.value;
    if (sessionToken) {
      const address = sessionStore.verify(sessionToken);
      if (address) {
        return NextResponse.json({
          valid: true,
          authRequired: true,
          siweEnabled,
          siweAddress: address,
        });
      }
    }

    // Fall back to API key verification
    const body = await request.json();
    const { apiKey } = body;
    const valid = typeof apiKey === 'string' && authService.verifyKeyValue(apiKey);
    return NextResponse.json({ valid, authRequired: true, siweEnabled });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

/**
 * Check if auth is required
 * GET /api/auth/verify
 * Returns: { authRequired: boolean, siweEnabled: boolean }
 */
export async function GET() {
  const siweEnabled = isSiweEnabled();
  const authRequired = authService.isAuthEnabled() || siweEnabled;
  return NextResponse.json({ authRequired, siweEnabled });
}
