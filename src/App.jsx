import { useState, useEffect, createContext, useContext } from 'react'
import Auth from './Auth.jsx'
import Chat from './Chat.jsx'
import './App.css'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

const API = (path, opts = {}) => {
  const token = localStorage.getItem('token')
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
    const token = localStorage.getItem('token')
    if (!token) { setLoading(false); return }
    API('/api/auth/me')
      .then(u => setUser(u))
      .catch(() => localStorage.removeItem('token'))
      .finally(() => setLoading(false))
  }, [])

  const login = (token, userData) => {
    localStorage.setItem('token', token)
    setUser(userData)
  }

  const logout = () => {
    localStorage.removeItem('token')
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
