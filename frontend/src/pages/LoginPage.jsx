import { useState } from "react";
import { Activity, ArrowRight, Fingerprint, GitBranch, ShieldCheck, Sparkles } from "lucide-react";
import { getApiError } from "../services/api";

export function LoginPage({ authEnabled = false, onLogin, onContinue, initialNotice = "" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialNotice);

  const submit = async event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onLogin({ email, password });
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return <div className="login-screen">
    <section className="login-story">
      <div className="login-brand"><div className="brand-mark"><Activity size={20}/></div><span>data<span className="brand-accent">lens</span></span></div>
      <div className="story-content">
        <div className="eyebrow light">● DATA QUALITY, IN FOCUS</div>
        <h1>Trust your data.<br/><span>See the whole picture.</span></h1>
        <p className="story-lead">One workspace to understand data health, uncover quality issues and map how your data connects.</p>
        <div className="story-preview">
          <div className="preview-top">QUALITY OVERVIEW <span>DATA WORKSPACE</span></div>
          <div className="preview-score"><div><small>OVERALL QUALITY</small><strong>—<span>/100</span></strong><em>Connected to your dataset</em></div><div className="preview-ring">DL</div></div>
          {["Schema intelligence","Quality monitoring","Grounded AI assistant"].map((name,index)=><div className="preview-bar" key={name}><span>{name}</span><i><b style={{width:(92-index*8)+"%"}}/></i><strong>Ready</strong></div>)}
        </div>
        <div className="story-foot"><span><ShieldCheck size={15}/> Server-side credentials</span><span><GitBranch size={15}/> Multi-table intelligence</span></div>
      </div>
      <div className="login-copyright">© 2026 DataLens · Data quality workspace</div>
    </section>
    <section className="login-panel">
      <div className="login-panel-inner">
        <div className="mobile-login-brand"><div className="brand-mark"><Activity size={18}/></div><span>data<span className="brand-accent">lens</span></span></div>
        <div className="login-icon"><Fingerprint size={23}/></div>
        <div className="eyebrow">WELCOME TO DATALENS</div>
        <h2>{authEnabled ? "Sign in to your workspace" : "Open the preview workspace"}</h2>
        <p className="login-subtitle">{authEnabled ? "Use the administrator credentials configured on your DataLens server." : "Authentication is disabled in this development environment."}</p>

        {authEnabled ? <form onSubmit={submit}>
          <label className="field-label" htmlFor="email">Administrator email</label>
          <input id="email" className="text-input" type="email" autoComplete="username" placeholder="admin@company.com" value={email} onChange={event=>setEmail(event.target.value)} required/>
          <label className="field-label login-password-label" htmlFor="password">Password</label>
          <input id="password" className="text-input" type="password" autoComplete="current-password" placeholder="Your administrator password" value={password} onChange={event=>setPassword(event.target.value)} required minLength={8}/>
          {error && <div className="inline-alert login-error" role="alert">{error}</div>}
          <button className="primary-button login-button" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in securely"} <ArrowRight size={17}/></button>
        </form> : <>
          {error && <div className="inline-alert login-error" role="alert">{error}</div>}
          <div className="preview-note"><Sparkles size={16}/><p>This is a local development preview. Enable server-side admin authentication before deploying DataLens publicly.</p></div>
          <button className="primary-button login-button" onClick={onContinue}>Continue to preview <ArrowRight size={17}/></button>
        </>}

        <div className="login-security"><ShieldCheck size={15}/> {authEnabled ? "Your session uses an HttpOnly, signed cookie." : "No password or API credential is collected in preview mode."}</div>
      </div>
      <div className="login-panel-footer">Need access? <a href="https://github.com/Pranav-078/DataLens" target="_blank" rel="noreferrer">View the project</a></div>
    </section>
  </div>;
}
