import { NextRequest, NextResponse } from 'next/server';
import { challengeStore, isSiweEnabled } from '@/lib/siwe-session';

/**
 * POST /api/auth/challenge
 *
 * Generate a SIWE challenge message for the given Ethereum address.
 * This endpoint is unprotected (no auth required).
 *
 * Body: { address: string }
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

    const nonce = challengeStore.create(address);
    const issuedAt = new Date().toISOString();

    // Determine URI from request origin
    const origin = request.headers.get('origin') || request.nextUrl.origin;

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

    return NextResponse.json({ nonce, message });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
