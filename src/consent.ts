// ── Layer: app · OAuth authorization UI ──────────────────────────────────────
// Supabase's OAuth server delegates the login + consent screen to the
// application: its dashboard "Authorization Path" must point at a page that
// authenticates the user and approves/denies the authorization request via
// supabase-js. This serves that page (framework-free, single HTML response) so
// no separate frontend deployment is needed. It is intentionally public — the
// user is mid-login here, so bearer auth cannot apply.
//
// Flow (per Supabase OAuth Server docs): the authorize endpoint redirects here
// with ?authorization_id=…; the page signs the user in (email+password),
// fetches the authorization details, and calls approve/deny, then follows the
// returned redirect back to the client (e.g. Claude).
export function consentPage(supabaseUrl: string, anonKey: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connexion — MOHEBS TLM</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f6f4; color: #1f2a2a; margin: 0;
         display: grid; place-items: center; min-height: 100vh; }
  .card { background: #fff; border: 1px solid #dde3dd; border-radius: 10px; padding: 2rem;
          width: min(92vw, 24rem); box-shadow: 0 1px 4px rgba(0,0,0,.06); }
  h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
  p  { font-size: .9rem; color: #5a6a68; margin: .25rem 0 1rem; }
  label { display: block; font-size: .8rem; font-weight: 600; margin: .75rem 0 .25rem; }
  input { width: 100%; box-sizing: border-box; padding: .55rem .7rem; border: 1px solid #c9d2c9;
          border-radius: 6px; font-size: .95rem; }
  button { width: 100%; margin-top: 1rem; padding: .6rem; border: 0; border-radius: 6px;
           font-size: .95rem; font-weight: 600; cursor: pointer; }
  .primary { background: #177245; color: #fff; }
  .secondary { background: #eef1ee; color: #1f2a2a; margin-top: .5rem; }
  .err { color: #a33; font-size: .85rem; margin-top: .75rem; min-height: 1.2em; }
  .hidden { display: none; }
  .app { font-weight: 700; }
</style>
</head>
<body>
<div class="card">
  <div id="login">
    <h1>Connexion</h1>
    <p>Connectez-vous avec le compte qui vous a été attribué. <br><small>Sign in with your assigned account.</small></p>
    <label for="email">Email</label>
    <input id="email" type="email" autocomplete="username">
    <label for="password">Mot de passe</label>
    <input id="password" type="password" autocomplete="current-password">
    <button class="primary" id="signin">Se connecter</button>
    <div class="err" id="login-err"></div>
  </div>
  <div id="consent" class="hidden">
    <h1>Autoriser l'accès&nbsp;?</h1>
    <p><span class="app" id="app-name">Une application</span> demande l'accès à votre compte MOHEBS TLM.</p>
    <button class="primary" id="approve">Autoriser</button>
    <button class="secondary" id="deny">Refuser</button>
    <div class="err" id="consent-err"></div>
  </div>
</div>
<script type="module">
  import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
  const supabase = createClient(${JSON.stringify(supabaseUrl)}, ${JSON.stringify(anonKey)});
  const qs = new URLSearchParams(location.search);
  const authorizationId = qs.get("authorization_id");
  const el = (id) => document.getElementById(id);
  const show = (id) => { el("login").classList.add("hidden"); el("consent").classList.add("hidden"); el(id).classList.remove("hidden"); };
  const follow = (data) => { const to = data?.redirect_to ?? data?.redirectTo; if (to) location.assign(to); };

  async function toConsent() {
    if (!authorizationId) { el("consent-err").textContent = "Lien invalide: authorization_id manquant."; show("consent"); return; }
    try {
      const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(authorizationId);
      if (error) throw error;
      el("app-name").textContent = data?.client?.client_name ?? data?.client_name ?? "Une application";
      show("consent");
    } catch (e) { el("consent-err").textContent = e.message ?? String(e); show("consent"); }
  }

  el("signin").addEventListener("click", async () => {
    el("login-err").textContent = "";
    const { error } = await supabase.auth.signInWithPassword({ email: el("email").value.trim(), password: el("password").value });
    if (error) { el("login-err").textContent = "Échec de la connexion : " + error.message; return; }
    await toConsent();
  });
  el("password").addEventListener("keydown", (e) => { if (e.key === "Enter") el("signin").click(); });

  el("approve").addEventListener("click", async () => {
    try {
      const { data, error } = await supabase.auth.oauth.approveAuthorization(authorizationId);
      if (error) throw error;
      follow(data);
    } catch (e) { el("consent-err").textContent = e.message ?? String(e); }
  });
  el("deny").addEventListener("click", async () => {
    try {
      const { data, error } = await supabase.auth.oauth.denyAuthorization(authorizationId);
      if (error) throw error;
      follow(data);
    } catch (e) { el("consent-err").textContent = e.message ?? String(e); }
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (session) await toConsent();
</script>
</body>
</html>`;
}
