import { useState } from "react";
import {
  Activity, ArrowRight, Fingerprint, GitBranch, ShieldCheck, Sparkles,
  UserRound, Mail, LockKeyhole, CheckCircle2
} from "lucide-react";
import { getApiError } from "../services/api";

export function LoginPage({
  authEnabled = false,
  registrationAllowed = true,
  onLogin,
  onRegister,
  onContinue,
  initialNotice = ""
}) {
  const [mode, setMode] = useState("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialNotice);
  const [success, setSuccess] = useState("");

  const switchMode = next => {
    setMode(next);
    setPassword("");
    setConfirmPassword("");
    setError("");
    setSuccess("");
  };

  const submit = async event => {
    event.preventDefault();
    if (busy) return;

    if (mode === "signup" && password !== confirmPassword) {
      setError("Your passwords do not match. Please check and try again.");
      return;
    }
    if (mode === "signup" && password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }

    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (mode === "signup") {
        await onRegister({ name: name.trim(), email: email.trim(), password });
      } else {
        await onLogin({ email: email.trim(), password });
      }
    } catch (err) {
      setError(getApiError(err));
    } finally {
      setBusy(false);
    }
  };

  return <div className="login-screen auth-screen">
    <section className="login-story">
      <div className="login-brand"><div className="brand-mark"><Activity size={20}/></div><span>data<span className="brand-accent">lens</span></span></div>
      <div className="story-content">
        <div className="eyebrow light">● DATA QUALITY, IN FOCUS</div>
        <h1>Trust your data.<br/><span>See the whole picture.</span></h1>
        <p className="story-lead">One workspace to understand data health, uncover quality issues and map how your data connects.</p>
        <div className="story-preview">
          <div className="preview-top">QUALITY OVERVIEW <span>YOUR DATA WORKSPACE</span></div>
          <div className="preview-score"><div><small>OVERALL QUALITY</small><strong>—<span>/100</span></strong><em>Your workspace, at a glance</em></div><div className="preview-ring">DL</div></div>
          {["Schema intelligence","Quality monitoring","Grounded AI assistant"].map((label,index)=><div className="preview-bar" key={label}><span>{label}</span><i><b style={{width:(92-index*8)+"%"}}/></i><strong>Ready</strong></div>)}
        </div>
        <div className="story-foot"><span><ShieldCheck size={15}/> Secure account access</span><span><GitBranch size={15}/> Multi-table intelligence</span></div>
      </div>
      <div className="login-copyright">© 2026 DataLens · Data quality workspace</div>
    </section>

    <section className="login-panel">
      <div className="login-panel-inner auth-panel-inner">
        <div className="mobile-login-brand"><div className="brand-mark"><Activity size={18}/></div><span>data<span className="brand-accent">lens</span></span></div>
        <div className="login-icon"><Fingerprint size={23}/></div>
        <div className="eyebrow">{mode === "signup" ? "GET STARTED WITH DATALENS" : "WELCOME BACK TO DATALENS"}</div>
        <h2>{authEnabled ? (mode === "signup" ? "Create your account" : "Sign in to your workspace") : "Open the preview workspace"}</h2>
        <p className="login-subtitle">{authEnabled
          ? (mode === "signup" ? "Create your account and get a private workspace for your datasets." : "Sign in to continue working with your data.")
          : "Authentication is disabled in this development environment."}</p>

        {authEnabled ? <>
          {registrationAllowed && <div className="auth-mode-switch" role="tablist" aria-label="Account access">
            <button type="button" role="tab" aria-selected={mode === "signin"} className={mode === "signin" ? "active" : ""} onClick={() => switchMode("signin")}>Sign in</button>
            <button type="button" role="tab" aria-selected={mode === "signup"} className={mode === "signup" ? "active" : ""} onClick={() => switchMode("signup")}>Create account</button>
          </div>}

          <form onSubmit={submit} className="auth-form">
            {mode === "signup" && <>
              <label className="field-label" htmlFor="account-name">Full name</label>
              <div className="auth-input-wrap"><UserRound size={16}/><input id="account-name" className="text-input" type="text" autoComplete="name" placeholder="Enter your full name" value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={80}/></div>
            </>}
            <label className="field-label" htmlFor="account-email">Email address</label>
            <div className="auth-input-wrap"><Mail size={16}/><input id="account-email" className="text-input" type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={event => setEmail(event.target.value)} required maxLength={254}/></div>

            <div className="auth-password-label-row"><label className="field-label" htmlFor="account-password">Password</label>{mode === "signup" && <span>8 characters minimum</span>}</div>
            <div className="auth-input-wrap"><LockKeyhole size={16}/><input id="account-password" className="text-input" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} placeholder={mode === "signup" ? "Create a strong password" : "Enter your password"} value={password} onChange={event => setPassword(event.target.value)} required minLength={8} maxLength={128}/></div>

            {mode === "signup" && <>
              <label className="field-label auth-confirm-label" htmlFor="confirm-password">Confirm password</label>
              <div className="auth-input-wrap"><LockKeyhole size={16}/><input id="confirm-password" className="text-input" type="password" autoComplete="new-password" placeholder="Re-enter your password" value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} required minLength={8} maxLength={128}/></div>
            </>}

            {error && <div className="inline-alert login-error" role="alert">{error}</div>}
            {success && <div className="auth-success" role="status"><CheckCircle2 size={15}/>{success}</div>}
            <button className="primary-button login-button auth-submit" type="submit" disabled={busy}>
              {busy ? (mode === "signup" ? "Creating your account…" : "Signing in…") : (mode === "signup" ? "Create account" : "Sign in securely")}
              {!busy && <ArrowRight size={17}/>}
            </button>
          </form>
          {registrationAllowed && <div className="auth-switch-prompt">
            {mode === "signup" ? <>Already have an account? <button type="button" onClick={() => switchMode("signin")}>Sign in</button></> : <>New to DataLens? <button type="button" onClick={() => switchMode("signup")}>Create your account</button></>}
          </div>}
        </> : <>
          {error && <div className="inline-alert login-error" role="alert">{error}</div>}
          <div className="preview-note"><Sparkles size={16}/><p>This is a local development preview. Enable server-side authentication before deploying DataLens publicly.</p></div>
          <button className="primary-button login-button" onClick={onContinue}>Continue to preview <ArrowRight size={17}/></button>
        </>}

        <div className="login-security"><ShieldCheck size={15}/> Passwords are securely hashed. Sessions use HttpOnly cookies.</div>
      </div>
      <div className="login-panel-footer">Your data workspace, securely organized.</div>
    </section>
  </div>;
}
