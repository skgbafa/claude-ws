'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Key, AlertCircle, Check } from 'lucide-react';
import { SiweSignIn } from './siwe-sign-in';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  getStoredApiKey,
  storeApiKey,
  verifyApiKey,
} from '@/components/auth/api-key-localstorage-and-server-verify-utils';

// Re-export utilities consumed by other modules
export {
  getStoredApiKey,
  storeApiKey,
  clearStoredApiKey,
  checkAuthRequired,
  verifyApiKey,
} from '@/components/auth/api-key-localstorage-and-server-verify-utils';

export { useApiKeyCheck } from '@/components/auth/api-key-required-check-hook';
export { ApiKeyFetchInterceptorProvider as ApiKeyProvider } from '@/components/auth/api-key-fetch-interceptor-provider';

interface ApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  siweEnabled?: boolean;
  siweNonce?: string;
}

export function ApiKeyDialog({ open, onOpenChange, onSuccess, siweEnabled, siweNonce }: ApiKeyDialogProps) {
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setApiKey('');
      setError('');
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!apiKey.trim()) {
      setError(t('apiKeyIsRequired'));
      return;
    }

    setLoading(true);
    try {
      const valid = await verifyApiKey(apiKey);
      if (valid) {
        storeApiKey(apiKey);
        setApiKey('');
        onOpenChange(false);
        onSuccess();
      } else {
        setError(t('invalidApiKey'));
      }
    } catch {
      setError(t('failedToVerifyApiKey'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px] z-[9999]">
        <DialogHeader>
          <DialogTitle>{t('apiKeyRequired')}</DialogTitle>
          <DialogDescription>{t('serverRequiresApiKey')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* SIWE Sign-In option (shown when enabled) */}
          {siweEnabled && (
            <>
              <SiweSignIn onSuccess={onSuccess} nonce={siweNonce} />
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground uppercase">or</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            </>
          )}

          {/* API Key Input */}
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label htmlFor="api-key" className="text-sm font-medium">
                {t('apiKey')}
              </label>
              <div className="relative">
                <Key className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t('enterYourApiKey')}
                  className="pl-8"
                  disabled={loading}
                  autoFocus={!siweEnabled}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('apiKeyStoredLocally')}
              </p>
            </div>

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}

            {/* Success hint */}
            {!error && apiKey && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Check className="h-4 w-4 text-muted-foreground" />
                {t('pressEnterOrSubmit')}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={loading}
              >
                {tCommon('cancel')}
              </Button>
              <Button type="submit" disabled={loading || !apiKey}>
                {loading ? tCommon('verifying') : tCommon('submit')}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
