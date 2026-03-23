import { useState, useEffect, useCallback } from 'react'
import { useAuth, API } from './App.jsx'
import { t } from './i18n.js'

export default function Auth() {
  const [mode, setMode] = useState('login') // login, register, verify, forgot, reset
  const [form, setForm] = useState({ username: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [verifyCode, setVerifyCode] = useState('')
  const [verifyEmail, setVerifyEmail] = useState('')
  const [resetEmail, setResetEmail] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [captcha, setCaptcha] = useState(null)
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [successMsg, setSuccessMsg] = useState('')
  const [rememberMe, setRememberMe] = useState(false)
  const { login } = useAuth()

  const loadCaptcha = useCallback(async () => {
    try {
      const data = await API('/api/auth/captcha')
      setCaptcha(data)
      setCaptchaAnswer('')
    } catch {}
  }, [])

  useEffect(() => {
    if (mode === 'register') loadCaptcha()
  }, [mode, loadCaptcha])

  const handleLogin = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const data = await API('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: form.email, password: form.password }) })
      login(data.token, data.user, rememberMe)
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  const handleRegisterSendCode = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const data = await API('/api/auth/register/send-code', { method: 'POST', body: JSON.stringify({ ...form, captchaId: captcha?.captchaId, captchaAnswer: Number(captchaAnswer) }) })
      setVerifyEmail(form.email)
      if (data.code) setVerifyCode(data.code)
      setMode('verify')
    } catch (err) { setError(err.message); loadCaptcha() } finally { setLoading(false) }
  }

  const handleVerify = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const data = await API('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ email: verifyEmail, code: verifyCode }) })
      login(data.token, data.user, rememberMe)
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  const handleForgotSendCode = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      const data = await API('/api/auth/reset/send-code', { method: 'POST', body: JSON.stringify({ email: resetEmail }) })
      if (data.code) setResetCode(data.code)
      setMode('reset')
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  const handleResetPassword = async (e) => {
    e.preventDefault()
    setError(''); setLoading(true)
    try {
      await API('/api/auth/reset/verify', { method: 'POST', body: JSON.stringify({ email: resetEmail, code: resetCode, newPassword }) })
      setSuccessMsg(t('auth.passwordChanged'))
      setTimeout(() => { setMode('login'); setSuccessMsg('') }, 2000)
    } catch (err) { setError(err.message) } finally { setLoading(false) }
  }

  const EyeIcon = ({ show, onClick }) => (
    <button type="button" className="password-eye" onClick={onClick} tabIndex={-1}>
      {show ? (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      )}
    </button>
  )

  return (
    <div className="auth-page">
      <div className="auth-bg">
        {[...Array(5)].map((_, i) => <div key={i} className={`auth-orb orb-${i + 1}`} />)}
      </div>
      <div className="auth-card">
        <div className="auth-logo">
          <svg width="40" height="40" viewBox="0 0 100 100">
            <defs><linearGradient id="al" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#00d4aa"/><stop offset="100%" stopColor="#7c5cfc"/></linearGradient></defs>
            <circle cx="50" cy="50" r="45" fill="url(#al)"/>
            <path d="M50 20L50 55M50 55L35 70M50 55L65 70M50 35L35 50M50 35L65 50" stroke="white" strokeWidth="4" strokeLinecap="round" fill="none"/>
          </svg>
          <span>Branch</span>
        </div>

        {successMsg && <div className="auth-success">{successMsg}</div>}
        {error && <div className="auth-error">{error}</div>}

        {mode === 'login' && (
          <>
            <h2>{t('auth.welcome')}</h2>
            <p className="auth-sub">{t('auth.welcomeSub')}</p>
            <form onSubmit={handleLogin}>
              <div className="field">
                <label>{t('auth.email')}</label>
                <input type="email" placeholder="you@example.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div className="field">
                <label>{t('auth.password')}</label>
                <div className="password-field">
                  <input type={showPassword ? 'text' : 'password'} placeholder="••••••••" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
                  <EyeIcon show={showPassword} onClick={() => setShowPassword(!showPassword)} />
                </div>
              </div>
              <div className="auth-options-row">
                <label className="remember-me" onClick={() => setRememberMe(!rememberMe)}>
                  <div className={`remember-checkbox ${rememberMe ? 'checked' : ''}`}>
                    {rememberMe && <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M3 8l3.5 3.5L13 5" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  {t('auth.rememberMe')}
                </label>
                <button type="button" className="auth-forgot-link" onClick={() => { setMode('forgot'); setError('') }}>{t('auth.forgotPassword')}</button>
              </div>
              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? <span className="btn-loader" /> : t('auth.loginBtn')}
              </button>
            </form>
            <p className="auth-toggle">
              {t('auth.noAccount')}
              <button onClick={() => { setMode('register'); setError('') }}>{t('auth.register')}</button>
            </p>
          </>
        )}

        {mode === 'register' && (
          <>
            <h2>{t('auth.createAccount')}</h2>
            <p className="auth-sub">{t('auth.createAccountSub')}</p>
            <form onSubmit={handleRegisterSendCode}>
              <div className="field">
                <label>{t('auth.username')}</label>
                <input type="text" placeholder="your_name" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required />
              </div>
              <div className="field">
                <label>{t('auth.email')}</label>
                <input type="email" placeholder="you@example.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
              </div>
              <div className="field">
                <label>{t('auth.password')}</label>
                <div className="password-field">
                  <input type={showPassword ? 'text' : 'password'} placeholder="••••••••" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required minLength={6} />
                  <EyeIcon show={showPassword} onClick={() => setShowPassword(!showPassword)} />
                </div>
              </div>
              {captcha && (
                <div className="field captcha-field">
                  <label>{t('auth.captcha')} <span className="captcha-question">{captcha.question}</span></label>
                  <div className="captcha-row">
                    <input type="number" placeholder={t('auth.captchaAnswer')} value={captchaAnswer} onChange={e => setCaptchaAnswer(e.target.value)} required />
                    <button type="button" className="captcha-refresh" onClick={loadCaptcha} title={t('auth.captchaRefresh')}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
                    </button>
                  </div>
                </div>
              )}
              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? <span className="btn-loader" /> : t('auth.sendCode')}
              </button>
            </form>
            <p className="auth-toggle">
              {t('auth.hasAccount')}
              <button onClick={() => { setMode('login'); setError('') }}>{t('auth.login')}</button>
            </p>
          </>
        )}

        {mode === 'verify' && (
          <>
            <h2>{t('auth.verification')}</h2>
            <p className="auth-sub">{t('auth.verifyCodeMsg')} <strong>{verifyEmail}</strong></p>
            <form onSubmit={handleVerify}>
              <div className="field">
                <label>{t('auth.verifyCode')}</label>
                <input type="text" placeholder="000000" value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required maxLength={6} className="code-input" autoFocus />
              </div>
              <button type="submit" className="auth-btn" disabled={loading || verifyCode.length !== 6}>
                {loading ? <span className="btn-loader" /> : t('auth.confirm')}
              </button>
            </form>
            <p className="auth-toggle">
              <button onClick={() => { setMode('register'); setError('') }}>{t('auth.backToRegister')}</button>
            </p>
          </>
        )}

        {mode === 'forgot' && (
          <>
            <h2>{t('auth.resetPassword')}</h2>
            <p className="auth-sub">{t('auth.resetPasswordMsg')}</p>
            <form onSubmit={handleForgotSendCode}>
              <div className="field">
                <label>{t('auth.email')}</label>
                <input type="email" placeholder="you@example.com" value={resetEmail} onChange={e => setResetEmail(e.target.value)} required autoFocus />
              </div>
              <button type="submit" className="auth-btn" disabled={loading}>
                {loading ? <span className="btn-loader" /> : t('auth.sendCode')}
              </button>
            </form>
            <p className="auth-toggle">
              <button onClick={() => { setMode('login'); setError('') }}>{t('auth.backToLogin')}</button>
            </p>
          </>
        )}

        {mode === 'reset' && (
          <>
            <h2>{t('auth.newPassword')}</h2>
            <p className="auth-sub">{t('auth.newPasswordMsg')}</p>
            <form onSubmit={handleResetPassword}>
              <div className="field">
                <label>{t('auth.codeFromEmail')}</label>
                <input type="text" placeholder="000000" value={resetCode} onChange={e => setResetCode(e.target.value.replace(/\D/g, '').slice(0, 6))} required maxLength={6} className="code-input" autoFocus />
              </div>
              <div className="field">
                <label>{t('auth.newPassword')}</label>
                <div className="password-field">
                  <input type={showNewPassword ? 'text' : 'password'} placeholder="••••••••" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={6} />
                  <EyeIcon show={showNewPassword} onClick={() => setShowNewPassword(!showNewPassword)} />
                </div>
              </div>
              <button type="submit" className="auth-btn" disabled={loading || resetCode.length !== 6}>
                {loading ? <span className="btn-loader" /> : t('auth.setPassword')}
              </button>
            </form>
            <p className="auth-toggle">
              <button onClick={() => { setMode('login'); setError('') }}>{t('auth.backToLogin')}</button>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
