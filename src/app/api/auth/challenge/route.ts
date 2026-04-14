import { NextRequest, NextResponse } from 'next/server';
import {
  challengeStore,
  createSiweChallengeCookieValue,
  isSiweEnabled,
  isValidSiweNonce,
  SIWE_CHALLENGE_COOKIE_NAME,
} from '@/lib/siwe-session';

function getPublicOrigin(request: NextRequest): string {
  const originHeader = request.headers.get('origin');
  if (originHeader) {
    return originHeader;
  }

  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = request.headers.get('host')?.split(',')[0]?.trim();
  const nextUrl = request.nextUrl;

  const protocol = forwardedProto || nextUrl.protocol.replace(/:$/, '') || 'https';
  const resolvedHost = forwardedHost || host || nextUrl.host;

  return `${protocol}://${resolvedHost}`;
}

/**
 * POST /api/auth/challenge
 *
 * Generate a SIWE challenge message for the given Ethereum address.
 * This endpoint is unprotected (no auth required).
 *
 * Body: { address: string, nonce?: string }
 * Returns: { nonce: string, message: string }
 */
export async function POST(request: NextRequest) {
  if (!isSiweEnabled()) {
    return NextResponse.json(
      { error: 'SIWE authentication is not configured' },
      { status: 404 }
    );
  }

  try {
    const body = await request.json();
    const { address } = body;

    if (!address || typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return NextResponse.json(
        { error: 'Valid Ethereum address (0x-prefixed, 40 hex chars) is required' },
        { status: 400 }
      );
    }

    const clientNonce = body.nonce;
    if (clientNonce !== undefined) {
      if (typeof clientNonce !== 'string' || !isValidSiweNonce(clientNonce)) {
        return NextResponse.json(
          { error: 'nonce must be 8-128 characters and use only letters, numbers, periods, underscores, or hyphens' },
          { status: 400 }
        );
      }
      if (challengeStore.has(clientNonce)) {
        return NextResponse.json(
          { error: 'nonce is already in use' },
          { status: 409 }
        );
      }
    }

    const nonce = challengeStore.create(address, clientNonce);
    const issuedAt = new Date().toISOString();

    // Use the public origin so tunneled/proxied deployments do not emit
    // localhost URIs inside the SIWE message.
    const origin = getPublicOrigin(request);

    // EIP-4361 SIWE message format
    const message = [
      `Claude Workspace wants you to sign in with your Ethereum account:`,
      address,
      '',
      'Sign in to Claude Workspace',
      '',
      `URI: ${origin}`,
      `Version: 1`,
      `Chain ID: 1`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
    ].join('\n');

    const response = NextResponse.json({ nonce, message });

    const challengeCookie = createSiweChallengeCookieValue(address, nonce, message);
    if (challengeCookie) {
      response.cookies.set(SIWE_CHALLENGE_COOKIE_NAME, challengeCookie, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/auth',
        maxAge: Math.floor(5 * 60),
      });
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.message === 'Challenge nonce already exists') {
      return NextResponse.json(
        { error: 'nonce is already in use' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
