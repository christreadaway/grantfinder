/**
 * /api/auth: Google sign-in, guest sign-in, current user, Claude API key.
 * Port of backend/routers/auth.py.
 */
import crypto from 'node:crypto';

import {
  deleteApiKey,
  getUser,
  hasApiKey,
  issueToken,
  rateLimit,
  saveApiKey,
  saveUser,
} from '../auth';
import { verifyApiKey } from '../claude';
import { allowGuestLogin, googleClientId } from '../config';
import { HttpError } from '../errors';
import { requireString } from '../http';
import { logger } from '../log';
import type { Router } from '../router';
import type { TokenResponse, User } from '../types';

interface GoogleTokenInfo {
  sub?: string;
  aud?: string;
  email?: string;
  name?: string;
  picture?: string;
  exp?: string;
}

async function verifyGoogleCredential(credential: string): Promise<GoogleTokenInfo> {
  const clientId = googleClientId();
  if (!clientId) {
    throw new HttpError(500, 'Server misconfiguration: GOOGLE_CLIENT_ID not set');
  }
  let response: Response;
  try {
    response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, {
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    logger.error('google_tokeninfo_unreachable', { error: (error as Error).message });
    throw new HttpError(502, "Couldn't reach Google to check the sign-in. Please try again.");
  }
  if (response.status !== 200) throw new HttpError(401, 'Invalid Google credential');
  const info = (await response.json()) as GoogleTokenInfo;
  if (info.aud !== clientId) {
    logger.warn('google_audience_mismatch', { expected: clientId, got: info.aud });
    throw new HttpError(401, 'Invalid token audience');
  }
  if (!info.sub) throw new HttpError(401, 'Invalid Google credential');
  return info;
}

export function registerAuthRoutes(router: Router): void {
  /** Public: which sign-in methods this deployment offers. */
  router.get('/api/auth/options', () => ({
    google: Boolean(googleClientId()),
    guest: allowGuestLogin(),
  }));

  router.post('/api/auth/google', async (ctx) => {
    await rateLimit('google', ctx.ip, 30, 600);
    const body = await ctx.json();
    const info = await verifyGoogleCredential(requireString(body, 'credential'));
    const userId = `user_${info.sub}`;
    const existing = await getUser(userId);
    const user: User = existing
      ? { ...existing, email: info.email ?? existing.email, name: info.name ?? existing.name, picture: info.picture ?? existing.picture }
      : {
          id: userId,
          google_id: info.sub as string,
          email: info.email ?? '',
          name: info.name ?? null,
          picture: info.picture ?? null,
          created_at: new Date().toISOString(),
          claude_api_key_set: false,
        };
    await saveUser(user);
    if (!existing) logger.info('user_created', { user_id: userId });
    const response: TokenResponse = {
      access_token: await issueToken(user.id),
      token_type: 'bearer',
      user: { ...user, claude_api_key_set: await hasApiKey(user.id) },
    };
    return response;
  });

  router.post('/api/auth/guest', async (ctx) => {
    if (!allowGuestLogin()) {
      throw new HttpError(403, 'Guest sign-in is turned off. Sign in with Google.');
    }
    await rateLimit('guest', ctx.ip, 20, 3600);
    const guestId = `guest_${crypto.randomBytes(6).toString('hex')}`;
    const user: User = {
      id: guestId,
      google_id: guestId,
      email: `${guestId}@guest.grantfinder`,
      name: 'Guest',
      picture: null,
      created_at: new Date().toISOString(),
      claude_api_key_set: false,
    };
    await saveUser(user);
    logger.info('guest_created', { user_id: guestId });
    const response: TokenResponse = { access_token: await issueToken(guestId), token_type: 'bearer', user };
    return response;
  });

  router.get('/api/auth/me', async (ctx) => ctx.user());

  router.post('/api/auth/api-key', async (ctx) => {
    const user = await ctx.user();
    const body = await ctx.json();
    const apiKey = String(body.api_key ?? '').trim();
    if (!apiKey.startsWith('sk-ant-')) {
      throw new HttpError(400, "Invalid API key format. Claude API keys start with 'sk-ant-'");
    }
    const check = await verifyApiKey(apiKey);
    if (check.result === 'invalid') throw new HttpError(400, check.detail || 'Anthropic rejected this API key.');
    await saveApiKey(user.id, apiKey);
    logger.info('api_key_saved', { user_id: user.id, verified: check.result === 'ok' });
    return {
      message: 'API key saved successfully',
      verified: check.result === 'ok',
      ...(check.result === 'unverified' ? { warning: "Saved, but Anthropic couldn't be reached to check it just now." } : {}),
    };
  });

  router.get('/api/auth/api-key/status', async (ctx) => {
    const user = await ctx.user();
    const isSet = await hasApiKey(user.id);
    return isSet ? { is_set: true, is_valid: true } : { is_set: false, is_valid: null };
  });

  router.delete('/api/auth/api-key', async (ctx) => {
    const user = await ctx.user();
    await deleteApiKey(user.id);
    logger.info('api_key_removed', { user_id: user.id });
    return { message: 'API key removed' };
  });
}
