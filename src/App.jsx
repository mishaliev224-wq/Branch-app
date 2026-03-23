import { useState, useEffect, createContext, useContext } from 'react'
import Auth from './Auth.jsx'
import Chat from './Chat.jsx'
import './App.css'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

const getToken = () => localStorage.getItem('token') || sessionStorage.getItem('token')
const removeToken = () => { localStorage.removeItem('token'); sessionStorage.removeItem('token') }

const API = (path, opts = {}) => {
  const token = getToken()
  return fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...opts.headers },
  }).then(async r => {
    const data = await r.json()
    if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.data = data; throw e }
    return data
  })
}

export { API }

export default function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = getToken()
    if (!token) { setLoading(false); return }
    API('/api/auth/me')
      .then(u => setUser(u))
      .catch(() => removeToken())
      .finally(() => setLoading(false))
  }, [])

  const login = (token, userData, remember = false) => {
    if (remember) {
      localStorage.setItem('token', token)
    } else {
      sessionStorage.setItem('token', token)
    }
    setUser(userData)
  }

  const logout = () => {
    removeToken()
    setUser(null)
  }

  if (loading) return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-darkest)' }}>
      <div className="loader" />
    </div>
  )

  return (
    <AuthContext.Provider value={{ user, setUser, login, logout }}>
      {user ? <Chat /> : <Auth />}
    </AuthContext.Provider>
  )
}
