import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createSiweChallengeCookieValue,
  sessionStore,
  verifySiweChallengeCookie,
} from './siwe-session';

const ORIGINAL_SIWE_SESSION_SECRET = process.env.SIWE_SESSION_SECRET;
const ORIGINAL_API_ACCESS_KEY = process.env.API_ACCESS_KEY;

afterEach(() => {
  if (ORIGINAL_SIWE_SESSION_SECRET === undefined) {
    delete process.env.SIWE_SESSION_SECRET;
  } else {
    process.env.SIWE_SESSION_SECRET = ORIGINAL_SIWE_SESSION_SECRET;
  }

  if (ORIGINAL_API_ACCESS_KEY === undefined) {
    delete process.env.API_ACCESS_KEY;
  } else {
    process.env.API_ACCESS_KEY = ORIGINAL_API_ACCESS_KEY;
  }
});

describe('siwe-session', () => {
  it('binds a stateless challenge cookie to the exact SIWE message and address', () => {
    process.env.SIWE_SESSION_SECRET = 'test-siwe-secret';
    delete process.env.API_ACCESS_KEY;

    const address = '0x0000000000000000000000000000000000000001';
    const nonce = 'server-generated-nonce';
    const message = [
      'Claude Workspace wants you to sign in with your Ethereum account:',
      address,
      '',
      'Sign in to Claude Workspace',
      '',
      'URI: https://ws.gbafa.com',
      'Version: 1',
      'Chain ID: 1',
      `Nonce: ${nonce}`,
      'Issued At: 2026-04-13T00:00:00.000Z',
    ].join('\n');

    const cookie = createSiweChallengeCookieValue(address, nonce, message);

    assert.ok(cookie, 'expected a stateless challenge cookie');
    assert.strictEqual(
      verifySiweChallengeCookie(cookie!, message, address, nonce),
      true
    );
    assert.strictEqual(
      verifySiweChallengeCookie(cookie!, `${message}\nExtra: tampered`, address, nonce),
      false
    );
  });

  it('creates verifiable stateless session tokens when a signing secret is configured', () => {
    process.env.SIWE_SESSION_SECRET = 'test-siwe-secret';
    delete process.env.API_ACCESS_KEY;

    const address = '0x0000000000000000000000000000000000000002';
    const token = sessionStore.create(address);

    assert.ok(typeof token === 'string' && token.length > 0);
    assert.strictEqual(sessionStore.verify(token), address.toLowerCase());
  });
});
