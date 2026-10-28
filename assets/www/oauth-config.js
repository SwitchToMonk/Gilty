/* ============================================================================
   Gitly website sign-in — helper configuration
   ============================================================================

   Why this file exists
   --------------------
   GitHub's token endpoint (github.com/login/oauth/access_token) sends no CORS
   headers, so a web page cannot swap the one-time code for a token by itself.
   The Android app avoids this with its native bridge; a website needs a tiny
   server-side helper instead.

   Deploy the Cloudflare Worker from the OAuth setup notes (it holds your
   CLIENT_ID, CLIENT_SECRET and ALLOWED_ORIGIN), then paste its URL below and
   re-upload this file. Nothing else changes.

   Leave `worker` empty and the website simply offers personal-access-token
   sign-in — the "Continue with GitHub" button stays hidden, exactly as before.

   Example:
     window.GITLY_OAUTH = {
       worker: 'https://gitly-oauth.your-name.workers.dev',
       clientId: 'Ov23liY2f5QBeO8CywWt',
       scopes: 'repo read:user notifications gist'
     };

   The helper must answer POST <worker>/token with {"code": "..."} and reply
   with {"access_token": "gho_..."} — that is what the oauth-worker.js in the
   setup notes already does.
   ========================================================================= */

window.GITLY_OAUTH = {
  worker: '',
  clientId: 'Ov23liY2f5QBeO8CywWt',
  scopes: 'repo read:user notifications gist'
};
