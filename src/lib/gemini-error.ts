/**
 * Detects Google's "ACCESS_TOKEN_TYPE_UNSUPPORTED" / "Expected OAuth 2 access token" 401
 * response and rewrites it into something a user can actually act on.
 *
 * This is NOT a bug in how Theta sends the key (the SDK client is always constructed as
 * `new GoogleGenAI({ apiKey })` with the exact string the user pasted in — see getClient()
 * in each engine/ui-adapter file). It's a known, ongoing issue on Google's side: AI Studio
 * has been issuing a new "Auth key" format (prefixed `AQ.` instead of the old `AIza...`
 * "Standard key" format) by default since mid-2026, and a subset of those AQ. keys are
 * being rejected by generativelanguage.googleapis.com with exactly this 401, independent of
 * the calling SDK/language and regardless of whether the key is sent via header or query
 * param. It's widely reported and still open on Google's AI Developer forum as of this
 * writing — nothing here can route around it from the client side.
 */
export function explainGeminiAuthError(error: unknown): string | null {
  const message = (error as any)?.message ? String((error as any).message) : String(error ?? '');
  const isTokenTypeError =
    /ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(message) ||
    (/401/.test(message) && /OAuth 2 access token/i.test(message));

  if (!isTokenTypeError) return null;

  return (
    "This key is being rejected by Google with a 401 \"Expected OAuth 2 access token\" " +
    "(ACCESS_TOKEN_TYPE_UNSUPPORTED) response. That's not a sign the key was entered wrong " +
    "— it's a known, currently-unresolved issue on Google's side affecting the new \"AQ.\"-" +
    "prefix Auth keys that Google AI Studio now issues by default in place of the old " +
    "\"AIza...\" Standard-key format. If the key you pasted starts with \"AQ.\", that's almost " +
    "certainly the cause; it's been reported repeatedly on the Google AI Developer forum with " +
    "no fix from Google yet. Two things worth trying: (1) in AI Studio, check whether an older " +
    "\"AIza...\" key is still available on this project and use that instead, or (2) regenerate " +
    "the key a couple of times — some accounts intermittently get an AIza key back. Otherwise " +
    "this needs to clear up on Google's end before the key will work here."
  );
}
