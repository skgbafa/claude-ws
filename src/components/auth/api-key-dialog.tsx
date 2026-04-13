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

// Extend global types for fetch patching
declare global {
  interface Window {
    fetch: typeof fetch & { _apiKeyPatched?: boolean };
  }
}

const API_KEY_STORAGE_KEY = 'claude-kanban:api-key';

interface ApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  siweEnabled?: boolean;
}

/**
 * Get stored API key from localStorage
 */
export function getStoredApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Store API key in localStorage
 */
export function storeApiKey(apiKey: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, apiKey);
  } catch {
    // Silent fail if localStorage is not available
  }
}

/**
 * Clear stored API key from localStorage
 */
export function clearStoredApiKey(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // Silent fail if localStorage is not available
  }
}

/**
 * Check if API key is required by the server and if SIWE is available
 */
async function checkAuthStatus(): Promise<{ authRequired: boolean; siweEnabled: boolean }> {
  try {
    const res = await fetch('/api/auth/verify');
    const data = await res.json();
    return {
      authRequired: data.authRequired === true,
      siweEnabled: data.siweEnabled === true,
    };
  } catch {
    return { authRequired: false, siweEnabled: false };
  }
}

/**
 * Check if API key is required by the server
 */
async function checkAuthRequired(): Promise<boolean> {
  const { authRequired } = await checkAuthStatus();
  return authRequired;
}

/**
 * Check if user has a valid session cookie (from SIWE sign-in)
 */
async function checkSessionCookie(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    return data.valid === true && !!data.siweAddress;
  } catch {
    return false;
  }
}

/**
 * Verify API key with the server
 */
async function verifyApiKey(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    return data.valid === true;
  } catch {
    return false;
  }
}

export function ApiKeyDialog({ open, onOpenChange, onSuccess, siweEnabled }: ApiKeyDialogProps) {
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Reset state when dialog opens
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
          <DialogDescription>
            {t('serverRequiresApiKey')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* SIWE Sign-In option (shown when enabled) */}
          {siweEnabled && (
            <>
              <SiweSignIn onSuccess={onSuccess} />
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

/**
 * Hook to check if API auth is required and key is stored
 * Returns true if user needs to enter API key
 */
export function useApiKeyCheck(refreshTrigger = 0): {
  needsApiKey: boolean;
  checking: boolean;
} {
  const [needsApiKey, setNeedsApiKey] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let mounted = true;

    const checkAuth = async () => {
      setChecking(true);
      try {
        const authRequired = await checkAuthRequired();
        if (!authRequired) {
          if (mounted) setNeedsApiKey(false);
          return;
        }

        const storedKey = getStoredApiKey();
        if (!storedKey) {
          if (mounted) setNeedsApiKey(true);
          return;
        }

        // Verify stored key is still valid
        const valid = await verifyApiKey(storedKey);
        if (!valid) {
          clearStoredApiKey();
          if (mounted) setNeedsApiKey(true);
          return;
        }

        if (mounted) setNeedsApiKey(false);
      } catch {
        if (mounted) setNeedsApiKey(false);
      } finally {
        if (mounted) setChecking(false);
      }
    };

    checkAuth();

    return () => {
      mounted = false;
    };
  }, [refreshTrigger]);

  return { needsApiKey, checking };
}

/**
 * Helper to convert Headers to plain object
 */
function headersToObject(headers: HeadersInit): Record<string, string> {
  if (headers instanceof Headers) {
    const obj: Record<string, string> = {};
    headers.forEach((value, key) => {
      obj[key] = value;
    });
    return obj;
  }
  return headers as Record<string, string>;
}

// Event name for triggering API key dialog from fetch interceptor
const API_KEY_REQUIRED_EVENT = 'claude-kanban:api-key-required';

/**
 * Dispatch event to trigger API key dialog
 */
function dispatchApiKeyRequired(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(API_KEY_REQUIRED_EVENT));
  }
}

/**
 * Provider that patches global fetch to include API key and handle 401 responses
 * Must be a client component and wrap the app
 */
export function ApiKeyProvider({ children }: { children: React.ReactNode }) {
  const [showAuthDialog, setShowAuthDialog] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [siweEnabled, setSiweEnabled] = useState(false);

  // Check auth on mount before rendering children
  useEffect(() => {
    const check = async () => {
      try {
        const status = await checkAuthStatus();
        if (!status.authRequired) {
          setAuthChecked(true);
          return;
        }
        setAuthRequired(true);
        setSiweEnabled(status.siweEnabled);

        // Check for valid SIWE session cookie first
        if (status.siweEnabled) {
          const hasSession = await checkSessionCookie();
          if (hasSession) {
            setAuthChecked(true);
            return;
          }
        }

        // Auth is required — check if we have a valid stored API key
        const storedKey = getStoredApiKey();
        if (storedKey) {
          const valid = await verifyApiKey(storedKey);
          if (valid) {
            setAuthChecked(true);
            return;
          }
          clearStoredApiKey();
        }

        // No valid key or session — show dialog, don't render children
        setShowAuthDialog(true);
      } catch {
        // If check fails, allow through
        setAuthChecked(true);
      }
    };

    check();
  }, []);

  // Listen for API key required events from fetch interceptor
  useEffect(() => {
    const handleApiKeyRequired = () => {
      setShowAuthDialog(true);
    };

    window.addEventListener(API_KEY_REQUIRED_EVENT, handleApiKeyRequired);
    return () => {
      window.removeEventListener(API_KEY_REQUIRED_EVENT, handleApiKeyRequired);
    };
  }, []);

  // Patch fetch immediately on render (synchronously)
  // This ensures it's available before any useEffect in child components runs
  if (typeof window !== 'undefined' && !window.fetch._apiKeyPatched) {
    const originalFetch = window.fetch;

    window.fetch = async (url, options) => {
      const apiKey = getStoredApiKey();
      const urlString = typeof url === 'string' ? url : url.toString();

      // Build new headers object with API key if available
      const existingHeaders = options?.headers
        ? headersToObject(options.headers)
        : {};

      const newHeaders: Record<string, string> = {
        ...existingHeaders,
      };

      // Add API key if stored
      if (apiKey) {
        newHeaders['x-api-key'] = apiKey;
      }

      // Create new options with merged headers
      const newOptions: RequestInit = {
        ...options,
        headers: newHeaders,
      };

      const response = await originalFetch(url, newOptions);

      // Check for 401 on API routes (except auth endpoints)
      const isApiRoute = urlString.includes('/api/');
      const isAuthEndpoint = urlString.includes('/api/auth/');

      if (response.status === 401 && isApiRoute && !isAuthEndpoint) {
        // Clear stored key if it's invalid
        if (apiKey) {
          clearStoredApiKey();
        }
        // Trigger API key dialog
        dispatchApiKeyRequired();
      }

      return response;
    };

    // Mark as patched to avoid double-patching
    window.fetch._apiKeyPatched = true;
  }

  const handleAuthSuccess = () => {
    setShowAuthDialog(false);

    // Reload page to reinitialize all components with authenticated state
    window.location.reload();
  };

  // When auth is required and dialog is showing, block children rendering
  // This prevents child components from mounting, running effects, and stealing focus
  if (showAuthDialog && !authChecked) {
    return (
      <ApiKeyDialog
        open={true}
        onOpenChange={() => {}}
        onSuccess={handleAuthSuccess}
        siweEnabled={siweEnabled}
      />
    );
  }

  return (
    <>
      {children}
      <ApiKeyDialog
        open={showAuthDialog}
        onOpenChange={setShowAuthDialog}
        onSuccess={handleAuthSuccess}
        siweEnabled={siweEnabled}
      />
    </>
  );
}
