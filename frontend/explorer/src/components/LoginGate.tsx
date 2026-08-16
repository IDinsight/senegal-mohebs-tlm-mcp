import { useState } from "react";
import { makeT } from "../i18n";
import type { Lang } from "../types";

type Props = {
  lang: Lang;
  onSubmit: (email: string, password: string) => Promise<string | null>;
};

// Email/password gate shown when the server reports authRequired and there is no
// live Supabase session. On success the parent resumes the boot flow.
export function LoginGate({ lang, onSubmit }: Props) {
  const t = makeT(lang);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const attempt = async () => {
    setError("");
    setBusy(true);
    const err = await onSubmit(email, password);
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <div className="grid min-h-[70vh] place-items-center p-5">
      <div className="w-[min(92vw,24rem)] rounded-xl border border-line bg-panel p-[26px]">
        <h2 className="text-base font-semibold">{t("loginTitle")}</h2>
        <p className="mb-3.5 mt-1 text-[12.5px] text-muted">
          {lang === "fr" ? "Connectez-vous pour continuer." : "Sign in to continue."}
        </p>

        <label className="mb-1.5 mt-3 block text-[11px] font-semibold text-muted">
          Email
        </label>
        <input
          type="email"
          autoComplete="username"
          className="w-full rounded-md border border-line bg-panel2 px-[11px] py-[9px] text-sm text-txt"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label className="mb-1.5 mt-3 block text-[11px] font-semibold text-muted">
          {lang === "fr" ? "Mot de passe" : "Password"}
        </label>
        <input
          type="password"
          autoComplete="current-password"
          className="w-full rounded-md border border-line bg-panel2 px-[11px] py-[9px] text-sm text-txt"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void attempt();
          }}
        />

        <button
          className="mt-4 w-full rounded-md bg-accent px-3 py-2.5 text-sm font-semibold text-[#08130e] disabled:opacity-60"
          onClick={() => void attempt()}
          disabled={busy}
        >
          {t("signin")}
        </button>
        <div className="mt-2.5 min-h-[1.2em] text-xs text-err">{error}</div>
      </div>
    </div>
  );
}
