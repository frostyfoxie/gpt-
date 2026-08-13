import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import { supabase } from './vfs-sync';

/**
 * Phase 6 — Supabase Auth (Google + GitHub OAuth).
 *
 * Thin wrapper over the single shared `supabase` client from vfs-sync.ts — this file creates
 * no client of its own, it only adds an auth-shaped surface on top of the existing one so the
 * rest of the app never touches `supabase.auth` directly.
 *
 * Scope of this phase (see index.ts / index.html wiring): gate the UI on session presence and
 * expose the signed-in user's id for later phases to key data off of. Project loading, the
 * VFSSynchronizer, and CommitManager are NOT wired to the user yet — that's the next phase —
 * so getCurrentUserId() exists but isn't consumed by those subsystems today.
 */

export type OAuthProvider = 'google' | 'github';

/**
 * Starts the Google OAuth flow. Supabase redirects the browser away to Google and back;
 * `redirectTo` sends the user back to this same app origin. Token exchange on the way back is
 * handled automatically by the Supabase client (detectSessionInUrl defaults to true) — nothing
 * else needs to run on redirect-back beyond having onAuthStateChange already subscribed.
 */
export async function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin },
  });
}

/**
 * Starts the GitHub OAuth flow. Same redirect-back handling as signInWithGoogle. Google and
 * GitHub both double as sign-up here — there's no separate signup form; Supabase creates the
 * auth.users row (and, via the Phase 1 migration's trigger, the mirrored public.profiles row)
 * automatically the first time a given provider identity signs in.
 */
export async function signInWithGithub() {
  return supabase.auth.signInWithOAuth({
    provider: 'github',
    options: { redirectTo: window.location.origin },
  });
}

/** Ends the current session. Triggers onAuthStateChange('SIGNED_OUT', null) for subscribers. */
export async function signOut() {
  return supabase.auth.signOut();
}

/** Reads the current session (if any) directly from the Supabase client. */
export async function getSession() {
  return supabase.auth.getSession();
}

/**
 * Thin wrapper over supabase.auth.onAuthStateChange so callers don't import supabase.auth
 * directly. Fires on sign-in, sign-out, token refresh, and — critically for this phase — on
 * the OAuth redirect-back, once the client has parsed the tokens out of the URL.
 *
 * Returns the subscription so the caller can unsubscribe() if it ever needs to.
 */
export function onAuthStateChange(
  callback: (event: AuthChangeEvent, session: Session | null) => void
) {
  return supabase.auth.onAuthStateChange(callback);
}

/**
 * Convenience helper for the many places that will eventually need to scope data to a single
 * user/project state where a signed-in project is required. Returns null when there's
 * no active session rather than throwing, since "not signed in" is an expected state pre-gate.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const {
    data: { session },
  } = await getSession();
  return session?.user?.id ?? null;
}

/** Returns the current Supabase access token for authenticated server-side tools. */
export async function getAccessToken(): Promise<string | null> {
  const { data: { session } } = await getSession();
  return session?.access_token ?? null;
}
