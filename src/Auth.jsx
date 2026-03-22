import { useState } from 'react'
import { useAuth, API } from './App.jsx'
import { t } from './i18n.js'

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true)
  const [form, setForm] = useState({ username: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { login } = useAuth()

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register'
      const body = isLogin ? { email: form.email, password: form.password } : form
      const data = await API(endpoint, { method: 'POST', body: JSON.stringify(body) })
      login(data.token, data.user)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  const toggle = () => { setIsLogin(!isLogin); setError('') }

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
        <h2>{isLogin ? t('auth.welcome') : t('auth.createAccount')}</h2>
        <p className="auth-sub">{isLogin ? t('auth.welcomeSub') : t('auth.createAccountSub')}</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit}>
          {!isLogin && (
            <div className="field">
              <label>{t('auth.username')}</label>
              <input type="text" placeholder="your_name" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} required />
            </div>
          )}
          <div className="field">
            <label>{t('auth.email')}</label>
            <input type="email" placeholder="you@example.com" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required />
          </div>
          <div className="field">
            <label>{t('auth.password')}</label>
            <input type="password" placeholder="••••••••" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required />
          </div>
          <button type="submit" className="auth-btn" disabled={loading}>
            {loading ? <span className="btn-loader" /> : (isLogin ? t('auth.loginBtn') : t('auth.registerBtn'))}
          </button>
        </form>

        <p className="auth-toggle">
          {isLogin ? t('auth.noAccount') : t('auth.hasAccount')}
          <button onClick={toggle}>{isLogin ? t('auth.register') : t('auth.login')}</button>
        </p>
      </div>
    </div>
  )
}
