import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Get API access key at call time (not module load time).
 * In daemon mode, dotenv loads after Next.js modules are imported,
 * so capturing at module scope would snapshot an undefined value.
 */
function getApiAccessKey(): string | undefined {
  return process.env.API_ACCESS_KEY;
}

/**
 * Check if API authentication is enabled
 */
export function isApiAuthEnabled(): boolean {
  const key = getApiAccessKey();
  return Boolean(key && key.length > 0);
}

/**
 * Verify API key from request headers
 * Returns true if auth is disabled or key matches
 */
export function verifyApiKey(request: NextRequest): boolean {
  // If no API key is configured, allow all requests
  if (!isApiAuthEnabled()) {
    return true;
  }

  const providedKey = request.headers.get('x-api-key');
  return providedKey === getApiAccessKey();
}

/**
 * Middleware response for unauthorized requests
 */
export function unauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized', message: 'Valid API key required' },
    { status: 401 }
  );
}

/**
 * Wrap a handler with API key authentication
 * Use this in route handlers to protect endpoints
 */
export function withApiAuth(
  handler: (request: NextRequest) => Promise<Response> | Response
) {
  return async (request: NextRequest) => {
    if (!verifyApiKey(request)) {
      return unauthorizedResponse();
    }
    return handler(request);
  };
}
