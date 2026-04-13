import { NextRequest, NextResponse } from 'next/server';
import { verifyMessage } from 'viem';
import {
  challengeStore,
  sessionStore,
  getAcceptedAddresses,
  isSiweEnabled,
} from '@/lib/siwe-session';

/**
 * POST /api/auth/siwe
 *
 * Verify a signed SIWE message and create a session.
 * This endpoint is unprotected (no auth required).
 *
 * Body: { message: string, signature: string }
 * Returns: { authenticated: true, address: string }
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
    const { message, signature } = body;

    if (!message || typeof message !== 'string') {
      return NextResponse.json({ error: 'message is required' }, { status: 400 });
    }
    if (!signature || typeof signature !== 'string') {
      return NextResponse.json({ error: 'signature is required' }, { status: 400 });
    }

    // Parse address from SIWE message (line 2 of EIP-4361 format)
    const lines = message.split('\n');
    const address = lines[1]?.trim();
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return NextResponse.json(
        { error: 'Could not parse valid address from SIWE message' },
        { status: 400 }
      );
    }

    // Parse nonce from SIWE message
    const nonceMatch = message.match(/Nonce: ([0-9a-f-]+)/);
    if (!nonceMatch) {
      return NextResponse.json(
        { error: 'Could not parse nonce from SIWE message' },
        { status: 400 }
      );
    }
    const nonce = nonceMatch[1]!;

    // Verify the nonce exists, hasn't expired, and matches the address
    // This also deletes the nonce (single-use, replay-safe)
    if (!challengeStore.verify(nonce, address)) {
      return NextResponse.json(
        { error: 'Invalid or expired challenge nonce' },
        { status: 401 }
      );
    }

    // Verify the signature using viem
    let isValid: boolean;
    try {
      isValid = await verifyMessage({
        address: address as `0x${string}`,
        message,
        signature: signature as `0x${string}`,
      });
    } catch {
      return NextResponse.json(
        { error: 'Signature verification failed' },
        { status: 401 }
      );
    }

    if (!isValid) {
      return NextResponse.json(
        { error: 'Invalid signature' },
        { status: 401 }
      );
    }

    // Verify the address is in the accepted list
    const acceptedAddresses = getAcceptedAddresses();
    if (!acceptedAddresses.has(address.toLowerCase())) {
      return NextResponse.json(
        { error: 'Address not authorized' },
        { status: 403 }
      );
    }

    // Create session
    const token = sessionStore.create(address);

    // Set HttpOnly cookie
    const response = NextResponse.json({
      authenticated: true,
      address: address.toLowerCase(),
    });

    response.cookies.set('cw-session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 24 * 60 * 60, // 24 hours in seconds
    });

    return response;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}
