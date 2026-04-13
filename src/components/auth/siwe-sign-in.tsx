'use client';

import { useState } from 'react';
import { AlertCircle, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Extend Window for ethereum provider (MetaMask / injected wallets)
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      isMetaMask?: boolean;
    };
  }
}

interface SiweSignInProps {
  onSuccess?: () => void;
}

export function SiweSignIn({ onSuccess }: SiweSignInProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSignIn = async () => {
    setError('');

    if (!window.ethereum) {
      setError('No Ethereum wallet detected. Please install MetaMask or another wallet.');
      return;
    }

    setLoading(true);
    try {
      // Request accounts from wallet
      const accounts = (await window.ethereum.request({
        method: 'eth_requestAccounts',
      })) as string[];

      if (!accounts || accounts.length === 0) {
        setError('No accounts found. Please connect your wallet.');
        return;
      }

      const address = accounts[0]!;

      // Request challenge from server
      const challengeRes = await fetch('/api/auth/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });

      if (!challengeRes.ok) {
        const data = await challengeRes.json();
        setError(data.error || 'Failed to get challenge');
        return;
      }

      const { message } = await challengeRes.json();

      // Sign the message with wallet (personal_sign)
      const signature = await window.ethereum.request({
        method: 'personal_sign',
        params: [message, address],
      });

      // Verify with server
      const verifyRes = await fetch('/api/auth/siwe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });

      if (!verifyRes.ok) {
        const data = await verifyRes.json();
        setError(data.error || 'Authentication failed');
        return;
      }

      const result = await verifyRes.json();
      if (result.authenticated) {
        // Session cookie is set automatically by the server response.
        // Reload to reinitialize with authenticated state.
        if (onSuccess) {
          onSuccess();
        } else {
          window.location.reload();
        }
      } else {
        setError('Authentication failed');
      }
    } catch (err: unknown) {
      // User rejected the signature request
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 4001) {
        setError('Signature request was rejected');
      } else {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <Button
        onClick={handleSignIn}
        disabled={loading}
        variant="outline"
        className="w-full gap-2"
      >
        <Wallet className="h-4 w-4" />
        {loading ? 'Signing in...' : 'Sign in with Ethereum'}
      </Button>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
