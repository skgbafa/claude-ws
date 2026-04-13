'use client';

import { useState, useRef } from 'react';
import { AlertCircle, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SiweSignInProps {
  onSuccess?: () => void;
}

export function SiweSignIn({ onSuccess }: SiweSignInProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const openKeyRef = useRef<import('@openkey/sdk').OpenKey | null>(null);

  const getOpenKey = async () => {
    if (!openKeyRef.current) {
      const { OpenKey } = await import('@openkey/sdk');
      openKeyRef.current = new OpenKey({
        host: process.env.NEXT_PUBLIC_OPENKEY_HOST || 'https://openkey.so',
      });
    }
    return openKeyRef.current;
  };

  const handleSignIn = async () => {
    setError('');
    setLoading(true);

    try {
      const openkey = await getOpenKey();

      // Connect via OpenKey — user authenticates and selects a key
      const auth = await openkey.connect();
      const address = auth.address;

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

      // Sign the SIWE message via OpenKey
      const { signature } = await openkey.signMessage({ message });

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
        if (onSuccess) {
          onSuccess();
        } else {
          window.location.reload();
        }
      } else {
        setError('Authentication failed');
      }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err) {
        const code = (err as { code: string }).code;
        if (code === 'USER_CANCELLED') {
          setError('Sign-in was cancelled');
          return;
        }
      }
      setError(err instanceof Error ? err.message : 'Sign-in failed');
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
        {loading ? 'Signing in...' : 'Sign in with OpenKey'}
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
