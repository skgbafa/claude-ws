# OpenKey and SIWE Auth

Claude Workspace uses two different auth layers that are easy to mix up:

- **OpenKey** handles wallet/key connection and message signing.
- **SIWE** (Sign-In With Ethereum) turns that signed message into a local session cookie for Claude Workspace.

This repo does not use OpenKey as a general app login system. It uses OpenKey as the signer inside the SIWE flow.

## Auth Flows

### OpenKey connection

The client creates an `OpenKey` instance and calls `connect()`. That step selects the wallet/key and returns metadata such as:

- `address`
- `keyId`
- `keyType`

If `keyType` is managed, OpenKey signs through its own UI. If it is external, signing is handed off to the browser wallet provider.

### SIWE sign-in

The repo’s sign-in dialog then:

1. Calls `/api/auth/challenge` with the wallet address.
2. Receives a SIWE message that includes a nonce.
3. Signs the message with OpenKey.
4. Posts the signed message to `/api/auth/siwe`.
5. The server verifies the signature, checks the nonce, and sets the `cw-session` cookie.

## Where Nonce Applies

Nonce belongs to the SIWE challenge, not to OpenKey `connect()`.

You can pass a nonce into the sign-in surface in this repo:

- `SiweSignIn` accepts an optional `nonce` prop.
- `ApiKeyDialog` forwards an optional `siweNonce` prop to `SiweSignIn`.
- `POST /api/auth/challenge` accepts an optional `nonce` field.

If no nonce is provided, the server generates a UUID nonce.

On hosted deployments, the challenge and session are bound to signed HttpOnly cookies so auth does not depend on one process's in-memory state. If no SIWE signing secret is configured, the repo falls back to the older in-memory challenge/session store for single-process local development.

Production guidance:

- Nonces should be generated server-side.
- Set `SIWE_SESSION_SECRET` for hosted or multi-instance deployments.
- Do not rely on the legacy in-memory fallback outside local development.

## OAuth vs SIWE

These are separate concepts in this repo:

- **Claude OAuth / provider setup** is the auth flow for Claude/Anthropic credentials. It lives in the provider setup UI and in `/api/settings/provider`.
- **SIWE** is the optional OpenKey-based sign-in flow for the workspace itself. It lives under `/api/auth/challenge`, `/api/auth/siwe`, and the `SiweSignIn` component.

So if you are configuring Claude access, that is not the same thing as signing in with OpenKey.

## Practical Examples

### Default SIWE flow

```tsx
<SiweSignIn onSuccess={handleSuccess} />
```

### SIWE flow with a caller-supplied nonce

```tsx
<ApiKeyDialog
  open={open}
  onOpenChange={setOpen}
  onSuccess={handleSuccess}
  siweEnabled
  siweNonce="my-custom-nonce-123"
/>
```

### Direct challenge request

```ts
await fetch('/api/auth/challenge', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    address,
    nonce: 'my-custom-nonce-123',
  }),
});
```

## Relevant Files

- `src/components/auth/siwe-sign-in.tsx`
- `src/components/auth/api-key-dialog.tsx`
- `src/app/api/auth/challenge/route.ts`
- `src/app/api/auth/siwe/route.ts`
- `src/lib/siwe-session.ts`
- `src/components/auth/agent-provider-setup-form.tsx`
- `src/app/api/settings/provider/route.ts`
