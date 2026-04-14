import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { io } from 'socket.io-client'
import { useAuth, API } from './App.jsx'
import { t, getLanguage, setLanguage as setLangStorage, setDynamicTranslations, getDynamicTranslations, getAllKeys, getAllValues, LANGUAGES } from './i18n.js'

const AImg = ({ src }) => src ? <img src={src} alt="" className="avatar-img-inner" /> : null

const BANNER_COLORS = [
  { name: 'Аметист',  value: '#7c5cfc' },
  { name: 'Сапфир',   value: '#3b82f6' },
  { name: 'Аква',     value: '#06b6d4' },
  { name: 'Изумруд',  value: '#10b981' },
  { name: 'Закат',    value: '#f59e0b' },
  { name: 'Коралл',   value: '#f43f5e' },
  { name: 'Малина',   value: '#ec4899' },
  { name: 'Ночь',     value: '#334155' },
]
const startCallRingtone = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return null
    const ctx = new Ctx()
    let active = true
    const scheduleBeeps = () => {
      if (!active) return
      const now = ctx.currentTime
      for (let i = 0; i < 2; i++) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.frequency.value = i === 0 ? 480 : 440
        const s = now + i * 0.55
        gain.gain.setValueAtTime(0, s)
        gain.gain.linearRampToValueAtTime(0.18, s + 0.05)
        gain.gain.linearRampToValueAtTime(0, s + 0.45)
        osc.start(s); osc.stop(s + 0.5)
      }
      setTimeout(scheduleBeeps, 2200)
    }
    scheduleBeeps()
    return { stop: () => { active = false; ctx.close().catch(() => {}) } }
  } catch { return null }
}

const bannerGradient = (color) =>
  color ? `linear-gradient(135deg, ${color}ee 0%, ${color}88 100%)` : 'linear-gradient(135deg, #2a2a3a 0%, #1a1a2a 100%)'

// Returns emoji count if text is ONLY 1-3 emojis, otherwise 0
const emojiOnlyCount = (text) => {
  if (!text) return 0
  const re = /\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}])?(?:\u200D\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}])?)*\uFE0F?/gu
  const stripped = text.replace(re, '').trim()
  if (stripped.length > 0) return 0
  const matches = text.match(re)
  const count = matches ? matches.length : 0
  return count >= 1 && count <= 3 ? count : 0
}

// Render message content with markdown + clickable links
const renderContent = (text, customEmojis = []) => {
  if (!text) return null
  const lines = text.split('\n')
  const result = []

  // Process inline markdown in a segment (no newlines)
  const parseInline = (str, key) => {
    // Tokenize: URLs first, then markdown, then custom emojis :name:
    const tokens = []
    let last = 0
    const re = /https?:\/\/[^\s<>"')\]]+|\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|_(.+?)_|~~(.+?)~~|`([^`]+)`|\|\|(.+?)\|\||:([a-zA-Z0-9_]{2,32}):/g
    let m
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) tokens.push({ type: 'text', value: str.slice(last, m.index) })
      if (m[0].startsWith('http')) {
        tokens.push({ type: 'url', value: m[0] })
      } else if (m[1] !== undefined) tokens.push({ type: 'bold', value: m[1] })
      else if (m[2] !== undefined) tokens.push({ type: 'italic', value: m[2] })
      else if (m[3] !== undefined) tokens.push({ type: 'bold', value: m[3] })
      else if (m[4] !== undefined) tokens.push({ type: 'italic', value: m[4] })
      else if (m[5] !== undefined) tokens.push({ type: 'strike', value: m[5] })
      else if (m[6] !== undefined) tokens.push({ type: 'code', value: m[6] })
      else if (m[7] !== undefined) tokens.push({ type: 'spoiler', value: m[7] })
      else if (m[8] !== undefined) tokens.push({ type: 'custom-emoji', value: m[8] })
      last = m.index + m[0].length
    }
    if (last < str.length) tokens.push({ type: 'text', value: str.slice(last) })

    return tokens.map((tok, i) => {
      const k = `${key}-${i}`
      if (tok.type === 'url') {
        const display = tok.value.length > 60 ? tok.value.slice(0, 57) + '…' : tok.value
        return <a key={k} href={tok.value} target="_blank" rel="noopener noreferrer" className="msg-link">{display}</a>
      }
      if (tok.type === 'bold') return <strong key={k}>{tok.value}</strong>
      if (tok.type === 'italic') return <em key={k}>{tok.value}</em>
      if (tok.type === 'strike') return <s key={k}>{tok.value}</s>
      if (tok.type === 'code') return <code key={k} className="msg-code-inline">{tok.value}</code>
      if (tok.type === 'spoiler') return <span key={k} className="msg-spoiler">{tok.value}</span>
      if (tok.type === 'custom-emoji') {
        const ce = customEmojis.find(e => e.name === tok.value)
        if (ce) return <img key={k} src={ce.url} alt={`:${ce.name}:`} title={`:${ce.name}:`} className="msg-custom-emoji" />
        return `:${tok.value}:`
      }
      return tok.value
    })
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Code block ```
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim()
      const codeLines = []
      i++
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i])
        i++
      }
      result.push(<pre key={i} className="msg-code-block"><code>{codeLines.join('\n')}</code></pre>)
      i++
      continue
    }
    // Quote >
    if (line.startsWith('> ')) {
      result.push(<blockquote key={i} className="msg-blockquote">{parseInline(line.slice(2), i)}</blockquote>)
      i++; continue
    }
    // Heading # ## ###
    const hm = line.match(/^(#{1,3})\s(.+)/)
    if (hm) {
      const level = hm[1].length
      const Tag = `h${level + 3}` // h4, h5, h6
      result.push(<Tag key={i} className={`msg-heading msg-h${level}`}>{parseInline(hm[2], i)}</Tag>)
      i++; continue
    }
    // Normal line
    result.push(<span key={i}>{parseInline(line, i)}{i < lines.length - 1 && <br/>}</span>)
    i++
  }
  return result
}

const ACCENT_COLORS = [
  { name: 'green', value: '#00d4aa' },
  { name: 'purple', value: '#7c5cfc' },
  { name: 'blue', value: '#5865f2' },
  { name: 'pink', value: '#ff6b9d' },
  { name: 'red', value: '#f04747' },
  { name: 'orange', value: '#faa61a' },
  { name: 'yellow', value: '#f0b232' },
  { name: 'cyan', value: '#00bcd4' },
  { name: 'teal', value: '#009688' },
]

const applyAccentColor = (color) => {
  const r = parseInt(color.slice(1,3),16), g = parseInt(color.slice(3,5),16), b = parseInt(color.slice(5,7),16)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  document.documentElement.style.setProperty('--primary', color)
  document.documentElement.style.setProperty('--primary-dim', `rgba(${r},${g},${b},0.15)`)
  document.documentElement.style.setProperty('--primary-glow', `rgba(${r},${g},${b},0.3)`)
  document.documentElement.style.setProperty('--primary-subtle', `rgba(${r},${g},${b},0.05)`)
  document.documentElement.style.setProperty('--primary-glow-deep', `rgba(${r},${g},${b},0.18)`)
  document.documentElement.style.setProperty('--primary-text', luminance > 0.5 ? '#000' : '#fff')
}

const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme)
}

// Initialize theme/accent from localStorage
;(() => {
  const theme = localStorage.getItem('appTheme') || 'dark'
  applyTheme(theme)
  const accent = localStorage.getItem('appAccent')
  applyAccentColor(accent || '#7c5cfc')
})()

const statusLabel = (s) => {
  const map = { online: 'status.online', idle: 'status.idle', dnd: 'status.dnd', invisible: 'status.invisible', offline: 'status.offline' }
  return t(map[s] || 'status.online')
}

// ── Audio Waveform Player ──
const WAVE_BARS = 60
const BAR_WIDTH = 3
const BAR_GAP = 2

function AudioWavePlayer({ src, fileName, fileSize }) {
  const audioRef = useRef(null)
  const [peaks, setPeaks] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [dragging, setDragging] = useState(false)
  const waveRef = useRef(null)
  const rafRef = useRef(null)
  const draggingRef = useRef(false)

  // Decode audio to extract waveform peaks
  useEffect(() => {
    let cancelled = false
    fetch(src)
      .then(r => r.arrayBuffer())
      .then(buf => {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        return ctx.decodeAudioData(buf).finally(() => ctx.close())
      })
      .then(decoded => {
        if (cancelled) return
        const raw = decoded.getChannelData(0)
        const step = Math.floor(raw.length / WAVE_BARS)
        const bars = []
        for (let i = 0; i < WAVE_BARS; i++) {
          let sum = 0
          for (let j = 0; j < step; j++) sum += Math.abs(raw[i * step + j])
          bars.push(sum / step)
        }
        const max = Math.max(...bars, 0.01)
        setPeaks(bars.map(v => v / max))
      })
      .catch(() => {
        if (!cancelled) setPeaks(Array(WAVE_BARS).fill(0.3))
      })
    return () => { cancelled = true }
  }, [src])

  const updateProgress = useCallback(() => {
    const a = audioRef.current
    if (!a || draggingRef.current) return
    setCurrentTime(a.currentTime)
    setProgress(a.duration ? a.currentTime / a.duration : 0)
    if (!a.paused) rafRef.current = requestAnimationFrame(updateProgress)
  }, [])

  const togglePlay = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) {
      a.play()
      setPlaying(true)
      rafRef.current = requestAnimationFrame(updateProgress)
    } else {
      a.pause()
      setPlaying(false)
      cancelAnimationFrame(rafRef.current)
    }
  }

  const getRatio = (clientX) => {
    const wave = waveRef.current
    if (!wave) return 0
    const rect = wave.getBoundingClientRect()
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  const seekTo = (ratio) => {
    const a = audioRef.current
    if (!a || !a.duration) return
    a.currentTime = ratio * a.duration
    setCurrentTime(a.currentTime)
    setProgress(ratio)
  }

  const handlePointerDown = (e) => {
    e.preventDefault()
    draggingRef.current = true
    setDragging(true)
    const ratio = getRatio(e.clientX)
    setProgress(ratio)
    setCurrentTime((audioRef.current?.duration || 0) * ratio)
    waveRef.current?.setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e) => {
    if (!draggingRef.current) return
    const ratio = getRatio(e.clientX)
    setProgress(ratio)
    setCurrentTime((audioRef.current?.duration || 0) * ratio)
  }

  const handlePointerUp = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    const ratio = getRatio(e.clientX)
    seekTo(ratio)
    if (playing) rafRef.current = requestAnimationFrame(updateProgress)
  }

  const handleLoaded = () => {
    const a = audioRef.current
    if (a) setDuration(a.duration)
  }

  const handleEnded = () => {
    setPlaying(false)
    setProgress(0)
    setCurrentTime(0)
    cancelAnimationFrame(rafRef.current)
  }

  const fmtTime = (s) => {
    if (!s || !isFinite(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return m + ':' + String(sec).padStart(2, '0')
  }

  const waveWidth = WAVE_BARS * (BAR_WIDTH + BAR_GAP) - BAR_GAP
  const progressPx = progress * waveWidth

  return (
    <div className="wave-player">
      <audio ref={audioRef} src={src} preload="metadata" onLoadedMetadata={handleLoaded} onEnded={handleEnded} />
      <button className="wave-play-btn" onClick={togglePlay}>
        {playing ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        )}
      </button>
      <div className="wave-body">
        <div className="wave-info">
          <span className="wave-name">{fileName}</span>
          <span className="wave-time">{fmtTime(currentTime)} / {fmtTime(duration)}</span>
        </div>
        <div
          className={`wave-bars ${dragging ? 'dragging' : ''}`}
          ref={waveRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          style={{ width: waveWidth }}
        >
          {peaks ? peaks.map((p, i) => {
            const barLeft = i * (BAR_WIDTH + BAR_GAP)
            const barRight = barLeft + BAR_WIDTH
            // Smooth fill: fully filled, partially filled, or unfilled
            let fill = 0
            if (progressPx >= barRight) fill = 1
            else if (progressPx > barLeft) fill = (progressPx - barLeft) / BAR_WIDTH
            const h = Math.max(4, Math.round(p * 28))
            return (
              <div
                key={i}
                className="wave-bar"
                style={{
                  height: h,
                  width: BAR_WIDTH,
                  marginRight: i < WAVE_BARS - 1 ? BAR_GAP : 0,
                  background: fill >= 1
                    ? 'var(--primary)'
                    : fill > 0
                      ? `linear-gradient(to right, var(--primary) ${fill * 100}%, var(--border-light) ${fill * 100}%)`
                      : 'var(--border-light)',
                }}
              />
            )
          }) : (
            <div className="wave-loading">Loading waveform...</div>
          )}
        </div>
      </div>
    </div>
  )
}

function LightboxVideoPlayer({ src, onPrev, onNext, hasPrev, hasNext, counter, fileName }) {
  const videoRef = useRef(null)
  const wrapRef = useRef(null)
  const hideTimer = useRef(null)
  const [playing, setPlaying] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [buffered, setBuffered] = useState(0)
  const [draggingSeek, setDraggingSeek] = useState(false)
  const [draggingVol, setDraggingVol] = useState(false)
  const progressRef = useRef(null)
  const volBarRef = useRef(null)

  const scheduleHide = () => {
    clearTimeout(hideTimer.current)
    setShowControls(true)
    hideTimer.current = setTimeout(() => { if (playing) setShowControls(false) }, 3000)
  }

  useEffect(() => {
    scheduleHide()
    return () => clearTimeout(hideTimer.current)
  }, [playing])

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onTime = () => { if (!progressRef.current?._dragging) setCurrentTime(v.currentTime) }
    const onDur = () => setDuration(v.duration)
    const onEnd = () => setPlaying(false)
    const onProgress = () => { if (v.buffered.length > 0) setBuffered(v.buffered.end(v.buffered.length - 1)) }
    v.addEventListener('timeupdate', onTime)
    v.addEventListener('loadedmetadata', onDur)
    v.addEventListener('ended', onEnd)
    v.addEventListener('progress', onProgress)
    return () => { v.removeEventListener('timeupdate', onTime); v.removeEventListener('loadedmetadata', onDur); v.removeEventListener('ended', onEnd); v.removeEventListener('progress', onProgress) }
  }, [src])

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) { v.play(); setPlaying(true) } else { v.pause(); setPlaying(false) }
  }

  const seekPct = (clientX) => {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }

  const onSeekDown = (e) => {
    e.preventDefault()
    setDraggingSeek(true)
    if (progressRef.current) progressRef.current._dragging = true
    const pct = seekPct(e.clientX)
    setCurrentTime(pct * duration)
    videoRef.current.currentTime = pct * duration
  }

  useEffect(() => {
    if (!draggingSeek) return
    const onMove = (e) => {
      const pct = seekPct(e.clientX)
      setCurrentTime(pct * duration)
    }
    const onUp = (e) => {
      const pct = seekPct(e.clientX)
      videoRef.current.currentTime = pct * duration
      setDraggingSeek(false)
      if (progressRef.current) progressRef.current._dragging = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [draggingSeek, duration])

  const volAt = (clientX) => {
    const rect = volBarRef.current?.getBoundingClientRect()
    if (!rect) return
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    videoRef.current.volume = pct
    setVolume(pct)
    setMuted(pct === 0)
  }

  const onVolDown = (e) => {
    e.preventDefault()
    setDraggingVol(true)
    volAt(e.clientX)
  }

  useEffect(() => {
    if (!draggingVol) return
    const onMove = (e) => volAt(e.clientX)
    const onUp = () => setDraggingVol(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [draggingVol])

  const toggleMute = () => {
    const v = videoRef.current
    v.muted = !v.muted
    setMuted(v.muted)
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else wrapRef.current?.requestFullscreen()
  }

  const fmt = (s) => {
    if (!s || isNaN(s)) return '0:00'
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return m + ':' + (sec < 10 ? '0' : '') + sec
  }

  return (
    <div ref={wrapRef} className={`vp-wrap ${isFullscreen ? 'vp-fullscreen' : ''}`} onMouseMove={scheduleHide} onClick={e => e.stopPropagation()}>
      <video ref={videoRef} src={src} className="vp-video" autoPlay onClick={togglePlay} />
      {!playing && !showControls && (
        <div className="vp-big-play" onClick={togglePlay}>
          <svg width="64" height="64" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21"/></svg>
        </div>
      )}
      <div className={`vp-controls ${showControls ? 'visible' : ''}`}>
        <div className={`vp-progress ${draggingSeek ? 'dragging' : ''}`} ref={progressRef} onMouseDown={onSeekDown}>
          <div className="vp-progress-buffered" style={{ width: duration ? (buffered / duration * 100) + '%' : 0 }} />
          <div className="vp-progress-fill" style={{ width: duration ? (currentTime / duration * 100) + '%' : 0 }} />
          <div className="vp-progress-thumb" style={{ left: duration ? (currentTime / duration * 100) + '%' : 0 }} />
        </div>
        <div className="vp-controls-row">
          <div className="vp-left">
            {hasPrev && <button className="vp-btn" onClick={onPrev}><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg></button>}
            <button className="vp-btn vp-play-btn" onClick={togglePlay}>
              {playing ? (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21"/></svg>
              )}
            </button>
            {hasNext && <button className="vp-btn" onClick={onNext}><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16 18h2V6h-2zm-3.5-6L4 6v12z" transform="rotate(180 12 12)"/></svg></button>}
            <div className="vp-volume-group">
              <button className="vp-btn" onClick={toggleMute}>
                {muted || volume === 0 ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                ) : volume < 0.5 ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM5 9v6h4l5 5V4L9 9H5z"/></svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                )}
              </button>
              <div className="vp-volume-bar" ref={volBarRef} onMouseDown={onVolDown}>
                <div className="vp-volume-fill" style={{ width: (muted ? 0 : volume * 100) + '%' }} />
              </div>
            </div>
            <span className="vp-time">{fmt(currentTime)} / {fmt(duration)}</span>
          </div>
          <div className="vp-right">
            {counter && <span className="vp-counter">{counter}</span>}
            <button className="vp-btn" onClick={toggleFullscreen}>
              {isFullscreen ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

let socket = null

export default function Chat() {
  const { user, setUser, logout } = useAuth()
  const [showTermsPopup, setShowTermsPopup] = useState(false)
  useEffect(() => { if (user && !user.agreedToTerms) setShowTermsPopup(true) }, [user?.agreedToTerms])
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [servers, setServers] = useState([])
  const [activeServer, setActiveServer] = useState(null)
  const [channels, setChannels] = useState([])
  const [activeChannel, setActiveChannel] = useState(null)
  const [messages, setMessages] = useState([])
  const [members, setMembers] = useState([])
  // Central profile store: { [userId]: { avatar, avatarColor, avatarFrame, statusEmoji, username, tag, status, bio, ... } }
  // All renders read from here — single source of truth, survives message reloads
  const [userProfiles, setUserProfiles] = useState({})
  const [input, setInput] = useState('')
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [emojiSearch, setEmojiSearch] = useState('')
  const [emojiCategory, setEmojiCategory] = useState('smileys')
  const [serverCustomEmojis, setServerCustomEmojis] = useState([]) // custom emojis for active server
  const [serverSettingsEmojis, setServerSettingsEmojis] = useState([]) // for settings panel
  const [emojiUploadName, setEmojiUploadName] = useState('')
  const [emojiUploading, setEmojiUploading] = useState(false)
  const emojiUploadRef = useRef(null)
  const emojiPickerRef = useRef(null)
  const [showGifPicker, setShowGifPicker] = useState(false)
  const [gifSearch, setGifSearch] = useState('')
  const [gifResults, setGifResults] = useState([])
  const [gifLoading, setGifLoading] = useState(false)
  const gifPickerRef = useRef(null)
  const gifSearchTimer = useRef(null)
  const [hoveredMsg, setHoveredMsg] = useState(null)
  const [reactionPickerMsg, setReactionPickerMsg] = useState(null) // { id, isDM, x, y }
  const [reactionSearch, setReactionSearch] = useState('')
  const [reactionCategory, setReactionCategory] = useState('smileys')
  const reactionPickerRef = useRef(null)
  const [reactionUsersPopup, setReactionUsersPopup] = useState(null) // { emoji, users: [{id,username,avatarColor}], x, y }
  const [showCreateServer, setShowCreateServer] = useState(false)
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [channelsCollapsed, setChannelsCollapsed] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [serverSettingsName, setServerSettingsName] = useState('')
  const [serverSettingsTab, setServerSettingsTab] = useState('general')
  const [memberSearchQuery, setMemberSearchQuery] = useState('')
  const [editingRole, setEditingRole] = useState(null) // { id?, name, permissions, color } for create/edit
  const [roleAssignMember, setRoleAssignMember] = useState(null) // member being assigned a role
  const [srvMemberSearch, setSrvMemberSearch] = useState('')
  const [showChannelSettings, setShowChannelSettings] = useState(null)
  const [channelSettingsName, setChannelSettingsName] = useState('')
  const [channelSettingsTab, setChannelSettingsTab] = useState('general') // general, permissions, slowmode
  const [chPrivate, setChPrivate] = useState(false)
  const [chAllowedUsers, setChAllowedUsers] = useState([])
  const [chPermissions, setChPermissions] = useState({ user: { invite: true, sendMessages: true, sendMedia: true, viewChannel: true }, admin: { invite: true, sendMessages: true, sendMedia: true, viewChannel: true } })
  const [chSlowmode, setChSlowmode] = useState(0)
  const [channelMenu, setChannelMenu] = useState(null) // { channel, x, y }
  const [channelMuteSub, setChannelMuteSub] = useState(false)
  const channelMenuRef = useRef(null)
  const [mutedChannels, setMutedChannels] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('mutedChannels') || '{}')
      const now = Date.now()
      const cleaned = {}
      for (const [k, v] of Object.entries(stored)) { if (v > now) cleaned[k] = v }
      return cleaned
    } catch { return {} }
  })
  const [slowmodeError, setSlowmodeError] = useState(null)
  const [newServerName, setNewServerName] = useState('')
  const [newChannelName, setNewChannelName] = useState('')
  const [typingUsers, setTypingUsers] = useState([])
  const [showMembers, setShowMembers] = useState(true)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showProfileSettings, setShowProfileSettings] = useState(false)
  const [showShop, setShowShop] = useState(false)
  const [themePremiumPrompt, setThemePremiumPrompt] = useState(false)
  const [shopTab, setShopTab] = useState('subscription') // 'subscription' | 'boosts'
  const [premiumStatus, setPremiumStatus] = useState(null) // { premium, premiumExpiry, boostCredits, boostedServers, active }
  const [boostData, setBoostData] = useState(null) // { total, used, free, boostedServers }
  const [shopLoading, setShopLoading] = useState(false)
  const [settingsTab, setSettingsTab] = useState('profile') // profile, app, privacy
  const [privacyDeleteConfirm, setPrivacyDeleteConfirm] = useState(false)
  const [privacyDeleteText, setPrivacyDeleteText] = useState('')
  const [privacyDeleting, setPrivacyDeleting] = useState(false)
  const [profileForm, setProfileForm] = useState({ username: '', bio: '', bannerColor: null, bannerImg: null, statusEmoji: null, avatarFrame: null })
  const [showEmojiPickerProfile, setShowEmojiPickerProfile] = useState(false)
  const avatarInputRef = useRef(null)
  const bannerInputRef = useRef(null)
  const [avatarCropModal, setAvatarCropModal] = useState(null) // { imgSrc, imgEl }
  const [cropScale, setCropScale] = useState(1)
  const [cropOffset, setCropOffset] = useState({ x: 0, y: 0 })
  const cropDrag = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 })
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [bannerCropModal, setBannerCropModal] = useState(null) // { imgSrc, imgEl }
  const [bannerCropScale, setBannerCropScale] = useState(1)
  const [bannerCropOffset, setBannerCropOffset] = useState({ x: 0, y: 0 })
  const bannerCropDrag = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 })
  const [bannerUploading, setBannerUploading] = useState(false)
  const [showBannerOptions, setShowBannerOptions] = useState(false)
  const [showBannerGifPicker, setShowBannerGifPicker] = useState(false)
  const [bannerGifSearch, setBannerGifSearch] = useState('')
  const [bannerGifResults, setBannerGifResults] = useState([])
  const [bannerGifLoading, setBannerGifLoading] = useState(false)
  const bannerGifSearchTimer = useRef(null)
  const [serverAvatarCropModal, setServerAvatarCropModal] = useState(null)
  const [serverCropScale, setServerCropScale] = useState(1)
  const [serverCropOffset, setServerCropOffset] = useState({ x: 0, y: 0 })
  const serverCropDrag = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 })
  const [serverAvatarUploading, setServerAvatarUploading] = useState(false)
  const [serverLayout, setServerLayout] = useState(() => {
    try { const s = localStorage.getItem('serverLayout'); if (s) return JSON.parse(s) } catch {}
    return null
  })
  const [expandedFolders, setExpandedFolders] = useState(new Set())
  const [srvDragState, setSrvDragState] = useState(null) // { id } | null
  const [srvDragPos, setSrvDragPos] = useState({ x: 0, y: 0 })
  const [srvDropTarget, setSrvDropTarget] = useState(null)
  const srvDragRef = useRef({ active: false, moved: false, id: null, startY: 0, dropTarget: null })
  const srvItemRefs = useRef({})
  const effectiveLayoutRef = useRef([])
  const [profileSaving, setProfileSaving] = useState(false)
  const [profileError, setProfileError] = useState('')
  const [appLang, setAppLang] = useState(getLanguage)
  const [langLoading, setLangLoading] = useState(false)
  const [appTheme, setAppTheme] = useState(() => localStorage.getItem('appTheme') || 'dark')
  const [appAccent, setAppAccent] = useState(() => localStorage.getItem('appAccent') || '#7c5cfc')
  const [timeFormat, setTimeFormat] = useState(() => localStorage.getItem('appTimeFormat') || '24')
  const [streamerMode, setStreamerMode] = useState(() => localStorage.getItem('streamerMode') === 'true')
  const [, forceUpdate] = useState(0)
  // Restore cached dynamic translations on mount
  useEffect(() => {
    const lang = getLanguage()
    const BUILTIN = ['ru', 'en', 'zh']
    if (!BUILTIN.includes(lang)) {
      const cached = localStorage.getItem(`i18n_cache_${lang}`)
      if (cached) { try { setDynamicTranslations(lang, JSON.parse(cached)); forceUpdate(n => n + 1) } catch {} }
    }
  }, [])
  const [showFriends, setShowFriends] = useState(true)
  const [mobileNav, setMobileNav] = useState(false) // mobile sidebar open
  const [mobileInChat, setMobileInChat] = useState(false) // mobile: full-screen chat view
  const [mobileTab, setMobileTab] = useState('home') // home, servers, notifications, profile
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
  const [friendsTab, setFriendsTab] = useState('all')
  const [friendsSearch, setFriendsSearch] = useState('')
  const [friends, setFriends] = useState([])
  const [friendRequests, setFriendRequests] = useState([])
  const [sentFriendRequests, setSentFriendRequests] = useState(new Map()) // userId -> requestId
  const [outgoingRequests, setOutgoingRequests] = useState([]) // full outgoing request objects
  const [friendSearch, setFriendSearch] = useState('')
  const [friendTag, setFriendTag] = useState('')
  const friendTagRef = useRef(null)
  const [friendSearchResult, setFriendSearchResult] = useState(null)
  const [friendSearchError, setFriendSearchError] = useState('')
  const [friendSearching, setFriendSearching] = useState(false)
  const [showUploadDialog, setShowUploadDialog] = useState(false)
  const [uploadFileObj, setUploadFileObj] = useState(null)
  const [uploadPreview, setUploadPreview] = useState(null)
  const [uploadSendAs, setUploadSendAs] = useState('file')
  const [uploading, setUploading] = useState(false)
  const [uploadComment, setUploadComment] = useState('')
  const [lightboxIndex, setLightboxIndex] = useState(-1)
  const messagesEndRef = useRef(null)
  const messagesAreaRef = useRef(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const typingTimeout = useRef(null)
  const typingTimers = useRef({})
  const userPopupRef = useRef(null)
  const fileInputRef = useRef(null)
  const [showAttachMenu, setShowAttachMenu] = useState(false)
  const attachMenuRef = useRef(null)
  const attachBtnRef = useRef(null)
  const [dmChannels, setDmChannels] = useState([])
  const [activeDM, setActiveDM] = useState(null)
  const [dmMessages, setDmMessages] = useState([])
  const [dmCtx, setDmCtx] = useState(null) // { dm, x, y }
  const [dmSearchQuery, setDmSearchQuery] = useState('')
  const [dmSearchResults, setDmSearchResults] = useState(null) // null = no search, [] = searching
  const dmSearchTimer = useRef(null)
  const [dmSearchExpanded, setDmSearchExpanded] = useState(null) // dmId of expanded result
  const dmCtxRef = useRef(null)
  const [dmMuteSub, setDmMuteSub] = useState(false)
  const [dmDeleteSub, setDmDeleteSub] = useState(false)
  const [dmClearSub, setDmClearSub] = useState(false)
  const [blockedUsers, setBlockedUsers] = useState([])
  const [blockedUsersDetails, setBlockedUsersDetails] = useState([])
  const [blockedByPartner, setBlockedByPartner] = useState(false)
  const [userProfilePopup, setUserProfilePopup] = useState(null) // { user, x, y }
  const userProfileRef = useRef(null)
  const [serverCtx, setServerCtx] = useState(null)
  const serverCtxRef = useRef(null)
  const [folderCtx, setFolderCtx] = useState(null) // { x, y, folder }
  const folderCtxRef = useRef(null)
  const [folderSettings, setFolderSettings] = useState(null) // { folder } editing state
  const [folderSettingsName, setFolderSettingsName] = useState('')
  const [folderSettingsColor, setFolderSettingsColor] = useState('')
  const [confirmDialog, setConfirmDialog] = useState(null)
  const [showServerMenu, setShowServerMenu] = useState(false)
  const serverMenuRef = useRef(null)
  const [showInviteModal, setShowInviteModal] = useState(null) // { serverId, serverName }
  const [showVoiceInviteModal, setShowVoiceInviteModal] = useState(null) // { channelId, channelName }
  const [voiceInviteSending, setVoiceInviteSending] = useState({})
  const [inviteSending, setInviteSending] = useState({})
  const [msgCtx, setMsgCtx] = useState(null) // { msg, x, y, isDM }
  const [memberCtx, setMemberCtx] = useState(null) // { member, x, y }
  const [selectMode, setSelectMode] = useState(false)
  const [selectedMsgs, setSelectedMsgs] = useState(new Set())
  const msgCtxRef = useRef(null)
  const [editingMsg, setEditingMsg] = useState(null) // { id, content }
  const editInputRef = useRef(null)
  const [replyTo, setReplyTo] = useState(null) // { id, content, user, isDM }
  const [pinnedMessages, setPinnedMessages] = useState([])
  const [pinnedIndex, setPinnedIndex] = useState(0)
  const [dmPinnedMessages, setDmPinnedMessages] = useState([])
  const [dmPinnedIndex, setDmPinnedIndex] = useState(0)
  const [pinChoiceCtx, setPinChoiceCtx] = useState(null) // { msg, isDM, x, y }
  const [hiddenMessages, setHiddenMessages] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('hiddenMsgs_' + user.id) || '[]')) } catch { return new Set() }
  })

  // Toast notifications
  const [toasts, setToasts] = useState([])
  const toastIdRef = useRef(0)
  const mutedChannelsRef = useRef(mutedChannels)
  useEffect(() => { mutedChannelsRef.current = mutedChannels }, [mutedChannels])

  const addToast = useCallback((toast) => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev.slice(-2), { ...toast, id }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000)
    return id
  }, [])
  const removeToast = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), [])
  const [copiedName, setCopiedName] = useState(false)
  const [emailRevealed, setEmailRevealed] = useState(false)
  const [copyTooltip, setCopyTooltip] = useState(null) // { x, y }
  const copyUsername = useCallback((username, tag, e) => {
    if (e) e.stopPropagation()
    const text = `${username}#${tag}`
    navigator.clipboard.writeText(text).catch(() => {})
    setCopiedName(true)
    if (e) setCopyTooltip({ x: e.clientX, y: e.clientY })
    setTimeout(() => { setCopiedName(false); setCopyTooltip(null) }, 1500)
  }, [])

  // Unread notifications state
  const [unreadChannels, setUnreadChannels] = useState({}) // { channelId: count }
  const [unreadDMs, setUnreadDMs] = useState({}) // { dmChannelId: count }
  const activeChannelRef = useRef(null)
  const activeDMRef = useRef(null)
  const serversRef = useRef([])
  const channelsRef = useRef([])

  // Keep refs in sync
  useEffect(() => { activeChannelRef.current = activeChannel }, [activeChannel])
  useEffect(() => { activeDMRef.current = activeDM }, [activeDM])
  useEffect(() => { serversRef.current = servers }, [servers])
  useEffect(() => { channelsRef.current = channels }, [channels])

  // Check if DM partner has blocked the current user
  useEffect(() => {
    if (activeDM?.partner?.id) {
      API(`/api/blocked-by/${activeDM.partner.id}`).then(r => setBlockedByPartner(r.blocked)).catch(() => setBlockedByPartner(false))
    } else {
      setBlockedByPartner(false)
    }
  }, [activeDM?.partner?.id])

  // Voice channel state
  const [voiceChannelsCollapsed, setVoiceChannelsCollapsed] = useState(false)
  const [voiceUsers, setVoiceUsers] = useState({}) // { channelId: [{ id, username, avatarColor, tag, socketId }] }
  const [voiceChannel, setVoiceChannel] = useState(null) // current voice channel object or null
  const voiceChannelRef = useRef(null)
  useEffect(() => { voiceChannelRef.current = voiceChannel }, [voiceChannel])
  const [voiceMuted, setVoiceMuted] = useState(false)
  const [voiceDeafened, setVoiceDeafened] = useState(false)
  const [newChannelType, setNewChannelType] = useState('text')
  const [showCreateVoiceChannel, setShowCreateVoiceChannel] = useState(false)
  const [newVoiceChannelName, setNewVoiceChannelName] = useState('')
  const [voiceViewChannel, setVoiceViewChannel] = useState(null) // shows voice call view in main area
  const peerConnections = useRef({}) // socketId -> RTCPeerConnection
  const localStream = useRef(null)
  const [speakingUsers, setSpeakingUsers] = useState(new Set()) // set of userIds currently speaking
  const speakingAnalysers = useRef({}) // socketId -> { analyser, interval }
  const localSpeakingRef = useRef(null) // { analyser, interval }

  // Voice call controls state
  const [showMicPopup, setShowMicPopup] = useState(false)
  const [showCameraPopup, setShowCameraPopup] = useState(false)
  const [audioDevices, setAudioDevices] = useState({ inputs: [], outputs: [] })
  const [videoDevices, setVideoDevices] = useState([])
  const [selectedMicId, setSelectedMicId] = useState('')
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('')
  const [selectedCameraId, setSelectedCameraId] = useState('')
  const [micVolume, setMicVolume] = useState(100)
  const [soundVolume, setSoundVolume] = useState(100)
  const [userVolumes, setUserVolumes] = useState({}) // userId -> volume (0-200)
  const [voiceUserCtx, setVoiceUserCtx] = useState(null) // { user, x, y }
  const voiceUserCtxRef = useRef(null)
  const micGainNode = useRef(null)
  const micAudioCtx = useRef(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [screenShareOn, setScreenShareOn] = useState(false)
  const cameraStream = useRef(null)
  const screenStream = useRef(null)
  const [remoteVideoStreams, setRemoteVideoStreams] = useState({}) // socketId -> MediaStream (camera)
  const [remoteScreenStreams, setRemoteScreenStreams] = useState({}) // socketId -> MediaStream (screen share)
  const videoRefs = useRef({}) // socketId -> video element
  const localVideoRef = useRef(null)
  const localScreenRef = useRef(null)
  const [focusedStreamUser, setFocusedStreamUser] = useState(null) // userId of focused user
  const [focusedStreamType, setFocusedStreamType] = useState('screen') // 'screen' or 'camera'
  const [pinnedUser, setPinnedUser] = useState(null) // userId pinned by user (overrides auto-focus)
  const micPopupRef = useRef(null)
  const cameraPopupRef = useRef(null)
  const gainNodeRef = useRef(null)

  // ── DM Call state ──
  const [dmCall, setDmCall] = useState(null) // { dmChannelId, partnerId, partnerUsername, partnerAvatarColor, status: 'calling'|'active' }
  const [incomingDmCall, setIncomingDmCall] = useState(null) // { dmChannelId, caller: { id, username, avatarColor, tag } }
  const [dmCallDuration, setDmCallDuration] = useState(0)
  const dmCallRef = useRef(null)
  const dmCallTimerRef = useRef(null)
  const dmCallPeerConnection = useRef(null)
  const dmCallLocalStream = useRef(null)
  const dmCallMuted = useRef(false)
  const [dmCallCameraOn, setDmCallCameraOn] = useState(false)
  const [dmCallScreenOn, setDmCallScreenOn] = useState(false)
  const [dmCallDeafened, setDmCallDeafened] = useState(false)
  const dmCallCameraStream = useRef(null)
  const dmCallScreenStream = useRef(null)
  const dmCallRingtone = useRef(null)
  useEffect(() => { dmCallRef.current = dmCall }, [dmCall])

  // ── Active server ref (for socket handlers) ──
  const activeServerRef = useRef(null)
  useEffect(() => { activeServerRef.current = activeServer }, [activeServer])

  // ── Preloaded sound cache ──
  const soundCache = useRef({})
  useEffect(() => {
    const files = {
      'sound_send': '/sound_send.wav',
      'voice_connect': '/voice_connect.wav',
      'voice_disconnect': '/voice_disconnect.wav',
      'unmute': '/unmute.wav',
      'mute_toggle': '/mute_toggle.m4a',
    }
    Object.entries(files).forEach(([key, src]) => {
      const a = new Audio(src)
      a.preload = 'auto'
      a.load()
      soundCache.current[key] = a
    })
  }, [])

  const playCachedSound = useCallback((key, volume = 1) => {
    try {
      const cached = soundCache.current[key]
      if (cached) {
        const clone = cached.cloneNode()
        clone.volume = Math.min(volume, 1)
        clone.play().catch(() => {})
      }
    } catch {}
  }, [])

  // ── App sounds ──
  const playSoundRef = useRef(null)
  const playSound = useCallback((type) => {
    try {
      if (type === 'message-send') {
        playCachedSound('sound_send', Math.min(soundVolume / 100, 1))
        return
      }
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.connect(gain)
      gain.connect(ctx.destination)
      const vol = (soundVolume / 100) * 0.15
      if (type === 'message-receive') {
        osc.type = 'sine'
        osc.frequency.setValueAtTime(587, ctx.currentTime)
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.08)
        gain.gain.setValueAtTime(vol, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.2)
      } else if (type === 'notification') {
        osc.type = 'sine'
        osc.frequency.setValueAtTime(523, ctx.currentTime)
        osc.frequency.setValueAtTime(659, ctx.currentTime + 0.1)
        osc.frequency.setValueAtTime(784, ctx.currentTime + 0.2)
        gain.gain.setValueAtTime(vol, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.35)
      } else if (type === 'error') {
        osc.type = 'square'
        osc.frequency.setValueAtTime(200, ctx.currentTime)
        osc.frequency.setValueAtTime(150, ctx.currentTime + 0.1)
        gain.gain.setValueAtTime(vol * 0.5, ctx.currentTime)
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2)
        osc.start(ctx.currentTime)
        osc.stop(ctx.currentTime + 0.2)
      }
      setTimeout(() => ctx.close(), 500)
    } catch {}
  }, [soundVolume, playCachedSound])
  useEffect(() => { playSoundRef.current = playSound }, [playSound])

  // Connect socket
  useEffect(() => {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
    socket = io({
      auth: { token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 20000,
    })
    window.__socket = socket

    // Connection error handling
    socket.on('connect_error', (err) => {
      console.warn('[Socket] connect_error:', err.message)
      if (err.message === 'Invalid token' || err.message === 'Auth required' || err.message === 'User not found') {
        localStorage.removeItem('token')
        sessionStorage.removeItem('token')
        logout()
      }
    })

    // Reconnection — re-join active rooms
    socket.on('connect', () => {
      console.log('[Socket] connected:', socket.id)
      // Re-join the active channel room
      if (activeChannelRef.current?.id) {
        socket.emit('join-channel', activeChannelRef.current.id)
      }
      // Re-join server rooms (server does this on connection, but just in case)
      // Re-join voice if was in call
      if (voiceChannelRef.current) {
        socket.emit('rejoin-voice', { channelId: voiceChannelRef.current.id })
      }
    })

    socket.on('disconnect', (reason) => {
      console.warn('[Socket] disconnected:', reason)
      if (reason === 'io server disconnect') {
        // Server forced disconnect — reconnect manually
        socket.connect()
      }
    })

    socket.on('new-message', (msg) => {
      setMessages(prev => [...prev, msg])
    })

    // Unread tracking for server channels
    socket.on('channel-message-notify', ({ channelId, serverId, userId, username, avatarColor, avatar, content, attachment }) => {
      if (userId === user.id) return // own messages
      if (activeChannelRef.current?.id === channelId) return // currently viewing
      setUnreadChannels(prev => ({ ...prev, [channelId]: (prev[channelId] || 0) + 1 }))
      // Toast notification (if not muted)
      const muted = mutedChannelsRef.current[channelId]
      if (!muted || muted <= Date.now()) {
        const srv = serversRef.current?.find(s => s.id === serverId)
        const ch = channelsRef.current?.find(c => c.id === channelId)
        addToast({
          type: 'channel',
          channelId,
          serverId,
          serverName: srv?.name || '',
          channelName: ch?.name || '',
          username: username || 'User',
          avatarColor: avatarColor || '#666',
          avatar: avatar || null,
          content: attachment ? (content || t('msg.attachment')) : (content || ''),
        })
        playSoundRef.current?.('message-receive')
      }
    })

    socket.on('user-typing', ({ channelId, user: typingUser }) => {
      setTypingUsers(prev => {
        if (prev.find(u => u.id === typingUser.id)) return prev
        return [...prev, typingUser]
      })
      if (typingTimers.current[typingUser.id]) clearTimeout(typingTimers.current[typingUser.id])
      typingTimers.current[typingUser.id] = setTimeout(() => {
        setTypingUsers(prev => prev.filter(u => u.id !== typingUser.id))
        delete typingTimers.current[typingUser.id]
      }, 6000)
    })

    socket.on('user-online', ({ userId }) => {
      setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, status: 'online' } }))
      setMembers(prev => prev.map(m => m.id === userId ? { ...m, status: 'online' } : m))
    })

    socket.on('user-offline', ({ userId }) => {
      setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, status: 'offline' } }))
      setMembers(prev => prev.map(m => m.id === userId ? { ...m, status: 'offline' } : m))
    })

    socket.on('user-status-changed', ({ userId, status }) => {
      setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, status } }))
      setUser(prev => prev?.id === userId ? { ...prev, status } : prev)
    })

    socket.on('user-status-emoji-changed', ({ userId, statusEmoji }) => {
      setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, statusEmoji } }))
      setUser(prev => prev?.id === userId ? { ...prev, statusEmoji } : prev)
    })

    socket.on('user-frame-changed', ({ userId, avatarFrame }) => {
      setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, avatarFrame } }))
      setUser(prev => prev?.id === userId ? { ...prev, avatarFrame } : prev)
    })

    socket.on('user-avatar-changed', ({ userId, avatar }) => {
      setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, avatar } }))
      setDmList(prev => prev.map(dm => dm.partner?.id === userId ? { ...dm, partner: { ...dm.partner, avatar } } : dm))
      setDmCall(prev => prev?.partnerId === userId ? { ...prev, partnerAvatar: avatar } : prev)
      setUser(prev => prev?.id === userId ? { ...prev, avatar } : prev)
    })

    socket.on('user-banner-changed', ({ userId, bannerImg }) => {
      setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, bannerImg } }))
      setUser(prev => prev?.id === userId ? { ...prev, bannerImg } : prev)
    })

    socket.on('friend-request-received', (fr) => {
      setFriendRequests(prev => {
        if (prev.find(r => r.id === fr.id)) return prev
        return [...prev, fr]
      })
      playSoundRef.current?.('notification')
    })

    socket.on('friend-request-accepted', ({ requestId, friend }) => {
      playSoundRef.current?.('notification')
      setFriendRequests(prev => prev.filter(r => r.id !== requestId))
      setFriends(prev => {
        if (prev.find(f => f.id === friend.id)) return prev
        return [...prev, friend]
      })
      setSentFriendRequests(prev => { const n = new Map(prev); n.delete(friend.id); return n })
    })

    socket.on('friend-removed', ({ userId }) => {
      setFriends(prev => prev.filter(f => f.id !== userId))
      setSentFriendRequests(prev => { const n = new Map(prev); n.delete(userId); return n })
    })

    socket.on('blocked-by-user', ({ userId }) => {
      // If currently in DM with this user, update blockedByPartner
      if (activeDMRef.current?.partner?.id === userId) {
        setBlockedByPartner(true)
      }
    })

    socket.on('friend-request-cancelled', ({ requestId }) => {
      setFriendRequests(prev => prev.filter(r => r.id !== requestId))
    })

    socket.on('new-dm', (msg) => {
      setDmMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg])
      // Update DM channel last message in sidebar
      setDmChannels(prev => {
        const updated = prev.map(d => d.id === msg.dmChannelId ? { ...d, lastMessage: { content: msg.content, createdAt: msg.createdAt, userId: msg.userId, attachment: msg.attachment } } : d)
        // Re-sort by last message
        updated.sort((a, b) => {
          const ta = a.lastMessage?.createdAt || a.createdAt
          const tb = b.lastMessage?.createdAt || b.createdAt
          return tb.localeCompare(ta)
        })
        return updated
      })
      // Track unread DMs
      if (msg.userId !== user.id && activeDMRef.current?.id !== msg.dmChannelId) {
        setUnreadDMs(prev => ({ ...prev, [msg.dmChannelId]: (prev[msg.dmChannelId] || 0) + 1 }))
        // Toast notification (if not muted)
        const muted = mutedChannelsRef.current[msg.dmChannelId]
        if (!muted || muted <= Date.now()) {
          addToast({
            type: 'dm',
            dmChannelId: msg.dmChannelId,
            username: msg.user?.username || 'User',
            avatarColor: msg.user?.avatarColor || '#666',
            avatar: msg.user?.avatar || null,
            content: msg.attachment ? (msg.content || t('msg.attachment')) : (msg.content || ''),
          })
          playSoundRef.current?.('message-receive')
        }
      }
    })

    socket.on('channel-created', (channel) => {
      setChannels(prev => {
        if (prev.find(c => c.id === channel.id)) return prev
        return [...prev, channel]
      })
    })

    socket.on('channel-deleted', ({ id, serverId }) => {
      setChannels(prev => {
        const updated = prev.filter(c => c.id !== id)
        setActiveChannel(ac => ac && ac.id === id ? (updated[0] || null) : ac)
        return updated
      })
    })

    socket.on('voice-channel-deleted', ({ channelId }) => {
      // If we're in the deleted voice channel, leave it
      setVoiceChannel(prev => {
        if (prev?.id === channelId) {
          // Clean up peer connections and streams
          for (const [sid, pc] of Object.entries(peerConnections.current)) {
            pc.close()
            document.getElementById('voice-audio-' + sid)?.remove()
          }
          peerConnections.current = {}
          if (localStream.current) {
            if (localStream.current._rawStream) localStream.current._rawStream.getTracks().forEach(t => t.stop())
            localStream.current.getTracks().forEach(t => t.stop())
            localStream.current = null
          }
          if (cameraStream.current) { cameraStream.current.getTracks().forEach(t => t.stop()); cameraStream.current = null }
          if (screenStream.current) { screenStream.current.getTracks().forEach(t => t.stop()); screenStream.current = null }
          setCameraOn(false)
          setScreenShareOn(false)
          setRemoteVideoStreams({})
          setRemoteScreenStreams({})
          setVoiceViewChannel(null)
          setFocusedStreamUser(null)
          setPinnedUser(null)
          return null
        }
        return prev
      })
    })

    socket.on('channel-cleared', ({ channelId }) => {
      setMessages(prev => activeChannel?.id === channelId ? [] : prev)
    })

    socket.on('server-updated', (updated) => {
      setServers(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))
      setActiveServer(prev => prev && prev.id === updated.id ? { ...prev, ...updated } : prev)
    })

    socket.on('server-deleted', ({ id }) => {
      setServers(prev => prev.filter(s => s.id !== id))
      setActiveServer(prev => {
        if (prev && prev.id === id) { setShowFriends(true); setChannels([]); setActiveChannel(null); return null }
        return prev
      })
    })

    socket.on('channel-updated', (updated) => {
      setChannels(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c))
      setActiveChannel(prev => prev && prev.id === updated.id ? { ...prev, ...updated } : prev)
    })

    socket.on('message-edited', ({ id, content, editedAt }) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, content, editedAt } : m))
    })
    socket.on('message-deleted-for-all', ({ id }) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, deleted: true, content: null, attachment: null } : m))
      setPinnedMessages(prev => prev.filter(p => p.id !== id))
    })
    socket.on('message-pinned', ({ id, pinned }) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, pinned } : m))
      if (pinned) {
        setMessages(prev => {
          const msg = prev.find(m => m.id === id)
          if (msg) setPinnedMessages(pp => pp.some(p => p.id === id) ? pp : [...pp, msg].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
          return prev
        })
      } else {
        setPinnedMessages(prev => prev.filter(p => p.id !== id))
      }
    })
    socket.on('dm-message-edited', ({ id, content, editedAt }) => {
      setDmMessages(prev => prev.map(m => m.id === id ? { ...m, content, editedAt } : m))
    })
    socket.on('dm-message-deleted-for-all', ({ id }) => {
      setDmMessages(prev => prev.map(m => m.id === id ? { ...m, deleted: true, content: null, attachment: null } : m))
      setDmPinnedMessages(prev => prev.filter(p => p.id !== id))
    })
    socket.on('dm-message-pinned', ({ id, pinned }) => {
      setDmMessages(prev => prev.map(m => m.id === id ? { ...m, pinned } : m))
      if (pinned) {
        setDmMessages(prev => {
          const msg = prev.find(m => m.id === id)
          if (msg) setDmPinnedMessages(pp => pp.some(p => p.id === id) ? pp : [...pp, msg].sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
          return prev
        })
      } else {
        setDmPinnedMessages(prev => prev.filter(p => p.id !== id))
      }
    })

    socket.on('message-reacted', ({ id, reactions }) => {
      setMessages(prev => prev.map(m => m.id === id ? { ...m, reactions } : m))
    })
    socket.on('dm-message-reacted', ({ id, reactions }) => {
      setDmMessages(prev => prev.map(m => m.id === id ? { ...m, reactions } : m))
    })

    socket.on('dm-channel-deleted', ({ id }) => {
      setDmChannels(prev => prev.filter(d => d.id !== id))
      setActiveDM(prev => prev?.id === id ? null : prev)
    })

    socket.on('dm-messages-cleared', ({ dmChannelId }) => {
      if (activeDMRef.current?.id === dmChannelId) setDmMessages([])
    })

    socket.on('message-error', ({ error }) => {
      setSlowmodeError(error)
      setTimeout(() => setSlowmodeError(null), 3000)
    })

    // Voice events
    socket.on('member-role-updated', ({ serverId, userId, role }) => {
      setMembers(prev => prev.map(m => m.id === userId ? { ...m, role } : m))
    })

    socket.on('kicked-from-server', ({ serverId }) => {
      setServers(prev => prev.filter(s => s.id !== serverId))
      if (activeServerRef.current?.id === serverId) { setActiveServer(null); setShowFriends(true) }
    })

    socket.on('member-kicked', ({ serverId, userId }) => {
      setMembers(prev => prev.filter(m => m.id !== userId))
    })

    socket.on('server-permissions-updated', ({ serverId, adminPermissions }) => {
      setServers(prev => prev.map(s => s.id === serverId ? { ...s, adminPermissions } : s))
      setActiveServer(prev => prev && prev.id === serverId ? { ...prev, adminPermissions } : prev)
    })

    socket.on('server-roles-updated', ({ serverId, customRoles }) => {
      setServers(prev => prev.map(s => s.id === serverId ? { ...s, customRoles } : s))
      setActiveServer(prev => prev && prev.id === serverId ? { ...prev, customRoles } : prev)
    })

    socket.on('server-boost-updated', ({ serverId, boostCount, boostLevel }) => {
      setServers(prev => prev.map(s => s.id === serverId ? { ...s, boostCount, boostLevel } : s))
      setActiveServer(prev => prev && prev.id === serverId ? { ...prev, boostCount, boostLevel } : prev)
    })

    socket.on('server-emojis-updated', ({ serverId, emojis }) => {
      setServers(prev => prev.map(s => s.id === serverId ? { ...s, customEmojis: emojis } : s))
      setActiveServer(prev => prev && prev.id === serverId ? { ...prev, customEmojis: emojis } : prev)
      setServerCustomEmojis(emojis)
      setServerSettingsEmojis(emojis)
    })

    socket.on('role-deleted-reset', ({ serverId, roleId }) => {
      setMembers(prev => prev.map(m => m.role === roleId ? { ...m, role: 'user' } : m))
    })

    socket.on('voice-state-update', ({ channelId, users }) => {
      setVoiceUsers(prev => ({ ...prev, [channelId]: users }))
    })

    socket.on('voice-peers', async ({ channelId, peers }) => {
      // We just joined — create offers to all existing peers
      for (const peer of peers) {
        const pc = createPeerConnection(peer.socketId, socket)
        pc._remoteUserId = peer.id
        pc._polite = false // We are the offerer (impolite)
        peerConnections.current[peer.socketId] = pc
        if (localStream.current) {
          localStream.current.getTracks().forEach(track => {
            if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, localStream.current)
          })
        }
        if (cameraStream.current) {
          cameraStream.current.getVideoTracks().forEach(track => {
            if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, cameraStream.current)
          })
        }
        if (screenStream.current) {
          screenStream.current.getVideoTracks().forEach(track => {
            if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, screenStream.current)
          })
        }
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          socket.emit('voice-offer', { targetSocketId: peer.socketId, offer })
        } catch (e) { console.warn('Failed to create offer for peer', peer.socketId, e) }
      }
    })

    socket.on('voice-offer', async ({ fromSocketId, fromUserId, offer }) => {
      try {
        let pc = peerConnections.current[fromSocketId]
        if (!pc) {
          pc = createPeerConnection(fromSocketId, socket)
          pc._remoteUserId = fromUserId
          pc._polite = true // We are the answerer (polite)
          peerConnections.current[fromSocketId] = pc
          // Check if this is a DM call offer
          const isDmCallOffer = dmCallRef.current && dmCallPeerConnection.current?._pendingLocal && dmCallPeerConnection.current._peerSocketId === fromSocketId
          if (isDmCallOffer) {
            pc._isDmCall = true
            dmCallPeerConnection.current = pc
            if (dmCallLocalStream.current) {
              dmCallLocalStream.current.getTracks().forEach(track => {
                if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, dmCallLocalStream.current)
              })
            }
          } else {
            if (localStream.current) {
              localStream.current.getTracks().forEach(track => {
                if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, localStream.current)
              })
            }
            if (cameraStream.current) {
              cameraStream.current.getVideoTracks().forEach(track => {
                if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, cameraStream.current)
              })
            }
            if (screenStream.current) {
              screenStream.current.getVideoTracks().forEach(track => {
                if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, screenStream.current)
              })
            }
          }
        }
        // Handle glare: if we're making an offer too, polite peer rolls back
        const offerCollision = pc._makingOffer || pc.signalingState !== 'stable'
        if (offerCollision && !pc._polite) return // impolite peer ignores incoming offer during collision
        if (offerCollision && pc.signalingState !== 'stable') {
          await pc.setLocalDescription({ type: 'rollback' })
        }
        await pc.setRemoteDescription(new RTCSessionDescription(offer))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        socket.emit('voice-answer', { targetSocketId: fromSocketId, answer })
      } catch (e) { console.warn('Failed to handle offer from', fromSocketId, e) }
    })

    socket.on('voice-answer', async ({ fromSocketId, answer }) => {
      const pc = peerConnections.current[fromSocketId]
      if (pc) {
        try { await pc.setRemoteDescription(new RTCSessionDescription(answer)) }
        catch (e) { console.warn('Failed to set answer from', fromSocketId, e) }
      }
    })

    socket.on('voice-ice-candidate', ({ fromSocketId, candidate }) => {
      const pc = peerConnections.current[fromSocketId]
      if (pc && candidate) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
    })

    // When remote user's video/mute state changes, update voiceUsers immediately
    socket.on('voice-video-state', ({ userId, camera, screen }) => {
      setVoiceUsers(prev => {
        const updated = { ...prev }
        for (const chId of Object.keys(updated)) {
          updated[chId] = updated[chId].map(u => u.id === userId ? { ...u, camera, screen } : u)
        }
        return updated
      })
      // Clean up remote screen stream when user stops sharing
      if (!screen) {
        setRemoteScreenStreams(prev => {
          const n = { ...prev }
          // Find socketId for this userId from peer connections
          for (const [sockId, pc] of Object.entries(peerConnections.current)) {
            if (pc._remoteUserId === userId) { delete n[sockId]; break }
          }
          return n
        })
      }
      // Clean up remote camera stream when user stops camera
      if (!camera) {
        // If they still have screen, move screen stream from remoteVideoStreams to remoteScreenStreams if needed
        // Otherwise just let it be — the track will be removed via renegotiation
      }
    })

    // ── DM Call socket listeners ──
    socket.on('dm-call-incoming', ({ dmChannelId, caller }) => {
      setIncomingDmCall({ dmChannelId, caller })
    })

    socket.on('dm-call-accepted', async ({ dmChannelId, peers }) => {
      const currentCall = dmCallRef.current
      if (dmCallRingtone.current) { dmCallRingtone.current.stop(); dmCallRingtone.current = null }
      setDmCall(prev => prev ? { ...prev, status: 'active' } : null)
      setDmCallDuration(0)
      if (dmCallTimerRef.current) clearInterval(dmCallTimerRef.current)
      dmCallTimerRef.current = setInterval(() => setDmCallDuration(d => d + 1), 1000)
      // Only the caller creates the offer; callee waits for voice-offer
      const isCaller = currentCall?.status === 'calling'
      if (isCaller && peers.length > 0) {
        const peer = peers[0]
        const pc = createPeerConnection(peer.socketId, socket)
        pc._remoteUserId = peer.id
        pc._polite = false
        pc._isDmCall = true
        dmCallPeerConnection.current = pc
        peerConnections.current[peer.socketId] = pc
        if (dmCallLocalStream.current) {
          dmCallLocalStream.current.getTracks().forEach(track => {
            if (!pc.getSenders().find(s => s.track === track)) pc.addTrack(track, dmCallLocalStream.current)
          })
        }
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          socket.emit('voice-offer', { targetSocketId: peer.socketId, offer })
        } catch (e) { console.warn('Failed to create DM call offer', e) }
      } else if (!isCaller && peers.length > 0) {
        // Callee: just save peer info, PC will be created by voice-offer handler
        // But we need to make sure local stream is added when PC is created
        // Store the peer socketId so voice-offer handler can add local stream
        dmCallPeerConnection.current = { _peerSocketId: peers[0].socketId, _pendingLocal: true }
      }
      playVoiceSound('/voice_connect.wav', 1.5)
    })

    socket.on('dm-call-ended', ({ dmChannelId, reason, duration }) => {
      setIncomingDmCall(null)
      // Cleanup peer connection
      if (dmCallPeerConnection.current) {
        dmCallPeerConnection.current.close()
        dmCallPeerConnection.current = null
      }
      if (dmCallLocalStream.current) {
        if (dmCallLocalStream.current._rawStream) dmCallLocalStream.current._rawStream.getTracks().forEach(t => t.stop())
        dmCallLocalStream.current.getTracks().forEach(t => t.stop())
        if (dmCallLocalStream.current._audioCtx) dmCallLocalStream.current._audioCtx.close().catch(() => {})
        dmCallLocalStream.current = null
      }
      if (dmCallTimerRef.current) { clearInterval(dmCallTimerRef.current); dmCallTimerRef.current = null }
      document.getElementById('dm-call-audio')?.remove()
      setDmCall(null)
      setDmCallDuration(0)
      playVoiceSound('/voice_disconnect.wav', 1.5)
    })

    socket.on('voice-sound', ({ type }) => {
      const keyMap = { join: 'voice_connect', leave: 'voice_disconnect', unmute: 'unmute', mute: 'mute_toggle' }
      const key = keyMap[type] || 'mute_toggle'
      const cached = soundCache.current[key]
      if (cached) {
        const clone = cached.cloneNode()
        clone.volume = Math.min((soundVolume || 100) / 100 * 1.5, 1)
        clone.play().catch(() => {})
      }
    })

    return () => { socket?.disconnect() }
  }, [])

  // Speaking detection helper
  const startSpeakingDetection = (stream, userId) => {
    try {
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.4
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const interval = setInterval(() => {
        analyser.getByteFrequencyData(data)
        const avg = data.reduce((a, b) => a + b, 0) / data.length
        const isSpeaking = avg > 15
        setSpeakingUsers(prev => {
          const next = new Set(prev)
          if (isSpeaking) next.add(userId)
          else next.delete(userId)
          return next.size !== prev.size || isSpeaking !== prev.has(userId) ? next : prev
        })
      }, 100)
      return { analyser, ctx, interval }
    } catch { return null }
  }

  const stopSpeakingDetection = (ref) => {
    if (ref) { clearInterval(ref.interval); ref.ctx?.close().catch(() => {}) }
  }

  // Auto-focus on speaking user (only when in focused view and not pinned)
  useEffect(() => {
    if (pinnedUser || !focusedStreamUser) return
    const speaking = [...speakingUsers].filter(id => id !== user?.id)
    if (speaking.length > 0 && speaking[0] !== focusedStreamUser) {
      setFocusedStreamUser(speaking[0])
    }
  }, [speakingUsers, pinnedUser, focusedStreamUser])

  // WebRTC helper
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:89.108.66.165:3478' },
    { urls: 'turn:89.108.66.165:3478', username: 'branch', credential: 'branch2026turn' },
  ]

  const createPeerConnection = (targetSocketId, sock) => {
    const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' })
    pc._polite = false // will be set by caller
    pc._makingOffer = false
    pc.onicecandidate = (e) => {
      if (e.candidate) sock.emit('voice-ice-candidate', { targetSocketId, candidate: e.candidate })
    }
    pc.ontrack = (e) => {
      if (e.track.kind === 'audio') {
        // Remove existing audio element for this peer to avoid duplicates
        document.getElementById('voice-audio-' + targetSocketId)?.remove()
        const audio = document.createElement('audio')
        audio.srcObject = e.streams[0]
        audio.autoplay = true
        audio.id = 'voice-audio-' + targetSocketId
        const remoteUserId = pc._remoteUserId
        audio._remoteUserId = remoteUserId
        // Apply per-user volume
        const uVol = remoteUserId && userVolumes[remoteUserId] !== undefined ? userVolumes[remoteUserId] : 100
        audio.volume = Math.min((soundVolume / 100) * (uVol / 100), 2)
        document.getElementById('voice-audio-container')?.appendChild(audio)
        // Detect speaking from remote stream
        if (remoteUserId) {
          stopSpeakingDetection(speakingAnalysers.current[targetSocketId])
          const det = startSpeakingDetection(e.streams[0], remoteUserId)
          if (det) speakingAnalysers.current[targetSocketId] = det
        }
      } else if (e.track.kind === 'video') {
        const stream = e.streams[0]
        // Distinguish camera vs screen: if we already have a camera stream with a
        // different id for this peer, the new stream is their screen share.
        setRemoteVideoStreams(prev => {
          const existing = prev[targetSocketId]
          if (existing && existing.id !== stream.id) {
            // Already have a camera stream — store new one as screen
            setRemoteScreenStreams(p => ({ ...p, [targetSocketId]: stream }))
            return prev
          }
          // First (or same) video stream — treat as camera
          return { ...prev, [targetSocketId]: stream }
        })
      }
    }
    pc.onnegotiationneeded = async () => {
      try {
        if (pc._makingOffer) return
        pc._makingOffer = true
        await pc.setLocalDescription()
        sock.emit('voice-offer', { targetSocketId, offer: pc.localDescription })
      } catch (e) { console.warn('Negotiation needed error:', e) }
      finally { pc._makingOffer = false }
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Try ICE restart on failure
        pc.restartIce()
      }
      if (pc.connectionState === 'disconnected') {
        // Wait a bit before cleaning up, connection might recover
        setTimeout(() => {
          if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            pc.close()
            delete peerConnections.current[targetSocketId]
            document.getElementById('voice-audio-' + targetSocketId)?.remove()
            stopSpeakingDetection(speakingAnalysers.current[targetSocketId])
            delete speakingAnalysers.current[targetSocketId]
            setRemoteVideoStreams(prev => { const n = { ...prev }; delete n[targetSocketId]; return n })
            setRemoteScreenStreams(prev => { const n = { ...prev }; delete n[targetSocketId]; return n })
          }
        }, 5000)
      }
    }
    return pc
  }

  const playVoiceSound = (src, volume = 1) => {
    // Map file paths to cache keys
    const keyMap = { '/voice_connect.wav': 'voice_connect', '/voice_disconnect.wav': 'voice_disconnect', '/unmute.wav': 'unmute', '/mute_toggle.m4a': 'mute_toggle', '/sound_send.wav': 'sound_send' }
    const key = keyMap[src]
    if (key) {
      playCachedSound(key, Math.min((soundVolume || 100) / 100 * volume, 1))
    } else {
      const a = new Audio(src)
      a.volume = Math.min(volume, 1)
      a.play().catch(() => {})
    }
  }

  const joinVoiceChannel = async (channel) => {
    if (voiceChannel?.id === channel.id) return
    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      // Route through GainNode for mic volume control
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(rawStream)
      const gain = ctx.createGain()
      gain.gain.value = micVolume / 100
      const dest = ctx.createMediaStreamDestination()
      source.connect(gain)
      gain.connect(dest)
      micAudioCtx.current = ctx
      micGainNode.current = gain
      localStream.current = dest.stream
      // Keep raw stream ref to stop tracks later
      localStream.current._rawStream = rawStream
      // Detect local speaking from raw stream
      const det = startSpeakingDetection(rawStream, user.id)
      if (det) localSpeakingRef.current = det
    } catch (err) {
      console.warn('Mic not available, joining voice channel without mic', err)
      localStream.current = null
    }
    setVoiceChannel(channel)
    setVoiceViewChannel(channel)
    setActiveChannel(null)
    setVoiceMuted(false)
    setVoiceDeafened(false)
    setCameraOn(false)
    setScreenShareOn(false)
    loadDevices()
    socket.emit('voice-join', { channelId: channel.id })
    playVoiceSound('/voice_connect.wav', 1.5)
  }

  const leaveVoiceChannel = (silent = false) => {
    socket.emit('voice-leave')
    // Stop speaking detection
    stopSpeakingDetection(localSpeakingRef.current)
    localSpeakingRef.current = null
    for (const [sid, det] of Object.entries(speakingAnalysers.current)) { stopSpeakingDetection(det) }
    speakingAnalysers.current = {}
    setSpeakingUsers(new Set())
    // Close all peer connections
    for (const [sid, pc] of Object.entries(peerConnections.current)) {
      pc.close()
      document.getElementById('voice-audio-' + sid)?.remove()
    }
    peerConnections.current = {}
    // Stop local stream
    if (localStream.current) {
      if (localStream.current._rawStream) localStream.current._rawStream.getTracks().forEach(t => t.stop())
      localStream.current.getTracks().forEach(t => t.stop())
      localStream.current = null
    }
    if (micAudioCtx.current) { micAudioCtx.current.close().catch(() => {}); micAudioCtx.current = null }
    micGainNode.current = null
    // Stop camera/screen
    if (cameraStream.current) { cameraStream.current.getTracks().forEach(t => t.stop()); cameraStream.current = null }
    if (screenStream.current) { screenStream.current.getTracks().forEach(t => t.stop()); screenStream.current = null }
    setCameraOn(false)
    setScreenShareOn(false)
    setRemoteVideoStreams({})
    setRemoteScreenStreams({})
    setFocusedStreamUser(null)
    setPinnedUser(null)
    setShowMicPopup(false)
    setShowCameraPopup(false)
    setVoiceChannel(null)
    setVoiceViewChannel(null)
    // Restore to first text channel or friends
    const textCh = channels.filter(c => c.type !== 'voice')
    if (textCh.length > 0) {
      setActiveChannel(textCh[0])
      setShowFriends(false)
    } else {
      setActiveChannel(null)
      setShowFriends(true)
    }
    if (!silent) playVoiceSound('/voice_disconnect.wav', 1.5)
  }

  // ── DM Call functions ──
  const startDmCall = async (dmChannelId, partner) => {
    if (dmCallRef.current) endDmCall()
    if (voiceChannel) leaveVoiceChannel(true)
    // Acquire mic
    let stream = null
    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(rawStream)
      const gain = ctx.createGain()
      gain.gain.value = 1
      const dest = ctx.createMediaStreamDestination()
      source.connect(gain)
      gain.connect(dest)
      stream = dest.stream
      stream._rawStream = rawStream
      stream._audioCtx = ctx
      stream._gain = gain
    } catch (err) {
      console.warn('Mic not available for DM call', err)
    }
    dmCallLocalStream.current = stream
    dmCallMuted.current = false
    dmCallRingtone.current = startCallRingtone()
    setDmCall({ dmChannelId, partnerId: partner.id, partnerUsername: partner.username, partnerAvatarColor: partner.avatarColor, partnerAvatar: partner.avatar, status: 'calling' })
    socket?.emit('dm-call-start', { dmChannelId })
  }

  const acceptDmCall = async (dmChannelId, caller) => {
    if (voiceChannel) leaveVoiceChannel(true)
    if (dmCallRef.current) endDmCall()
    // Acquire mic
    let stream = null
    try {
      const rawStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const ctx = new AudioContext()
      const source = ctx.createMediaStreamSource(rawStream)
      const gain = ctx.createGain()
      gain.gain.value = 1
      const dest = ctx.createMediaStreamDestination()
      source.connect(gain)
      gain.connect(dest)
      stream = dest.stream
      stream._rawStream = rawStream
      stream._audioCtx = ctx
      stream._gain = gain
    } catch (err) {
      console.warn('Mic not available for DM call', err)
    }
    dmCallLocalStream.current = stream
    dmCallMuted.current = false
    setDmCall({ dmChannelId, partnerId: caller.id, partnerUsername: caller.username, partnerAvatarColor: caller.avatarColor, partnerAvatar: caller.avatar, status: 'active' })
    setDmCallDuration(0)
    dmCallTimerRef.current = setInterval(() => setDmCallDuration(d => d + 1), 1000)
    setIncomingDmCall(null)
    socket?.emit('dm-call-accept', { dmChannelId })
    playVoiceSound('/voice_connect.wav', 1.5)
  }

  const rejectDmCall = (dmChannelId) => {
    socket?.emit('dm-call-reject', { dmChannelId })
    setIncomingDmCall(null)
  }

  const endDmCall = () => {
    const call = dmCallRef.current
    if (!call) return
    socket?.emit('dm-call-end', { dmChannelId: call.dmChannelId })
    cleanupDmCall()
  }

  const cleanupDmCall = () => {
    if (dmCallPeerConnection.current) {
      dmCallPeerConnection.current.close()
      dmCallPeerConnection.current = null
    }
    if (dmCallLocalStream.current) {
      if (dmCallLocalStream.current._rawStream) dmCallLocalStream.current._rawStream.getTracks().forEach(t => t.stop())
      dmCallLocalStream.current.getTracks().forEach(t => t.stop())
      if (dmCallLocalStream.current._audioCtx) dmCallLocalStream.current._audioCtx.close().catch(() => {})
      dmCallLocalStream.current = null
    }
    if (dmCallTimerRef.current) { clearInterval(dmCallTimerRef.current); dmCallTimerRef.current = null }
    if (dmCallRingtone.current) { dmCallRingtone.current.stop(); dmCallRingtone.current = null }
    if (dmCallCameraStream.current) { dmCallCameraStream.current.getTracks().forEach(t => t.stop()); dmCallCameraStream.current = null }
    if (dmCallScreenStream.current) { dmCallScreenStream.current.getTracks().forEach(t => t.stop()); dmCallScreenStream.current = null }
    // Remove any audio elements
    document.getElementById('dm-call-audio')?.remove()
    setDmCall(null)
    setDmCallDuration(0)
    dmCallMuted.current = false
    setDmCallCameraOn(false)
    setDmCallScreenOn(false)
    setDmCallDeafened(false)
  }

  const toggleDmCallMute = () => {
    if (!dmCallLocalStream.current) return
    const track = dmCallLocalStream.current.getAudioTracks()[0]
    if (track) {
      dmCallMuted.current = !dmCallMuted.current
      track.enabled = !dmCallMuted.current
      setDmCall(prev => prev ? { ...prev } : null)
    }
  }

  const toggleDmCallDeafen = () => {
    const newDeafened = !dmCallDeafened
    const audios = document.querySelectorAll('#voice-audio-container audio')
    audios.forEach(a => { a.muted = newDeafened })
    setDmCallDeafened(newDeafened)
    playVoiceSound(newDeafened ? '/mute_toggle.m4a' : '/unmute.wav', 1.5)
  }

  const toggleDmCallCamera = async () => {
    const pc = dmCallPeerConnection.current
    if (dmCallCameraOn) {
      if (dmCallCameraStream.current) {
        const vt = dmCallCameraStream.current.getVideoTracks()[0]
        if (pc && pc.getSenders) { const s = pc.getSenders().find(s => s.track === vt); if (s) pc.removeTrack(s) }
        dmCallCameraStream.current.getTracks().forEach(t => t.stop())
        dmCallCameraStream.current = null
      }
      setDmCallCameraOn(false)
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        dmCallCameraStream.current = stream
        const vt = stream.getVideoTracks()[0]
        if (pc && pc.addTrack) pc.addTrack(vt, stream)
        setDmCallCameraOn(true)
      } catch (e) { console.warn('DM call camera denied', e) }
    }
  }

  const toggleDmCallScreen = async () => {
    const pc = dmCallPeerConnection.current
    if (dmCallScreenOn) {
      if (dmCallScreenStream.current) {
        const vt = dmCallScreenStream.current.getVideoTracks()[0]
        if (pc && pc.getSenders) { const s = pc.getSenders().find(s => s.track === vt); if (s) pc.removeTrack(s) }
        dmCallScreenStream.current.getTracks().forEach(t => t.stop())
        dmCallScreenStream.current = null
      }
      setDmCallScreenOn(false)
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false })
        dmCallScreenStream.current = stream
        const vt = stream.getVideoTracks()[0]
        if (pc && pc.addTrack) pc.addTrack(vt, stream)
        setDmCallScreenOn(true)
        vt.onended = () => {
          if (pc && pc.getSenders) { const s = pc.getSenders().find(s => s.track === vt); if (s) pc.removeTrack(s) }
          dmCallScreenStream.current = null
          setDmCallScreenOn(false)
        }
      } catch (e) { console.warn('DM call screen denied', e) }
    }
  }

  const toggleVoiceMute = async () => {
    const newMuted = !voiceMuted
    if (!localStream.current) {
      if (newMuted) { setVoiceMuted(true); playVoiceSound('/mute_toggle.m4a', 1.5); socketRef.current?.emit('voice-mute-state', { muted: true, deafened: voiceDeafened }); return }
      // Try to get mic if we didn't have it before
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true })
        localStream.current = stream
        const det = startSpeakingDetection(stream, user.id)
        if (det) localSpeakingRef.current = det
        for (const pc of Object.values(peerConnections.current)) {
          stream.getAudioTracks().forEach(track => pc.addTrack(track, stream))
        }
        setVoiceMuted(false)
        playVoiceSound('/unmute.wav', 1.5)
        return
      } catch { setVoiceMuted(!voiceMuted); return }
    }
    const audioTrack = localStream.current.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !newMuted
    }
    setVoiceMuted(newMuted)
    playVoiceSound(newMuted ? '/mute_toggle.m4a' : '/unmute.wav', 1.5)
    socketRef.current?.emit('voice-mute-state', { muted: newMuted, deafened: voiceDeafened })
  }

  const toggleVoiceDeafen = () => {
    const audios = document.querySelectorAll('#voice-audio-container audio')
    const newDeafened = !voiceDeafened
    audios.forEach(a => { a.muted = newDeafened })
    setVoiceDeafened(newDeafened)
    playVoiceSound(newDeafened ? '/mute_toggle.m4a' : '/unmute.wav', 1.5)
    if (newDeafened) {
      // Deafen also mutes mic
      if (localStream.current) {
        const t = localStream.current.getAudioTracks()[0]
        if (t) t.enabled = false
      }
      setVoiceMuted(true)
      socketRef.current?.emit('voice-mute-state', { muted: true, deafened: true })
    } else {
      // Undeafen restores mic
      if (localStream.current) {
        const t = localStream.current.getAudioTracks()[0]
        if (t) t.enabled = true
      }
      setVoiceMuted(false)
      socketRef.current?.emit('voice-mute-state', { muted: false, deafened: false })
    }
  }

  // Enumerate audio/video devices
  const loadDevices = async () => {
    try {
      // Request permission first to get device labels
      try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()) } catch {}
      const devices = await navigator.mediaDevices.enumerateDevices()
      const inputs = devices.filter(d => d.kind === 'audioinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `${t('voice.inputDevice')} ${i + 1}` }))
      const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `${t('voice.outputDevice')} ${i + 1}` }))
      const cameras = devices.filter(d => d.kind === 'videoinput' && d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `${t('voice.cameraDevice')} ${i + 1}` }))
      setAudioDevices({ inputs, outputs })
      setVideoDevices(cameras)
      // Auto-select current device from active stream
      if (localStream.current) {
        const activeTrack = localStream.current.getAudioTracks()[0]
        if (activeTrack) {
          const settings = activeTrack.getSettings()
          if (settings.deviceId && inputs.find(d => d.id === settings.deviceId)) setSelectedMicId(settings.deviceId)
          else if (!selectedMicId && inputs.length) setSelectedMicId(inputs[0].id)
        }
      } else if (!selectedMicId && inputs.length) setSelectedMicId(inputs[0].id)
      if (!selectedSpeakerId && outputs.length) setSelectedSpeakerId(outputs[0].id)
      if (!selectedCameraId && cameras.length) setSelectedCameraId(cameras[0].id)
    } catch (e) { console.warn('Failed to enumerate devices', e) }
  }

  // Switch microphone device
  const switchMicrophone = async (deviceId) => {
    setSelectedMicId(deviceId)
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
      const newTrack = newStream.getAudioTracks()[0]
      if (localStream.current) {
        const oldTrack = localStream.current.getAudioTracks()[0]
        if (oldTrack) { localStream.current.removeTrack(oldTrack); oldTrack.stop() }
        localStream.current.addTrack(newTrack)
      } else {
        localStream.current = newStream
      }
      // Apply mute state
      newTrack.enabled = !voiceMuted
      // Replace track in all peer connections
      for (const pc of Object.values(peerConnections.current)) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'audio')
        if (sender) await sender.replaceTrack(newTrack)
      }
      // Restart local speaking detection
      stopSpeakingDetection(localSpeakingRef.current)
      const det = startSpeakingDetection(localStream.current, user.id)
      if (det) localSpeakingRef.current = det
    } catch (e) { console.warn('Failed to switch mic', e) }
  }

  // Switch speaker (output) device
  const switchSpeaker = async (deviceId) => {
    setSelectedSpeakerId(deviceId)
    const audios = document.querySelectorAll('#voice-audio-container audio')
    for (const audio of audios) {
      if (audio.setSinkId) { try { await audio.setSinkId(deviceId) } catch {} }
    }
  }

  // Apply mic volume (gain)
  const applyMicVolume = (vol) => {
    setMicVolume(vol)
    if (micGainNode.current) {
      micGainNode.current.gain.value = vol / 100
    }
  }

  // Apply sound volume
  const applySoundVolume = (vol) => {
    setSoundVolume(vol)
    const audios = document.querySelectorAll('#voice-audio-container audio')
    audios.forEach(a => {
      const uid = a._remoteUserId
      const userVol = uid && userVolumes[uid] !== undefined ? userVolumes[uid] : 100
      a.volume = Math.min((vol / 100) * (userVol / 100), 2)
    })
  }

  const applyUserVolume = (userId, vol) => {
    setUserVolumes(prev => ({ ...prev, [userId]: vol }))
    // Find the audio element for this user and apply
    const audios = document.querySelectorAll('#voice-audio-container audio')
    audios.forEach(a => {
      if (a._remoteUserId === userId) {
        a.volume = Math.min((soundVolume / 100) * (vol / 100), 2)
      }
    })
  }

  // Helper: renegotiate all peer connections after adding/removing tracks
  const renegotiateAll = async () => {
    for (const [sid, pc] of Object.entries(peerConnections.current)) {
      try {
        pc._makingOffer = true
        const offer = await pc.createOffer()
        if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') { pc._makingOffer = false; continue }
        await pc.setLocalDescription(offer)
        socket.emit('voice-offer', { targetSocketId: sid, offer: pc.localDescription })
      } catch (e) { console.warn('Renegotiation failed for', sid, e) }
      finally { pc._makingOffer = false }
    }
  }

  // Toggle camera
  const toggleCamera = async () => {
    if (cameraOn) {
      if (cameraStream.current) {
        const videoTrack = cameraStream.current.getVideoTracks()[0]
        for (const pc of Object.values(peerConnections.current)) {
          const sender = pc.getSenders().find(s => s.track === videoTrack)
          if (sender) pc.removeTrack(sender)
        }
        cameraStream.current.getTracks().forEach(t => t.stop())
        cameraStream.current = null
      }
      setCameraOn(false)
      socket.emit('voice-video-state', { camera: false, screen: screenShareOn })
      await renegotiateAll()
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : true })
        cameraStream.current = stream
        setCameraOn(true)
        const videoTrack = stream.getVideoTracks()[0]
        for (const pc of Object.values(peerConnections.current)) {
          pc.addTrack(videoTrack, stream)
        }
        socket.emit('voice-video-state', { camera: true, screen: screenShareOn })
        await renegotiateAll()
      } catch (e) { console.warn('Camera access denied', e) }
    }
  }

  // Switch camera device
  const switchCamera = async (deviceId) => {
    setSelectedCameraId(deviceId)
    if (!cameraOn) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } })
      // Remove old camera track from PCs
      if (cameraStream.current) {
        const oldTrack = cameraStream.current.getVideoTracks()[0]
        for (const pc of Object.values(peerConnections.current)) {
          const sender = pc.getSenders().find(s => s.track === oldTrack)
          if (sender) sender.replaceTrack(stream.getVideoTracks()[0])
        }
        cameraStream.current.getTracks().forEach(t => t.stop())
      }
      cameraStream.current = stream
    } catch (e) { console.warn('Failed to switch camera', e) }
  }

  // Toggle screen share
  const toggleScreenShare = async () => {
    if (screenShareOn) {
      if (screenStream.current) {
        const videoTrack = screenStream.current.getVideoTracks()[0]
        for (const pc of Object.values(peerConnections.current)) {
          const sender = pc.getSenders().find(s => s.track === videoTrack)
          if (sender) pc.removeTrack(sender)
        }
        screenStream.current.getTracks().forEach(t => t.stop())
        screenStream.current = null
      }
      setScreenShareOn(false)
      socket.emit('voice-video-state', { camera: cameraOn, screen: false })
      await renegotiateAll()
    } else {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 60 } }, audio: false })
        screenStream.current = stream
        setScreenShareOn(true)
        const videoTrack = stream.getVideoTracks()[0]
        // Hint browser to optimize for screen content (sharp text, less compression)
        if (videoTrack.contentHint !== undefined) videoTrack.contentHint = 'detail'
        for (const pc of Object.values(peerConnections.current)) {
          const sender = pc.addTrack(videoTrack, stream)
          // Set high bitrate for screen share quality
          if (sender) {
            try {
              const params = sender.getParameters()
              if (!params.encodings) params.encodings = [{}]
              params.encodings[0].maxBitrate = 5000000 // 5 Mbps for sharp screen share
              params.encodings[0].maxFramerate = 30
              params.encodings[0].scaleResolutionDownBy = 1.0 // No downscaling
              await sender.setParameters(params)
            } catch {}
          }
        }
        socket.emit('voice-video-state', { camera: cameraOn, screen: true })
        await renegotiateAll()
        videoTrack.onended = () => {
          for (const pc of Object.values(peerConnections.current)) {
            const sender = pc.getSenders().find(s => s.track === videoTrack)
            if (sender) pc.removeTrack(sender)
          }
          setScreenShareOn(false)
          screenStream.current = null
          socket.emit('voice-video-state', { camera: cameraOn, screen: false })
          renegotiateAll()
        }
      } catch (e) { console.warn('Screen share denied', e) }
    }
  }

  // Close popups on outside click
  useEffect(() => {
    const handler = (e) => {
      if (showMicPopup && micPopupRef.current && !micPopupRef.current.contains(e.target)) setShowMicPopup(false)
      if (showCameraPopup && cameraPopupRef.current && !cameraPopupRef.current.contains(e.target)) setShowCameraPopup(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMicPopup, showCameraPopup])

  // PWA keyboard handling — shift layout up when virtual keyboard opens
  useEffect(() => {
    if (!window.visualViewport) return
    const onResize = () => {
      const vv = window.visualViewport
      const offset = window.innerHeight - vv.height
      document.documentElement.style.setProperty('--keyboard-offset', offset + 'px')
      // Scroll chat to bottom when keyboard opens
      if (offset > 100 && messagesAreaRef.current) {
        setTimeout(() => messagesAreaRef.current?.scrollTo({ top: messagesAreaRef.current.scrollHeight }), 50)
      }
    }
    window.visualViewport.addEventListener('resize', onResize)
    window.visualViewport.addEventListener('scroll', onResize)
    return () => {
      window.visualViewport.removeEventListener('resize', onResize)
      window.visualViewport.removeEventListener('scroll', onResize)
    }
  }, [])

  // Load servers
  useEffect(() => {
    API('/api/servers').then(s => {
      setServers(s)
      // Don't auto-select a server on load — start on friends/DM screen
    })
  }, [])

  // Load channels when server changes
  useEffect(() => {
    if (!activeServer) return
    API(`/api/servers/${activeServer.id}/channels`).then(c => {
      setChannels(c)
      const textChannels = c.filter(ch => ch.type !== 'voice')
      if (textChannels.length > 0) setActiveChannel(textChannels[0])
      else setActiveChannel(null)
    }).catch(() => {
      setServers(prev => prev.filter(s => s.id !== activeServer.id))
      setActiveServer(null); setShowFriends(true); setChannels([]); setActiveChannel(null)
    })
    API(`/api/servers/${activeServer.id}/members`).then(ms => { setMembers(ms); seedProfiles(ms) }).catch(() => {})
    // Load voice state
    API(`/api/servers/${activeServer.id}/voice`).then(data => setVoiceUsers(prev => ({ ...prev, ...data }))).catch(() => {})
    // Load custom emojis
    API(`/api/servers/${activeServer.id}/emojis`).then(emojis => {
      setServerCustomEmojis(emojis)
      setServerSettingsEmojis(emojis)
    }).catch(() => { setServerCustomEmojis([]); setServerSettingsEmojis([]) })
  }, [activeServer?.id])

  // Clear reply when switching context
  useEffect(() => { setReplyTo(null) }, [activeChannel?.id, activeDM?.id])

  // Load messages when channel changes
  useEffect(() => {
    if (!activeChannel) { setMessages([]); setPinnedMessages([]); return }
    // Leave prev, join new
    socket?.emit('join-channel', activeChannel.id)
    API(`/api/channels/${activeChannel.id}/messages`).then(msgs => { setMessages(msgs); seedProfiles(msgs.map(m => m.user).filter(Boolean)) })
    API(`/api/channels/${activeChannel.id}/pinned`).then(p => { setPinnedMessages(p); setPinnedIndex(0) }).catch(() => setPinnedMessages([]))
    setTypingUsers([])
    // Clear unread for this channel
    setUnreadChannels(prev => { const n = { ...prev }; delete n[activeChannel.id]; return n })
    return () => { socket?.emit('leave-channel', activeChannel.id) }
  }, [activeChannel?.id])

  // Track which channel was already scrolled — force scroll on first messages load per channel
  const scrolledChannelRef = useRef(null)
  useEffect(() => {
    scrolledChannelRef.current = null
  }, [activeChannel?.id, activeDM?.id])

  // Scroll to bottom on new messages
  useEffect(() => {
    const channelKey = activeChannel?.id || activeDM?.id || null
    if (scrolledChannelRef.current !== channelKey) {
      // First batch of messages for this channel — always scroll to bottom instantly
      messagesEndRef.current?.scrollIntoView({ behavior: 'instant' })
      scrolledChannelRef.current = channelKey
    } else {
      // Subsequent messages — only scroll if already near bottom
      const area = messagesAreaRef.current
      if (area) {
        const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 150
        if (atBottom) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      } else {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    }
  }, [messages, dmMessages])

  const handleMessagesScroll = useCallback((e) => {
    const el = e.target
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollBtn(distFromBottom > 50)
  }, [])

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  const [slowmodeCooldown, setSlowmodeCooldown] = useState(0)
  const slowmodeTimerRef = useRef(null)

  const sendMessage = (e) => {
    e.preventDefault()
    if (!input.trim() || !activeChannel) return
    if (slowmodeCooldown > 0) {
      setSlowmodeError(`${t('slowmode.wait')} ${slowmodeCooldown} ${t('slowmode.sec')}`)
      setTimeout(() => setSlowmodeError(null), 3000)
      return
    }
    socket.emit('send-message', { channelId: activeChannel.id, content: input, replyToId: replyTo && !replyTo.isDM ? replyTo.id : undefined })
    setInput('')
    setReplyTo(null)
    playSound('message-send')
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    // Start client-side cooldown if channel has slowmode
    if (activeChannel.slowmode && activeChannel.slowmode > 0) {
      const isOwner = activeServer && activeServer.ownerId === user.id
      if (!isOwner) {
        setSlowmodeCooldown(activeChannel.slowmode)
        clearInterval(slowmodeTimerRef.current)
        slowmodeTimerRef.current = setInterval(() => {
          setSlowmodeCooldown(prev => {
            if (prev <= 1) { clearInterval(slowmodeTimerRef.current); return 0 }
            return prev - 1
          })
        }, 1000)
      }
    }
  }

  const handleInput = (e) => {
    setInput(e.target.value.slice(0, 1500))
    // Auto-resize textarea
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
    if (!activeChannel) return
    socket.emit('typing', { channelId: activeChannel.id })
    clearTimeout(typingTimeout.current)
    typingTimeout.current = setTimeout(() => {}, 3000)
  }

  const handleChatKeyDown = (e, sendFn) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendFn(e)
      // Reset textarea height
      e.target.style.height = 'auto'
    }
  }

  const createServer = async (e) => {
    e.preventDefault()
    if (!newServerName.trim()) return
    const s = await API('/api/servers', { method: 'POST', body: JSON.stringify({ name: newServerName }) })
    setServers(prev => [...prev, s])
    setActiveServer(s)
    setShowCreateServer(false)
    setNewServerName('')
  }

  const createChannel = async (e) => {
    e.preventDefault()
    if (!newChannelName.trim() || !activeServer) return
    try {
      const c = await API(`/api/servers/${activeServer.id}/channels`, { method: 'POST', body: JSON.stringify({ name: newChannelName, type: newChannelType }) })
      if (newChannelType === 'text') setActiveChannel(c)
    } catch (err) { console.error(err) }
    setShowCreateChannel(false)
    setNewChannelName('')
    setNewChannelType('text')
  }

  const createVoiceChannel = async (e) => {
    e.preventDefault()
    if (!newVoiceChannelName.trim() || !activeServer) return
    try {
      await API(`/api/servers/${activeServer.id}/channels`, { method: 'POST', body: JSON.stringify({ name: newVoiceChannelName, type: 'voice' }) })
    } catch (err) { console.error(err) }
    setShowCreateVoiceChannel(false)
    setNewVoiceChannelName('')
  }

  // Close popup on outside click
  useEffect(() => {
    if (!showUserMenu) return
    const handler = (e) => {
      if (userPopupRef.current && !userPopupRef.current.contains(e.target)) {
        setShowUserMenu(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showUserMenu])

  const changeStatus = async (status) => {
    try {
      const updated = await API('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ status }) })
      setUser(updated)
    } catch {}
    setShowUserMenu(false)
  }

  const openShop = async (tab = 'subscription') => {
    setShopTab(tab)
    setShowShop(true)
    setShowUserMenu(false)
    try {
      const [status, boosts] = await Promise.all([
        API('/api/premium/status'),
        API('/api/boosts/my'),
      ])
      setPremiumStatus(status)
      setBoostData(boosts)
    } catch {}
  }

  const activatePremium = async (tier) => {
    setShopLoading(true)
    try {
      await API('/api/premium/activate', { method: 'POST', body: JSON.stringify({ tier }) })
      const [status, boosts] = await Promise.all([API('/api/premium/status'), API('/api/boosts/my')])
      setPremiumStatus(status)
      setBoostData(boosts)
      setUser(u => ({ ...u, premium: status.premium, premiumExpiry: status.premiumExpiry }))
    } catch (e) { alert(e.message) }
    setShopLoading(false)
  }

  const cancelPremium = async () => {
    if (!window.confirm('Отменить подписку? Все голоса будут сняты с серверов.')) return
    setShopLoading(true)
    try {
      await API('/api/premium/cancel', { method: 'DELETE' })
      const [status, boosts] = await Promise.all([API('/api/premium/status'), API('/api/boosts/my')])
      setPremiumStatus(status)
      setBoostData(boosts)
      setUser(u => ({ ...u, premium: null, premiumExpiry: null }))
    } catch (e) { alert(e.message) }
    setShopLoading(false)
  }

  const giveBoost = async (serverId, amount) => {
    try {
      await API('/api/boosts/give', { method: 'POST', body: JSON.stringify({ serverId, amount }) })
      const boosts = await API('/api/boosts/my')
      setBoostData(boosts)
    } catch (e) { alert(e.message) }
  }

  const removeBoost = async (serverId, amount) => {
    try {
      await API('/api/boosts/remove', { method: 'POST', body: JSON.stringify({ serverId, amount }) })
      const boosts = await API('/api/boosts/my')
      setBoostData(boosts)
    } catch (e) { alert(e.message) }
  }

  const openProfileSettings = () => {
    setProfileForm({ username: user.username, bio: user.bio || '', bannerColor: user.bannerColor || null, bannerImg: user.bannerImg || null, statusEmoji: user.statusEmoji || null, avatarFrame: user.avatarFrame || null })
    setProfileError('')
    setSettingsTab('profile')
    setPrivacyDeleteConfirm(false)
    setPrivacyDeleteText('')
    setShowProfileSettings(true)
    setShowUserMenu(false)
  }

  const changeLanguage = async (lang) => {
    const BUILTIN = ['ru', 'en', 'zh']
    setLangStorage(lang)
    setAppLang(lang)
    if (!BUILTIN.includes(lang)) {
      // Check localStorage cache
      const cacheKey = `i18n_cache_${lang}`
      const cached = localStorage.getItem(cacheKey)
      if (cached) {
        try {
          setDynamicTranslations(lang, JSON.parse(cached))
          forceUpdate(n => n + 1)
          return
        } catch {}
      }
      // Fetch translation from server
      setLangLoading(true)
      try {
        const keys = getAllKeys()
        const values = getAllValues()
        const data = await API('/api/translate', { method: 'POST', body: JSON.stringify({ texts: values, to: lang, from: 'ru' }) })
        const map = {}
        keys.forEach((k, i) => { map[k] = data.translations[i] ?? values[i] })
        setDynamicTranslations(lang, map)
        localStorage.setItem(cacheKey, JSON.stringify(map))
      } catch (err) {
        console.error('Translation failed:', err)
      } finally {
        setLangLoading(false)
      }
    }
    forceUpdate(n => n + 1)
  }

  const changeTheme = (theme) => {
    localStorage.setItem('appTheme', theme)
    setAppTheme(theme)
    applyTheme(theme)
  }

  const changeAccent = (color) => {
    localStorage.setItem('appAccent', color)
    setAppAccent(color)
    applyAccentColor(color)
  }

  const saveProfile = async (e) => {
    e.preventDefault()
    setProfileSaving(true)
    setProfileError('')
    try {
      const updated = await API('/api/auth/me', { method: 'PATCH', body: JSON.stringify(profileForm) })
      setUser(updated)
      setShowProfileSettings(false)
    } catch (err) {
      setProfileError(err.message)
    } finally {
      setProfileSaving(false)
    }
  }

  // Load friends data
  const loadFriends = () => {
    API('/api/friends').then(fs => { setFriends(fs); seedProfiles(fs) }).catch(() => {})
    API('/api/friends/requests').then(setFriendRequests).catch(() => {})
    API('/api/friends/requests/sent').then(data => {
      setOutgoingRequests(data)
      setSentFriendRequests(new Map(data.map(r => [r.toId, r.id])))
    }).catch(() => {})
  }

  useEffect(() => { loadFriends() }, [])
  // Seed self into profile store
  useEffect(() => { if (user?.id) patchProfile(user.id, user) }, [user?.id])

  // Load DM channels
  const loadDmChannels = () => {
    API('/api/dm-channels').then(dms => { setDmChannels(dms); seedProfiles(dms.map(d => d.partner).filter(Boolean)) }).catch(() => {})
  }
  useEffect(() => { loadDmChannels() }, [])

  // Load DM messages when activeDM changes
  useEffect(() => {
    if (!activeDM) { setDmMessages([]); setDmPinnedMessages([]); return }
    socket?.emit('join-dm', activeDM.id)
    API(`/api/dm-channels/${activeDM.id}/messages`).then(msgs => { setDmMessages(msgs); seedProfiles(msgs.map(m => m.user).filter(Boolean)) })
    API(`/api/dm-channels/${activeDM.id}/pinned`).then(p => { setDmPinnedMessages(p); setDmPinnedIndex(0) }).catch(() => setDmPinnedMessages([]))
    // Clear unread for this DM
    setUnreadDMs(prev => { const n = { ...prev }; delete n[activeDM.id]; return n })
  }, [activeDM?.id])

  // Compute server unread: sum of all channel unreads for that server
  const getServerUnread = (serverId) => {
    return channels.filter(c => c.serverId === serverId).reduce((sum, c) => sum + (unreadChannels[c.id] || 0), 0)
  }
  // We need all channels across all servers for server badge calculation
  const [allChannels, setAllChannels] = useState([])
  useEffect(() => {
    if (servers.length === 0) return
    Promise.all(servers.map(s => API(`/api/servers/${s.id}/channels`).catch(() => []))).then(results => {
      setAllChannels(results.flat())
    })
  }, [servers.length])
  // Server layout (drag-reorder + folders)
  const effectiveLayout = useMemo(() => {
    const serverSet = new Set(servers.map(s => s.id))
    const base = serverLayout || servers.map(s => ({ type: 'server', id: s.id }))
    const allLayoutIds = new Set()
    base.forEach(item => {
      if (item.type === 'server') allLayoutIds.add(item.id)
      else if (item.type === 'folder') item.serverIds.forEach(id => allLayoutIds.add(id))
    })
    const missing = servers.filter(s => !allLayoutIds.has(s.id)).map(s => ({ type: 'server', id: s.id }))
    const clean = base.map(item => {
      if (item.type === 'server') return serverSet.has(item.id) ? item : null
      if (item.type === 'folder') {
        const ids = item.serverIds.filter(id => serverSet.has(id))
        return ids.length > 0 ? { ...item, serverIds: ids } : null
      }
      return null
    }).filter(Boolean)
    return [...clean, ...missing]
  }, [serverLayout, servers])

  effectiveLayoutRef.current = effectiveLayout

  const saveServerLayout = (layout) => {
    setServerLayout(layout)
    localStorage.setItem('serverLayout', JSON.stringify(layout))
  }

  const extractFromFolder = (layout, dragId) => {
    // If dragId is inside a folder, remove it and return cleaned layout + whether it was in a folder
    const folderIdx = layout.findIndex(item => item.type === 'folder' && item.serverIds.includes(dragId))
    if (folderIdx === -1) return { layout, wasInFolder: false }
    const folder = layout[folderIdx]
    const newServerIds = folder.serverIds.filter(id => id !== dragId)
    const newLayout = layout.map((item, i) => {
      if (i !== folderIdx) return item
      return newServerIds.length > 0 ? { ...item, serverIds: newServerIds } : null
    }).filter(Boolean)
    return { layout: newLayout, wasInFolder: true }
  }

  const executeSrvDrop = (dragId, drop) => {
    const layout = effectiveLayoutRef.current
    const srvs = serversRef.current
    if (drop.action === 'reorder') {
      // First extract from folder if needed
      const { layout: baseLayout, wasInFolder } = extractFromFolder(layout, dragId)
      const newLayout = [...baseLayout]
      const dragIdx = newLayout.findIndex(item =>
        (item.type === 'server' && item.id === dragId) ||
        (item.type === 'folder' && item.folderId === dragId)
      )
      if (dragIdx === -1) {
        // Was in folder and now extracted — just insert at drop position
        let at = Math.min(drop.insertAt, newLayout.length)
        newLayout.splice(at, 0, { type: 'server', id: dragId })
        saveServerLayout(newLayout)
        return
      }
      const [dragged] = newLayout.splice(dragIdx, 1)
      let at = drop.insertAt
      if (dragIdx < at) at--
      newLayout.splice(Math.min(at, newLayout.length), 0, dragged)
      saveServerLayout(newLayout)
    } else if (drop.action === 'merge') {
      const { layout: baseLayout } = extractFromFolder(layout, dragId)
      const targetIdx = baseLayout.findIndex(item => item.type === 'server' && item.id === drop.targetServerId)
      if (targetIdx === -1) return
      const newLayout = baseLayout.filter(item =>
        !(item.type === 'server' && (item.id === dragId || item.id === drop.targetServerId))
      )
      const dragServer = srvs.find(s => s.id === dragId)
      const newFolder = {
        type: 'folder',
        folderId: 'folder_' + Date.now(),
        name: 'Папка',
        serverIds: [drop.targetServerId, dragId],
        color: appAccent
      }
      let insertPos = targetIdx
      if (baseLayout.findIndex(item => item.type === 'server' && item.id === dragId) < targetIdx) insertPos--
      newLayout.splice(Math.max(0, insertPos), 0, newFolder)
      saveServerLayout(newLayout)
    } else if (drop.action === 'add-to-folder') {
      const { layout: baseLayout } = extractFromFolder(layout, dragId)
      const newLayout = baseLayout.map(item => {
        if (item.type === 'folder' && item.folderId === drop.folderId) {
          if (item.serverIds.includes(dragId)) return item
          return { ...item, serverIds: [...item.serverIds, dragId] }
        }
        return item
      }).filter(item => !(item.type === 'server' && item.id === dragId))
      saveServerLayout(newLayout)
    }
  }

  const startSrvDrag = (e, dragId) => {
    if (e.button !== 0) return
    const srv = serversRef.current.find(s => s.id === dragId)
    if (srv?.verified) return
    e.preventDefault()
    e.stopPropagation()
    srvDragRef.current = { active: true, moved: false, id: dragId, startY: e.clientY, dropTarget: null }

    const getSortedRects = () =>
      Object.entries(srvItemRefs.current)
        .map(([id, el]) => {
          if (!el) return null
          const rect = el.getBoundingClientRect()
          return { id, rect, itemType: el.dataset.itemType, verified: el.dataset.verified === 'true' }
        })
        .filter(Boolean)
        .sort((a, b) => a.rect.top - b.rect.top)

    const calcDrop = (mouseY) => {
      const rects = getSortedRects()
      for (let i = 0; i < rects.length; i++) {
        const { id, rect, itemType, verified } = rects[i]
        if (mouseY < rect.top) return { action: 'reorder', insertAt: i }
        if (mouseY <= rect.bottom) {
          if (id === dragId) {
            return mouseY <= (rect.top + rect.bottom) / 2
              ? { action: 'reorder', insertAt: i }
              : { action: 'reorder', insertAt: i + 1 }
          }
          if (itemType === 'folder') return { action: 'add-to-folder', folderId: id }
          if (!verified) {
            const third = (rect.bottom - rect.top) / 3
            if (mouseY > rect.top + third && mouseY < rect.bottom - third) {
              return { action: 'merge', targetServerId: id }
            }
          }
          return mouseY <= (rect.top + rect.bottom) / 2
            ? { action: 'reorder', insertAt: i }
            : { action: 'reorder', insertAt: i + 1 }
        }
      }
      return { action: 'reorder', insertAt: rects.length }
    }

    const onMove = (me) => {
      if (!srvDragRef.current.active) return
      if (!srvDragRef.current.moved && Math.abs(me.clientY - srvDragRef.current.startY) > 4) {
        srvDragRef.current.moved = true
        setSrvDragState({ id: dragId })
      }
      if (srvDragRef.current.moved) {
        setSrvDragPos({ x: me.clientX, y: me.clientY })
        const drop = calcDrop(me.clientY)
        srvDragRef.current.dropTarget = drop
        setSrvDropTarget(drop)
      }
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      if (srvDragRef.current.moved && srvDragRef.current.dropTarget) {
        executeSrvDrop(srvDragRef.current.id, srvDragRef.current.dropTarget)
      }
      srvDragRef.current = { active: false, moved: false, id: null, startY: 0, dropTarget: null }
      setSrvDragState(null)
      setSrvDropTarget(null)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const getServerUnreadAll = (serverId) => {
    return allChannels.filter(c => c.serverId === serverId).reduce((sum, c) => sum + (unreadChannels[c.id] || 0), 0)
  }

  // Mark as read helpers
  const markChannelRead = (channelId, e) => {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setUnreadChannels(prev => { const n = { ...prev }; delete n[channelId]; return n })
  }
  const markServerRead = (serverId, e) => {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setUnreadChannels(prev => {
      const n = { ...prev }
      allChannels.filter(c => c.serverId === serverId).forEach(c => delete n[c.id])
      return n
    })
  }
  const markDMRead = (dmId, e) => {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setUnreadDMs(prev => { const n = { ...prev }; delete n[dmId]; return n })
  }
  const markAllDMsRead = (e) => {
    if (e) { e.stopPropagation(); e.preventDefault() }
    setUnreadDMs({})
  }

  // Total DM unread
  const totalDMUnread = Object.values(unreadDMs).reduce((s, v) => s + v, 0)

  // Load blocked users
  const loadBlockedUsers = () => {
    API('/api/blocked-users').then(setBlockedUsers).catch(() => {})
    API('/api/blocked-users-details').then(setBlockedUsersDetails).catch(() => {})
  }
  useEffect(() => { loadBlockedUsers() }, [])

  // DM context menu handler
  const handleDmContext = (e, dm) => {
    e.preventDefault()
    e.stopPropagation()
    const x = Math.min(e.clientX, window.innerWidth - 220)
    const y = Math.min(e.clientY, window.innerHeight - 300)
    setDmCtx({ dm, x, y })
    setDmMuteSub(false)
  }

  const deleteDmChannel = (dm, mode) => {
    setDmCtx(null)
    setConfirmDialog({
      title: mode === 'both' ? t('dm.deleteForAll') : t('dm.deleteForSelf'),
      message: mode === 'both'
        ? t('dm.deleteConfirm').replace('{name}', dm.partner?.username)
        : t('dm.hideConfirm').replace('{name}', dm.partner?.username),
      confirmText: t('common.delete'),
      danger: true,
      onConfirm: async () => {
        try {
          await API(`/api/dm-channels/${dm.id}?mode=${mode}`, { method: 'DELETE' })
          setDmChannels(prev => prev.filter(d => d.id !== dm.id))
          if (activeDM?.id === dm.id) setActiveDM(null)
        } catch {}
        setConfirmDialog(null)
      }
    })
  }

  const clearDmChat = (dm, mode) => {
    setDmCtx(null)
    setConfirmDialog({
      title: mode === 'both' ? 'Очистить для всех' : 'Очистить у себя',
      message: mode === 'both'
        ? `Очистить историю переписки с ${dm.partner?.username} для обоих участников? Это действие нельзя отменить.`
        : `Очистить историю переписки с ${dm.partner?.username} у себя?`,
      confirmText: 'Очистить',
      danger: true,
      onConfirm: async () => {
        try {
          await API(`/api/dm-channels/${dm.id}/messages?mode=${mode}`, { method: 'DELETE' })
          if (activeDM?.id === dm.id) setDmMessages([])
        } catch {}
        setConfirmDialog(null)
      }
    })
  }

  const blockUser = async (userId, username) => {
    setDmCtx(null)
    setConfirmDialog({
      title: t('dm.blockUser'),
      message: t('friends.blockConfirm').replace('{name}', username),
      confirmText: t('dm.block'),
      danger: true,
      onConfirm: async () => {
        try {
          const token = localStorage.getItem('token') || sessionStorage.getItem('token')
          await fetch(`/api/users/${userId}/block`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } })
          const res = await fetch('/api/blocked-users', { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } })
          const blocked = await res.json()
          setBlockedUsers(blocked)
          setFriends(prev => prev.filter(f => f.id !== userId))
          loadBlockedUsers()
        } catch (err) { console.error('BLOCK ERROR:', err) }
        setConfirmDialog(null)
      }
    })
  }

  const unblockUser = async (userId) => {
    setDmCtx(null)
    try {
      await API(`/api/users/${userId}/unblock`, { method: 'POST' })
      setBlockedUsers(prev => prev.filter(id => id !== userId))
      setBlockedUsersDetails(prev => prev.filter(u => u.id !== userId))
    } catch {}
  }

  const showUserProfile = async (partnerUser, anchorX, anchorY) => {
    setDmCtx(null)
    let fullUser = partnerUser
    try {
      const profile = await API(`/api/users/${partnerUser.id}/profile`)
      // Use real-time status from members/friends state (updated via socket) instead of DB value
      const liveUser = members.find(m => m.id === partnerUser.id) || friends.find(f => f.id === partnerUser.id)
      fullUser = { ...partnerUser, ...profile, status: liveUser?.status ?? profile.status }
    } catch {}
    setUserProfilePopup({
      user: fullUser,
      x: Math.min(anchorX, window.innerWidth - 300),
      y: Math.min(anchorY, window.innerHeight - 350)
    })
  }

  const openDM = async (targetUserId) => {
    try {
      const dm = await API('/api/dm-channels', { method: 'POST', body: JSON.stringify({ targetUserId }) })
      setActiveServer(null)
      setActiveChannel(null)
      setShowFriends(true)
      setActiveDM(dm)
      setFriendsTab('all')
      loadDmChannels()
      if (isMobile) setMobileInChat(true)
      return dm
    } catch {}
  }

  const sendDM = (e) => {
    e.preventDefault()
    if (!input.trim() || !activeDM) return
    socket.emit('send-dm', { dmChannelId: activeDM.id, content: input, replyToId: replyTo && replyTo.isDM ? replyTo.id : undefined })
    setInput('')
    setReplyTo(null)
    playSound('message-send')
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }

  const handleFriendNameKey = (e) => {
    if (e.key === ' ' || e.key === '#') {
      e.preventDefault()
      if (friendSearch.trim()) friendTagRef.current?.focus()
    }
  }

  const handleFriendTagInput = (e) => {
    const v = e.target.value.replace(/\D/g, '').slice(0, 4)
    setFriendTag(v)
  }

  const searchFriend = async (e) => {
    e.preventDefault()
    if (!friendSearch.trim() || friendTag.length !== 4) return
    const query = `${friendSearch.trim()}#${friendTag}`
    setFriendSearching(true)
    setFriendSearchError('')
    setFriendSearchResult(null)
    try {
      const data = await API('/api/friends/search', { method: 'POST', body: JSON.stringify({ query }) })
      setFriendSearchResult(data)
    } catch (err) {
      setFriendSearchError(err.message === 'self' ? t('friends.searchSelf') : err.message)
    } finally {
      setFriendSearching(false)
    }
  }

  const sendFriendRequest = async (toUserId) => {
    try {
      const result = await API('/api/friends/request', { method: 'POST', body: JSON.stringify({ toUserId }) })
      if (result.autoAccepted) {
        // Mutual request — auto-accepted, reload friends
        loadFriends()
        setSentFriendRequests(prev => { const n = new Map(prev); n.delete(toUserId); return n })
        setOutgoingRequests(prev => prev.filter(r => r.toId !== toUserId))
      } else {
        setFriendSearchResult(prev => prev ? { ...prev, friendStatus: 'pending' } : prev)
        setSentFriendRequests(prev => new Map([...prev, [toUserId, result.id]]))
        // Add to outgoing requests list for pending tab
        loadFriends()
      }
    } catch (err) {
      setFriendSearchError(err.message)
      // If already friends, reload friends list to fix UI
      if (err.message === 'Already friends') loadFriends()
      // If request already pending from us, show pending state with request ID for cancellation
      if (err.message === 'Request already pending') setSentFriendRequests(prev => new Map([...prev, [toUserId, err.data?.requestId || null]]))
    }
  }

  const acceptFriendRequest = async (requestId) => {
    try {
      await API(`/api/friends/requests/${requestId}/accept`, { method: 'POST' })
      setFriendRequests(prev => prev.filter(r => r.id !== requestId))
      loadFriends()
    } catch {}
  }

  const declineFriendRequest = async (requestId) => {
    try {
      await API(`/api/friends/requests/${requestId}/decline`, { method: 'POST' })
      setFriendRequests(prev => prev.filter(r => r.id !== requestId))
    } catch {}
  }

  const cancelFriendRequest = async (toUserId, reqId) => {
    const requestId = reqId || sentFriendRequests.get(toUserId)
    if (!requestId) return
    try {
      await API(`/api/friends/requests/${requestId}/cancel`, { method: 'POST' })
      setSentFriendRequests(prev => { const n = new Map(prev); n.delete(toUserId); return n })
      setOutgoingRequests(prev => prev.filter(r => r.id !== requestId))
      setFriendSearchResult(prev => prev ? { ...prev, friendStatus: null } : prev)
    } catch {}
  }

  const removeFriend = async (requestId) => {
    try {
      await API(`/api/friends/${requestId}`, { method: 'DELETE' })
      setFriends(prev => prev.filter(f => f.requestId !== requestId))
    } catch {}
  }

  const confirmRemoveFriend = (friend) => {
    setConfirmDialog({
      title: t('friends.removeFriend'),
      message: t('friends.removeConfirm').replace('{name}', friend.username),
      confirmText: t('friends.remove'),
      danger: true,
      onConfirm: () => {
        removeFriend(friend.requestId)
        setConfirmDialog(null)
      }
    })
  }

  const openFriends = () => {
    setShowFriends(true)
    setActiveServer(null)
    setActiveChannel(null)
    setActiveDM(null)
    setMobileInChat(false)
    loadFriends()
    loadDmChannels()
  }

  // ── Server context menu ──
  const handleServerContext = (e, s) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    setServerCtx({ server: s, x: rect.right + 8, y: rect.top })
  }

  useEffect(() => {
    const close = (e) => {
      if (serverCtxRef.current && !serverCtxRef.current.contains(e.target)) setServerCtx(null)
    }
    if (serverCtx) { document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }
  }, [serverCtx])

  useEffect(() => {
    const close = (e) => {
      if (dmCtxRef.current && !dmCtxRef.current.contains(e.target)) { setDmCtx(null); setDmMuteSub(false) }
    }
    if (dmCtx) { document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }
  }, [dmCtx])

  useEffect(() => {
    const close = (e) => {
      if (userProfileRef.current && !userProfileRef.current.contains(e.target)) setUserProfilePopup(null)
    }
    if (userProfilePopup) { document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }
  }, [userProfilePopup])

  useEffect(() => {
    const close = (e) => {
      if (serverMenuRef.current && !serverMenuRef.current.contains(e.target)) setShowServerMenu(false)
    }
    if (showServerMenu) { document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }
  }, [showServerMenu])

  const leaveServer = (serverId) => {
    const server = servers.find(s => s.id === serverId)
    setServerCtx(null)
    setConfirmDialog({
      title: t('server.leave'),
      message: `${t('server.leaveConfirm')} «${server?.name}»?`,
      confirmText: t('server.leaveBtn'),
      danger: true,
      onConfirm: async () => {
        try {
          await API(`/api/servers/${serverId}/leave`, { method: 'DELETE' })
          setServers(prev => prev.filter(s => s.id !== serverId))
          if (activeServer?.id === serverId) { setActiveServer(null); setShowFriends(true) }
        } catch {}
        setConfirmDialog(null)
      }
    })
  }

  const deleteServer = (serverId) => {
    const server = servers.find(s => s.id === serverId)
    setServerCtx(null)
    setConfirmDialog({
      title: t('server.delete'),
      message: `${t('server.deleteConfirm')} «${server?.name}»? ${t('server.deleteWarn')}`,
      confirmText: t('server.deleteBtn'),
      danger: true,
      onConfirm: async () => {
        try {
          await API(`/api/servers/${serverId}`, { method: 'DELETE' })
          setServers(prev => prev.filter(s => s.id !== serverId))
          if (activeServer?.id === serverId) { setActiveServer(null); setShowFriends(true) }
        } catch {}
        setConfirmDialog(null)
      }
    })
  }

  const copyServerId = (serverId) => {
    navigator.clipboard.writeText(serverId).catch(() => {})
    setServerCtx(null)
  }

  const sendVoiceInvite = async (channelId, targetUserId) => {
    setVoiceInviteSending(prev => ({ ...prev, [targetUserId]: true }))
    try {
      await API(`/api/channels/${channelId}/voice-invite`, { method: 'POST', body: JSON.stringify({ targetUserId }) })
      setVoiceInviteSending(prev => ({ ...prev, [targetUserId]: 'done' }))
    } catch (err) {
      setVoiceInviteSending(prev => ({ ...prev, [targetUserId]: 'error' }))
    }
  }

  const sendInvite = async (serverId, targetUserId) => {
    setInviteSending(prev => ({ ...prev, [targetUserId]: true }))
    try {
      await API(`/api/servers/${serverId}/invite`, { method: 'POST', body: JSON.stringify({ targetUserId }) })
      setInviteSending(prev => ({ ...prev, [targetUserId]: 'done' }))
    } catch (err) {
      setInviteSending(prev => ({ ...prev, [targetUserId]: 'error' }))
    }
  }

  const joinServerFromInvite = (serverId, serverName) => {
    setConfirmDialog({
      title: t('server.joinTitle'),
      message: `${t('server.joinConfirm')} «${serverName}»?`,
      confirmText: t('server.joinBtn'),
      danger: false,
      onConfirm: async () => {
        try {
          await API(`/api/servers/${serverId}/join`, { method: 'POST' })
          const updatedServers = await API('/api/servers')
          setServers(updatedServers)
          const joined = updatedServers.find(s => s.id === serverId)
          if (joined) { setActiveServer(joined); setShowFriends(false); setActiveDM(null) }
        } catch {}
        setConfirmDialog(null)
      }
    })
  }

  const joinVoiceFromInvite = async (serverId, channelId, channelName) => {
    // First make sure we're on the right server
    let srv = servers.find(s => s.id === serverId)
    if (!srv) {
      try {
        await API(`/api/servers/${serverId}/join`, { method: 'POST' })
        const updatedServers = await API('/api/servers')
        setServers(updatedServers)
        srv = updatedServers.find(s => s.id === serverId)
      } catch { return }
    }
    if (srv) {
      setActiveServer(srv)
      setShowFriends(false)
      setActiveDM(null)
      // Load channels and find the voice channel
      const chs = await API(`/api/servers/${srv.id}/channels`)
      setChannels(chs)
      const vc = chs.find(c => c.id === channelId)
      if (vc) joinVoiceChannel(vc)
    }
  }

  const kickMember = async (memberId) => {
    if (!activeServer) return
    try {
      await API(`/api/servers/${activeServer.id}/members/${memberId}/kick`, { method: 'POST' })
      setMembers(prev => prev.filter(m => m.id !== memberId))
    } catch {}
  }

  const toggleMemberRole = async (memberId, currentRole) => {
    if (!activeServer) return
    const newRole = currentRole === 'admin' ? 'user' : 'admin'
    try {
      await API(`/api/servers/${activeServer.id}/members/${memberId}/role`, { method: 'POST', body: JSON.stringify({ role: newRole }) })
      setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role: newRole } : m))
    } catch {}
    setMemberCtx(null)
  }

  // Helper: check if current user has a permission on active server
  const hasServerPerm = useCallback((perm) => {
    if (!activeServer) return false
    if (activeServer.ownerId === user.id) return true
    const myMember = members.find(m => m.id === user.id)
    if (!myMember) return false
    if (myMember.role === 'admin' && activeServer.adminPermissions?.[perm]) return true
    // Check custom role permissions
    const customRole = (activeServer.customRoles || []).find(r => r.id === myMember.role)
    if (customRole && customRole.permissions?.[perm]) return true
    return false
  }, [activeServer, members, user.id])

  // ── Central profile helpers ──
  // Merge partial data into the profile store for one user
  const patchProfile = useCallback((userId, fields) => {
    if (!userId) return
    setUserProfiles(prev => ({ ...prev, [userId]: { ...(prev[userId] || {}), id: userId, ...fields } }))
  }, [])

  // Seed profile store from an array of user objects
  const seedProfiles = useCallback((users) => {
    if (!users?.length) return
    setUserProfiles(prev => {
      const next = { ...prev }
      users.forEach(u => { if (u?.id) next[u.id] = { ...(next[u.id] || {}), ...u } })
      return next
    })
  }, [])

  // Get profile for a user — live store takes priority over fallback snapshot
  const prof = useCallback((id, fallback = {}) => {
    const stored = userProfiles[id]
    if (!stored) return fallback
    return { ...fallback, ...stored }
  }, [userProfiles])

  // Returns custom role color for a user in the active server, or null
  const getMemberRoleColor = useCallback((userId) => {
    if (!activeServer) return null
    const member = members.find(m => m.id === userId)
    if (!member || !member.role || member.role === 'user' || member.role === 'admin') return null
    const customRole = (activeServer.customRoles || []).find(r => r.id === member.role)
    return customRole?.color || null
  }, [activeServer, members])

  // ── Message context menu ──
  const handleMsgContext = (e, msg, isDM = false) => {
    if (msg.type === 'system') return
    e.preventDefault()
    e.stopPropagation()
    const menuH = 200, menuW = 180
    const x = Math.min(e.clientX, window.innerWidth - menuW - 8)
    const y = Math.min(e.clientY, window.innerHeight - menuH - 8)
    setMsgCtx({ msg, x, y, isDM })
  }

  useEffect(() => {
    const close = (e) => {
      if (msgCtxRef.current && !msgCtxRef.current.contains(e.target)) setMsgCtx(null)
    }
    if (msgCtx) { document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close) }
  }, [msgCtx])

  useEffect(() => {
    if (!pinChoiceCtx) return
    const close = () => setPinChoiceCtx(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [pinChoiceCtx])

  useEffect(() => {
    if (!channelMenu) return
    const close = (e) => {
      if (channelMenuRef.current && !channelMenuRef.current.contains(e.target)) { setChannelMenu(null); setChannelMuteSub(false) }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [channelMenu])

  const MUTE_FOREVER = 9999999999999
  const muteChannel = (channelId, durationMin) => {
    const expires = durationMin === Infinity ? MUTE_FOREVER : Date.now() + durationMin * 60 * 1000
    setMutedChannels(prev => {
      const next = { ...prev, [channelId]: expires }
      localStorage.setItem('mutedChannels', JSON.stringify(next))
      return next
    })
    setChannelMenu(null)
    setChannelMuteSub(false)
  }

  const unmuteChannel = (channelId) => {
    setMutedChannels(prev => {
      const next = { ...prev }
      delete next[channelId]
      localStorage.setItem('mutedChannels', JSON.stringify(next))
      return next
    })
    setChannelMenu(null)
  }

  const deleteChannel = (channel) => {
    setChannelMenu(null)
    setConfirmDialog({
      title: t('channel.delete'),
      message: `${t('channel.deleteConfirm')} ${channel.type === 'voice' ? '🔊' : '#'}${channel.name}`,
      confirmText: t('common.delete'),
      danger: true,
      onConfirm: async () => {
        try {
          await API(`/api/channels/${channel.id}`, { method: 'DELETE' })
        } catch (e) { console.error(e) }
        setConfirmDialog(null)
      }
    })
  }

  const clearChannelMessages = (channel) => {
    setChannelMenu(null)
    setConfirmDialog({
      title: t('channel.clear') || 'Очистить канал',
      message: (t('channel.clearConfirm') || 'Очистить все сообщения в канале #{name}?').replace('{name}', channel.name),
      confirmText: t('channel.clear') || 'Очистить',
      danger: true,
      onConfirm: async () => {
        try {
          await API(`/api/channels/${channel.id}/clear`, { method: 'POST' })
          if (activeChannel?.id === channel.id) setMessages([])
        } catch (e) { console.error(e) }
        setConfirmDialog(null)
      }
    })
  }

  const handleChannelGear = (e, channel) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    const x = Math.min(rect.right + 4, window.innerWidth - 220)
    const y = Math.min(rect.top, window.innerHeight - 280)
    setChannelMenu({ channel, x, y })
    setChannelMuteSub(false)
  }

  const copyMsgText = (text) => {
    navigator.clipboard.writeText(text).catch(() => {})
    setMsgCtx(null)
  }

  const saveMedia = async (url, filename) => {
    setMsgCtx(null)
    try {
      const res = await fetch(url)
      const blob = await res.blob()
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename || url.split('/').pop().split('?')[0] || 'file'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    } catch {
      window.open(url, '_blank')
    }
  }

  const startEditMsg = (msg) => {
    setEditingMsg({ id: msg.id, content: msg.content, isDM: msgCtx?.isDM })
    setMsgCtx(null)
    setTimeout(() => {
      const el = editInputRef.current
      if (!el) return
      el.focus()
      el.style.height = 'auto'
      el.style.height = el.scrollHeight + 'px'
    }, 50)
  }

  const saveEditMsg = async () => {
    if (!editingMsg || !editingMsg.content.trim()) return
    try {
      const endpoint = editingMsg.isDM ? `/api/dm-messages/${editingMsg.id}` : `/api/messages/${editingMsg.id}`
      await API(endpoint, { method: 'PUT', body: JSON.stringify({ content: editingMsg.content }) })
    } catch {}
    setEditingMsg(null)
  }

  const cancelEdit = () => setEditingMsg(null)

  // Emoji data
  const emojiData = useMemo(() => ({
    smileys: { icon: '😀', label: 'Смайлы', emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤗','🤭','🤫','🤔','🫡','🤐','🤨','😐','😑','😶','🫥','😏','😒','🙄','😬','😮‍💨','🤥','🫨','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥵','🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐','😕','🫤','😟','🙁','☹️','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'] },
    gestures: { icon: '👋', label: 'Жесты', emojis: ['👋','🤚','🖐️','✋','🖖','🫱','🫲','🫳','🫴','👌','🤌','🤏','✌️','🤞','🫰','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','🫵','👍','👎','✊','👊','🤛','🤜','👏','🙌','🫶','👐','🤲','🤝','🙏','✍️','💅','🤳','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🫀','🫁','🦷','🦴','👀','👁️','👅','👄'] },
    hearts: { icon: '❤️', label: 'Сердца', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❤️‍🔥','❤️‍🩹','❣️','💕','💞','💓','💗','💖','💘','💝','💟'] },
    animals: { icon: '🐶', label: 'Животные', emojis: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐻‍❄️','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🪱','🐛','🦋','🐌','🐞','🐜','🪰','🪲','🪳','🦟','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🪼','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🦬','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐈‍⬛','🪶','🐓','🦃','🦤','🦚','🦜','🦢','🦩','🕊️','🐇','🦝','🦨','🦡','🦫','🦦','🦥','🐁','🐀','🐿️','🦔'] },
    food: { icon: '🍕', label: 'Еда', emojis: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🫘','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🦴','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🫙','🍶','🍺','🍻','🥂','🍷','🫗','🥃','🍸','🍹','🧉','🍾','🧊','🥄','🍴','🍽️','🥣','🥡','🥢','🧂'] },
    travel: { icon: '🚗', label: 'Транспорт', emojis: ['🚗','🚕','🚙','🚌','🚎','🏎️','🚓','🚑','🚒','🚐','🛻','🚚','🚛','🚜','🏍️','🛵','🚲','🛴','🛹','🛼','🚁','🛸','🚀','🛩️','✈️','🛫','🛬','🪂','💺','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚟','🚠','🚡','🛥️','🚢','⛵','🛶','🚤','⚓','🗼','🗽','🗿','🏰','🏯','🏟️','🎡','🎢','🎠','⛲','⛱️','🏖️','🏝️','🏜️','🌋','⛰️','🏔️','🗻','🏕️','🛖','🏠','🏡','🏘️','🏚️'] },
    objects: { icon: '💡', label: 'Объекты', emojis: ['⌚','📱','📲','💻','⌨️','🖥️','🖨️','🖱️','🖲️','🕹️','🗜️','💽','💾','💿','📀','📼','📷','📸','📹','🎥','📽️','🎞️','📞','☎️','📟','📠','📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','⌛','⏳','📡','🔋','🪫','🔌','💡','🔦','🕯️','🧯','🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🪜','🧰','🪛','🔧','🔨','⚒️','🛠️','⛏️','🪚','🔩','⚙️','🪤','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬','⚰️','🪦','⚱️','🏺','🔮','📿','🧿','🪬','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','🩻','🩼','💊','💉','🩸','🧬','🦠','🧫','🧪','🌡️','🧹','🪠','🧺','🧻','🚽','🚰','🚿','🛁','🛀','🧼','🪥','🪒','🧽','🪣','🧴','🛎️','🔑','🗝️','🚪','🪑','🛋️','🛏️','🛌','🧸','🪆','🖼️','🪞','🪟','🛍️','🛒','🎁','🎈','🎏','🎀','🪄','🪅','🎊','🎉','🎎','🏮','🎐','🧧','✉️','📩','📨','📧','💌','📥','📤','📦','🏷️','🪧','📪','📫','📬','📭','📮','📯','📜','📃','📄','📑','🧾','📊','📈','📉','🗒️','🗓️','📆','📅','🗑️','📇','🗃️','🗳️','🗄️','📋','📁','📂','🗂️','🗞️','📰','📓','📔','📒','📕','📗','📘','📙','📚','📖','🔖','🧷','🔗','📎','🖇️','📐','📏','🧮','📌','📍','✂️','🖊️','🖋️','✒️','🖌️','🖍️','📝','✏️','🔍','🔎','🔏','🔐','🔒','🔓'] },
    symbols: { icon: '⭐', label: 'Символы', emojis: ['⭐','🌟','✨','💫','🔥','💥','⚡','🌈','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','❄️','☃️','⛄','🌊','💧','💦','☔','🎵','🎶','🎼','🎤','🎧','📣','📢','🔔','🔕','🎃','🎄','🎆','🎇','🧨','✨','🎈','🎉','🎊','🎋','🎍','🎎','🎏','🎐','🎑','🎀','🎁','🏆','🏅','🥇','🥈','🥉','⚽','⚾','🥎','🏀','🏐','🏈','🏉','🎾','🥏','🎳','🏏','🏑','🏒','🥍','🏓','🏸','🥊','🥋','🥅','⛳','⛸️','🎣','🤿','🎽','🎿','🛷','🥌','🎯','🪀','🪁','🔮','🧿','🎮','🕹️','🎰','🎲','🧩','🧸','♠️','♥️','♦️','♣️','♟️','🃏','🀄','🎴'] },
    flags: { icon: '🏁', label: 'Флаги', emojis: ['🏁','🚩','🎌','🏴','🏳️','🏳️‍🌈','🏳️‍⚧️','🏴‍☠️','🇷🇺','🇺🇸','🇬🇧','🇩🇪','🇫🇷','🇪🇸','🇮🇹','🇯🇵','🇰🇷','🇨🇳','🇧🇷','🇮🇳','🇨🇦','🇦🇺','🇲🇽','🇹🇷','🇺🇦','🇵🇱','🇳🇱','🇸🇪','🇳🇴','🇫🇮','🇩🇰','🇦🇹','🇨🇭','🇧🇪','🇵🇹','🇬🇷','🇨🇿','🇷🇴','🇭🇺','🇮🇱','🇦🇪','🇸🇦','🇪🇬','🇿🇦','🇳🇬','🇰🇪','🇦🇷','🇨🇱','🇨🇴','🇵🇪','🇻🇪','🇹🇭','🇻🇳','🇮🇩','🇵🇭','🇲🇾','🇸🇬','🇳🇿','🇰🇿'] },
  }), [])

  const insertEmoji = (emoji) => {
    setInput(prev => (prev + emoji).slice(0, 1500))
  }

  const GIPHY_KEY = 'SyQTOSFtZxV42IbU7OK98OWqlBat4sA1'

  const fetchGifs = useCallback(async (q) => {
    setGifLoading(true)
    try {
      const url = q.trim()
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(q)}&limit=24&rating=g`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=24&rating=g`
      const res = await fetch(url)
      const data = await res.json()
      setGifResults(data.data || [])
    } catch { setGifResults([]) } finally { setGifLoading(false) }
  }, [])

  const openGifPicker = () => {
    setShowGifPicker(v => {
      if (!v) { setGifSearch(''); fetchGifs('') }
      return !v
    })
    setShowEmojiPicker(false)
  }

  const fetchBannerGifs = useCallback(async (q) => {
    setBannerGifLoading(true)
    try {
      const url = q.trim()
        ? `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_KEY}&q=${encodeURIComponent(q)}&limit=24&rating=g`
        : `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_KEY}&limit=24&rating=g`
      const res = await fetch(url)
      const data = await res.json()
      setBannerGifResults(data.data || [])
    } catch { setBannerGifResults([]) } finally { setBannerGifLoading(false) }
  }, [])

  const selectBannerGif = (gif) => {
    const url = gif.images.original.url
    setProfileForm(f => ({ ...f, bannerImg: url }))
    setShowBannerGifPicker(false)
    setShowBannerOptions(false)
  }

  const sendGif = (gif) => {
    const url = gif.images.fixed_height.url
    if (showFriends && activeDM) {
      socket.emit('send-dm', { dmChannelId: activeDM.id, content: url })
    } else if (activeChannel) {
      socket.emit('send-message', { channelId: activeChannel.id, content: url })
    }
    setShowGifPicker(false)
    playSound('message-send')
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
  }

  useEffect(() => {
    if (!showEmojiPicker) return
    const close = (e) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target)) {
        setShowEmojiPicker(false)
        setEmojiSearch('')
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showEmojiPicker])

  useEffect(() => {
    if (!showGifPicker) return
    const close = (e) => {
      if (gifPickerRef.current && !gifPickerRef.current.contains(e.target)) {
        setShowGifPicker(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showGifPicker])

  // Reactions
  const openReactionPicker = (e, msgId, isDM) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const spaceBelow = window.innerHeight - r.bottom
    const pickerH = 380
    const y = spaceBelow < pickerH + 8 ? r.top - pickerH - 4 : r.bottom + 4
    const x = Math.min(r.left, window.innerWidth - 350)
    setReactionPickerMsg(reactionPickerMsg?.id === msgId ? null : { id: msgId, isDM, x, y })
    setReactionSearch('')
    setReactionCategory('smileys')
  }

  const toggleReaction = async (msgId, emoji, isDM = false) => {
    try {
      const endpoint = isDM ? `/api/dm-messages/${msgId}/react` : `/api/messages/${msgId}/react`
      await API(endpoint, { method: 'POST', body: JSON.stringify({ emoji }) })
    } catch (e) { console.error('React error:', e) }
    setReactionPickerMsg(null)
    setReactionSearch('')
  }

  const showReactionUsers = (e, emoji, userIds, isDM) => {
    e.preventDefault()
    e.stopPropagation()
    const resolvedUsers = userIds.map(uid => {
      if (uid === user.id) return { id: uid, username: user.username, avatarColor: user.avatarColor }
      if (isDM && activeDM?.partner?.id === uid) return { id: uid, username: activeDM.partner.username, avatarColor: activeDM.partner.avatarColor }
      const m = members.find(mm => mm.id === uid)
      if (m) return { id: uid, username: m.username, avatarColor: m.avatarColor }
      return { id: uid, username: 'User', avatarColor: '#666' }
    })
    setReactionUsersPopup({ emoji, users: resolvedUsers, x: e.clientX, y: e.clientY })
  }

  useEffect(() => {
    if (!reactionUsersPopup) return
    const close = () => setReactionUsersPopup(null)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [reactionUsersPopup])

  useEffect(() => {
    if (!reactionPickerMsg) return
    const close = (e) => {
      if (reactionPickerRef.current && !reactionPickerRef.current.contains(e.target)) {
        setReactionPickerMsg(null)
        setReactionSearch('')
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [reactionPickerMsg])

  const isWithin15Min = (createdAt) => Date.now() - new Date(createdAt).getTime() < 15 * 60 * 1000

  const deleteMsgForAll = (msg, isDM) => {
    setMsgCtx(null)
    setConfirmDialog({
      title: t('msg.deleteForAll'),
      message: t('msg.deleteAllConfirm'),
      confirmText: t('msg.deleteForAll'),
      danger: true,
      onConfirm: async () => {
        try {
          const endpoint = isDM ? `/api/dm-messages/${msg.id}` : `/api/messages/${msg.id}`
          await API(endpoint, { method: 'DELETE' })
        } catch {}
        setConfirmDialog(null)
      }
    })
  }

  const deleteMsgForMe = async (msg, isDM) => {
    setMsgCtx(null)
    try {
      const endpoint = isDM ? `/api/dm-messages/${msg.id}` : `/api/messages/${msg.id}`
      await API(endpoint, { method: 'DELETE' })
      // Hide locally
      setHiddenMessages(prev => {
        const next = new Set(prev)
        next.add(msg.id)
        localStorage.setItem('hiddenMsgs_' + user.id, JSON.stringify([...next]))
        return next
      })
      if (isDM) setDmMessages(prev => prev.filter(m => m.id !== msg.id))
      else setMessages(prev => prev.filter(m => m.id !== msg.id))
    } catch {}
  }

  const toggleMsgSelect = (msgId) => {
    setSelectedMsgs(prev => {
      const next = new Set(prev)
      if (next.has(msgId)) next.delete(msgId)
      else next.add(msgId)
      return next
    })
  }

  const canBulkDeleteForAll = () => {
    const isDM = !!activeDM
    const msgList = isDM ? dmMessages : messages
    const selectedList = msgList.filter(m => selectedMsgs.has(m.id) && !m.deleted)
    if (selectedList.length === 0) return false
    if (isDM) {
      // In DM: all selected must be own and within 15 min
      return selectedList.every(m => m.userId === user.id && isWithin15Min(m.createdAt))
    } else {
      // In channel: all must be own OR user has deleteMessages perm
      const canDeleteOthers = hasServerPerm('deleteMessages')
      return selectedList.every(m => m.userId === user.id || canDeleteOthers)
    }
  }

  const bulkDeleteExec = async (mode) => {
    try {
      const ids = [...selectedMsgs]
      if (activeDM) {
        await API(`/api/dm-channels/${activeDM.id}/messages/bulk`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: ids, mode })
        })
        if (mode === 'forMe') {
          setHiddenMessages(prev => {
            const next = new Set(prev)
            ids.forEach(id => next.add(id))
            localStorage.setItem('hiddenMsgs_' + user.id, JSON.stringify([...next]))
            return next
          })
          setDmMessages(prev => prev.filter(m => !ids.includes(m.id)))
        }
      } else if (activeChannel) {
        await API(`/api/channels/${activeChannel.id}/messages/bulk`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messageIds: ids, mode })
        })
        if (mode === 'forMe') {
          setHiddenMessages(prev => {
            const next = new Set(prev)
            ids.forEach(id => next.add(id))
            localStorage.setItem('hiddenMsgs_' + user.id, JSON.stringify([...next]))
            return next
          })
          setMessages(prev => prev.filter(m => !ids.includes(m.id)))
        }
      }
    } catch {}
    setSelectedMsgs(new Set())
    setSelectMode(false)
    setConfirmDialog(null)
  }

  const bulkDeleteMsgs = (mode) => {
    if (selectedMsgs.size === 0) return
    const label = mode === 'forAll' ? (t('msg.deleteForAll') || 'Удалить для всех') : (t('msg.deleteForMe') || 'Удалить для себя')
    setConfirmDialog({
      title: label,
      message: (t('msg.deleteSelectedConfirm') || 'Удалить {count} выбранных сообщений?').replace('{count}', selectedMsgs.size),
      confirmText: label,
      danger: true,
      onConfirm: () => bulkDeleteExec(mode)
    })
  }

  const scrollToPinned = (idx) => {
    const pin = pinnedMessages[idx]
    if (!pin) return
    setPinnedIndex(idx)
    const el = document.getElementById('msg-' + pin.id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('highlight')
      setTimeout(() => el.classList.remove('highlight'), 1500)
    }
  }

  const isMsgPinned = (msg, isDM) => {
    if (msg.pinned) return 'all'
    const list = isDM ? dmPinnedMessages : pinnedMessages
    if (list.some(p => p.id === msg.id)) return 'self'
    return false
  }

  const togglePinMsg = (msg, isDM) => {
    const pinState = isMsgPinned(msg, isDM)
    if (pinState === 'all') {
      // Unpin for all
      setMsgCtx(null)
      const endpoint = isDM ? `/api/dm-messages/${msg.id}/pin` : `/api/messages/${msg.id}/pin`
      API(endpoint, { method: 'POST', body: JSON.stringify({ mode: 'all' }) }).then(() => {
        if (isDM) reloadDmPinned()
      }).catch(() => {})
      return
    }
    if (pinState === 'self') {
      // Unpin for self
      setMsgCtx(null)
      const endpoint = isDM ? `/api/dm-messages/${msg.id}/pin` : `/api/messages/${msg.id}/pin`
      API(endpoint, { method: 'POST', body: JSON.stringify({ mode: 'self' }) }).then(() => {
        if (isDM) reloadDmPinned()
        else reloadChannelPinned()
      }).catch(() => {})
      return
    }
    // Show pin choice submenu
    setPinChoiceCtx({ msg, isDM, x: msgCtx?.x || 0, y: msgCtx?.y || 0 })
    setMsgCtx(null)
  }

  const pinWithMode = async (mode) => {
    if (!pinChoiceCtx) return
    const { msg, isDM } = pinChoiceCtx
    const endpoint = isDM ? `/api/dm-messages/${msg.id}/pin` : `/api/messages/${msg.id}/pin`
    setPinChoiceCtx(null)
    try {
      await API(endpoint, { method: 'POST', body: JSON.stringify({ mode }) })
      if (mode === 'self' || isDM) {
        // Self-pins don't broadcast, reload pinned list
        if (isDM) reloadDmPinned()
        else reloadChannelPinned()
      }
    } catch {}
  }

  const reloadChannelPinned = () => {
    if (!activeChannel) return
    API(`/api/channels/${activeChannel.id}/pinned`).then(p => { setPinnedMessages(p); setPinnedIndex(0) }).catch(() => {})
  }

  const reloadDmPinned = () => {
    if (!activeDM) return
    API(`/api/dm-channels/${activeDM.id}/pinned`).then(p => { setDmPinnedMessages(p); setDmPinnedIndex(0) }).catch(() => {})
  }

  const scrollToDmPinned = (idx) => {
    const pin = dmPinnedMessages[idx]
    if (!pin) return
    setDmPinnedIndex(idx)
    const el = document.getElementById('msg-' + pin.id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      el.classList.add('highlight')
      setTimeout(() => el.classList.remove('highlight'), 1500)
    }
  }

  // ── File upload helpers ──
  const formatFileSize = (bytes) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  const uploadFileAPI = async (file, sendAs) => {
    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
    const fd = new FormData()
    fd.append('file', file)
    fd.append('sendAs', sendAs)
    const res = await fetch('/api/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || t('upload.failed'))
    return data
  }

  const handleFileSelect = (file) => {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { alert('10 MB max'); return }
    setUploadFileObj(file)
    setUploadComment('')
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = (ev) => setUploadPreview(ev.target.result)
      reader.readAsDataURL(file)
      setUploadSendAs('photo')
    } else {
      setUploadPreview(null)
      setUploadSendAs('file')
    }
    setShowUploadDialog(true)
  }

  const handleFileInput = (e) => {
    handleFileSelect(e.target.files?.[0])
    e.target.value = ''
  }

  const openFileWith = (accept) => {
    setShowAttachMenu(false)
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept || ''
      fileInputRef.current.click()
    }
  }

  const closeUploadDialog = () => {
    setShowUploadDialog(false)
    setUploadFileObj(null)
    setUploadPreview(null)
    setUploadComment('')
  }

  const handleUploadSend = async () => {
    if (!uploadFileObj || (!activeChannel && !activeDM)) return
    setUploading(true)
    try {
      const attachment = await uploadFileAPI(uploadFileObj, uploadSendAs)
      if (activeDM) {
        socket.emit('send-dm', { dmChannelId: activeDM.id, content: uploadComment.trim(), attachment })
      } else {
        socket.emit('send-message', { channelId: activeChannel.id, content: uploadComment.trim(), attachment })
      }
      closeUploadDialog()
      playSound('message-send')
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {
      alert(t('upload.failed') + ': ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const file = e.dataTransfer?.files?.[0]
    if (file) handleFileSelect(file)
  }

  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation() }

  // ── Lightbox ──
  const channelMedia = messages.filter(m => m.attachment?.fileType === 'image' || m.attachment?.fileType === 'video')
  const dmMediaArr = dmMessages.filter(m => m.attachment?.fileType === 'image' || m.attachment?.fileType === 'video')
  const lightboxImages = activeDM ? dmMediaArr : channelMedia

  const openLightbox = (msg) => {
    const idx = lightboxImages.findIndex(m => m.id === msg.id)
    setLightboxIndex(idx)
  }

  useEffect(() => {
    if (lightboxIndex < 0) return
    const handler = (e) => {
      if (e.key === 'Escape') setLightboxIndex(-1)
      if (e.key === 'ArrowLeft') setLightboxIndex(i => Math.max(0, i - 1))
      if (e.key === 'ArrowRight') setLightboxIndex(i => Math.min(lightboxImages.length - 1, i + 1))
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxIndex, lightboxImages.length])

  useEffect(() => {
    if (!showAttachMenu) return
    const handler = (e) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target)) setShowAttachMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAttachMenu])

  const formatTime = (iso) => {
    const d = new Date(iso)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: timeFormat === '12' })
  }

  const formatDate = (iso) => {
    const d = new Date(iso)
    const today = new Date()
    if (d.toDateString() === today.toDateString()) return t('date.today')
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
    if (d.toDateString() === yesterday.toDateString()) return t('date.yesterday')
    return d.toLocaleDateString()
  }

  // Group messages by date and consecutive user
  const groupedMessages = messages.reduce((acc, msg, i) => {
    const dateStr = formatDate(msg.createdAt)
    if (i === 0 || formatDate(messages[i - 1].createdAt) !== dateStr) {
      acc.push({ type: 'date', date: dateStr })
    }
    const prev = messages[i - 1]
    const isGrouped = prev && prev.userId === msg.userId && !msg.type && !prev.type && formatDate(prev.createdAt) === dateStr &&
      (new Date(msg.createdAt) - new Date(prev.createdAt)) < 300000
    acc.push({ type: 'message', msg, isGrouped })
    return acc
  }, [])

  const onlineMembers = members.filter(m => m.status && m.status !== 'offline')
  const offlineMembers = members.filter(m => !m.status || m.status === 'offline')

  return (
    <div className={`chat-app ${mobileNav ? 'mobile-nav-open' : ''} ${mobileInChat ? 'mobile-in-chat' : ''}`}>
      {/* Mobile overlay */}
      {mobileNav && <div className="mobile-overlay" onClick={() => setMobileNav(false)} />}
      {/* Left sidebar (server + channel + user panel) */}
      <div className="left-sidebar">
      <div className="left-sidebar-panels">
      {/* Server sidebar */}
      <div className="server-bar">
        <div className="server-bar-inner">
          <button className={`server-icon friends-icon ${showFriends ? 'active' : ''}`} onClick={openFriends} title="Home">
            <img src="/logo.png" alt="Буст" className="server-logo" />
            {(friendRequests.length + totalDMUnread) > 0 && <div className="friends-badge">{friendRequests.length + totalDMUnread}</div>}
          </button>
          <div className="server-divider" />
          {effectiveLayout.map((item, idx) => {
            if (item.type === 'folder') {
              const folderServers = item.serverIds.map(id => servers.find(s => s.id === id)).filter(Boolean)
              const folderUnread = folderServers.reduce((sum, s) => sum + getServerUnreadAll(s.id), 0)
              const isExpanded = expandedFolders.has(item.folderId)
              const isDragTarget = srvDropTarget?.action === 'add-to-folder' && srvDropTarget.folderId === item.folderId
              const isDragging = srvDragState?.id === item.folderId
              return (
                <div key={item.folderId} className={`srv-folder-wrap ${isExpanded ? 'expanded' : ''}`}>
                  <div
                    ref={el => srvItemRefs.current[item.folderId] = el}
                    data-item-type="folder"
                    className={`server-icon srv-folder-icon ${isDragTarget ? 'drag-over' : ''} ${isDragging ? 'srv-dragging' : ''}`}
                    style={{ cursor: 'pointer', background: `${item.color || appAccent}22`, border: `2px solid ${item.color || appAccent}55` }}
                    onClick={() => setExpandedFolders(prev => {
                      const n = new Set(prev)
                      if (n.has(item.folderId)) n.delete(item.folderId)
                      else n.add(item.folderId)
                      return n
                    })}
                    onMouseDown={e => startSrvDrag(e, item.folderId)}
                    onContextMenu={e => { e.preventDefault(); setFolderCtx({ x: e.clientX, y: e.clientY, folder: item }) }}
                  >
                    <div className="folder-mini-grid">
                      {folderServers.slice(0, 4).map(s => (
                        <div key={s.id} className="folder-mini-cell" style={{ background: s.avatarColor }}>
                          {s.avatar ? <img src={s.avatar} className="folder-mini-img" alt="" /> : <span>{s.iconText}</span>}
                        </div>
                      ))}
                    </div>
                    <div className="folder-icon-overlay">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill={item.color || appAccent}><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                    </div>
                    <div className="server-pill" />
                    {folderUnread > 0 && <div className="server-badge">{folderUnread > 99 ? '99+' : folderUnread}</div>}
                  </div>
                  {isExpanded && (
                    <div className="srv-folder-expanded">
                      {folderServers.map(s => {
                        const sUnread = getServerUnreadAll(s.id)
                        const isFolderSrvDragging = srvDragState?.id === s.id
                        return (
                          <button
                            key={s.id}
                            ref={el => srvItemRefs.current[s.id] = el}
                            data-item-type="server"
                            data-verified={s.verified ? 'true' : 'false'}
                            data-in-folder={item.folderId}
                            className={`server-icon server-icon-sm ${activeServer?.id === s.id ? 'active' : ''} ${isFolderSrvDragging ? 'srv-dragging' : ''}`}
                            onClick={() => { setActiveServer(s); setShowFriends(false); setActiveDM(null) }}
                            onContextMenu={e => handleServerContext(e, s)}
                            onMouseDown={e => startSrvDrag(e, s.id)}
                            title={s.name}
                          >
                            {s.avatar ? <img src={s.avatar} alt={s.name} className="server-icon-avatar" /> : <span>{s.iconText}</span>}
                            <div className="server-pill" />
                            {s.verified && <div className="server-verified-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 1l3.09 2.26L19 4l.74 3.91L22 11l-2.26 3.09L19 18l-3.91.74L12 21l-3.09-2.26L5 18l-.74-3.91L2 11l2.26-3.09L5 4l3.91-.74L12 1z" fill="#5865f2"/><path d="M8.5 12l2.5 2.5 5-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>}
                            {sUnread > 0 && <div className="server-badge">{sUnread > 99 ? '99+' : sUnread}</div>}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            }
            // type === 'server'
            const s = servers.find(x => x.id === item.id)
            if (!s) return null
            const sUnread = getServerUnreadAll(s.id)
            const isDragTarget = srvDropTarget?.action === 'merge' && srvDropTarget.targetServerId === s.id
            const isDragging = srvDragState?.id === s.id
            return (
              <button
                key={s.id}
                ref={el => srvItemRefs.current[s.id] = el}
                data-item-type="server"
                data-verified={s.verified ? 'true' : 'false'}
                className={`server-icon ${activeServer?.id === s.id ? 'active' : ''} ${isDragTarget ? 'drag-over' : ''} ${isDragging ? 'srv-dragging' : ''}`}
                onClick={() => { setActiveServer(s); setShowFriends(false); setActiveDM(null) }}
                onContextMenu={e => handleServerContext(e, s)}
                onMouseDown={e => startSrvDrag(e, s.id)}
                title={s.name}
              >
                {s.avatar ? <img src={s.avatar} alt={s.name} className="server-icon-avatar" /> : <span>{s.iconText}</span>}
                <div className="server-pill" />
                {s.verified && <div className="server-verified-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 1l3.09 2.26L19 4l.74 3.91L22 11l-2.26 3.09L19 18l-3.91.74L12 21l-3.09-2.26L5 18l-.74-3.91L2 11l2.26-3.09L5 4l3.91-.74L12 1z" fill="#5865f2"/><path d="M8.5 12l2.5 2.5 5-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg></div>}
                {(s.boostLevel > 0) && <div className="server-boost-badge" title={`Уровень ${s.boostLevel}`}>{'🔥'.repeat(s.boostLevel)}</div>}
                {sUnread > 0 && <div className="server-badge">{sUnread > 99 ? '99+' : sUnread}</div>}
              </button>
            )
          })}
          {/* Reorder drop indicator line */}
          {srvDragState && srvDropTarget?.action === 'reorder' && (() => {
            const entries = Object.entries(srvItemRefs.current)
              .map(([id, el]) => el ? { id, rect: el.getBoundingClientRect() } : null)
              .filter(Boolean).sort((a, b) => a.rect.top - b.rect.top)
            const insertAt = srvDropTarget.insertAt
            let lineY
            if (insertAt < entries.length) lineY = entries[insertAt].rect.top
            else if (entries.length > 0) lineY = entries[entries.length - 1].rect.bottom
            else return null
            const barEl = entries[0]?.id && srvItemRefs.current[entries[0].id]?.closest('.server-bar')
            if (!barEl) return null
            const barRect = barEl.getBoundingClientRect()
            return <div className="srv-drop-line-fixed" style={{ top: lineY - 1.5, left: barRect.left + 6, width: barRect.width - 12 }} />
          })()}
          <button className="server-icon add-server" onClick={() => setShowCreateServer(true)} title="Create Server">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>
      </div>

      {/* Server context menu */}
      {serverCtx && (
        <div className="ctx-overlay" onClick={() => setServerCtx(null)}>
        <div className="server-ctx-menu" ref={serverCtxRef} style={{ top: serverCtx.y, left: serverCtx.x }} onClick={e => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { markServerRead(serverCtx.server.id); setServerCtx(null) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{t('channel.markRead')}</span>
          </button>
          <button className="ctx-item" onClick={() => { { const sid = serverCtx.server.id; setShowInviteModal({ serverId: sid, serverName: serverCtx.server.name, memberIds: [] }); setInviteSending({}); loadFriends(); API(`/api/servers/${sid}/members`).then(m => setShowInviteModal(prev => prev ? { ...prev, memberIds: m.map(x => x.userId || x.id) } : prev)).catch(() => {}); setServerCtx(null) } }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
            <span>{t('server.invite')}</span>
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item" onClick={() => setServerCtx(null)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18.36 6.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
            <span>{t('channel.mute')}</span>
          </button>
          <div className="ctx-divider" />
          {effectiveLayout.some(item => item.type === 'folder' && item.serverIds.includes(serverCtx.server.id)) && (
            <button className="ctx-item" onClick={() => {
              const origFolder = effectiveLayout.find(it => it.type === 'folder' && it.serverIds.includes(serverCtx.server.id))
              const newLayout = effectiveLayout.map(item => {
                if (item.type === 'folder' && item.serverIds.includes(serverCtx.server.id)) {
                  const ids = item.serverIds.filter(id => id !== serverCtx.server.id)
                  return ids.length > 0 ? { ...item, serverIds: ids } : null
                }
                return item
              }).filter(Boolean)
              const folderInNew = origFolder ? newLayout.findIndex(it => it.folderId === origFolder.folderId) : -1
              const insertAt = folderInNew >= 0 ? folderInNew + 1 : newLayout.length
              newLayout.splice(insertAt, 0, { type: 'server', id: serverCtx.server.id })
              saveServerLayout(newLayout)
              setServerCtx(null)
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
              <span>Убрать из папки</span>
            </button>
          )}
          {serverCtx.server.ownerId === user.id && (
            <button className="ctx-item ctx-danger" onClick={() => deleteServer(serverCtx.server.id)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              <span>{t('server.delete')}</span>
            </button>
          )}
          <button className="ctx-item ctx-danger" onClick={() => leaveServer(serverCtx.server.id)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
            <span>{t('server.leave')}</span>
          </button>
          <div className="ctx-divider" />
          <button className="ctx-item" onClick={() => copyServerId(serverCtx.server.id)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <span>{t('server.copyId')}</span>
          </button>
        </div>
        </div>
      )}

      {/* Folder context menu */}
      {folderCtx && (
        <div className="ctx-overlay" onClick={() => setFolderCtx(null)}>
          <div className="server-ctx-menu" ref={folderCtxRef} style={{ top: folderCtx.y, left: folderCtx.x }} onClick={e => e.stopPropagation()}>
            <button className="ctx-item" onClick={() => {
              const folderServerIds = new Set(folderCtx.folder.serverIds)
              setUnreadChannels(prev => {
                const n = { ...prev }
                allChannels.filter(c => folderServerIds.has(c.serverId)).forEach(c => delete n[c.id])
                return n
              })
              setFolderCtx(null)
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Пометить как прочитанное</span>
            </button>
            <button className="ctx-item" onClick={() => {
              setFolderSettings({ folder: folderCtx.folder })
              setFolderSettingsName(folderCtx.folder.name)
              setFolderSettingsColor(folderCtx.folder.color || appAccent)
              setFolderCtx(null)
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 010 14.14M4.93 4.93a10 10 0 000 14.14"/></svg>
              <span>Настройки папки</span>
            </button>
            <div className="ctx-divider" />
            <button className="ctx-item ctx-danger" onClick={() => {
              const folder = folderCtx.folder
              // Dissolve folder: extract all servers back to top level
              const folderIdx = effectiveLayout.findIndex(it => it.folderId === folder.folderId)
              const newLayout = effectiveLayout.filter(it => it.folderId !== folder.folderId)
              const insertAt = folderIdx >= 0 ? folderIdx : newLayout.length
              folder.serverIds.forEach((id, i) => newLayout.splice(insertAt + i, 0, { type: 'server', id }))
              saveServerLayout(newLayout)
              setFolderCtx(null)
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              <span>Удалить папку</span>
            </button>
          </div>
        </div>
      )}

      {/* Folder settings modal */}
      {folderSettings && (
        <div className="modal-overlay" style={{ zIndex: 300 }} onClick={() => setFolderSettings(null)}>
          <div className="modal" style={{ width: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Настройки папки</h3>
              <button className="modal-close" onClick={() => setFolderSettings(null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="modal-body" style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {/* Name */}
              <div className="field">
                <label>Название папки</label>
                <input
                  className="input"
                  value={folderSettingsName}
                  onChange={e => setFolderSettingsName(e.target.value)}
                  placeholder="Папка"
                  maxLength={32}
                />
              </div>
              {/* Color */}
              <div className="field">
                <label>Цвет папки</label>
                <div className="banner-color-picker-row">
                  <div className="banner-color-swatch"
                       style={{ background: bannerGradient(folderSettingsColor) }}
                       title="Изменить цвет"
                       onClick={() => document.getElementById('folder-color-input').click()}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                    <input id="folder-color-input" type="color" value={folderSettingsColor || appAccent}
                      style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }}
                      onChange={e => setFolderSettingsColor(e.target.value)} />
                  </div>
                  {folderSettingsColor && folderSettingsColor !== appAccent && (
                    <button type="button" className="banner-color-clear" onClick={() => setFolderSettingsColor(appAccent)} title="Сбросить">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setFolderSettings(null)}>Отмена</button>
              <button className="btn-submit" onClick={() => {
                const newLayout = effectiveLayout.map(item =>
                  item.type === 'folder' && item.folderId === folderSettings.folder.folderId
                    ? { ...item, name: folderSettingsName || 'Папка', color: folderSettingsColor }
                    : item
                )
                saveServerLayout(newLayout)
                setFolderSettings(null)
              }}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* DM context menu */}
      {dmCtx && (
        <div className="ctx-overlay" onClick={() => { setDmCtx(null); setDmMuteSub(false); setDmDeleteSub(false); setDmClearSub(false) }}>
        <div className="dm-ctx-menu" ref={dmCtxRef} style={{ top: dmCtx.y, left: dmCtx.x }} onClick={e => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { showUserProfile(dmCtx.dm.partner, dmCtx.x, dmCtx.y) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>{t('profile.title')}</span>
          </button>
          <button className="ctx-item" onClick={() => { markDMRead(dmCtx.dm.id); setDmCtx(null) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{t('dm.markAsRead')}</span>
          </button>
          <div className="ctx-divider" />
          <div className="ctx-item-wrap" onMouseEnter={() => setDmMuteSub(true)} onMouseLeave={() => setDmMuteSub(false)}>
            {mutedChannels[dmCtx.dm.id] && mutedChannels[dmCtx.dm.id] > Date.now() ? (
              <button className="ctx-item" onClick={() => { unmuteChannel(dmCtx.dm.id); setDmCtx(null) }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
                <span>{t('dm.enableNotifications')}</span>
              </button>
            ) : (
              <>
                <button className="ctx-item" onClick={() => { muteChannel(dmCtx.dm.id, Infinity); setDmCtx(null) }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                  <span>{t('dm.muteNotifications')}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginLeft:'auto'}} onClick={(e) => { e.stopPropagation(); setDmMuteSub(!dmMuteSub) }}><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                {dmMuteSub && (
                  <div className="channel-mute-submenu">
                    <button className="ctx-item" onClick={() => { muteChannel(dmCtx.dm.id, 15); setDmCtx(null) }}>{t('mute.15min')}</button>
                    <button className="ctx-item" onClick={() => { muteChannel(dmCtx.dm.id, 60); setDmCtx(null) }}>{t('mute.1hour')}</button>
                    <button className="ctx-item" onClick={() => { muteChannel(dmCtx.dm.id, 480); setDmCtx(null) }}>{t('mute.8hours')}</button>
                    <button className="ctx-item" onClick={() => { muteChannel(dmCtx.dm.id, 1440); setDmCtx(null) }}>{t('mute.24hours')}</button>
                    <button className="ctx-item" onClick={() => { muteChannel(dmCtx.dm.id, Infinity); setDmCtx(null) }}>{t('channel.muteForever')}</button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="ctx-divider" />
          <div className="ctx-item-wrap" onMouseEnter={() => { setDmClearSub(false); setDmDeleteSub(true) }} onMouseLeave={() => setDmDeleteSub(false)}>
            <button type="button" className="ctx-item ctx-danger" onClick={() => setDmDeleteSub(prev => !prev)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              <span>Удалить чат</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginLeft:'auto'}}><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            {dmDeleteSub && (
              <div className="channel-mute-submenu">
                <button className="ctx-item" onClick={() => deleteDmChannel(dmCtx.dm, 'self')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  <span>У себя</span>
                </button>
                <button className="ctx-item ctx-danger" onClick={() => deleteDmChannel(dmCtx.dm, 'both')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                  <span>У всех</span>
                </button>
              </div>
            )}
          </div>
          <div className="ctx-item-wrap" onMouseEnter={() => { setDmDeleteSub(false); setDmClearSub(true) }} onMouseLeave={() => setDmClearSub(false)}>
            <button type="button" className="ctx-item" onClick={() => setDmClearSub(prev => !prev)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/><line x1="9" y1="11" x2="9" y2="17"/><line x1="15" y1="11" x2="15" y2="17"/></svg>
              <span>Очистить чат</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginLeft:'auto'}}><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            {dmClearSub && (
              <div className="channel-mute-submenu">
                <button className="ctx-item" onClick={() => clearDmChat(dmCtx.dm, 'self')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  <span>У себя</span>
                </button>
                <button className="ctx-item ctx-danger" onClick={() => clearDmChat(dmCtx.dm, 'both')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                  <span>У всех</span>
                </button>
              </div>
            )}
          </div>
          <div className="ctx-divider" />
          {blockedUsers.includes(dmCtx.dm.partner?.id) ? (
            <button className="ctx-item" onClick={() => unblockUser(dmCtx.dm.partner?.id)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/></svg>
              <span>{t('friends.unblock')}</span>
            </button>
          ) : (
            <button className="ctx-item ctx-danger" onClick={() => blockUser(dmCtx.dm.partner?.id, dmCtx.dm.partner?.username)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
              <span>{t('dm.block')}</span>
            </button>
          )}
        </div>
        </div>
      )}

      {/* User profile popup */}
      {userProfilePopup && (
        <div className="user-profile-card" ref={userProfileRef} style={{ top: userProfilePopup.y, left: userProfilePopup.x }}>
          {(() => { const p = prof(userProfilePopup.user?.id, userProfilePopup.user); return (
            <div className="upc-banner" style={p.bannerImg ? { backgroundImage:`url(${p.bannerImg})`, backgroundSize:'cover', backgroundPosition:'center' } : { background: bannerGradient(p.bannerColor || p.avatarColor) }} />
          )})()}
          <div className="upc-avatar-row">
            {(() => { const p = prof(userProfilePopup.user?.id, userProfilePopup.user); return (
              <div className={`upc-avatar${p.avatarFrame ? ` avatar-frame-${p.avatarFrame}` : ''}`} style={{ background: p.avatarColor }}>
                <AImg src={p.avatar} />
                {p.username?.[0]?.toUpperCase()}
              </div>
            )})()}
            <div className={`upc-status-dot ${prof(userProfilePopup.user?.id, userProfilePopup.user).status || 'offline'}`} />
          </div>
          <div className="upc-body">
            <div className={`upc-name copyable-name ${streamerMode && userProfilePopup.user?.id === user.id ? 'streamer-blur' : ''}`} onClick={(e) => copyUsername(userProfilePopup.user?.username, userProfilePopup.user?.tag, e)} title={copiedName ? t('profile.copied') : t('profile.clickToCopy')}>{userProfilePopup.user?.username}<span className="user-tag">#{userProfilePopup.user?.tag}</span></div>
            {userProfilePopup.user?.bio && (
              <div className="upc-section">
                <div className="upc-section-title">{t('profile.aboutMe')}</div>
                <div className="upc-bio">{userProfilePopup.user.bio}</div>
              </div>
            )}
            <div className="upc-section">
              <div className="upc-section-title">{t('profile.memberSince')}</div>
              <div className="upc-date">{userProfilePopup.user?.createdAt ? new Date(userProfilePopup.user.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'}</div>
            </div>
            {userProfilePopup.user?.id !== user.id && (
              <div className="upc-actions">
                <button className="upc-btn upc-btn-dm" onClick={() => { const p = userProfilePopup.user; setUserProfilePopup(null); openDM(p.id) }} title={t('profile.sendMessage')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                </button>
                {!blockedUsers.includes(userProfilePopup.user?.id) && !friends.some(f => f.id === userProfilePopup.user?.id) && (() => {
                  const incomingReq = friendRequests.find(r => r.fromId === userProfilePopup.user?.id || r.from?.id === userProfilePopup.user?.id)
                  if (incomingReq) {
                    return (
                      <button className="upc-btn upc-btn-friend" onClick={() => { acceptFriendRequest(incomingReq.id); setUserProfilePopup(null) }} title={t('profile.acceptRequest')}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                      </button>
                    )
                  }
                  if (sentFriendRequests.has(userProfilePopup.user?.id)) {
                    return (
                      <button className="upc-btn upc-btn-pending" title={t('profile.cancelRequest')} onClick={() => cancelFriendRequest(userProfilePopup.user?.id)}>
                        <svg className="upc-pending-clock" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        <svg className="upc-pending-x" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                      </button>
                    )
                  }
                  return (
                    <button className="upc-btn upc-btn-friend" onClick={() => sendFriendRequest(userProfilePopup.user?.id)} title={t('profile.addFriend')}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                    </button>
                  )
                })()}
                {friends.some(f => f.id === userProfilePopup.user?.id) && (
                  <button className="upc-btn upc-btn-friend-ok" title={t('profile.removeFriend')} onClick={() => {
                    const friend = friends.find(f => f.id === userProfilePopup.user?.id)
                    const uname = userProfilePopup.user?.username
                    setUserProfilePopup(null)
                    setConfirmDialog({
                      title: t('friends.removeFriend'),
                      message: t('friends.removeConfirm').replace('{name}', uname),
                      confirmText: t('friends.remove'),
                      danger: true,
                      onConfirm: async () => {
                        if (friend?.requestId) await removeFriend(friend.requestId)
                        setConfirmDialog(null)
                      }
                    })
                  }}>
                    <svg className="upc-friend-check" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/></svg>
                    <svg className="upc-friend-x" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg>
                  </button>
                )}
                {blockedUsers.includes(userProfilePopup.user?.id) ? (
                  <button className="upc-btn-text" onClick={() => { unblockUser(userProfilePopup.user?.id); setUserProfilePopup(null) }}>{t('friends.unblock')}</button>
                ) : (
                  <button className="upc-btn-text upc-btn-block" onClick={() => { blockUser(userProfilePopup.user?.id, userProfilePopup.user?.username); setUserProfilePopup(null) }}>{t('dm.block')}</button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Channel sidebar */}
      <div className="channel-bar">
        {showFriends ? (
          <>
            <div className="dm-search-bar">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
              <input
                className="dm-search-input"
                placeholder={t('common.search')}
                value={dmSearchQuery}
                onChange={e => {
                  const val = e.target.value
                  setDmSearchQuery(val)
                  if (dmSearchTimer.current) clearTimeout(dmSearchTimer.current)
                  if (!val.trim()) { setDmSearchResults(null); return }
                  dmSearchTimer.current = setTimeout(async () => {
                    try {
                      const res = await API('/api/dm-search?q=' + encodeURIComponent(val.trim()))
                      setDmSearchResults(res)
                    } catch { setDmSearchResults([]) }
                  }, 300)
                }}
              />
              {dmSearchQuery && (
                <button className="dm-search-clear" onClick={() => { setDmSearchQuery(''); setDmSearchResults(null) }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
              )}
            </div>
            <div className="channel-list dm-nav">
              <button className={`dm-nav-item ${!activeDM && !mobileInChat ? 'active' : ''}`} onClick={() => { setActiveDM(null); if (isMobile) setMobileInChat(true) }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                <span>{t('nav.friends')}</span>
                {(friendRequests.length + outgoingRequests.length) > 0 && <span className="nav-badge pending">{friendRequests.length + outgoingRequests.length}</span>}
              </button>
              <button className={`dm-nav-item dm-nav-store ${showShop ? 'active' : ''}`} onClick={() => showShop ? setShowShop(false) : openShop()}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2L3 7v11a2 2 0 002 2h14a2 2 0 002-2V7l-3-5z"/><line x1="3" y1="7" x2="21" y2="7"/><path d="M16 11a4 4 0 01-8 0"/></svg>
                <span>Магазин</span>
              </button>
              {dmSearchResults ? (
                <>
                  <div className="dm-section-header"><span>{t('common.search')} — {dmSearchResults.length} {t('dm.searchChats')}</span></div>
                  {dmSearchResults.length === 0 && <div className="dm-search-empty">{t('dm.searchNothing')}</div>}
                  {dmSearchResults.map(r => {
                    const highlightText = (text, query) => {
                      if (!text || !query) return text
                      const idx = text.toLowerCase().indexOf(query.toLowerCase())
                      if (idx === -1) return text
                      return <>{text.slice(0, idx)}<mark>{text.slice(idx, idx + query.length)}</mark>{text.slice(idx + query.length)}</>
                    }
                    const isExpanded = dmSearchExpanded === r.dmId
                    const goToMessage = (msgId) => {
                      const dm = dmChannels.find(d => d.id === r.dmId)
                      if (dm) {
                        setActiveDM(dm); if (isMobile) setMobileInChat(true)
                        setDmSearchQuery('')
                        setDmSearchResults(null)
                        setDmSearchExpanded(null)
                        const tryHighlight = (msgId2, attempts) => {
                          const el = document.getElementById('msg-' + msgId2)
                          if (el) {
                            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
                            el.classList.remove('msg-highlight')
                            void el.offsetWidth
                            el.classList.add('msg-highlight')
                            setTimeout(() => el.classList.remove('msg-highlight'), 2000)
                          } else if (attempts > 0) {
                            setTimeout(() => tryHighlight(msgId2, attempts - 1), 300)
                          }
                        }
                        setTimeout(() => tryHighlight(msgId, 5), 300)
                      }
                    }
                    return (
                      <div key={r.dmId} className="dm-search-result">
                        <button
                          className={`dm-item ${activeDM?.id === r.dmId ? 'active' : ''}`}
                          onClick={() => {
                            if (r.matchedMessages && r.matchedMessages.length > 0) {
                              setDmSearchExpanded(isExpanded ? null : r.dmId)
                            } else {
                              const dm = dmChannels.find(d => d.id === r.dmId)
                              if (dm) { setActiveDM(dm); setDmSearchQuery(''); setDmSearchResults(null); if (isMobile) setMobileInChat(true) }
                            }
                          }}
                        >
                          <div className="dm-item-avatar-wrap">
                            <div className="dm-item-avatar" style={{ background: r.partner.avatarColor }}>
                              <AImg src={r.partner.avatar} />
                              {r.partner.username[0].toUpperCase()}
                            </div>
                            <div className={`status-dot ${r.partner.status || 'offline'}`} />
                          </div>
                          <div className="dm-item-info">
                            <span className="dm-item-name">{r.nameMatch ? highlightText(r.partner.username, dmSearchQuery) : r.partner.username}</span>
                            {r.matchedMessages && r.matchedMessages.length > 0 && (
                              <span className="dm-item-last dm-search-match">{r.matchedMessages.length} {t('dm.searchFound')}</span>
                            )}
                          </div>
                          {r.matchedMessages && r.matchedMessages.length > 0 && (
                            <svg className={`dm-search-chevron ${isExpanded ? 'open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                          )}
                        </button>
                        {isExpanded && r.matchedMessages && (
                          <div className="dm-search-messages">
                            {r.matchedMessages.map(msg => (
                              <button key={msg.id} className="dm-search-msg-item" onClick={(e) => { e.stopPropagation(); goToMessage(msg.id) }}>
                                <div className="dm-search-msg-author">{msg.username}</div>
                                <div className="dm-search-msg-text">{highlightText(msg.content, dmSearchQuery)}</div>
                                <div className="dm-search-msg-time">{new Date(msg.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })} {new Date(msg.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
              ) : (
                <>
              <div className="dm-section-header">
                <span>{t('nav.directMessages')}</span>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {totalDMUnread > 0 && (
                    <button title={t('dm.readAll')} onClick={markAllDMsRead} className="mark-read-btn">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                    </button>
                  )}
                </div>
              </div>
              {dmChannels.map(dm => {
                const dmUnread = unreadDMs[dm.id] || 0
                return (
                <button
                  key={dm.id}
                  className={`dm-item ${activeDM?.id === dm.id ? 'active' : ''} ${dmUnread > 0 ? 'has-unread' : ''}`}
                  onClick={() => { setActiveDM(dm); setSelectMode(false); setSelectedMsgs(new Set()); setMobileNav(false); if (isMobile) setMobileInChat(true) }}
                  onContextMenu={(e) => handleDmContext(e, dm)}
                >
                  <div className="dm-item-avatar-wrap">
                    <div className="dm-item-avatar" style={{ background: dm.partner?.avatarColor }}>
                      <AImg src={dm.partner?.avatar} />
                      {dm.partner?.username?.[0]?.toUpperCase()}
                    </div>
                    <div className={`status-dot ${dm.partner?.status || 'offline'}`} />
                  </div>
                  <div className="dm-item-info">
                    <span className="dm-item-name">{dm.partner?.username}</span>
                    {dm.lastMessage && (
                      <span className="dm-item-last">{dm.lastMessage.attachment ? (dm.lastMessage.content || t('msg.attachment')) : dm.lastMessage.content}</span>
                    )}
                  </div>
                  {mutedChannels[dm.id] && mutedChannels[dm.id] > Date.now() && (
                    <span className="mute-indicator" title={(() => {
                      if (mutedChannels[dm.id] >= 9999999999999) return t('mute.forever')
                      const left = mutedChannels[dm.id] - Date.now()
                      if (left > 86400000) return t('mute.days').replace('{n}', Math.ceil(left / 86400000))
                      if (left > 3600000) return t('mute.hours').replace('{n}', Math.ceil(left / 3600000))
                      return t('mute.minutes').replace('{n}', Math.ceil(left / 60000))
                    })()} onClick={(e) => { e.stopPropagation(); unmuteChannel(dm.id) }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8.7 3A6 6 0 0118 8c0 3.2.9 5.4 1.8 6.8M3.3 3.3L2 2m11.7 19a2 2 0 01-3.5 0M6.3 6.3A6 6 0 006 8c0 7-3 9-3 9h12.3"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
                    </span>
                  )}
                  {dmUnread > 0 && (
                    <span className="dm-unread-badge" onClick={(e) => markDMRead(dm.id, e)} title={t('dm.markAsRead')}>{dmUnread}</span>
                  )}
                </button>
              )})}
                </>
              )}
            </div>
          </>
        ) : activeServer ? (
          <>
            <div className="channel-header server-header-dropdown" ref={serverMenuRef}>
              <button className={`server-header-btn ${showServerMenu ? 'open' : ''}`} onClick={() => setShowServerMenu(v => !v)}>
                <h3>{activeServer.name}{activeServer.verified && <svg className="server-verified-icon" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 1l3.09 2.26L19 4l.74 3.91L22 11l-2.26 3.09L19 18l-3.91.74L12 21l-3.09-2.26L5 18l-.74-3.91L2 11l2.26-3.09L5 4l3.91-.74L12 1z" fill="#5865f2"/><path d="M8.5 12l2.5 2.5 5-5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}</h3>
                <svg className="server-header-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              {showServerMenu && (
                <div className="server-dropdown-menu">
                  <button className="ctx-item" onClick={() => { { const sid = activeServer.id; setShowInviteModal({ serverId: sid, serverName: activeServer.name, memberIds: [] }); setInviteSending({}); loadFriends(); API(`/api/servers/${sid}/members`).then(m => setShowInviteModal(prev => prev ? { ...prev, memberIds: m.map(x => x.userId || x.id) } : prev)).catch(() => {}); setShowServerMenu(false) } }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                    <span>{t('server.invite')}</span>
                  </button>
                  {(activeServer.ownerId === user.id || members.find(m => m.id === user.id)?.role === 'admin') && (
                    <button className="ctx-item" onClick={() => { setServerSettingsName(activeServer.name); setShowServerSettings(true); setShowServerMenu(false) }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                      <span>{t('server.settings')}</span>
                    </button>
                  )}
                  {hasServerPerm('createChannels') && (
                    <button className="ctx-item" onClick={() => { setShowCreateChannel(true); setShowServerMenu(false) }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
                      <span>{t('channel.create')}</span>
                    </button>
                  )}
                  <div className="ctx-divider" />
                  <button className="ctx-item" onClick={() => { setShowServerMenu(false) }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg>
                    <span>{t('channel.mute')}</span>
                  </button>
                  <div className="ctx-divider" />
                  {activeServer.ownerId === user.id && (
                    <button className="ctx-item ctx-danger" onClick={() => { deleteServer(activeServer.id); setShowServerMenu(false) }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                      <span>{t('server.delete')}</span>
                    </button>
                  )}
                  <button className="ctx-item ctx-danger" onClick={() => { leaveServer(activeServer.id); setShowServerMenu(false) }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                    <span>{t('server.leave')}</span>
                  </button>
                </div>
              )}
            </div>
            <div className="channel-list">
              {/* Text Channels */}
              <div className="channel-category">
                <div className="channel-category-toggle" onClick={() => setChannelsCollapsed(v => !v)}>
                  <svg className={`channel-category-arrow ${channelsCollapsed ? 'collapsed' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                  <span>{t('nav.textChannels')}</span>
                </div>
                {activeServer && hasServerPerm('createChannels') && (
                  <button onClick={() => setShowCreateChannel(true)} title="Create Channel">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                )}
              </div>
              {!channelsCollapsed && channels.filter(c => c.type !== 'voice').map(c => {
                const chUnread = unreadChannels[c.id] || 0
                return (
                <button
                  key={c.id}
                  className={`channel-item ${activeChannel?.id === c.id && !voiceViewChannel ? 'active' : ''} ${chUnread > 0 ? 'has-unread' : ''}`}
                  onClick={() => { setActiveChannel(c); setVoiceViewChannel(null); setSelectMode(false); setSelectedMsgs(new Set()); setMobileNav(false); if (isMobile) setMobileInChat(true) }}
                >
                  {mutedChannels[c.id] && mutedChannels[c.id] > Date.now() ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" opacity=".5" title={(() => { if (mutedChannels[c.id] >= 9999999999999) return t('mute.forever'); const left = mutedChannels[c.id] - Date.now(); if (left > 86400000) return t('mute.days').replace('{n}', Math.ceil(left / 86400000)); if (left > 3600000) return t('mute.hours').replace('{n}', Math.ceil(left / 3600000)); return t('mute.minutes').replace('{n}', Math.ceil(left / 60000)) })()}><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>
                  )}
                  <span>{c.name}</span>
                  {chUnread > 0 && (
                    <span className="channel-unread-badge" onClick={(e) => markChannelRead(c.id, e)} title={t('dm.markAsRead')}>{chUnread}</span>
                  )}
                  <span className="channel-gear" onClick={(e) => handleChannelGear(e, c)} title={t('channel.settings')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                  </span>
                </button>
              )})}

              {/* Voice Channels */}
              <div className="channel-category" style={{ marginTop: 8 }}>
                <div className="channel-category-toggle" onClick={() => setVoiceChannelsCollapsed(v => !v)}>
                  <svg className={`channel-category-arrow ${voiceChannelsCollapsed ? 'collapsed' : ''}`} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                  <span>{t('nav.voiceChannels')}</span>
                </div>
                {activeServer && hasServerPerm('createChannels') && (
                  <button onClick={() => setShowCreateVoiceChannel(true)} title="Create Voice Channel">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                  </button>
                )}
              </div>
              {!voiceChannelsCollapsed && channels.filter(c => c.type === 'voice').map(vc => {
                const vcUsers = voiceUsers[vc.id] || []
                const isConnected = voiceChannel?.id === vc.id
                return (
                  <div key={vc.id} className="voice-channel-wrap">
                    <button
                      className={`channel-item voice-channel-item ${isConnected && voiceViewChannel?.id === vc.id ? 'active' : ''} ${isConnected ? 'connected' : ''}`}
                      onClick={() => { if (isConnected) { setVoiceViewChannel(vc); setActiveChannel(null) } else { joinVoiceChannel(vc) }; setMobileNav(false); if (isMobile) setMobileInChat(true) }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                      <span>{vc.name}</span>
                      {vcUsers.length > 0 && <span className="voice-user-count">{vcUsers.length}</span>}
                      <span className="channel-gear" onClick={(e) => handleChannelGear(e, vc)} title={t('channel.settings')}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                      </span>
                    </button>
                    {vcUsers.length > 0 && (
                      <div className="voice-users-list">
                        {vcUsers.map(vu => (
                          <div key={vu.id} className="voice-user-item" onContextMenu={e => { if (vu.id !== user.id) { e.preventDefault(); setVoiceUserCtx({ user: vu, x: e.clientX, y: e.clientY }) } }}>
                            <div className={`voice-user-avatar ${speakingUsers.has(vu.id) ? 'speaking' : ''}`} style={{ background: vu.avatarColor }}>
                              <AImg src={vu.avatar} />
                              {vu.username[0].toUpperCase()}
                            </div>
                            <span className="voice-user-name">{vu.username}</span>
                            <div className="voice-user-icons">
                              {(vu.id === user.id ? voiceMuted : vu.muted) && (
                                <svg className="voice-user-status-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="var(--danger)" strokeWidth="1.5" strokeLinecap="round">
                                  <rect x="5" y="1" width="6" height="9" rx="3"/>
                                  <path d="M3 7v1a5 5 0 0010 0V7"/>
                                  <line x1="8" y1="13" x2="8" y2="15"/>
                                  <line x1="13" y1="2" x2="3" y2="14"/>
                                </svg>
                              )}
                              {(vu.id === user.id ? voiceDeafened : vu.deafened) && (
                                <svg className="voice-user-status-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round">
                                  <path d="M3 14h3a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a9 9 0 0118 0v7a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3"/>
                                  <line x1="21" y1="3" x2="3" y2="21"/>
                                </svg>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Voice connection panel */}
            {voiceChannel && (
              <div className="voice-panel">
                <div className="voice-panel-left" onClick={() => setVoiceViewChannel(voiceChannel)} title={voiceChannel.name}>
                  <div className="voice-panel-signal">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#43b581" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                  </div>
                  <div className="voice-panel-info">
                    <span className="voice-panel-connected">{t('voice.connected')}</span>
                    <span className="voice-panel-channel">{voiceChannel.name}</span>
                  </div>
                </div>
                <div className="voice-panel-controls">
                  <button className={`voice-ctrl-btn ${voiceMuted ? 'active' : ''}`} onClick={toggleVoiceMute} title={voiceMuted ? t('voice.unmute') : t('voice.mute')}>
                    {voiceMuted ? (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="1" width="6" height="9" rx="3"/><path d="M3 7v1a5 5 0 0010 0V7"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="13" y1="2" x2="3" y2="14"/></svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="1" width="6" height="9" rx="3"/><path d="M3 7v1a5 5 0 0010 0V7"/><line x1="8" y1="13" x2="8" y2="15"/></svg>
                    )}
                  </button>
                  <button className={`voice-ctrl-btn ${voiceDeafened ? 'active' : ''}`} onClick={toggleVoiceDeafen} title={voiceDeafened ? t('voice.undeafen') : t('voice.deafen')}>
                    {voiceDeafened ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 14h3a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a9 9 0 0118 0v7a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3"/><line x1="21" y1="3" x2="3" y2="21"/></svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 14h3a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a9 9 0 0118 0v7a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3"/></svg>
                    )}
                  </button>
                  <button className="voice-ctrl-btn voice-ctrl-disconnect" onClick={leaveVoiceChannel} title={t('voice.disconnect')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91"/><line x1="21" y1="3" x2="3" y2="21"/></svg>
                  </button>
                </div>
              </div>
            )}
          </>
        ) : null}
        {false && (
            <div className="user-panel-wrapper" ref={userPopupRef}>
              {showUserMenu && (
                <div className="user-popup">
                  <div className="popup-banner" style={{ background: bannerGradient(user.bannerColor || user.avatarColor) }} />
                  <div className="popup-avatar-wrap">
                    <div className="popup-avatar" style={{ background: user.avatarColor }}>
                      <AImg src={user.avatar} />
                      {user.username[0].toUpperCase()}
                    </div>
                    <div className={`status-dot ${user.status || 'offline'}`} />
                  </div>
                  <div className="popup-info">
                    <div className={`popup-name copyable-name ${streamerMode ? 'streamer-blur' : ''}`} onClick={(e) => copyUsername(user.username, user.tag, e)} title={copiedName ? t('profile.copied') : t('profile.clickToCopy')}>{user.username}<span className="user-tag">#{user.tag}</span></div>
                    <div className="popup-email" onClick={() => {
                      if (!emailRevealed) { setEmailRevealed(true); setTimeout(() => setEmailRevealed(false), 3000) }
                    }} title={streamerMode ? t('profile.emailHidden') : (emailRevealed ? user.email : t('profile.emailReveal'))}>
                      {streamerMode ? <span className="streamer-blur">{user.email}</span> : (<>{emailRevealed ? user.email : <><span className="email-blurred">{user.email.split('@')[0]}</span>@{user.email.split('@')[1]}</>}</>)}
                    </div>
                    {user.bio && <div className="popup-bio">{user.bio}</div>}
                  </div>
                  <div className="popup-divider" />
                  <div className="popup-section-label">{t('status.label')}</div>
                  {[
                    { value: 'online', key: 'status.online', color: '#00d4aa' },
                    { value: 'idle', key: 'status.idle', color: '#f0b232' },
                    { value: 'dnd', key: 'status.dnd', color: '#f04747' },
                    { value: 'invisible', key: 'status.invisible', color: '#55556a' },
                  ].map(opt => (
                    <button
                      key={opt.value}
                      className={`popup-status-item ${user.status === opt.value ? 'active' : ''}`}
                      onClick={() => changeStatus(opt.value)}
                    >
                      <div className="popup-status-dot" style={{ background: opt.color }} />
                      <span>{t(opt.key)}</span>
                      {user.status === opt.value && (
                        <svg className="popup-check" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8l3.5 3.5L13 5" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      )}
                    </button>
                  ))}
                  <div className="popup-divider" />
                  <button className="popup-action" onClick={() => { const next = !streamerMode; setStreamerMode(next); localStorage.setItem('streamerMode', next) }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>{streamerMode && <line x1="1" y1="1" x2="23" y2="23"/>}</svg>
                    {t('settings.streamerMode')}{streamerMode ? ` — ${t('settings.streamerOn')}` : ''}
                    <div className={`streamer-indicator ${streamerMode ? 'active' : ''}`} />
                  </button>
                  <button className="popup-action" onClick={openProfileSettings}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                    {t('settings.profileSettings')}
                  </button>
                  <button className="popup-action popup-action-danger" onClick={logout}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                    {t('settings.logout')}
                  </button>
                </div>
              )}
              <div className="user-panel">
                <div className="user-panel-info" onClick={() => setShowUserMenu(!showUserMenu)}>
                  <div className="user-avatar-sm-wrap">
                    <div className="user-avatar-sm" style={{ background: user.avatarColor }}>
                      <AImg src={user.avatar} />
                      {user.username[0].toUpperCase()}
                    </div>
                    <div className={`status-dot ${user.status || 'offline'}`} />
                  </div>
                  <div className="user-panel-text">
                    <span className={`user-panel-name ${streamerMode ? 'streamer-blur' : ''}`}>{user.username}<span className="user-tag">#{user.tag}</span></span>
                    <span className="user-panel-status">{statusLabel(user.status)}</span>
                  </div>
                </div>
                <button className="user-panel-btn" onClick={openProfileSettings} title="Settings">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                </button>
              </div>
            </div>
        )}
      </div>
      </div>{/* /left-sidebar-panels */}

      {/* Global user panel spanning full left sidebar width */}
      {(showFriends || activeServer) && (
        <div className="user-panel-wrapper global-user-panel" ref={userPopupRef}>
          {showUserMenu && (
            <div className="user-popup user-popup-global">
              <div className="popup-banner" style={user.bannerImg ? { backgroundImage:`url(${user.bannerImg})`, backgroundSize:'cover', backgroundPosition:'center' } : { background: bannerGradient(user.bannerColor || user.avatarColor) }} />
              <div className="popup-avatar-wrap">
                <div className={`popup-avatar${user.avatarFrame ? ` avatar-frame-${user.avatarFrame}` : ''}`} style={{ background: user.avatarColor }}>
                  <AImg src={user.avatar} />
                  {user.username[0].toUpperCase()}
                </div>
                <div className={`status-dot ${user.status || 'offline'}`} />
              </div>
              <div className="popup-info">
                <div className={`popup-name copyable-name ${streamerMode ? 'streamer-blur' : ''}`} onClick={(e) => copyUsername(user.username, user.tag, e)} title={copiedName ? t('profile.copied') : t('profile.clickToCopy')}>{user.username}<span className="user-tag">#{user.tag}</span></div>
                <div className="popup-email" onClick={() => { if (!emailRevealed) { setEmailRevealed(true); setTimeout(() => setEmailRevealed(false), 3000) } }} title={streamerMode ? t('profile.emailHidden') : (emailRevealed ? user.email : t('profile.emailReveal'))}>
                  {streamerMode ? <span className="streamer-blur">{user.email}</span> : (<>{emailRevealed ? user.email : <><span className="email-blurred">{user.email.split('@')[0]}</span>@{user.email.split('@')[1]}</>}</>)}
                </div>
                {user.bio && <div className="popup-bio">{user.bio}</div>}
              </div>
              <div className="popup-divider" />
              <div className="popup-section-label">{t('status.label')}</div>
              {[
                { value: 'online', key: 'status.online', color: '#00d4aa' },
                { value: 'idle', key: 'status.idle', color: '#f0b232' },
                { value: 'dnd', key: 'status.dnd', color: '#f04747' },
                { value: 'invisible', key: 'status.invisible', color: '#55556a' },
              ].map(opt => (
                <button key={opt.value} className={`popup-status-item ${user.status === opt.value ? 'active' : ''}`} onClick={() => changeStatus(opt.value)}>
                  <div className="popup-status-dot" style={{ background: opt.color }} />
                  <span>{t(opt.key)}</span>
                  {user.status === opt.value && <svg className="popup-check" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8l3.5 3.5L13 5" stroke="var(--primary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                </button>
              ))}
              <div className="popup-divider" />
              <button className="popup-action" onClick={() => { const next = !streamerMode; setStreamerMode(next); localStorage.setItem('streamerMode', next) }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>{streamerMode && <line x1="1" y1="1" x2="23" y2="23"/>}</svg>
                {t('settings.streamerMode')}{streamerMode ? ` — ${t('settings.streamerOn')}` : ''}
                <div className={`streamer-indicator ${streamerMode ? 'active' : ''}`} />
              </button>
              <button className="popup-action" onClick={openProfileSettings}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                {t('settings.profileSettings')}
              </button>
              <button className="popup-action popup-action-danger" onClick={logout}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                {t('settings.logout')}
              </button>
            </div>
          )}
          <div className="user-panel user-panel-global">
            <div className="user-panel-info" onClick={() => setShowUserMenu(!showUserMenu)}>
              <div className="user-avatar-sm-wrap">
                <div className={`user-avatar-sm${user.avatarFrame ? ` avatar-frame-${user.avatarFrame}` : ''}`} style={{ background: user.avatarColor }}>
                  <AImg src={user.avatar} />
                  {user.username[0].toUpperCase()}
                </div>
                <div className={`status-dot ${user.status || 'offline'}`} />
              </div>
              <div className="user-panel-text">
                <span className={`user-panel-name ${streamerMode ? 'streamer-blur' : ''}`}>{user.username}<span className="user-tag">#{user.tag}</span></span>
                <span className="user-panel-status">{statusLabel(user.status)}</span>
              </div>
            </div>
            <button className="user-panel-btn" onClick={openProfileSettings} title="Settings">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
            </button>
          </div>
        </div>
      )}
      </div>{/* /left-sidebar */}

      {/* Chat area */}
      <div className="chat-area">
        {showFriends && activeDM ? (
          <>
            <div className="chat-header">
              <div className="chat-header-left">
                <button className="mobile-back-btn" onClick={() => { setMobileInChat(false); setActiveDM(null) }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
                <button className="mobile-hamburger" onClick={() => setMobileNav(true)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
                <div className="dm-header-avatar" style={{ background: activeDM.partner?.avatarColor }}>
                  <AImg src={activeDM.partner?.avatar} />
                  {activeDM.partner?.username?.[0]?.toUpperCase()}
                </div>
                <h3>{activeDM.partner?.username}</h3>
              </div>
              <div className="chat-header-right">
                {dmCall && dmCall.dmChannelId === activeDM.id ? (
                  <button className="dm-call-header-btn dm-call-end-btn" onClick={endDmCall} title="Завершить звонок">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.09 8.98 7.27 7 12 7s8.91 1.98 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
                  </button>
                ) : (
                  <button className="dm-call-header-btn" onClick={() => startDmCall(activeDM.id, activeDM.partner)} title="Позвонить">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                  </button>
                )}
              </div>
            </div>
            {/* DM Call — Discord style */}
            {dmCall && dmCall.dmChannelId === activeDM.id && (
              dmCall.status === 'calling' ? (
                <div className="dm-call-panel">
                  <div className="dm-call-video-area">
                    <div className="dm-call-circles">
                      <div className="dm-call-circle-wrap">
                        <div className="dm-call-circle-ring pulsing-ring">
                          <div className="dm-call-big-avatar" style={{ background: dmCall.partnerAvatarColor }}>
                            <AImg src={dmCall.partnerAvatar} />
                            {dmCall.partnerUsername?.[0]?.toUpperCase()}
                          </div>
                        </div>
                        <span className="dm-call-circle-name">{dmCall.partnerUsername}</span>
                        <span className="dm-call-circle-sub">Вызов...</span>
                      </div>
                    </div>
                  </div>
                  <div className="dm-call-bar">
                    <button type="button" className="vc-ctrl-btn hangup" onClick={endDmCall} title="Отменить вызов">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.09 8.98 7.27 7 12 7s8.91 1.98 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
                    </button>
                  </div>
                </div>
              ) : (() => {
                const dmPeerSid = Object.keys(peerConnections.current).find(sid => peerConnections.current[sid] === dmCallPeerConnection.current)
                const hasLocalCam = dmCallCameraOn && dmCallCameraStream.current
                const hasLocalScreen = dmCallScreenOn && dmCallScreenStream.current
                const hasRemoteVid = dmPeerSid && remoteVideoStreams[dmPeerSid]
                const hasRemoteScreen = dmPeerSid && remoteScreenStreams[dmPeerSid]
                const anyVideo = hasLocalCam || hasLocalScreen || hasRemoteVid || hasRemoteScreen
                return (
                <div className={`dm-call-panel${anyVideo ? ' has-video' : ''}`}>
                  {/* Video area */}
                  <div className="dm-call-video-area">
                    {(() => {
                      if (anyVideo) {
                        return (
                          <div className="dm-call-tiles">
                            <div className={`dm-call-tile ${speakingUsers.has(dmCall.partnerId) ? 'speaking' : ''}`}>
                              {hasRemoteScreen ? (
                                <video ref={el => { if (el) { const s = remoteScreenStreams[dmPeerSid]; if (s && el.srcObject !== s) el.srcObject = s } }} autoPlay playsInline className="dm-tile-video" />
                              ) : hasRemoteVid ? (
                                <video ref={el => { if (el) { const s = remoteVideoStreams[dmPeerSid]; if (s && el.srcObject !== s) el.srcObject = s } }} autoPlay playsInline className="dm-tile-video" />
                              ) : (
                                <div className="dm-tile-avatar" style={{ background: dmCall.partnerAvatarColor }}><AImg src={dmCall.partnerAvatar} />{dmCall.partnerUsername?.[0]?.toUpperCase()}</div>
                              )}
                              <div className="dm-tile-name">{dmCall.partnerUsername}</div>
                            </div>
                            <div className={`dm-call-tile ${speakingUsers.has(user.id) ? 'speaking' : ''}`}>
                              {hasLocalScreen ? (
                                <video ref={el => { if (el) { const s = dmCallScreenStream.current; if (s && el.srcObject !== s) el.srcObject = s } }} autoPlay muted playsInline className="dm-tile-video" />
                              ) : hasLocalCam ? (
                                <video ref={el => { if (el) { const s = dmCallCameraStream.current; if (s && el.srcObject !== s) el.srcObject = s } }} autoPlay muted playsInline className="dm-tile-video mirror" />
                              ) : (
                                <div className="dm-tile-avatar" style={{ background: user.avatarColor }}><AImg src={user.avatar} />{user.username?.[0]?.toUpperCase()}</div>
                              )}
                              <div className="dm-tile-name">{user.username}</div>
                              {dmCallMuted.current && <div className="dm-tile-mute"><svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="1" width="6" height="9" rx="3"/><path d="M3 7v1a5 5 0 0010 0V7"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="13" y1="2" x2="3" y2="14"/></svg></div>}
                            </div>
                          </div>
                        )
                      }
                      return (
                        <div className="dm-call-circles">
                          <div className="dm-call-circle-wrap">
                            <div className={`dm-call-circle-ring ${speakingUsers.has(dmCall.partnerId) ? 'speaking' : ''}`}>
                              <div className="dm-call-big-avatar" style={{ background: dmCall.partnerAvatarColor }}><AImg src={dmCall.partnerAvatar} />{dmCall.partnerUsername?.[0]?.toUpperCase()}</div>
                            </div>
                            <span className="dm-call-circle-name">{dmCall.partnerUsername}</span>
                          </div>
                          <div className="dm-call-circle-wrap">
                            <div className={`dm-call-circle-ring ${speakingUsers.has(user.id) ? 'speaking' : ''}`}>
                              <div className="dm-call-big-avatar" style={{ background: user.avatarColor }}><AImg src={user.avatar} />{user.username?.[0]?.toUpperCase()}</div>
                              {dmCallMuted.current && <div className="dm-call-mute-badge"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="1" width="6" height="9" rx="3"/><path d="M3 7v1a5 5 0 0010 0V7"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="13" y1="2" x2="3" y2="14"/></svg></div>}
                            </div>
                            <span className="dm-call-circle-name">{user.username}</span>
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                  {/* Timer */}
                  <div className="dm-call-timer-bar">
                    <span className="dm-call-duration">{Math.floor(dmCallDuration / 60).toString().padStart(2, '0')}:{(dmCallDuration % 60).toString().padStart(2, '0')}</span>
                  </div>
                  {/* Controls */}
                  <div className="dm-call-bar">
                    <button type="button" className={`vc-ctrl-btn${dmCallMuted.current ? ' muted' : ''}`} onClick={toggleDmCallMute} title={dmCallMuted.current ? 'Включить микрофон' : 'Выключить микрофон'}>
                      {dmCallMuted.current
                        ? <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="1" width="6" height="9" rx="3"/><path d="M3 7v1a5 5 0 0010 0V7"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="13" y1="2" x2="3" y2="14"/></svg>
                        : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>}
                    </button>
                    <button type="button" className={`vc-ctrl-btn${dmCallDeafened ? ' muted' : ''}`} onClick={toggleDmCallDeafen} title={dmCallDeafened ? 'Включить звук' : 'Заглушить звук'}>
                      {dmCallDeafened
                        ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 14h3a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a9 9 0 0118 0v7a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3"/><line x1="21" y1="3" x2="3" y2="21"/></svg>
                        : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 18v-6a9 9 0 0118 0v6"/><path d="M21 19a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3zM3 19a2 2 0 002 2h1a2 2 0 002-2v-3a2 2 0 00-2-2H3z"/></svg>}
                    </button>
                    <button type="button" className={`vc-ctrl-btn${dmCallCameraOn ? ' cam-on' : ''}`} onClick={toggleDmCallCamera} title={dmCallCameraOn ? 'Выключить камеру' : 'Включить камеру'}>
                      {dmCallCameraOn
                        ? <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                        : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M16 16v1a2 2 0 01-2 2H3a2 2 0 01-2-2V7a2 2 0 012-2h2m5.66 0H14a2 2 0 012 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>}
                    </button>
                    <button type="button" className={`vc-ctrl-btn${dmCallScreenOn ? ' cam-on' : ''}`} onClick={toggleDmCallScreen} title={dmCallScreenOn ? 'Остановить демонстрацию' : 'Демонстрация экрана'}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                    </button>
                    <button type="button" className="vc-ctrl-btn hangup" onClick={endDmCall} title="Завершить звонок">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.09 8.98 7.27 7 12 7s8.91 1.98 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
                    </button>
                  </div>
                </div>
                )
              })()
            )}
            {dmPinnedMessages.length > 0 && (
              <div className="pinned-bar" onClick={() => scrollToDmPinned(dmPinnedIndex)}>
                <svg className="pinned-bar-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                <div className="pinned-bar-text">
                  <span className="pinned-bar-author">{dmPinnedMessages[dmPinnedIndex]?.user?.username}: </span>
                  <span className="pinned-bar-content">{dmPinnedMessages[dmPinnedIndex]?.content || t('msg.attachment')}</span>
                </div>
                <div className="pinned-bar-nav">
                  <button onClick={(e) => { e.stopPropagation(); scrollToDmPinned((dmPinnedIndex - 1 + dmPinnedMessages.length) % dmPinnedMessages.length) }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="18 15 12 9 6 15"/></svg>
                  </button>
                  <span className="pinned-bar-count">{dmPinnedIndex + 1}/{dmPinnedMessages.length}</span>
                  <button onClick={(e) => { e.stopPropagation(); scrollToDmPinned((dmPinnedIndex + 1) % dmPinnedMessages.length) }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                </div>
              </div>
            )}
            <div className="messages-area-wrapper">
            <div className="messages-area" ref={messagesAreaRef} onScroll={handleMessagesScroll} onDrop={handleDrop} onDragOver={handleDragOver}>
              <div className="messages-list">
                {dmMessages.map((msg, i) => {
                  const prev = dmMessages[i - 1]
                  const isGrouped = prev && prev.userId === msg.userId && !msg.type && !prev?.type && (new Date(msg.createdAt) - new Date(prev.createdAt)) < 300000
                  if (hiddenMessages.has(msg.id)) return null
                  return (
                    <div key={msg.id} id={'msg-' + msg.id} className={`message ${isGrouped ? 'grouped' : ''}${isMsgPinned(msg, true) ? ' pinned' : ''}${msg.deleted ? ' deleted-msg' : ''}${selectMode && selectedMsgs.has(msg.id) ? ' selected' : ''}`} onContextMenu={(e) => !msg.deleted && handleMsgContext(e, msg, true)} onClick={() => selectMode && !msg.deleted && toggleMsgSelect(msg.id)} onMouseEnter={() => !selectMode && !msg.deleted && setHoveredMsg(msg.id)} onMouseLeave={() => hoveredMsg === msg.id && setHoveredMsg(null)} onDoubleClick={() => !selectMode && !msg.deleted && toggleReaction(msg.id, '👍', true)}>
                      {hoveredMsg === msg.id && !selectMode && !msg.deleted && (
                        <div className="msg-hover-actions">
                          <button title={t('message.replyAction')} onClick={(e) => { e.stopPropagation(); setReplyTo(msg) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg></button>
                          <button title="👍" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, '👍', true) }}>👍</button>
                          <button title={t('emoji.search')} onClick={(e) => { openReactionPicker(e, msg.id, true) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></button>
                        </div>
                      )}
                      {selectMode && !msg.deleted && (
                        <div className="msg-select-checkbox" onClick={(e) => { e.stopPropagation(); toggleMsgSelect(msg.id) }}>
                          <div className={`msg-checkbox ${selectedMsgs.has(msg.id) ? 'checked' : ''}`}>
                            {selectedMsgs.has(msg.id) && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                          </div>
                        </div>
                      )}
                      {isMsgPinned(msg, true) && !msg.deleted && <div className="msg-pin-indicator"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></div>}
                      {!isGrouped && !selectMode && (() => { const p = prof(msg.userId, msg.user); return (
                        <div className={`msg-avatar clickable${p.avatarFrame ? ` avatar-frame-${p.avatarFrame}` : ''}`} style={{ background: p.avatarColor }} onClick={(e) => msg.user && showUserProfile({ ...msg.user, ...userProfiles[msg.userId] }, e.clientX, e.clientY)}>
                          <AImg src={p.avatar} />
                          {p.username?.[0]?.toUpperCase()}
                        </div>
                      )})()}
                      <div className="msg-content">
                        {msg.replyTo && (
                          <div className="msg-reply-ref" onClick={() => { const el = document.getElementById('msg-' + msg.replyTo.id); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('msg-highlight'); void el.offsetWidth; el.classList.add('msg-highlight'); setTimeout(() => el.classList.remove('msg-highlight'), 2000) } }}>
                            <div className="msg-reply-line" style={{ background: getMemberRoleColor(msg.replyTo.user?.id) || msg.replyTo.user?.avatarColor || 'var(--primary)' }} />
                            <span className="msg-reply-author" style={{ color: getMemberRoleColor(msg.replyTo.user?.id) || undefined }}>{msg.replyTo.user?.username || t('msg.deletedUser')}</span>
                            <span className="msg-reply-text">{msg.replyTo.content || t('msg.replyContent')}</span>
                          </div>
                        )}
                        {!isGrouped && (() => { const p = prof(msg.userId, msg.user); return (
                          <div className="msg-header">
                            <span className={`msg-author clickable ${streamerMode && msg.userId === user.id ? 'streamer-blur' : ''}`} style={{ color: getMemberRoleColor(msg.userId) || undefined }} onClick={(e) => showUserProfile({ ...msg.user, ...userProfiles[msg.userId] }, e.clientX, e.clientY)}><span className="msg-author-name">{p.username}</span><span className="user-tag">#{p.tag}</span>{p.statusEmoji && <span className="msg-status-emoji" title="Статус">{p.statusEmoji}</span>}</span>
                            <span className="msg-time">{formatTime(msg.createdAt)}</span>
                          </div>
                        )})()}
                        {msg.deleted ? (
                          <div className="msg-text message-deleted">{t('msg.deleted')}</div>
                        ) : editingMsg && editingMsg.id === msg.id ? (
                          <div className="msg-edit-wrap">
                            <textarea ref={editInputRef} className="msg-edit-input" value={editingMsg.content} maxLength={1500} rows={1} onChange={e => { setEditingMsg(prev => ({ ...prev, content: e.target.value.slice(0, 1500) })); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditMsg(); } if (e.key === 'Escape') cancelEdit(); }} />
                            <div className="msg-edit-hint">{t('msg.edited')}</div>
                          </div>
                        ) : (
                          <>
                            {msg.content && !['dm-call-start','dm-call-end','dm-call-missed'].includes(msg.type) && (
                              /^https:\/\/media\d*\.giphy\.com\//i.test(msg.content)
                                ? <div className="msg-gif"><img src={msg.content} alt="GIF" className="msg-gif-img" loading="lazy" /></div>
                                : <div className={`msg-text${emojiOnlyCount(msg.content) ? " msg-big-emoji" : ""}`}>{renderContent(msg.content, serverCustomEmojis)}{msg.editedAt && <span className="msg-edited">{t('msg.edited')}</span>}</div>
                            )}
                          </>
                        )}
                        {msg.type === 'invite' && msg.invite && (
                          <div className="invite-card">
                            <div className="invite-card-header">{t('server.invite')}</div>
                            <div className="invite-card-body">
                              <div className="invite-card-icon" style={{ background: 'var(--primary)' }}>
                                {msg.invite.serverIcon}
                              </div>
                              <div className="invite-card-info">
                                <span className="invite-card-name">{msg.invite.serverName}</span>
                                <span className="invite-card-members">{msg.invite.memberCount} {t('members.title').toLowerCase()}</span>
                              </div>
                              {servers.find(s => s.id === msg.invite.serverId) ? (
                                <span className="invite-card-joined">{t('invite.alreadyMember')}</span>
                              ) : (
                                <button className="btn-submit invite-card-btn" onClick={() => joinServerFromInvite(msg.invite.serverId, msg.invite.serverName)}>{t('server.joinBtn')}</button>
                              )}
                            </div>
                          </div>
                        )}
                        {msg.type === 'voice-invite' && msg.voiceInvite && (
                          <div className="invite-card voice-invite-card">
                            <div className="invite-card-header">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/></svg>
                              {t('voice.invite')}
                            </div>
                            <div className="invite-card-body">
                              <div className="invite-card-icon voice-invite-icon" style={{ background: 'var(--secondary)' }}>
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                              </div>
                              <div className="invite-card-info">
                                <span className="invite-card-name">{msg.voiceInvite.channelName}</span>
                                <span className="invite-card-members">{msg.voiceInvite.serverName} · {msg.voiceInvite.participantCount} {t('members.title').toLowerCase()}</span>
                              </div>
                              {voiceChannel?.id === msg.voiceInvite.channelId ? (
                                <span className="invite-card-joined">{t('voice.connected')}</span>
                              ) : (
                                <button className="btn-submit invite-card-btn" onClick={() => joinVoiceFromInvite(msg.voiceInvite.serverId, msg.voiceInvite.channelId, msg.voiceInvite.channelName)}>{t('voice.joinChannel')}</button>
                              )}
                            </div>
                          </div>
                        )}
                        {(msg.type === 'dm-call-start' || msg.type === 'dm-call-end' || msg.type === 'dm-call-missed') && (
                          <div className="dm-call-system-msg">
                            <div className="dm-call-system-icon">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={msg.type === 'dm-call-missed' ? 'var(--danger)' : 'var(--secondary)'} strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/>{msg.type === 'dm-call-missed' && <line x1="1" y1="1" x2="23" y2="23"/>}</svg>
                            </div>
                            <div className="dm-call-system-text">
                              <span className="dm-call-system-title">
                                {msg.type === 'dm-call-start' ? `${msg.user?.username} начал звонок` : msg.type === 'dm-call-missed' ? 'Пропущенный звонок' : `Звонок завершён`}
                              </span>
                              {msg.type === 'dm-call-end' && msg.content && <span className="dm-call-system-duration">{msg.content}</span>}
                            </div>
                          </div>
                        )}
                        {msg.attachment && (
                          <div className={`msg-attachment msg-attachment-${msg.attachment.fileType}`}>
                            {msg.attachment.fileType === 'image' ? (
                              <img src={msg.attachment.url} alt={msg.attachment.fileName} className="msg-image" onClick={() => openLightbox(msg)} loading="lazy" />
                            ) : msg.attachment.fileType === 'video' ? (
                              <div className="msg-video-wrap" onClick={() => openLightbox(msg)}>
                                <video src={msg.attachment.url} className="msg-video" preload="metadata" />
                                <div className="msg-video-play"><svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
                              </div>
                            ) : msg.attachment.fileType === 'audio' ? (
                              <AudioWavePlayer src={msg.attachment.url} fileName={msg.attachment.fileName} fileSize={msg.attachment.fileSize} />
                            ) : (
                              <a href={msg.attachment.url} download={msg.attachment.fileName} className="msg-file-link" target="_blank" rel="noreferrer">
                                <div className="file-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
                                <div className="file-info">
                                  <span className="file-name">{msg.attachment.fileName}</span>
                                  <span className="file-size">{formatFileSize(msg.attachment.fileSize)}</span>
                                </div>
                                <svg className="file-download-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                              </a>
                            )}
                          </div>
                        )}
                        {msg.reactions?.length > 0 && (
                          <div className="msg-reactions">
                            {msg.reactions.map((r, ri) => (
                              <button key={ri} className={`msg-reaction ${r.users.includes(user.id) ? 'reacted' : ''}`} onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, r.emoji, true) }} onContextMenu={(e) => showReactionUsers(e, r.emoji, r.users, true)}>
                                <span className="reaction-emoji">{r.emoji}</span>
                                <span className="reaction-count">{r.users.length}</span>
                              </button>
                            ))}
                            <button className="msg-reaction add-reaction" onClick={(e) => { openReactionPicker(e, msg.id, true) }}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>
            </div>
              {showScrollBtn && (
                <button className="scroll-bottom-btn" onClick={scrollToBottom} title={t('msg.scrollDown')}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                </button>
              )}
            </div>
            {selectMode && (
              <div className="select-bar">
                <span className="select-bar-count">{(t('msg.selectedCount') || 'Выбрано: {count}').replace('{count}', selectedMsgs.size)}</span>
                {canBulkDeleteForAll() && (
                  <button className="select-bar-delete" onClick={() => bulkDeleteMsgs('forAll')} disabled={selectedMsgs.size === 0}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    <span>{t('msg.deleteForAll') || 'Удалить для всех'}</span>
                  </button>
                )}
                <button className="select-bar-delete" onClick={() => bulkDeleteMsgs('forMe')} disabled={selectedMsgs.size === 0} style={{ background: 'var(--bg-secondary)' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  <span>{t('msg.deleteForMe') || 'Удалить для себя'}</span>
                </button>
                <button className="select-bar-cancel" onClick={() => { setSelectMode(false); setSelectedMsgs(new Set()) }}>
                  <span>{t('common.cancel') || 'Отмена'}</span>
                </button>
              </div>
            )}
            {blockedByPartner || blockedUsers.includes(activeDM.partner?.id) ? (
              <div className="chat-input-blocked" style={selectMode ? { display: 'none' } : undefined}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M4.93 4.93l14.14 14.14"/></svg>
                <span>{blockedUsers.includes(activeDM.partner?.id) ? t('msg.blockedUser') : t('msg.cannotSend')}</span>
              </div>
            ) : (
              <form className="chat-input-form" onSubmit={sendDM} style={selectMode ? { display: 'none' } : undefined}>
                {replyTo && replyTo.isDM && (
                  <div className="reply-bar">
                    <div className="reply-bar-line" style={{ background: 'var(--primary)' }} />
                    <div className="reply-bar-content">
                      <span className="reply-bar-label">{t('message.reply')} <span className="reply-bar-author">{replyTo.user?.username}</span></span>
                      <span className="reply-bar-text">{replyTo.content || t('message.attachment')}</span>
                    </div>
                    <button type="button" className="reply-bar-close" onClick={() => setReplyTo(null)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </div>
                )}
                <div className="chat-input-wrapper">
                  <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileInput} />
                  <div className="attach-wrapper" ref={attachMenuRef}>
                    <button type="button" className="input-btn" ref={attachBtnRef} onClick={() => setShowAttachMenu(v => !v)} title="Upload file">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
                    </button>
                    {showAttachMenu && (
                      <div className="attach-menu">
                        <button className="attach-menu-item" onClick={() => openFileWith('image/*')}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                          <span>{t('upload.photo')}</span>
                        </button>
                        <button className="attach-menu-item" onClick={() => openFileWith('video/*')}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                          <span>{t('upload.video')}</span>
                        </button>
                        <button className="attach-menu-item" onClick={() => openFileWith('')}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                          <span>{t('upload.file')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <textarea
                    className="chat-textarea"
                    placeholder={t('dm.writeToPlaceholder').replace('{name}', activeDM.partner?.username)}
                    value={input}
                    onChange={e => { setInput(e.target.value.slice(0, 1500)); e.target.style.height='auto'; e.target.style.height=Math.min(e.target.scrollHeight,160)+'px' }}
                    onKeyDown={e => handleChatKeyDown(e, sendDM)}
                    maxLength={1500}
                    rows={1}
                    autoFocus
                  />
                  {input.length > 1300 && <span className="char-counter" style={{ color: input.length >= 1500 ? 'var(--danger)' : 'var(--text-muted)' }}>{input.length}/1500</span>}
                  <div className="emoji-btn-wrapper">
                    <button type="button" className="input-btn emoji-toggle-btn" onClick={() => { setShowEmojiPicker(v => !v); setEmojiSearch(''); setEmojiCategory('smileys') }} title={t('emoji.title') || 'Эмодзи'}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                    </button>
                    {showEmojiPicker && (
                      <div className="emoji-picker" ref={emojiPickerRef}>
                        <div className="emoji-picker-search">
                          <input type="text" placeholder={t('emoji.search') || 'Поиск...'} value={emojiSearch} onChange={e => setEmojiSearch(e.target.value)} autoFocus />
                        </div>
                        {serverCustomEmojis.length > 0 && !emojiSearch && (
                          <>
                            <div className="emoji-picker-section-label">Эмодзи сервера</div>
                            <div className="emoji-picker-grid">
                              {serverCustomEmojis.map(ce => (
                                <button type="button" key={ce.id} className="emoji-item emoji-item-custom" title={`:${ce.name}:`} onClick={() => { setInput(v => v + `:${ce.name}:`); setShowEmojiPicker(false) }}>
                                  <img src={ce.url} alt={ce.name} style={{ width: 24, height: 24, objectFit: 'contain' }} />
                                </button>
                              ))}
                            </div>
                            <div className="emoji-picker-section-label">Стандартные</div>
                          </>
                        )}
                        <div className="emoji-picker-cats">
                          {Object.entries(emojiData).map(([key, cat]) => (
                            <button key={key} className={`emoji-cat-btn ${emojiCategory === key ? 'active' : ''}`} onClick={() => setEmojiCategory(key)} title={cat.label}>{cat.icon}</button>
                          ))}
                        </div>
                        <div className="emoji-picker-grid">
                          {(emojiSearch
                            ? Object.values(emojiData).flatMap(c => c.emojis)
                            : emojiData[emojiCategory]?.emojis || []
                          ).filter(e => !emojiSearch || e.includes(emojiSearch)).map((emoji, i) => (
                            <button type="button" key={i} className="emoji-item" onClick={() => insertEmoji(emoji)}>{emoji}</button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="gif-btn-wrapper" ref={gifPickerRef}>
                    <button type="button" className="input-btn gif-toggle-btn" onClick={openGifPicker} title="GIF">
                      <span className="gif-btn-label">GIF</span>
                    </button>
                    {showGifPicker && (
                      <div className="gif-picker">
                        <div className="gif-picker-search">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                          <input type="text" placeholder="Поиск GIF..." value={gifSearch} autoFocus
                            onChange={e => {
                              const q = e.target.value; setGifSearch(q)
                              clearTimeout(gifSearchTimer.current)
                              gifSearchTimer.current = setTimeout(() => fetchGifs(q), 400)
                            }} />
                        </div>
                        <div className="gif-picker-grid">
                          {gifLoading ? (
                            <div className="gif-picker-loading">
                              <div className="gif-picker-spinner" />
                            </div>
                          ) : gifResults.length === 0 ? (
                            <div className="gif-picker-empty">Ничего не найдено</div>
                          ) : gifResults.map(gif => (
                            <div key={gif.id} className="gif-item" onClick={() => sendGif(gif)}>
                              <img src={gif.images.fixed_width.url} alt={gif.title} loading="lazy" />
                            </div>
                          ))}
                        </div>
                        <div className="gif-picker-footer">
                          <img src="https://developers.giphy.com/branch/master/static/header-logo-8974b8ae658f704a5b48a2d039b8ad93.gif" alt="Powered by GIPHY" className="giphy-logo" />
                        </div>
                      </div>
                    )}
                  </div>
                  <button type="submit" className="input-btn send-btn" disabled={!input.trim()}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
                  </button>
                </div>
              </form>
            )}
          </>
        ) : showFriends ? (
          <div className="friends-panel">
            <div className="chat-header">
              <div className="chat-header-left">
                <button className="mobile-back-btn" onClick={() => { setMobileInChat(false) }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
                <button className="mobile-hamburger" onClick={() => setMobileNav(true)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                <h3>{t('friends.title')}</h3>
                <div className="friends-header-divider" />
                <div className="friends-tabs">
                  <button className={`friends-tab ${friendsTab === 'all' ? 'active' : ''}`} onClick={() => setFriendsTab('all')}>{t('friends.all')}</button>
                  <button className={`friends-tab ${friendsTab === 'pending' ? 'active' : ''}`} onClick={() => setFriendsTab('pending')}>
                    {t('friends.pending')}
                    {friendRequests.length > 0 && <span className="friends-tab-badge">{friendRequests.length}</span>}
                  </button>
                  <button className={`friends-tab ${friendsTab === 'blocked' ? 'active' : ''}`} onClick={() => setFriendsTab('blocked')}>{t('friends.blocked')}</button>
                  <button className={`friends-tab friends-tab-add ${friendsTab === 'add' ? 'active' : ''}`} onClick={() => setFriendsTab('add')}>{t('friends.add')}</button>
                </div>
              </div>
            </div>
            {/* Mobile-only friends tabs row */}
            <div className="mobile-friends-tabs">
              <button className={`friends-tab ${friendsTab === 'all' ? 'active' : ''}`} onClick={() => setFriendsTab('all')}>{t('friends.all')}</button>
              <button className={`friends-tab ${friendsTab === 'pending' ? 'active' : ''}`} onClick={() => setFriendsTab('pending')}>
                {t('friends.pending')}
                {friendRequests.length > 0 && <span className="friends-tab-badge">{friendRequests.length}</span>}
              </button>
              <button className={`friends-tab ${friendsTab === 'blocked' ? 'active' : ''}`} onClick={() => setFriendsTab('blocked')}>{t('friends.blocked')}</button>
              <button className={`friends-tab friends-tab-add ${friendsTab === 'add' ? 'active' : ''}`} onClick={() => setFriendsTab('add')}>{t('friends.add')}</button>
            </div>
            {friendsTab === 'all' && (
              <div className="friends-search-bar">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input
                  type="text"
                  className="friends-search-input"
                  placeholder={t('friends.searchPlaceholder')}
                  value={friendsSearch}
                  onChange={e => setFriendsSearch(e.target.value)}
                />
                {friendsSearch && (
                  <button className="friends-search-clear" onClick={() => setFriendsSearch('')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                )}
              </div>
            )}
            <div className="friends-content">
              {friendsTab === 'all' && (() => {
                const filtered = friendsSearch.trim()
                  ? friends.filter(f => f.username.toLowerCase().includes(friendsSearch.toLowerCase()) || (f.tag && f.tag.includes(friendsSearch)))
                  : friends
                return (
                <div className="friends-list">
                  {filtered.length === 0 && !friendsSearch ? (
                    <div className="friends-empty">
                      <div className="friends-empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="url(#emptyGrad)" strokeWidth="1.5">
                          <defs><linearGradient id="emptyGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#00d4aa"/><stop offset="100%" stopColor="#7c5cfc"/></linearGradient></defs>
                          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
                        </svg>
                      </div>
                      <h4>{t('friends.noFriends')}</h4>
                      <p>{t('friends.sendRequest')}</p>
                      <button className="btn-submit friends-empty-btn" onClick={() => setFriendsTab('add')}>{t('friends.add')}</button>
                    </div>
                  ) : filtered.length === 0 && friendsSearch ? (
                    <div className="friends-empty">
                      <h4>{t('friends.noResults')}</h4>
                      <p>«{friendsSearch}»</p>
                    </div>
                  ) : (
                    <>
                      <div className="friends-section-label">{t('friends.all')} — {filtered.length}</div>
                      {filtered.map(f => (
                        <div key={f.id} className="friend-item">
                          <div className="friend-item-left">
                            <div className="member-avatar" style={{ background: f.avatarColor }}>
                              <AImg src={f.avatar} />
                              {f.username[0].toUpperCase()}
                              <div className={`status-dot ${f.status}`} />
                            </div>
                            <div className="friend-item-info">
                              <span className="friend-item-name">{f.username}<span className="user-tag">#{f.tag}</span></span>
                              <span className="friend-item-status">{statusLabel(f.status)}</span>
                            </div>
                          </div>
                          <div className="friend-actions">
                            <button className="friend-action-btn friend-action-msg" onClick={() => openDM(f.id)}>
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
                              <span className="friend-action-tooltip">{t('friends.message')}</span>
                            </button>
                            <button className="friend-action-btn friend-action-call" onClick={async () => { const dm = await openDM(f.id); if (dm) startDmCall(dm.id, { id: f.id, username: f.username, avatarColor: f.avatarColor }) }}>
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                              <span className="friend-action-tooltip">{t('friends.call')}</span>
                            </button>
                            <button className="friend-action-btn friend-action-block" onClick={() => blockUser(f.id, f.username)}>
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                              <span className="friend-action-tooltip">{t('friends.block')}</span>
                            </button>
                            <button className="friend-action-btn friend-action-remove" onClick={() => confirmRemoveFriend(f)}>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="11" x2="23" y2="11"/></svg>
                              <span className="friend-action-tooltip">{t('friends.remove')}</span>
                            </button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
                )
              })()}
              {friendsTab === 'pending' && (
                <div className="friends-list">
                  {friendRequests.length === 0 && outgoingRequests.length === 0 ? (
                    <div className="friends-empty">
                      <div className="friends-empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="url(#emptyGrad2)" strokeWidth="1.5">
                          <defs><linearGradient id="emptyGrad2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#00d4aa"/><stop offset="100%" stopColor="#7c5cfc"/></linearGradient></defs>
                          <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/>
                        </svg>
                      </div>
                      <h4>{t('friends.noPending')}</h4>
                      <p>{t('friends.sendRequest')}</p>
                    </div>
                  ) : (
                    <>
                      {friendRequests.length > 0 && (
                        <>
                          <div className="friends-section-label">{t('friends.incoming')} — {friendRequests.length}</div>
                          {friendRequests.map(fr => (
                            <div key={fr.id} className="friend-item">
                              <div className="friend-item-left">
                                <div className="member-avatar" style={{ background: fr.from.avatarColor }}>
                                  <AImg src={fr.from.avatar} />
                                  {fr.from.username[0].toUpperCase()}
                                  <div className={`status-dot ${fr.from.status}`} />
                                </div>
                                <div className="friend-item-info">
                                  <span className="friend-item-name">{fr.from.username}<span className="user-tag">#{fr.from.tag}</span></span>
                                  <span className="friend-item-status">{t('friends.incoming')}</span>
                                </div>
                              </div>
                              <div className="friend-actions">
                                <button className="friend-accept-btn" onClick={() => acceptFriendRequest(fr.id)} title="Accept">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                                </button>
                                <button className="friend-decline-btn" onClick={() => declineFriendRequest(fr.id)} title="Decline">
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                                </button>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                      {outgoingRequests.length > 0 && (
                        <>
                          <div className="friends-section-label">{t('friends.outgoing')} — {outgoingRequests.length}</div>
                          {outgoingRequests.map(fr => (
                            <div key={fr.id} className="friend-item">
                              <div className="friend-item-left">
                                <div className="member-avatar" style={{ background: fr.to.avatarColor }}>
                                  <AImg src={fr.to.avatar} />
                                  {fr.to.username[0].toUpperCase()}
                                  <div className={`status-dot ${fr.to.status}`} />
                                </div>
                                <div className="friend-item-info">
                                  <span className="friend-item-name">{fr.to.username}<span className="user-tag">#{fr.to.tag}</span></span>
                                  <span className="friend-item-status">{t('friends.outgoing')}</span>
                                </div>
                              </div>
                              <div className="friend-actions">
                                <button className="friend-decline-btn" onClick={() => cancelFriendRequest(fr.toId, fr.id)} title={t('common.cancel')}>
                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                                </button>
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </>
                  )}
                </div>
              )}
              {friendsTab === 'add' && (
                <div className="friends-add">
                  <div className="friends-add-card">
                    <h4>{t('friends.add')}</h4>
                    <p>{t('friends.sendRequest')}</p>
                    <form className="friends-search-form" onSubmit={searchFriend}>
                      <div className="friend-search-inputs">
                        <input
                          className="friend-search-name"
                          type="text"
                          placeholder={t('auth.username')}
                          value={friendSearch}
                          onChange={e => { setFriendSearch(e.target.value.replace(/[#\s]/g, '')); setFriendSearchError(''); setFriendSearchResult(null) }}
                          onKeyDown={handleFriendNameKey}
                          onPaste={e => {
                            const pasted = e.clipboardData.getData('text')
                            const match = pasted.match(/^(.+)#(\d{4})$/)
                            if (match) {
                              e.preventDefault()
                              setFriendSearch(match[1])
                              setFriendTag(match[2])
                              setFriendSearchError('')
                              setFriendSearchResult(null)
                            }
                          }}
                          autoFocus
                        />
                        <span className="friend-search-hash">#</span>
                        <input
                          ref={friendTagRef}
                          className="friend-search-tag"
                          type="text"
                          placeholder="0000"
                          value={friendTag}
                          onChange={handleFriendTagInput}
                          maxLength={4}
                        />
                      </div>
                      <button type="submit" className="btn-submit" disabled={friendSearching || !friendSearch.trim() || friendTag.length !== 4}>
                        {friendSearching ? t('friends.searching') : t('friends.sendRequest')}
                      </button>
                    </form>
                    {friendSearchError && <div className="friend-search-error">{friendSearchError}</div>}
                  </div>
                  {friendSearchResult && (
                    <div className="friend-search-result">
                      <div className="friend-item">
                        <div className="friend-item-left">
                          <div className="member-avatar" style={{ background: friendSearchResult.user.avatarColor }}>
                            <AImg src={friendSearchResult.user.avatar} />
                            {friendSearchResult.user.username[0].toUpperCase()}
                            <div className={`status-dot ${friendSearchResult.user.status}`} />
                          </div>
                          <div className="friend-item-info">
                            <span className="friend-item-name">{friendSearchResult.user.username}<span className="user-tag">#{friendSearchResult.user.tag}</span></span>
                            <span className="friend-item-status">{friendSearchResult.user.bio || statusLabel(friendSearchResult.user.status)}</span>
                          </div>
                        </div>
                        {friendSearchResult.friendStatus === 'accepted' ? (
                          <span className="friend-badge">{t('friends.all')}</span>
                        ) : friendSearchResult.friendStatus === 'pending' ? (
                          <span className="friend-badge">{t('friends.pending')}</span>
                        ) : (
                          <button className="btn-submit friend-add-btn" onClick={() => sendFriendRequest(friendSearchResult.user.id)}>
                            {t('friends.sendRequest')}
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {friendsTab === 'blocked' && (
                <div className="friends-list">
                  {blockedUsersDetails.length === 0 ? (
                    <div className="friends-empty">
                      <div className="friends-empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="url(#emptyGrad)" strokeWidth="1.5">
                          <defs><linearGradient id="emptyGrad2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#00d4aa"/><stop offset="100%" stopColor="#7c5cfc"/></linearGradient></defs>
                          <circle cx="12" cy="12" r="10" stroke="url(#emptyGrad2)"/><path d="M4.93 4.93l14.14 14.14" stroke="url(#emptyGrad2)"/>
                        </svg>
                      </div>
                      <h4>{t('friends.noBlocked')}</h4>
                      <p>{t('friends.noBlockedSub')}</p>
                    </div>
                  ) : (
                    <>
                      <div className="friends-section-label">{t('friends.blocked')} — {blockedUsersDetails.length}</div>
                      {blockedUsersDetails.map(bu => (
                        <div key={bu.id} className="friend-item">
                          <div className="friend-item-left">
                            <div className="member-avatar" style={{ background: bu.avatarColor }}>
                              <AImg src={bu.avatar} />
                              {bu.username[0].toUpperCase()}
                            </div>
                            <div className="friend-item-info">
                              <span className="friend-item-name">{bu.username}<span className="user-tag">#{bu.tag}</span></span>
                              <span className="friend-item-status">{t('friends.blocked')}</span>
                            </div>
                          </div>
                          <div className="friend-actions">
                            <button className="btn-sm" onClick={() => unblockUser(bu.id)} title={t('friends.unblock')}>{t('friends.unblock')}</button>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        ) : voiceViewChannel && voiceChannel ? (
          <>
            <div className="chat-header">
              <div className="chat-header-left">
                <button className="mobile-back-btn" onClick={() => { setMobileInChat(false) }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
                <button className="mobile-hamburger" onClick={() => setMobileNav(true)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                <h3>{voiceViewChannel.name}</h3>
              </div>
            </div>
            <div className="voice-call-view">
              {(() => {
                const vcUsers = voiceUsers[voiceViewChannel.id] || []
                const focusedUser = focusedStreamUser ? vcUsers.find(u => u.id === focusedStreamUser) : null
                const hasFocused = !!focusedUser
                const focusedIsLocal = focusedUser?.id === user.id
                const focusedIsScreenSharing = focusedUser && (focusedIsLocal ? screenShareOn : focusedUser.screen)
                const focusedHasCamera = focusedUser && (focusedIsLocal ? (cameraOn && cameraStream.current) : remoteVideoStreams[focusedUser?.socketId])
                const focusedHasBoth = focusedIsScreenSharing && focusedHasCamera
                const showScreen = focusedStreamType === 'screen' && focusedIsScreenSharing
                const showCamera = focusedStreamType === 'camera' && focusedHasCamera
                // If focused user left the channel, reset
                if (focusedStreamUser && !focusedUser) {
                  setTimeout(() => setFocusedStreamUser(null), 0)
                }
                // Pin button component
                const PinBtn = ({ userId }) => {
                  const isPinned = pinnedUser === userId
                  return (
                    <button className={`voice-tile-pin ${isPinned ? 'pinned' : ''}`} onClick={(e) => {
                      e.stopPropagation()
                      if (isPinned) {
                        setPinnedUser(null)
                      } else {
                        setPinnedUser(userId)
                        setFocusedStreamUser(userId)
                        setFocusedStreamType('screen')
                      }
                    }} title={isPinned ? t('voice.unpin') : t('voice.pin')}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                    </button>
                  )
                }
                return hasFocused ? (
                  /* ── Focused user view ── */
                  <div className="voice-focused-layout">
                    <div className="voice-focused-main">
                      {showScreen ? (
                        <video
                          key={focusedStreamUser + '-screen'}
                          ref={el => { if (el) { const _s = focusedIsLocal ? screenStream.current : (remoteScreenStreams[focusedUser.socketId] || remoteVideoStreams[focusedUser.socketId]); if (el.srcObject !== _s) el.srcObject = _s } }}
                          autoPlay muted={focusedIsLocal} playsInline
                          className="voice-focused-video"
                        />
                      ) : showCamera || (focusedHasCamera && !focusedIsScreenSharing) ? (
                        <video
                          key={focusedStreamUser + '-camera'}
                          ref={el => { if (el) { const _s = focusedIsLocal ? cameraStream.current : remoteVideoStreams[focusedUser.socketId]; if (el.srcObject !== _s) el.srcObject = _s } }}
                          autoPlay muted={focusedIsLocal} playsInline
                          className={`voice-focused-video ${focusedIsLocal ? 'mirror' : ''}`}
                        />
                      ) : focusedIsScreenSharing ? (
                        <video
                          key={focusedStreamUser + '-screen-fallback'}
                          ref={el => { if (el) { const _s = focusedIsLocal ? screenStream.current : (remoteScreenStreams[focusedUser.socketId] || remoteVideoStreams[focusedUser.socketId]); if (el.srcObject !== _s) el.srcObject = _s } }}
                          autoPlay muted={focusedIsLocal} playsInline
                          className="voice-focused-video"
                        />
                      ) : (
                        <div className="voice-focused-avatar-wrap">
                          <div className="voice-focused-avatar" style={{ background: focusedUser.avatarColor }}>
                            <AImg src={focusedUser.avatar} />
                            {focusedUser.username[0].toUpperCase()}
                          </div>
                        </div>
                      )}
                      <div className="voice-focused-label">
                        {(showScreen || (!showCamera && focusedIsScreenSharing)) ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        )}
                        <span>{(showScreen || (!showCamera && focusedIsScreenSharing)) ? t('voice.screen').replace('{name}', focusedUser.username) : focusedUser.username}</span>
                        {focusedHasBoth && (
                          <div className="voice-focused-switch">
                            <button className={`vfs-btn ${focusedStreamType === 'screen' ? 'active' : ''}`} onClick={() => setFocusedStreamType('screen')}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                              {t('voice.screenLabel')}
                            </button>
                            <button className={`vfs-btn ${focusedStreamType === 'camera' ? 'active' : ''}`} onClick={() => setFocusedStreamType('camera')}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                              {t('voice.camera')}
                            </button>
                          </div>
                        )}
                        {pinnedUser && (
                          <button className="voice-focused-unpin" onClick={() => setPinnedUser(null)}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                            {t('voice.pinned')}
                          </button>
                        )}
                        <button className="voice-focused-stop" onClick={() => { setFocusedStreamUser(null); setPinnedUser(null) }}>
                          {t('voice.backToGrid')}
                        </button>
                      </div>
                    </div>
                    <div className="voice-focused-sidebar">
                      {vcUsers.map(vu => {
                        const isLocal = vu.id === user.id
                        const isFocused = vu.id === focusedStreamUser
                        return (
                          <div key={vu.id} className={`voice-tile mini ${speakingUsers.has(vu.id) ? 'speaking' : ''} ${isFocused ? 'focused' : ''}`} onClick={() => { setPinnedUser(vu.id); setFocusedStreamUser(vu.id); setFocusedStreamType('screen') }}>
                            {(() => {
                              const vuIsLocal = vu.id === user.id
                              const vuHasScreen = vuIsLocal ? screenShareOn : vu.screen
                              const vuHasCamera = vuIsLocal ? (cameraOn && cameraStream.current) : (vu.camera && remoteVideoStreams[vu.socketId])
                              const vuHasBoth = vuHasScreen && vuHasCamera
                              // If this user is focused and has both, mini shows the OTHER stream
                              if (isFocused && vuHasBoth) {
                                if (focusedStreamType === 'screen') {
                                  // Main shows screen, mini shows camera
                                  if (vuIsLocal) return <video ref={el => { if (el) { const _s = cameraStream.current; if (_s && el.srcObject !== _s) el.srcObject = _s } }} autoPlay muted playsInline className="voice-tile-video mirror" />
                                  return remoteVideoStreams[vu.socketId]
                                    ? <video ref={el => { if (el) { const _s = remoteVideoStreams[vu.socketId]; if (el.srcObject !== _s) el.srcObject = _s } }} autoPlay playsInline className="voice-tile-video" />
                                    : <div className="voice-tile-avatar" style={{ background: vu.avatarColor }}><AImg src={vu.avatar} />{vu.username[0].toUpperCase()}</div>
                                } else {
                                  // Main shows camera, mini shows screen
                                  if (vuIsLocal && screenStream.current) return <video ref={el => { if (el) { const _s = screenStream.current; if (_s && el.srcObject !== _s) el.srcObject = _s } }} autoPlay muted playsInline className="voice-tile-video" />
                                  const scrSrc = remoteScreenStreams[vu.socketId] || remoteVideoStreams[vu.socketId]
                                  return scrSrc
                                    ? <video ref={el => { if (el) { const _s = scrSrc; if (el.srcObject !== _s) el.srcObject = _s } }} autoPlay playsInline className="voice-tile-video" />
                                    : <div className="voice-tile-avatar" style={{ background: vu.avatarColor }}><AImg src={vu.avatar} />{vu.username[0].toUpperCase()}</div>
                                }
                              }
                              // Normal mini tile
                              if (vuIsLocal && cameraOn && cameraStream.current) {
                                return <video ref={el => { if (el) { const _s = cameraStream.current; if (_s && el.srcObject !== _s) el.srcObject = _s } }} autoPlay muted playsInline className="voice-tile-video mirror" />
                              }
                              if (!vuIsLocal && remoteVideoStreams[vu.socketId]) {
                                return <video ref={el => { if (el) { const _s = remoteVideoStreams[vu.socketId]; if (_s && el.srcObject !== _s) el.srcObject = _s } }} autoPlay playsInline className="voice-tile-video" />
                              }
                              return <div className="voice-tile-avatar" style={{ background: vu.avatarColor }}><AImg src={vu.avatar} />{vu.username[0].toUpperCase()}</div>
                            })()}
                            <div className="voice-tile-overlay">
                              <div className="voice-tile-name">{vu.username}</div>
                              <div className="voice-tile-badges">
                                {(isLocal ? voiceMuted : vu.muted) && (
                                  <div className="voice-tile-badge">
                                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="1" width="6" height="9" rx="3"/><path d="M3 7v1a5 5 0 0010 0V7"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="13" y1="2" x2="3" y2="14"/></svg>
                                  </div>
                                )}
                                {(isLocal ? voiceDeafened : vu.deafened) && (
                                  <div className="voice-tile-badge">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round"><path d="M3 14h3a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a9 9 0 0118 0v7a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3"/><line x1="21" y1="3" x2="3" y2="21"/></svg>
                                  </div>
                                )}
                                {(isLocal ? screenShareOn : vu.screen) && (
                                  <div className="voice-tile-badge screen">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ) : (
                  /* ── Normal grid view ── */
                  <div className="voice-call-grid">
                    {vcUsers.map(vu => {
                      const isLocal = vu.id === user.id
                      const hasLocalCamera = isLocal && cameraOn && cameraStream.current
                      const hasLocalScreen = isLocal && screenShareOn && screenStream.current
                      const isScreenSharing = isLocal ? screenShareOn : vu.screen
                      const hasRemoteVideo = !isLocal && remoteVideoStreams[vu.socketId]
                      const hasRemoteScreen = !isLocal && (remoteScreenStreams[vu.socketId] || (isScreenSharing && remoteVideoStreams[vu.socketId]))
                      const remoteScreenSrc = remoteScreenStreams[vu.socketId] || (isScreenSharing ? remoteVideoStreams[vu.socketId] : null)
                      const hasVideo = hasLocalCamera || hasRemoteVideo
                      return (
                        <div key={vu.id} className={`voice-tile ${speakingUsers.has(vu.id) ? 'speaking' : ''} ${hasVideo || hasLocalScreen || hasRemoteScreen ? 'has-video' : ''}`}>
                          {isScreenSharing && !isLocal && hasRemoteScreen ? (
                            /* Remote screen share tile — show actual screen stream, click to enter focused view */
                            <div style={{ position: 'relative', width: '100%', height: '100%', cursor: 'pointer' }} onClick={() => { setFocusedStreamUser(vu.id); setFocusedStreamType('screen') }}>
                              <video ref={el => { if (el) { const _s = remoteScreenSrc; if (_s && el.srcObject !== _s) el.srcObject = _s } }} autoPlay playsInline className="voice-tile-video" />
                            </div>
                          ) : isScreenSharing && isLocal && !hasLocalCamera ? (
                            /* Local screen share tile — show "View" button */
                            <div className="voice-tile-screen-preview">
                              <div className="voice-tile-avatar small" style={{ background: vu.avatarColor }}>
                                <AImg src={vu.avatar} />
                                {vu.username[0].toUpperCase()}
                              </div>
                              <div className="voice-tile-screen-info">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                                <span>{t('voice.sharingScreen').replace('{name}', vu.username)}</span>
                                <button className="voice-watch-btn" onClick={(e) => { e.stopPropagation(); setFocusedStreamUser(vu.id); setFocusedStreamType('screen') }}>
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                                  {t('voice.view')}
                                </button>
                              </div>
                            </div>
                          ) : hasLocalCamera ? (
                            <video ref={el => { if (el) { const _s = cameraStream.current; if (_s && el.srcObject !== _s) el.srcObject = _s } }} autoPlay muted playsInline className="voice-tile-video mirror" />
                          ) : hasRemoteVideo ? (
                            <video ref={el => { if (el) { const _s = remoteVideoStreams[vu.socketId]; if (_s && el.srcObject !== _s) el.srcObject = _s } }} autoPlay playsInline className="voice-tile-video" />
                          ) : (
                            <div className="voice-tile-avatar" style={{ background: vu.avatarColor }}>
                              <AImg src={vu.avatar} />
                              {vu.username[0].toUpperCase()}
                            </div>
                          )}
                          {vcUsers.length > 1 && <PinBtn userId={vu.id} />}
                          <div className="voice-tile-overlay">
                            <div className="voice-tile-name">{vu.username}</div>
                            <div className="voice-tile-badges">
                              {(isLocal ? voiceMuted : vu.muted) && (
                                <div className="voice-tile-badge">
                                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round">
                                    <rect x="5" y="1" width="6" height="9" rx="3"/><path d="M3 7v1a5 5 0 0010 0V7"/><line x1="8" y1="13" x2="8" y2="15"/><line x1="13" y1="2" x2="3" y2="14"/>
                                  </svg>
                                </div>
                              )}
                              {(isLocal ? voiceDeafened : vu.deafened) && (
                                <div className="voice-tile-badge">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round">
                                    <path d="M3 14h3a2 2 0 012 2v3a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a9 9 0 0118 0v7a2 2 0 01-2 2h-1a2 2 0 01-2-2v-3a2 2 0 012-2h3"/><line x1="21" y1="3" x2="3" y2="21"/>
                                  </svg>
                                </div>
                              )}
                              {isScreenSharing && (
                                <div className="voice-tile-badge screen">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
              <div className="voice-call-toolbar">
                {/* Mic with dropdown */}
                <div className="vc-wrap" ref={micPopupRef}>
                  <button className={`vc-round ${voiceMuted ? 'off' : ''}`} onClick={toggleVoiceMute}>
                    {voiceMuted ? (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/><line x1="21" y1="3" x2="3" y2="21" strokeWidth="2.5"/></svg>
                    ) : (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                    )}
                  </button>
                  <button className="vc-arrow" onClick={() => { loadDevices(); setShowMicPopup(v => !v); setShowCameraPopup(false) }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {showMicPopup && (
                    <div className="vc-popup" onClick={e => e.stopPropagation()}>
                      <div className="vc-popup-section">
                        <div className="vc-popup-label">{t('voice.inputDevice')}</div>
                        {audioDevices.inputs.map(d => (
                          <button key={d.id} className={`vc-popup-item ${selectedMicId === d.id ? 'active' : ''}`} onClick={() => switchMicrophone(d.id)}>
                            <span>{d.label}</span>
                            {selectedMicId === d.id && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
                          </button>
                        ))}
                        {audioDevices.inputs.length === 0 && <div className="vc-popup-empty">{t('voice.noDevices')}</div>}
                      </div>
                      <div className="vc-popup-divider" />
                      <div className="vc-popup-section">
                        <div className="vc-popup-label">{t('voice.outputDevice')}</div>
                        {audioDevices.outputs.map(d => (
                          <button key={d.id} className={`vc-popup-item ${selectedSpeakerId === d.id ? 'active' : ''}`} onClick={() => switchSpeaker(d.id)}>
                            <span>{d.label}</span>
                            {selectedSpeakerId === d.id && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
                          </button>
                        ))}
                        {audioDevices.outputs.length === 0 && <div className="vc-popup-empty">{t('voice.noDevices')}</div>}
                      </div>
                      <div className="vc-popup-divider" />
                      <div className="vc-popup-section">
                        <div className="vc-popup-label">{t('voice.micVolume')}</div>
                        <div className="vc-popup-slider">
                          <input type="range" min="0" max="100" value={micVolume} onChange={e => applyMicVolume(+e.target.value)} />
                          <span>{micVolume}%</span>
                        </div>
                      </div>
                      <div className="vc-popup-divider" />
                      <div className="vc-popup-section">
                        <div className="vc-popup-label">{t('voice.soundVolume')}</div>
                        <div className="vc-popup-slider">
                          <input type="range" min="0" max="200" value={soundVolume} onChange={e => applySoundVolume(+e.target.value)} />
                          <span>{soundVolume}%</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Camera with dropdown */}
                <div className="vc-wrap" ref={cameraPopupRef}>
                  <button className={`vc-round ${cameraOn ? 'on' : ''}`} onClick={toggleCamera}>
                    {cameraOn ? (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                    ) : (
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/><line x1="21" y1="3" x2="3" y2="21" strokeWidth="2.5"/></svg>
                    )}
                  </button>
                  <button className="vc-arrow" onClick={() => { loadDevices(); setShowCameraPopup(v => !v); setShowMicPopup(false) }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {showCameraPopup && (
                    <div className="vc-popup" onClick={e => e.stopPropagation()}>
                      <div className="vc-popup-section">
                        <div className="vc-popup-label">{t('voice.cameraDevice')}</div>
                        {videoDevices.map(d => (
                          <button key={d.id} className={`vc-popup-item ${selectedCameraId === d.id ? 'active' : ''}`} onClick={() => switchCamera(d.id)}>
                            <span>{d.label}</span>
                            {selectedCameraId === d.id && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>}
                          </button>
                        ))}
                        {videoDevices.length === 0 && <div className="vc-popup-empty">{t('voice.noDevices')}</div>}
                      </div>
                    </div>
                  )}
                </div>

                {/* Screen share */}
                <button className={`vc-round ${screenShareOn ? 'on' : ''}`} onClick={toggleScreenShare}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                </button>

                {/* Invite */}
                <button className="vc-round" onClick={() => { setShowVoiceInviteModal({ channelId: voiceViewChannel.id, channelName: voiceViewChannel.name }); setVoiceInviteSending({}); loadFriends() }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
                </button>

                {/* Disconnect */}
                <button className="vc-round disconnect" onClick={leaveVoiceChannel}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6A19.79 19.79 0 012.12 4.18 2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91"/><line x1="21" y1="3" x2="3" y2="21"/></svg>
                </button>
              </div>
            </div>
          </>
        ) : activeChannel ? (
          <>
            <div className="chat-header">
              <div className="chat-header-left">
                <button className="mobile-back-btn" onClick={() => { setMobileInChat(false) }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
                <button className="mobile-hamburger" onClick={() => setMobileNav(true)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2"><path d="M4 9h16M4 15h16M7 3l-2 18M17 3l-2 18"/></svg>
                <h3>{activeChannel.name}</h3>
              </div>
              <div className="chat-header-right">
                <button className={`header-btn ${showMembers ? 'active' : ''}`} onClick={() => setShowMembers(!showMembers)} title="Members">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                </button>
              </div>
            </div>
            {pinnedMessages.length > 0 && (
              <div className="pinned-bar" onClick={() => scrollToPinned(pinnedIndex)}>
                <svg className="pinned-bar-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
                <div className="pinned-bar-text">
                  <span className="pinned-bar-author">{pinnedMessages[pinnedIndex]?.user?.username}: </span>
                  <span className="pinned-bar-content">{pinnedMessages[pinnedIndex]?.content || t('msg.attachment')}</span>
                </div>
                <div className="pinned-bar-nav">
                  <button onClick={(e) => { e.stopPropagation(); scrollToPinned((pinnedIndex - 1 + pinnedMessages.length) % pinnedMessages.length) }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
                  </button>
                  <span className="pinned-bar-count">{pinnedIndex + 1}/{pinnedMessages.length}</span>
                  <button onClick={(e) => { e.stopPropagation(); scrollToPinned((pinnedIndex + 1) % pinnedMessages.length) }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                </div>
              </div>
            )}
            <div className="chat-body" onDrop={handleDrop} onDragOver={handleDragOver}>
              <div className="messages-area-wrapper">
              <div className="messages-area" ref={messagesAreaRef} onScroll={handleMessagesScroll}>
                <div className="messages-list">
                  {groupedMessages.length === 0 && (
                    <div className="empty-chat">
                      <div className="empty-hash">#</div>
                      <h3>#{activeChannel.name}</h3>
                      <p>{t('msg.typePlaceholder')}</p>
                    </div>
                  )}
                  {groupedMessages.map((item, i) => {
                    if (item.type === 'date') return (
                      <div key={`d-${i}`} className="date-divider">
                        <span>{item.date}</span>
                      </div>
                    )
                    const { msg, isGrouped } = item
                    if (msg.type === 'system') {
                      const isKick = msg.content.includes('исключил')
                      const isRoleChange = msg.content.includes('роль')
                      const isJoin = msg.content.includes('присоединил')
                      const isLeave = msg.content.includes('покинул')
                      const isRename = msg.content.includes('название канала')
                      return (
                      <div key={msg.id} className={`system-message ${isKick ? 'sys-kick' : isRoleChange ? 'sys-role' : isJoin ? 'sys-join' : isLeave ? 'sys-leave' : ''}`}>
                        {isKick ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/></svg>
                        ) : isRoleChange ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                        ) : isJoin ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                        ) : isLeave ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                        )}
                        <span>{msg.content}</span>
                        <span className="system-message-time">{formatTime(msg.createdAt)}</span>
                      </div>
                    )}
                    if (hiddenMessages.has(msg.id)) return null
                    return (
                      <div key={msg.id} id={'msg-' + msg.id} className={`message ${isGrouped ? 'grouped' : ''}${isMsgPinned(msg, false) ? ' pinned' : ''}${msg.deleted ? ' deleted-msg' : ''}${selectMode && selectedMsgs.has(msg.id) ? ' selected' : ''}`} onContextMenu={(e) => !msg.deleted && handleMsgContext(e, msg, false)} onClick={() => selectMode && !msg.deleted && toggleMsgSelect(msg.id)} onMouseEnter={() => !selectMode && !msg.deleted && setHoveredMsg(msg.id)} onMouseLeave={() => hoveredMsg === msg.id && setHoveredMsg(null)} onDoubleClick={() => !selectMode && !msg.deleted && toggleReaction(msg.id, '👍', false)}>
                        {hoveredMsg === msg.id && !selectMode && !msg.deleted && (
                          <div className="msg-hover-actions">
                            <button title={t('message.replyAction')} onClick={(e) => { e.stopPropagation(); setReplyTo(msg) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg></button>
                            <button title="👍" onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, '👍', false) }}>👍</button>
                            <button title={t('emoji.search')} onClick={(e) => { openReactionPicker(e, msg.id, false) }}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg></button>
                          </div>
                        )}
                        {selectMode && !msg.deleted && (
                          <div className="msg-select-checkbox" onClick={(e) => { e.stopPropagation(); toggleMsgSelect(msg.id) }}>
                            <div className={`msg-checkbox ${selectedMsgs.has(msg.id) ? 'checked' : ''}`}>
                              {selectedMsgs.has(msg.id) && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                            </div>
                          </div>
                        )}
                        {isMsgPinned(msg, false) && !msg.deleted && <div className="msg-pin-indicator"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg></div>}
                        {!isGrouped && !selectMode && (() => { const p = prof(msg.userId, msg.user); return (
                          <div className={`msg-avatar clickable${p.avatarFrame ? ` avatar-frame-${p.avatarFrame}` : ''}`} style={{ background: p.avatarColor }} onClick={(e) => showUserProfile({ ...msg.user, ...userProfiles[msg.userId] }, e.clientX, e.clientY)}>
                            <AImg src={p.avatar} />
                            {p.username?.[0]?.toUpperCase()}
                          </div>
                        )})()}
                        <div className="msg-content">
                          {msg.replyTo && (
                            <div className="msg-reply-ref" onClick={() => { const el = document.getElementById('msg-' + msg.replyTo.id); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.remove('msg-highlight'); void el.offsetWidth; el.classList.add('msg-highlight'); setTimeout(() => el.classList.remove('msg-highlight'), 2000) } }}>
                              <div className="msg-reply-line" style={{ background: 'var(--primary)' }} />
                              <span className="msg-reply-author">{msg.replyTo.user?.username || t('msg.deletedUser')}</span>
                              <span className="msg-reply-text">{msg.replyTo.content || t('msg.replyContent')}</span>
                            </div>
                          )}
                          {!isGrouped && (() => { const p = prof(msg.userId, msg.user); return (
                            <div className="msg-header">
                              <span className={`msg-author clickable ${streamerMode && msg.userId === user.id ? 'streamer-blur' : ''}`} onClick={(e) => showUserProfile({ ...msg.user, ...userProfiles[msg.userId] }, e.clientX, e.clientY)}><span className="msg-author-name">{p.username}</span><span className="user-tag">#{p.tag}</span>{p.statusEmoji && <span className="msg-status-emoji" title="Статус">{p.statusEmoji}</span>}</span>
                              <span className="msg-time">{formatTime(msg.createdAt)}</span>
                            </div>
                          )})()}
                          {msg.deleted ? (
                            <div className="msg-text message-deleted">{t('msg.deleted')}</div>
                          ) : editingMsg && editingMsg.id === msg.id ? (
                            <div className="msg-edit-wrap">
                              <input ref={editInputRef} className="msg-edit-input" value={editingMsg.content} maxLength={1500} onChange={e => setEditingMsg(prev => ({ ...prev, content: e.target.value.slice(0, 1500) }))} onKeyDown={e => { if (e.key === 'Enter') saveEditMsg(); if (e.key === 'Escape') cancelEdit() }} />
                              <div className="msg-edit-hint">{t('msg.edited')}</div>
                            </div>
                          ) : (
                            <>
                              {msg.content && (
                                /^https:\/\/media\d*\.giphy\.com\//i.test(msg.content)
                                  ? <div className="msg-gif"><img src={msg.content} alt="GIF" className="msg-gif-img" loading="lazy" /></div>
                                  : <div className={`msg-text${emojiOnlyCount(msg.content) ? " msg-big-emoji" : ""}`}>{renderContent(msg.content)}{msg.editedAt && <span className="msg-edited">{t('msg.edited')}</span>}</div>
                              )}
                            </>
                          )}
                          {msg.attachment && (
                            <div className={`msg-attachment msg-attachment-${msg.attachment.fileType}`}>
                              {msg.attachment.fileType === 'image' ? (
                                <img src={msg.attachment.url} alt={msg.attachment.fileName} className="msg-image" onClick={() => openLightbox(msg)} loading="lazy" />
                              ) : msg.attachment.fileType === 'video' ? (
                                <div className="msg-video-wrap" onClick={() => openLightbox(msg)}>
                                  <video src={msg.attachment.url} className="msg-video" preload="metadata" />
                                  <div className="msg-video-play"><svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg></div>
                                </div>
                              ) : msg.attachment.fileType === 'audio' ? (
                                <AudioWavePlayer src={msg.attachment.url} fileName={msg.attachment.fileName} fileSize={msg.attachment.fileSize} />
                              ) : (
                                <a href={msg.attachment.url} download={msg.attachment.fileName} className="msg-file-link" target="_blank" rel="noreferrer">
                                  <div className="file-icon">
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                                  </div>
                                  <div className="file-info">
                                    <span className="file-name">{msg.attachment.fileName}</span>
                                    <span className="file-size">{formatFileSize(msg.attachment.fileSize)}</span>
                                  </div>
                                  <svg className="file-download-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7,10 12,15 17,10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                </a>
                              )}
                            </div>
                          )}
                          {msg.reactions?.length > 0 && (
                            <div className="msg-reactions">
                              {msg.reactions.map((r, ri) => (
                                <button key={ri} className={`msg-reaction ${r.users.includes(user.id) ? 'reacted' : ''}`} onClick={(e) => { e.stopPropagation(); toggleReaction(msg.id, r.emoji, false) }} onContextMenu={(e) => showReactionUsers(e, r.emoji, r.users, false)}>
                                  <span className="reaction-emoji">{r.emoji}</span>
                                  <span className="reaction-count">{r.users.length}</span>
                                </button>
                              ))}
                              <button className="msg-reaction add-reaction" onClick={(e) => { openReactionPicker(e, msg.id, false) }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                              </button>
                            </div>
                          )}
                        </div>
                        {isGrouped && <span className="msg-time-hover">{formatTime(msg.createdAt)}</span>}
                      </div>
                    )
                  })}
                  <div ref={messagesEndRef} />
                </div>
                <div className="typing-indicator-wrapper">
                  {typingUsers.length > 0 && (
                    <div className="typing-indicator">
                      <div className="typing-dots"><span/><span/><span/></div>
                      <span>{typingUsers.map(u => u.username).join(', ')} {typingUsers.length === 1 ? t('typing.one') : t('typing.many')}</span>
                    </div>
                  )}
                </div>
              </div>
                {showScrollBtn && (
                  <button className="scroll-bottom-btn" onClick={scrollToBottom} title={t('msg.scrollDown')}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                )}
              </div>
              {showMembers && (
                <div className="members-bar">
                  {onlineMembers.length > 0 && (
                    <>
                      <div className="members-category">{t('members.online')} — {onlineMembers.length}</div>
                      {onlineMembers.map(m => { const p = prof(m.id, m); return (
                        <div key={m.id} className="member-item" onClick={e => showUserProfile(p, e.clientX, e.clientY)} onContextMenu={e => { if ((hasServerPerm('kickMembers') || hasServerPerm('manageRoles')) && m.id !== user.id) { e.preventDefault(); setMemberCtx({ member: m, x: e.clientX, y: e.clientY }) } }}>
                          <div className="member-avatar-wrap">
                            <div className={`member-avatar${p.avatarFrame ? ` avatar-frame-${p.avatarFrame}` : ''}`} style={{ background: p.avatarColor }}>
                              <AImg src={p.avatar} />
                              {p.username?.[0]?.toUpperCase()}
                            </div>
                            <div className={`status-dot ${p.status || m.status}`} />
                          </div>
                          <span className={streamerMode && m.id === user.id ? 'streamer-blur' : ''} style={{ color: getMemberRoleColor(m.id) || undefined }}>{p.username}{p.statusEmoji && <span className="msg-status-emoji">{p.statusEmoji}</span>}<span className="user-tag" style={{ color: undefined }}>#{p.tag}</span></span>
                          {m.role === 'owner' && <span className="role-badge owner" title={t('members.owner')}>👑</span>}
                          {m.role === 'admin' && <span className="role-badge admin" title={t('role.admin')}>🛡️</span>}
                          {(() => { const cr = (activeServer?.customRoles || []).find(r => r.id === m.role); return cr ? <span className="role-badge custom" style={{ color: cr.color }} title={cr.name}>{cr.name}</span> : null })()}
                        </div>
                      )})}
                    </>
                  )}
                  {offlineMembers.length > 0 && (
                    <>
                      <div className="members-category">{t('members.offline')} — {offlineMembers.length}</div>
                      {offlineMembers.map(m => { const p = prof(m.id, m); return (
                        <div key={m.id} className="member-item offline" onClick={e => showUserProfile(p, e.clientX, e.clientY)} onContextMenu={e => { if ((hasServerPerm('kickMembers') || hasServerPerm('manageRoles')) && m.id !== user.id) { e.preventDefault(); setMemberCtx({ member: m, x: e.clientX, y: e.clientY }) } }}>
                          <div className="member-avatar-wrap">
                            <div className="member-avatar" style={{ background: p.avatarColor, opacity: 0.4 }}>
                              <AImg src={p.avatar} />
                              {p.username?.[0]?.toUpperCase()}
                            </div>
                            <div className="status-dot" />
                          </div>
                          <span className={streamerMode && m.id === user.id ? 'streamer-blur' : ''} style={{ color: getMemberRoleColor(m.id) || undefined }}>{p.username}<span className="user-tag" style={{ color: undefined }}>#{p.tag}</span></span>
                          {m.role === 'owner' && <span className="role-badge owner" title={t('members.owner')}>👑</span>}
                          {m.role === 'admin' && <span className="role-badge admin" title={t('role.admin')}>🛡️</span>}
                          {(() => { const cr = (activeServer?.customRoles || []).find(r => r.id === m.role); return cr ? <span className="role-badge custom" style={{ color: cr.color }} title={cr.name}>{cr.name}</span> : null })()}
                        </div>
                      )})}
                    </>
                  )}
                </div>
              )}
            </div>
            {selectMode && (
              <div className="select-bar">
                <span className="select-bar-count">{(t('msg.selectedCount') || 'Выбрано: {count}').replace('{count}', selectedMsgs.size)}</span>
                {canBulkDeleteForAll() && (
                  <button className="select-bar-delete" onClick={() => bulkDeleteMsgs('forAll')} disabled={selectedMsgs.size === 0}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                    <span>{t('msg.deleteForAll') || 'Удалить для всех'}</span>
                  </button>
                )}
                <button className="select-bar-delete" onClick={() => bulkDeleteMsgs('forMe')} disabled={selectedMsgs.size === 0} style={{ background: 'var(--bg-secondary)' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  <span>{t('msg.deleteForMe') || 'Удалить для себя'}</span>
                </button>
                <button className="select-bar-cancel" onClick={() => { setSelectMode(false); setSelectedMsgs(new Set()) }}>
                  <span>{t('common.cancel') || 'Отмена'}</span>
                </button>
              </div>
            )}
            <form className="chat-input-form" onSubmit={sendMessage} style={selectMode ? { display: 'none' } : undefined}>
              {replyTo && !replyTo.isDM && (
                <div className="reply-bar">
                  <div className="reply-bar-line" style={{ background: replyTo.user?.avatarColor || 'var(--primary)' }} />
                  <div className="reply-bar-content">
                    <span className="reply-bar-label">{t('message.reply')} <span className="reply-bar-author" style={{ color: replyTo.user?.avatarColor }}>{replyTo.user?.username}</span></span>
                    <span className="reply-bar-text">{replyTo.content || t('message.attachment')}</span>
                  </div>
                  <button type="button" className="reply-bar-close" onClick={() => setReplyTo(null)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              )}
              <div className="chat-input-wrapper">
                <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileInput} />
                <div className="attach-wrapper" ref={attachMenuRef}>
                  <button type="button" className="input-btn" ref={attachBtnRef} onClick={() => setShowAttachMenu(v => !v)} title="Upload file">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg>
                  </button>
                  {showAttachMenu && (
                    <div className="attach-menu">
                      <button className="attach-menu-item" onClick={() => openFileWith('image/*')}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                        <span>{t('upload.photo')}</span>
                      </button>
                      <button className="attach-menu-item" onClick={() => openFileWith('video/*')}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                        <span>{t('upload.video')}</span>
                      </button>
                      <button className="attach-menu-item" onClick={() => openFileWith('')}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        <span>{t('upload.file')}</span>
                      </button>
                    </div>
                  )}
                </div>
                <textarea
                  className="chat-textarea"
                  placeholder={slowmodeCooldown > 0 ? `${t('slowmode.wait')} ${slowmodeCooldown} ${t('slowmode.sec')}` : `${t('msg.typePlaceholder')}`}
                  value={input}
                  onChange={handleInput}
                  onKeyDown={e => handleChatKeyDown(e, sendMessage)}
                  maxLength={1500}
                  rows={1}
                  autoFocus
                />
                {input.length > 1300 && <span className="char-counter" style={{ color: input.length >= 1500 ? 'var(--danger)' : 'var(--text-muted)' }}>{input.length}/1500</span>}
                {activeChannel.slowmode > 0 && (() => {
                  const isOwner = activeServer && activeServer.ownerId === user.id
                  const sm = activeChannel.slowmode
                  const smMap = { 5:'slowmode.5s.short', 10:'slowmode.10s.short', 15:'slowmode.15s.short', 30:'slowmode.30s.short', 60:'slowmode.1m.short', 600:'slowmode.10m.short', 1800:'slowmode.30m.short', 3600:'slowmode.1h.short', 7200:'slowmode.2h.short', 86400:'slowmode.24h.short' }
                  const label = t(smMap[sm] || 'slowmode.5s.short')
                  return (
                    <div className="slowmode-indicator">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      <div className="slowmode-tooltip">
                        <div className="slowmode-tooltip-text">{t('slowmode.enabled')} {label}</div>
                        {isOwner && <div className="slowmode-tooltip-shield"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> {t('slowmode.protection')}</div>}
                      </div>
                    </div>
                  )
                })()}
                <div className="emoji-btn-wrapper">
                  <button type="button" className="input-btn emoji-toggle-btn" onClick={() => { setShowEmojiPicker(v => !v); setEmojiSearch(''); setEmojiCategory('smileys') }} title={t('emoji.title') || 'Эмодзи'}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                  </button>
                  {showEmojiPicker && (
                    <div className="emoji-picker" ref={emojiPickerRef}>
                      <div className="emoji-picker-search">
                        <input type="text" placeholder={t('emoji.search') || 'Поиск...'} value={emojiSearch} onChange={e => setEmojiSearch(e.target.value)} autoFocus />
                      </div>
                      <div className="emoji-picker-cats">
                        {Object.entries(emojiData).map(([key, cat]) => (
                          <button key={key} className={`emoji-cat-btn ${emojiCategory === key ? 'active' : ''}`} onClick={() => setEmojiCategory(key)} title={cat.label}>{cat.icon}</button>
                        ))}
                      </div>
                      <div className="emoji-picker-grid">
                        {(emojiSearch
                          ? Object.values(emojiData).flatMap(c => c.emojis)
                          : emojiData[emojiCategory]?.emojis || []
                        ).filter(e => !emojiSearch || e.includes(emojiSearch)).map((emoji, i) => (
                          <button type="button" key={i} className="emoji-item" onClick={() => insertEmoji(emoji)}>{emoji}</button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="gif-btn-wrapper" ref={gifPickerRef}>
                  <button type="button" className="input-btn gif-toggle-btn" onClick={openGifPicker} title="GIF">
                    <span className="gif-btn-label">GIF</span>
                  </button>
                  {showGifPicker && (
                    <div className="gif-picker">
                      <div className="gif-picker-search">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                        <input type="text" placeholder="Поиск GIF..." value={gifSearch} autoFocus
                          onChange={e => {
                            const q = e.target.value; setGifSearch(q)
                            clearTimeout(gifSearchTimer.current)
                            gifSearchTimer.current = setTimeout(() => fetchGifs(q), 400)
                          }} />
                      </div>
                      <div className="gif-picker-grid">
                        {gifLoading ? (
                          <div className="gif-picker-loading"><div className="gif-picker-spinner" /></div>
                        ) : gifResults.length === 0 ? (
                          <div className="gif-picker-empty">Ничего не найдено</div>
                        ) : gifResults.map(gif => (
                          <div key={gif.id} className="gif-item" onClick={() => sendGif(gif)}>
                            <img src={gif.images.fixed_width.url} alt={gif.title} loading="lazy" />
                          </div>
                        ))}
                      </div>
                      <div className="gif-picker-footer">
                        <img src="https://developers.giphy.com/branch/master/static/header-logo-8974b8ae658f704a5b48a2d039b8ad93.gif" alt="Powered by GIPHY" className="giphy-logo" />
                      </div>
                    </div>
                  )}
                </div>
                <button type="submit" className="input-btn send-btn" disabled={!input.trim() || slowmodeCooldown > 0}>
                  {slowmodeCooldown > 0 ? <span className="cooldown-badge">{slowmodeCooldown}</span> : <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>}
                </button>
              </div>
            </form>
            {slowmodeError && <div className="slowmode-error">{slowmodeError}</div>}
          </>
        ) : (
          <div className="no-channel">
            <div className="empty-hash">#</div>
            <h3>{t('nav.textChannels')}</h3>
            <p>{t('msg.typePlaceholder')}</p>
          </div>
        )}
      </div>

      {/* Message context menu */}
      {msgCtx && (
        <div className="ctx-overlay" onClick={() => setMsgCtx(null)}>
        <div className="msg-ctx-menu" ref={msgCtxRef} style={{ top: msgCtx.y, left: msgCtx.x }} onClick={e => e.stopPropagation()}>
          {!msgCtx.msg.deleted && !msgCtx.msg.type && (
            <button className="ctx-item" onClick={() => { setReplyTo({ id: msgCtx.msg.id, content: msgCtx.msg.content, user: msgCtx.msg.user, isDM: msgCtx.isDM }); setMsgCtx(null) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 00-4-4H4"/></svg>
              <span>{t('message.replyAction')}</span>
            </button>
          )}
          {msgCtx.msg.content && !(/^https:\/\/media\d*\.giphy\.com\//i.test(msgCtx.msg.content)) && (
            <button className="ctx-item" onClick={() => copyMsgText(msgCtx.msg.content)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              <span>{t('msg.copyText')}</span>
            </button>
          )}
          {msgCtx.msg.content && /^https:\/\/media\d*\.giphy\.com\//i.test(msgCtx.msg.content) && (
            <button className="ctx-item" onClick={() => saveMedia(msgCtx.msg.content, 'animation.gif')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Сохранить GIF</span>
            </button>
          )}
          {msgCtx.msg.attachment?.fileType === 'image' && (
            <button className="ctx-item" onClick={() => saveMedia(msgCtx.msg.attachment.url, msgCtx.msg.attachment.fileName)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Сохранить фото</span>
            </button>
          )}
          {msgCtx.msg.attachment?.fileType === 'video' && (
            <button className="ctx-item" onClick={() => saveMedia(msgCtx.msg.attachment.url, msgCtx.msg.attachment.fileName)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Сохранить видео</span>
            </button>
          )}
          {msgCtx.msg.attachment && !['image','video','audio'].includes(msgCtx.msg.attachment.fileType) && (
            <button className="ctx-item" onClick={() => saveMedia(msgCtx.msg.attachment.url, msgCtx.msg.attachment.fileName)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Сохранить файл</span>
            </button>
          )}
          {msgCtx.msg.attachment?.fileType === 'audio' && (
            <button className="ctx-item" onClick={() => saveMedia(msgCtx.msg.attachment.url, msgCtx.msg.attachment.fileName)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Сохранить аудио</span>
            </button>
          )}
          {msgCtx.msg.userId === user.id && !msgCtx.msg.type && (
            <button className="ctx-item" onClick={() => startEditMsg(msgCtx.msg)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              <span>{t('msg.edit')}</span>
            </button>
          )}
          <button className="ctx-item" onClick={() => togglePinMsg(msgCtx.msg, msgCtx.isDM)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
            <span>{isMsgPinned(msgCtx.msg, msgCtx.isDM) ? t('msg.unpin') : t('msg.pin')}</span>
          </button>
          {!msgCtx.msg.deleted && (
            <button className="ctx-item" onClick={() => { setSelectMode(true); setSelectedMsgs(new Set([msgCtx.msg.id])); setMsgCtx(null) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
              <span>{t('msg.select') || 'Выбрать'}</span>
            </button>
          )}
          {msgCtx.msg.userId === user.id && !msgCtx.msg.deleted && (
            <>
              <div className="ctx-divider" />
              {isWithin15Min(msgCtx.msg.createdAt) ? (
                <button className="ctx-item ctx-danger" onClick={() => deleteMsgForAll(msgCtx.msg, msgCtx.isDM)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  <span>{t('msg.deleteForAll')}</span>
                </button>
              ) : (
                <button className="ctx-item ctx-danger" onClick={() => deleteMsgForMe(msgCtx.msg, msgCtx.isDM)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                  <span>{t('msg.deleteForMe')}</span>
                </button>
              )}
            </>
          )}
        </div>
        </div>
      )}

      {/* Member context menu */}
      {memberCtx && (
        <div className="ctx-overlay" onClick={() => setMemberCtx(null)}>
        <div className="msg-ctx-menu" style={{ top: memberCtx.y, left: memberCtx.x }} onClick={e => e.stopPropagation()}>
          <div className="ctx-header">{memberCtx.member.username}</div>
          <button className="ctx-item" onClick={() => { showUserProfile(memberCtx.member, memberCtx.x, memberCtx.y); setMemberCtx(null) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>{t('profile.title')}</span>
          </button>
          <button className="ctx-item" onClick={() => { openDM(memberCtx.member.id); setMemberCtx(null) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
            <span>{t('dm.write')}</span>
          </button>
          {hasServerPerm('manageRoles') && memberCtx.member.role !== 'owner' && (<>
            <div className="ctx-divider" />
            {memberCtx.member.role === 'admin' ? (
              <button className="ctx-item ctx-danger" onClick={() => toggleMemberRole(memberCtx.member.id, 'admin')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                <span>{t('server.removeAdmin')}</span>
              </button>
            ) : (
              <button className="ctx-item" onClick={() => toggleMemberRole(memberCtx.member.id, 'user')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                <span>{t('server.makeAdmin')}</span>
              </button>
            )}
            {(activeServer?.customRoles || []).map(cr => (
              <button key={cr.id} className={`ctx-item ${memberCtx.member.role === cr.id ? 'ctx-active' : ''}`} onClick={async () => {
                const newRole = memberCtx.member.role === cr.id ? 'user' : cr.id
                try {
                  await API(`/api/servers/${activeServer.id}/members/${memberCtx.member.id}/role`, { method: 'POST', body: JSON.stringify({ role: newRole }) })
                  setMembers(prev => prev.map(m => m.id === memberCtx.member.id ? { ...m, role: newRole } : m))
                } catch {}
                setMemberCtx(null)
              }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', background: cr.color, display: 'inline-block', marginRight: 4 }} />
                <span style={{ color: memberCtx.member.role === cr.id ? cr.color : undefined }}>{cr.name}{memberCtx.member.role === cr.id ? ' ✓' : ''}</span>
              </button>
            ))}
          </>)}
          {hasServerPerm('kickMembers') && memberCtx.member.role !== 'owner' && (
            <button className="ctx-item ctx-danger" onClick={() => { kickMember(memberCtx.member.id); setMemberCtx(null) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="11" x2="23" y2="11"/></svg>
              <span>{t('server.kick')}</span>
            </button>
          )}
        </div>
        </div>
      )}

      {/* Pin choice popup */}
      {pinChoiceCtx && (
        <div className="ctx-overlay" onClick={() => setPinChoiceCtx(null)}>
        <div className="msg-ctx-menu" style={{ top: pinChoiceCtx.y, left: pinChoiceCtx.x }} onMouseDown={e => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => pinWithMode('all')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/></svg>
            <span>{t('msg.pinForAll')}</span>
          </button>
          <button className="ctx-item" onClick={() => pinWithMode('self')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span>{t('msg.pinForMe')}</span>
          </button>
        </div>
        </div>
      )}

      {channelMenu && (
        <div className="ctx-overlay" onClick={() => setChannelMenu(null)}>
        <div className="channel-gear-menu" ref={channelMenuRef} style={{ top: channelMenu.y, left: channelMenu.x }} onClick={e => e.stopPropagation()}>
          <button className="ctx-item" onClick={() => { markChannelRead(channelMenu.channel.id); setChannelMenu(null) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            <span>{t('channel.markRead')}</span>
          </button>
          <div className="ctx-divider" />
          <div className="ctx-item-wrap" onMouseEnter={() => setChannelMuteSub(true)} onMouseLeave={() => setChannelMuteSub(false)}>
            {mutedChannels[channelMenu.channel.id] && mutedChannels[channelMenu.channel.id] > Date.now() ? (
              <button className="ctx-item" onClick={() => unmuteChannel(channelMenu.channel.id)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>
                <span>{t('channel.unmute')}</span>
              </button>
            ) : (
              <>
                <button className="ctx-item" onClick={() => { muteChannel(channelMenu.channel.id, Infinity) }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                  <span>{t('channel.mute')}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{marginLeft:'auto'}} onClick={(e) => { e.stopPropagation(); setChannelMuteSub(!channelMuteSub) }}><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                {channelMuteSub && (
                  <div className="channel-mute-submenu">
                    <button className="ctx-item" onClick={() => muteChannel(channelMenu.channel.id, 15)}>{t('channel.mute15')}</button>
                    <button className="ctx-item" onClick={() => muteChannel(channelMenu.channel.id, 30)}>{t('channel.mute30')}</button>
                    <button className="ctx-item" onClick={() => muteChannel(channelMenu.channel.id, 60)}>{t('channel.mute60')}</button>
                    <button className="ctx-item" onClick={() => muteChannel(channelMenu.channel.id, 1440)}>{t('channel.mute1440')}</button>
                    <button className="ctx-item" onClick={() => muteChannel(channelMenu.channel.id, Infinity)}>{t('channel.muteForever')}</button>
                  </div>
                )}
              </>
            )}
          </div>
          {activeServer && activeServer.ownerId === user.id && (
            <button className="ctx-item" onClick={() => { const ch = channelMenu.channel; setChannelSettingsName(ch.name); setChPrivate(!!ch.isPrivate); setChAllowedUsers(ch.allowedUsers || []); setChPermissions(ch.permissions || { user: { invite: true, sendMessages: true, sendMedia: true, viewChannel: true }, admin: { invite: true, sendMessages: true, sendMedia: true, viewChannel: true } }); setChSlowmode(ch.slowmode || 0); setChannelSettingsTab('general'); setShowChannelSettings(ch); setChannelMenu(null) }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
              <span>{t('channel.settings')}</span>
            </button>
          )}
          <button className="ctx-item" onClick={() => { navigator.clipboard.writeText(channelMenu.channel.id).catch(() => {}); setChannelMenu(null) }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
            <span>{t('channel.copyId')}</span>
          </button>
          {(activeServer && activeServer.ownerId === user.id) || hasServerPerm('clearChannel') ? (
            <>
              <div className="ctx-divider" />
              <button className="ctx-item ctx-danger" onClick={() => clearChannelMessages(channelMenu.channel)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M5 6v14a2 2 0 002 2h10a2 2 0 002-2V6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
                <span>{t('channel.clear') || 'Очистить канал'}</span>
              </button>
            </>
          ) : null}
          {activeServer && activeServer.ownerId === user.id && (
            <>
              <button className="ctx-item ctx-danger" onClick={() => deleteChannel(channelMenu.channel)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                <span>{t('channel.delete')}</span>
              </button>
            </>
          )}
        </div>
        </div>
      )}

      {/* Modals */}
      {showCreateServer && (
        <div className="modal-overlay" onClick={() => setShowCreateServer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{t('server.create')}</h3>
            <p>{t('server.createDesc')}</p>
            <form onSubmit={createServer}>
              <div className="field">
                <label>{t('server.name')}</label>
                <input type="text" placeholder={t('server.name')} value={newServerName} onChange={e => setNewServerName(e.target.value)} autoFocus required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn-cancel" onClick={() => setShowCreateServer(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn-submit">{t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showShop && (
        <div className="modal-overlay shop-overlay" onClick={() => setShowShop(false)}>
          <div className="shop-panel" onClick={e => e.stopPropagation()}>
            <button className="settings-close" onClick={() => setShowShop(false)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>

            {/* Shop header */}
            <div className="shop-header">
              <div className="shop-header-icon">✨</div>
              <div>
                <h2 className="shop-title">Буст Премиум</h2>
                <p className="shop-subtitle">Расширь возможности — для себя и своих серверов</p>
              </div>
              {premiumStatus?.active && (
                <div className="shop-active-badge">
                  {premiumStatus.premium === 'pro' ? '💎 Про' : '⭐ Стандарт'}
                  <span className="shop-expiry">до {new Date(premiumStatus.premiumExpiry).toLocaleDateString('ru-RU')}</span>
                </div>
              )}
            </div>

            {/* Tabs */}
            <div className="shop-tabs">
              <button className={`shop-tab ${shopTab === 'subscription' ? 'active' : ''}`} onClick={() => setShopTab('subscription')}>Подписка</button>
              <button className={`shop-tab ${shopTab === 'boosts' ? 'active' : ''}`} onClick={() => setShopTab('boosts')}>
                Голоса {boostData && <span className="shop-tab-badge">{boostData.free}/{boostData.total}</span>}
              </button>
            </div>

            <div className="shop-content">
              {shopTab === 'subscription' && (
                <div className="shop-plans">
                  {/* Standard */}
                  <div className={`shop-plan ${premiumStatus?.premium === 'standard' ? 'active' : ''}`}>
                    <div className="shop-plan-header">
                      <span className="shop-plan-icon">⭐</span>
                      <div>
                        <div className="shop-plan-name">Стандарт</div>
                        <div className="shop-plan-price">99 ₽ / мес</div>
                      </div>
                    </div>
                    <ul className="shop-plan-features">
                      <li>✅ 2 голоса для серверов</li>
                      <li>✅ GIF-аватар</li>
                      <li>✅ Эмодзи-значок у ника</li>
                      <li>✅ Расширенное bio (500 симв.)</li>
                      <li>✅ Трансляция экрана 720p</li>
                      <li>✅ До 8 серверов</li>
                    </ul>
                    {premiumStatus?.premium === 'standard' ? (
                      <button className="shop-plan-btn danger" onClick={cancelPremium} disabled={shopLoading}>Отменить подписку</button>
                    ) : (
                      <button className="shop-plan-btn" onClick={() => activatePremium('standard')} disabled={shopLoading}>
                        {shopLoading ? 'Загрузка...' : premiumStatus?.premium === 'pro' ? 'Перейти на Стандарт' : 'Активировать'}
                      </button>
                    )}
                  </div>

                  {/* Pro */}
                  <div className={`shop-plan pro ${premiumStatus?.premium === 'pro' ? 'active' : ''}`}>
                    <div className="shop-plan-badge">Лучший выбор</div>
                    <div className="shop-plan-header">
                      <span className="shop-plan-icon">💎</span>
                      <div>
                        <div className="shop-plan-name">Про</div>
                        <div className="shop-plan-price">249 ₽ / мес</div>
                      </div>
                    </div>
                    <ul className="shop-plan-features">
                      <li>✅ 8 голосов для серверов</li>
                      <li>✅ GIF-аватар и GIF-баннер</li>
                      <li>✅ Эмодзи-значок у ника</li>
                      <li>✅ Рамка аватара</li>
                      <li>✅ Эффект профиля</li>
                      <li>✅ Расширенное bio (500 симв.)</li>
                      <li>✅ Трансляция экрана 1440p (2K)</li>
                      <li>✅ До 20 серверов</li>
                    </ul>
                    {premiumStatus?.premium === 'pro' ? (
                      <button className="shop-plan-btn danger" onClick={cancelPremium} disabled={shopLoading}>Отменить подписку</button>
                    ) : (
                      <button className="shop-plan-btn pro" onClick={() => activatePremium('pro')} disabled={shopLoading}>
                        {shopLoading ? 'Загрузка...' : 'Активировать Про'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {shopTab === 'boosts' && (
                <div className="shop-boosts">
                  {!premiumStatus?.active ? (
                    <div className="shop-boosts-empty">
                      <div style={{ fontSize:'2.5rem' }}>🚀</div>
                      <p>Голоса доступны с подпиской Буст Премиум</p>
                      <button className="shop-plan-btn" onClick={() => setShopTab('subscription')}>Выбрать подписку</button>
                    </div>
                  ) : (
                    <>
                      <div className="shop-boosts-summary">
                        <div className="shop-boosts-stat">
                          <span className="shop-boosts-num">{boostData?.total ?? 0}</span>
                          <span className="shop-boosts-label">всего</span>
                        </div>
                        <div className="shop-boosts-stat">
                          <span className="shop-boosts-num" style={{ color: 'var(--primary)' }}>{boostData?.used ?? 0}</span>
                          <span className="shop-boosts-label">розданы</span>
                        </div>
                        <div className="shop-boosts-stat">
                          <span className="shop-boosts-num" style={{ color: 'var(--online)' }}>{boostData?.free ?? 0}</span>
                          <span className="shop-boosts-label">свободны</span>
                        </div>
                      </div>

                      <div className="shop-boosts-list">
                        {servers.map(srv => {
                          const myBoost = (boostData?.boostedServers || []).find(b => b.serverId === srv.id)
                          const myAmount = myBoost?.amount || 0
                          const srvData = servers.find(s => s.id === srv.id)
                          const level = srvData?.boostLevel ?? 0
                          return (
                            <div key={srv.id} className="shop-boost-row">
                              <div className="shop-boost-srv-info">
                                <div className="shop-boost-srv-avatar" style={{ background: srv.avatarColor || 'var(--primary-dim)' }}>
                                  {srv.avatar ? <img src={srv.avatar} alt="" style={{ width:'100%',height:'100%',objectFit:'cover',borderRadius:8 }}/> : <span>{srv.iconText}</span>}
                                </div>
                                <div>
                                  <div className="shop-boost-srv-name">{srv.name}</div>
                                  <div className="shop-boost-srv-level">{'🔥'.repeat(level) || '—'} Уровень {level}</div>
                                </div>
                              </div>
                              <div className="shop-boost-controls">
                                <button className="shop-boost-btn" onClick={() => removeBoost(srv.id, 1)} disabled={myAmount === 0}>−</button>
                                <span className="shop-boost-count">{myAmount}</span>
                                <button className="shop-boost-btn" onClick={() => giveBoost(srv.id, 1)} disabled={(boostData?.free ?? 0) === 0}>+</button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showProfileSettings && (
        <div className="modal-overlay settings-overlay" onClick={() => setShowProfileSettings(false)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <button className="settings-close" onClick={() => setShowProfileSettings(false)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
            <div className="settings-sidebar">
              <div className="settings-sidebar-group-label">Настройки пользователя</div>
              <button className={`settings-sidebar-item ${settingsTab === 'profile' ? 'active' : ''}`} onClick={() => setSettingsTab('profile')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Мой профиль
              </button>
              <button className={`settings-sidebar-item ${settingsTab === 'privacy' ? 'active' : ''}`} onClick={() => setSettingsTab('privacy')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                Конфиденциальность
              </button>
              <div className="settings-sidebar-divider" />
              <div className="settings-sidebar-group-label">Настройки приложения</div>
              <button className={`settings-sidebar-item ${settingsTab === 'app' ? 'active' : ''}`} onClick={() => setSettingsTab('app')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                Внешний вид
              </button>
              <button className={`settings-sidebar-item ${settingsTab === 'lang' ? 'active' : ''}`} onClick={() => setSettingsTab('lang')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/></svg>
                Язык и время
              </button>
              <div className="settings-sidebar-divider" />
              <button className="settings-sidebar-item danger" onClick={logout}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
                {t('settings.logout')}
              </button>
            </div>
            <div className="settings-content">
              {settingsTab === 'profile' && (
                <div className="settings-page">
                  <h2>{t('settings.profileTitle')}</h2>
                  <p className="settings-page-desc">{t('settings.profileDesc')}</p>
                  {/* Mini profile card preview */}
                  <div className="profile-settings-card" style={{ position:'relative' }}>
                    <div
                      className={`profile-settings-banner${premiumStatus?.active ? ' banner-clickable' : ''}`}
                      style={profileForm.bannerImg ? { backgroundImage: `url(${profileForm.bannerImg})`, backgroundSize: 'cover', backgroundPosition: 'center' } : { background: bannerGradient(profileForm.bannerColor || user.avatarColor) }}
                      onClick={() => premiumStatus?.active && setShowBannerOptions(v => !v)}
                    >
                      {premiumStatus?.active && (
                        <div className="banner-edit-overlay">
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                          <span>Изменить баннер</span>
                        </div>
                      )}
                    </div>
                    {showBannerOptions && (
                      <div className="banner-options-popup" onClick={e => e.stopPropagation()}>
                        <button className="banner-opt-btn" onClick={() => { setShowBannerOptions(false); bannerInputRef.current?.click() }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                          Загрузить изображение
                        </button>
                        <button className="banner-opt-btn" onClick={() => { setShowBannerOptions(false); setBannerGifSearch(''); fetchBannerGifs(''); setShowBannerGifPicker(true) }}>
                          <span style={{ fontWeight:800, fontSize:'.75rem', letterSpacing:'.05em' }}>GIF</span>
                          Выбрать GIF
                        </button>
                        {profileForm.bannerImg && (
                          <button className="banner-opt-btn banner-opt-danger" onClick={() => { setProfileForm(f => ({ ...f, bannerImg: null })); setShowBannerOptions(false) }}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                            Удалить баннер
                          </button>
                        )}
                      </div>
                    )}
                    <input ref={bannerInputRef} type="file" accept="image/*" style={{ display:'none' }} onChange={e => {
                      const file = e.target.files?.[0]; if (!file) return
                      if (file.size > 10 * 1024 * 1024) { setProfileError('Max 10 MB'); return }
                      const reader = new FileReader()
                      reader.onload = () => {
                        const img = new Image()
                        img.onload = () => {
                          const baseW = 500 * img.width / img.height
                          const initScale = Math.max(460 / baseW, 100 / 150)
                          setBannerCropScale(Math.max(initScale, 1))
                          setBannerCropOffset({ x: 0, y: 0 })
                          setBannerCropModal({ imgSrc: reader.result, imgEl: img })
                        }
                        img.src = reader.result
                      }
                      reader.readAsDataURL(file)
                      e.target.value = ''
                    }} />
                    <div className="profile-settings-card-body">
                      <div className={`profile-preview-avatar-wrap ${profileForm.avatarFrame ? `avatar-frame-${profileForm.avatarFrame}` : ''}`} onClick={() => avatarInputRef.current?.click()}>
                        {user.avatar ? (
                          <img src={user.avatar} alt="" className="profile-preview-avatar-img" />
                        ) : (
                          <div className="profile-preview-avatar" style={{ background: user.avatarColor }}>
                            {(profileForm.username || user.username)[0].toUpperCase()}
                          </div>
                        )}
                        <div className="profile-avatar-overlay">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>
                        </div>
                        <div className={`status-dot ${user.status || 'offline'}`} />
                        <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={async (e) => {
                          const file = e.target.files?.[0]
                          if (!file) return
                          if (file.size > 10 * 1024 * 1024) { setProfileError('Max 10 MB'); return }
                          // GIF/WebP direct upload for Pro users (preserves animation)
                          if ((file.type === 'image/gif' || file.type === 'image/webp') && user.premium === 'pro') {
                            setAvatarUploading(true)
                            try {
                              const fd = new FormData()
                              fd.append('avatar', file)
                              const res = await fetch('/api/auth/avatar', { method: 'POST', headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }, body: fd })
                              if (!res.ok) { const err = await res.json(); setProfileError(err.error || 'Upload error'); return }
                              const data = await res.json()
                              setUser(prev => ({ ...prev, avatar: data.avatar }))
                              socket?.emit('avatar-changed', { userId: user.id, avatar: data.avatar })
                            } catch { setProfileError('Upload failed') }
                            finally { setAvatarUploading(false); e.target.value = '' }
                            return
                          }
                          if (file.type === 'image/gif' && user.premium !== 'pro') {
                            setProfileError('GIF-аватар доступен только с подпиской Про 💎')
                            e.target.value = ''; return
                          }
                          const reader = new FileReader()
                          reader.onload = () => {
                            const img = new Image()
                            img.onload = () => {
                              const bW = 300 * img.width / img.height
                              const initScale = Math.max(1, 220 / bW, 220 / 300)
                              setCropScale(initScale); setCropOffset({ x: 0, y: 0 })
                              setAvatarCropModal({ imgSrc: reader.result, imgEl: img })
                            }
                            img.src = reader.result
                          }
                          reader.readAsDataURL(file)
                          e.target.value = ''
                        }} />
                      </div>
                      <div className="profile-settings-card-info">
                        <span className={`profile-preview-name ${streamerMode ? 'streamer-blur' : ''}`}>{profileForm.username || user.username}<span className="user-tag">#{user.tag}</span>{profileForm.statusEmoji && <span style={{ marginLeft: 6, fontSize: '1rem' }}>{profileForm.statusEmoji}</span>}</span>
                        <span className="profile-preview-status">{statusLabel(user.status)}</span>
                        {user.avatar && (
                          <button type="button" className="profile-avatar-remove" onClick={async () => {
                            try { await API('/api/auth/avatar', { method: 'DELETE' }); setUser(prev => ({ ...prev, avatar: null })) } catch {}
                          }}>Удалить аватар</button>
                        )}
                      </div>
                    </div>
                  </div>
                  {profileError && <div className="auth-error">{profileError}</div>}
                  <form onSubmit={saveProfile}>
                    <div className="field">
                      <label>{t('settings.username')}</label>
                      <input type="text" value={profileForm.username} onChange={e => setProfileForm({ ...profileForm, username: e.target.value })} required />
                    </div>
                    {user.premium === 'pro' && (
                      <div className="field">
                        <label>Рамка аватара 💎</label>
                        <div className="avatar-frame-picker">
                          {[
                            { id: null, label: 'Нет', preview: null },
                            { id: 'glow-purple', label: 'Фиолетовый', color: '#7c5cfc' },
                            { id: 'gold', label: 'Золото', color: '#f59e0b' },
                            { id: 'fire', label: 'Огонь', color: '#ef4444' },
                            { id: 'ice', label: 'Лёд', color: '#06b6d4' },
                            { id: 'neon', label: 'Неон', color: '#10b981' },
                            { id: 'galaxy', label: 'Галактика', color: 'linear-gradient(135deg,#7c5cfc,#ec4899,#06b6d4)' },
                          ].map(frame => (
                            <button
                              key={String(frame.id)}
                              type="button"
                              className={`avatar-frame-option ${profileForm.avatarFrame === frame.id ? 'active' : ''}`}
                              onClick={() => setProfileForm(f => ({ ...f, avatarFrame: frame.id }))}
                              title={frame.label}
                            >
                              <div
                                className={`avatar-frame-preview ${frame.id ? `avatar-frame-${frame.id}` : ''}`}
                                style={{ background: user.avatarColor, width: 32, height: 32, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '.75rem', fontWeight: 700, color: '#fff' }}
                              >
                                {user.username[0].toUpperCase()}
                              </div>
                              <span style={{ fontSize: '.65rem', color: 'var(--text-muted)', marginTop: 2 }}>{frame.label}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {user.premium && (
                      <div className="field">
                        <label>Эмодзи-значок у ника {user.premium === 'pro' ? '💎' : '⭐'}</label>
                        <div className="status-emoji-pick-row" style={{ position: 'relative' }}>
                          <button type="button" className="status-emoji-pick-btn" onClick={() => setShowEmojiPickerProfile(v => !v)}>
                            {profileForm.statusEmoji ? <span style={{ fontSize: '1.3rem' }}>{profileForm.statusEmoji}</span> : <span style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>Выбрать эмодзи</span>}
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                          </button>
                          {profileForm.statusEmoji && (
                            <button type="button" className="status-emoji-clear-btn" onClick={() => setProfileForm(f => ({ ...f, statusEmoji: null }))} title="Убрать">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
                            </button>
                          )}
                          {showEmojiPickerProfile && (
                            <div className="emoji-picker status-emoji-picker-float" style={{ position: 'absolute', top: '110%', left: 0, zIndex: 200 }}>
                              <div className="emoji-picker-search"><input type="text" placeholder={t('emoji.search')} autoFocus onChange={e => {}} /></div>
                              <div className="emoji-picker-grid">
                                {['😀','😂','🥰','😎','🤩','🥳','😍','🤔','😤','🔥','⭐','💎','👑','🎉','🎮','🎵','🎨','🏆','💪','🚀','🌟','✨','💫','🌈','🎯','🎲','🧠','💡','🔮','🎭','👾','🤖','🦋','🌸','🍀','🦁','🐺','🦊','🐉','🌙'].map(emoji => (
                                  <button key={emoji} type="button" className="emoji-btn" onClick={() => { setProfileForm(f => ({ ...f, statusEmoji: emoji })); setShowEmojiPickerProfile(false) }}>{emoji}</button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="field">
                      <label>{t('settings.aboutMe')}{user.premium && <span className="field-label-badge">{user.premium === 'pro' ? '💎 500 симв.' : '⭐ 500 симв.'}</span>}</label>
                      <textarea
                        className="profile-textarea"
                        placeholder={t('settings.aboutPlaceholder')}
                        value={profileForm.bio}
                        onChange={e => setProfileForm({ ...profileForm, bio: e.target.value })}
                        maxLength={user.premium ? 500 : 200}
                        rows={3}
                      />
                      <div className="field-counter">{profileForm.bio.length}/{user.premium ? 500 : 200}</div>
                    </div>
                    <div className="field">
                      <label>Баннер профиля</label>
                      <div className="banner-color-picker-row">
                        <div className="banner-color-swatch" style={{ background: bannerGradient(profileForm.bannerColor || user.avatarColor) }} title="Изменить цвет баннера" onClick={() => document.getElementById('banner-color-input').click()}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="2" strokeLinecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                          <input id="banner-color-input" type="color" value={profileForm.bannerColor || '#7c5cfc'} style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }} onChange={e => setProfileForm(f => ({ ...f, bannerColor: e.target.value }))} />
                        </div>
                        {profileForm.bannerColor && (
                          <button type="button" className="banner-color-clear" onClick={() => setProfileForm(f => ({ ...f, bannerColor: null }))} title="Сбросить цвет">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="modal-actions">
                      <button type="button" className="btn-cancel" onClick={() => setShowProfileSettings(false)}>{t('settings.cancel')}</button>
                      <button type="submit" className="btn-submit" disabled={profileSaving}>
                        {profileSaving ? t('settings.saving') : t('settings.save')}
                      </button>
                    </div>
                  </form>
                </div>
              )}
              {settingsTab === 'app' && (
                <div className="settings-page">
                  <h2>{t('settings.appSettings')}</h2>
                  <div className="settings-section">
                    <label className="settings-section-title">{t('settings.theme')}</label>
                    <div className="settings-theme-options">
                      {[
                        { id: 'dark', label: t('settings.themeDark') || 'Тёмная', bar: '#0d0d14', bg: '#111118', line: '#1e1e2e' },
                        { id: 'light', label: t('settings.themeLight') || 'Светлая', bar: '#dde0f0', bg: '#eef0f9', line: '#cdd1e8' },
                        { id: 'amoled', label: 'AMOLED', bar: '#000000', bg: '#050508', line: '#0a0a10', premium: true },
                        { id: 'nord', label: 'Nord', bar: '#242933', bg: '#2e3440', line: '#3b4252', premium: true },
                        { id: 'mocha', label: 'Мокко', bar: '#1e1a18', bg: '#241f1b', line: '#2c2622', premium: true },
                      ].map(theme => {
                        const locked = theme.premium && !premiumStatus?.active
                        return (
                        <button
                          key={theme.id}
                          className={`settings-theme-btn ${appTheme === theme.id ? 'active' : ''} ${locked ? 'locked' : ''}`}
                          onClick={() => { if (locked) setThemePremiumPrompt(true); else changeTheme(theme.id) }}
                          title={locked ? '⭐ Требуется подписка' : theme.label}
                        >
                          <div className="theme-preview" style={{ background: theme.bar }}>
                            <div className="theme-preview-bar" style={{ background: theme.bg }} />
                            <div className="theme-preview-content" style={{ background: theme.bg }}>
                              <div className="theme-preview-line" style={{ background: theme.line }} />
                              <div className="theme-preview-line short" style={{ background: theme.line }} />
                            </div>
                            {locked && <div className="theme-preview-lock">⭐</div>}
                          </div>
                          <span>{theme.label}</span>
                        </button>
                        )
                      })}
                    </div>
                  </div>
                  <div className="settings-section">
                    <label className="settings-section-title">{t('settings.accentColor')}</label>
                    <div className="settings-accent-options">
                      {ACCENT_COLORS.map(c => (
                        <button
                          key={c.value}
                          className={`settings-accent-btn ${appAccent === c.value ? 'active' : ''}`}
                          style={{ background: c.value }}
                          onClick={() => changeAccent(c.value)}
                          title={c.name}
                        >
                          {appAccent === c.value && (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {settingsTab === 'lang' && (
                <div className="settings-page">
                  <h2>Язык и время</h2>
                  <div className="settings-section">
                    <label className="settings-section-title">{t('settings.language')}</label>
                    <div className="settings-lang-select-row">
                      <select
                        className="settings-lang-select"
                        value={appLang}
                        onChange={e => changeLanguage(e.target.value)}
                        disabled={langLoading}
                      >
                        {LANGUAGES.map(lang => (
                          <option key={lang.code} value={lang.code}>{lang.flag} {lang.native}</option>
                        ))}
                      </select>
                      {langLoading && <div className="lang-loading-spinner" />}
                    </div>
                    {langLoading && <p className="lang-loading-hint">Загрузка перевода...</p>}
                  </div>
                  <div className="settings-section">
                    <label className="settings-section-title">Формат времени</label>
                    <div className="settings-timeformat-row">
                      <button
                        className={`settings-timeformat-btn ${timeFormat === '24' ? 'active' : ''}`}
                        onClick={() => { localStorage.setItem('appTimeFormat', '24'); setTimeFormat('24') }}
                      >
                        24ч <span className="settings-timeformat-example">14:30</span>
                      </button>
                      <button
                        className={`settings-timeformat-btn ${timeFormat === '12' ? 'active' : ''}`}
                        onClick={() => { localStorage.setItem('appTimeFormat', '12'); setTimeFormat('12') }}
                      >
                        12ч <span className="settings-timeformat-example">2:30 PM</span>
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {settingsTab === 'privacy' && (
                <div className="settings-page">
                  <h2>Конфиденциальность</h2>
                  <p className="settings-page-desc">Управление данными и конфиденциальностью вашего аккаунта.</p>
                  <div className="settings-section">
                    <label className="settings-section-title">Соглашения</label>
                    <div className="privacy-agreements">
                      <div className="privacy-agreement-item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                        <a href="/terms" target="_blank" rel="noopener noreferrer">Пользовательское соглашение</a>
                      </div>
                      <div className="privacy-agreement-item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--primary)" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
                        <a href="/privacy" target="_blank" rel="noopener noreferrer">Политика конфиденциальности</a>
                      </div>
                    </div>
                  </div>
                  <div className="settings-section">
                    <label className="settings-section-title">Данные аккаунта</label>
                    <p style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 12 }}>
                      Мы храним только необходимые данные: имя пользователя, email, сообщения. Пароль хранится в зашифрованном виде.
                    </p>
                  </div>
                  <div className="settings-section settings-danger-zone">
                    <label className="settings-section-title" style={{ color: 'var(--danger)' }}>Опасная зона</label>
                    <p style={{ fontSize: '.85rem', color: 'var(--text-muted)', marginBottom: 16 }}>
                      Удаление аккаунта необратимо. Вы будете удалены из всех серверов и списков друзей. Ваши сообщения останутся, но имя будет заменено на «Удалённый пользователь».
                    </p>
                    {!privacyDeleteConfirm ? (
                      <button className="btn-danger" onClick={() => setPrivacyDeleteConfirm(true)}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                        Удалить аккаунт
                      </button>
                    ) : (
                      <div className="privacy-delete-confirm">
                        <p style={{ fontSize: '.85rem', color: 'var(--danger)', marginBottom: 8 }}>Для подтверждения введите <b>УДАЛИТЬ</b></p>
                        <input
                          type="text"
                          className="terms-delete-input"
                          value={privacyDeleteText}
                          onChange={e => setPrivacyDeleteText(e.target.value)}
                          placeholder="УДАЛИТЬ"
                          autoFocus
                        />
                        <div className="privacy-delete-actions">
                          <button
                            className="btn-danger"
                            disabled={privacyDeleteText !== 'УДАЛИТЬ' || privacyDeleting}
                            onClick={async () => {
                              setPrivacyDeleting(true)
                              try {
                                await API('/api/auth/account', { method: 'DELETE' })
                                logout()
                              } catch { setPrivacyDeleting(false) }
                            }}
                          >
                            {privacyDeleting ? 'Удаление...' : 'Удалить аккаунт навсегда'}
                          </button>
                          <button className="btn-cancel" onClick={() => { setPrivacyDeleteConfirm(false); setPrivacyDeleteText('') }}>Отмена</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {themePremiumPrompt && (
              <div className="theme-premium-prompt-overlay" onClick={() => setThemePremiumPrompt(false)}>
                <div className="theme-premium-prompt" onClick={e => e.stopPropagation()}>
                  <div className="theme-premium-prompt-icon">⭐</div>
                  <div className="theme-premium-prompt-title">Эксклюзивные темы</div>
                  <div className="theme-premium-prompt-desc">AMOLED, Nord и Мокко доступны с подпиской Буст. Открой новый облик приложения.</div>
                  <div className="theme-premium-prompt-actions">
                    <button className="btn-primary theme-premium-prompt-btn" onClick={() => { setThemePremiumPrompt(false); setShowProfileSettings(false); openShop('subscription') }}>
                      Смотреть подписки
                    </button>
                    <button className="theme-premium-prompt-cancel" onClick={() => setThemePremiumPrompt(false)}>Позже</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {avatarCropModal && (() => {
        // Image base dimensions when rendered with height:100% (300px) in the crop area
        const baseW = 300 * avatarCropModal.imgEl.width / avatarCropModal.imgEl.height
        // Minimum scale: image must always cover the 220×220 hole
        const minScale = Math.max(220 / baseW, 220 / 300)
        // Max allowed offset at a given scale so image never leaves the hole
        const maxOX = (s) => baseW * s / 2 - 110
        const maxOY = (s) => 150 * s - 110
        const clampOff = (s, ox, oy) => ({
          x: Math.max(-maxOX(s), Math.min(maxOX(s), ox)),
          y: Math.max(-maxOY(s), Math.min(maxOY(s), oy)),
        })
        // Visual position of image top-left in the 300x300 area
        const imgVX = 150 + cropOffset.x - baseW * cropScale / 2
        const imgVY = 150 + cropOffset.y - 150 * cropScale
        // Preview circle (100x100) maps the 220x220 hole at [40,260]×[40,260]
        const ps = 100 / 220
        const previewStyle = {
          backgroundImage: `url(${avatarCropModal.imgSrc})`,
          backgroundSize: `${baseW * cropScale * ps}px ${300 * cropScale * ps}px`,
          backgroundPosition: `${(imgVX - 40) * ps}px ${(imgVY - 40) * ps}px`,
        }
        const applyScale = (newS) => {
          const s = Math.max(minScale, Math.min(3, newS))
          setCropScale(s)
          setCropOffset(o => clampOff(s, o.x, o.y))
        }
        return (
          <div className="modal-overlay" onClick={() => setAvatarCropModal(null)}>
            <div className="modal avatar-crop-modal" onClick={e => e.stopPropagation()}>
              <h3>Настройка аватара</h3>
              <p className="avatar-crop-hint">Перетащи и масштабируй изображение</p>
              <div className="avatar-crop-container">
                <div className="avatar-crop-area"
                  onWheel={(e) => { e.preventDefault(); applyScale(cropScale + (e.deltaY > 0 ? -0.08 : 0.08)) }}
                  onMouseDown={(e) => { e.preventDefault(); cropDrag.current = { active: true, startX: e.clientX, startY: e.clientY, origX: cropOffset.x, origY: cropOffset.y } }}
                  onMouseMove={(e) => { if (!cropDrag.current.active) return; const d = cropDrag.current; setCropOffset(clampOff(cropScale, d.origX + e.clientX - d.startX, d.origY + e.clientY - d.startY)) }}
                  onMouseUp={() => { cropDrag.current.active = false }}
                  onMouseLeave={() => { cropDrag.current.active = false }}
                  onTouchStart={(e) => { const t = e.touches[0]; cropDrag.current = { active: true, startX: t.clientX, startY: t.clientY, origX: cropOffset.x, origY: cropOffset.y } }}
                  onTouchMove={(e) => { if (!cropDrag.current.active) return; const t = e.touches[0]; const d = cropDrag.current; setCropOffset(clampOff(cropScale, d.origX + t.clientX - d.startX, d.origY + t.clientY - d.startY)) }}
                  onTouchEnd={() => { cropDrag.current.active = false }}
                >
                  <img
                    className="avatar-crop-img"
                    src={avatarCropModal.imgSrc}
                    alt=""
                    draggable={false}
                    style={{ transform: `translate(-50%, -50%) translate(${cropOffset.x}px, ${cropOffset.y}px) scale(${cropScale})` }}
                  />
                  <svg className="avatar-crop-mask" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                    <defs>
                      <mask id="avatarCropHole">
                        <rect fill="white" width="300" height="300" />
                        <circle fill="black" cx="150" cy="150" r="110" />
                      </mask>
                    </defs>
                    <rect fill="rgba(0,0,0,0.65)" width="300" height="300" mask="url(#avatarCropHole)" />
                    <circle fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" cx="150" cy="150" r="110" />
                  </svg>
                </div>
                <div className="avatar-crop-preview">
                  <div className="avatar-crop-preview-circle" style={previewStyle} />
                  <span className="avatar-crop-preview-label">Предпросмотр</span>
                </div>
              </div>
              <div className="avatar-crop-zoom">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                <input type="range" min={minScale.toFixed(2)} max="3" step="0.02" value={cropScale} onChange={(e) => applyScale(parseFloat(e.target.value))} />
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>
              </div>
              <div className="modal-actions">
                <button className="btn-cancel" onClick={() => setAvatarCropModal(null)}>Отмена</button>
                <button className="btn-submit" disabled={avatarUploading} onClick={async () => {
                  const imgEl = avatarCropModal.imgEl; if (!imgEl) return
                  setAvatarUploading(true)
                  try {
                    const canvas = document.createElement('canvas')
                    const outSize = 256
                    canvas.width = outSize; canvas.height = outSize
                    const ctx = canvas.getContext('2d')
                    // crop area is 300×300 (matches CSS), hole is 220×220 centered at (40,40)
                    const baseW = 300 * imgEl.width / imgEl.height
                    const imgW = baseW * cropScale
                    const imgH = 300 * cropScale
                    const imgX = 150 + cropOffset.x - imgW / 2
                    const imgY = 150 + cropOffset.y - imgH / 2
                    const srcX = (40 - imgX) / imgW * imgEl.width
                    const srcY = (40 - imgY) / imgH * imgEl.height
                    const srcW = 220 / imgW * imgEl.width
                    const srcH = 220 / imgH * imgEl.height
                    ctx.beginPath(); ctx.arc(outSize/2, outSize/2, outSize/2, 0, Math.PI*2); ctx.clip()
                    ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize)
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
                    if (!blob) { setAvatarUploading(false); return }
                    const fd = new FormData()
                    fd.append('avatar', blob, 'avatar.png')
                    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
                    const res = await fetch('/api/auth/avatar', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
                    const data = await res.json()
                    if (!res.ok) throw new Error(data.error)
                    setUser(prev => ({ ...prev, avatar: data.avatar }))
                    setAvatarCropModal(null)
                    setAvatarUploading(false)
                  } catch (err) { setProfileError(err.message); setAvatarUploading(false) }
                }}>{avatarUploading ? 'Сохранение...' : 'Сохранить'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {bannerCropModal && (() => {
        // Container 500×150, hole 460×100 at (20,25)
        const baseW = 150 * bannerCropModal.imgEl.width / bannerCropModal.imgEl.height
        const minScale = Math.max(460 / baseW, 100 / 150)
        const maxOX = (s) => Math.max(0, baseW * s / 2 - 230)
        const maxOY = (s) => Math.max(0, 75 * s - 50)
        const clamp = (s, ox, oy) => ({
          x: Math.max(-maxOX(s), Math.min(maxOX(s), ox)),
          y: Math.max(-maxOY(s), Math.min(maxOY(s), oy)),
        })
        const applyScale = (newS) => {
          const s = Math.max(minScale, Math.min(4, newS))
          setBannerCropScale(s)
          setBannerCropOffset(o => clamp(s, o.x, o.y))
        }
        return (
          <div className="modal-overlay" onClick={() => setBannerCropModal(null)}>
            <div className="modal banner-crop-modal" onClick={e => e.stopPropagation()}>
              <h3>Настройка баннера</h3>
              <p className="avatar-crop-hint">Перетащи и масштабируй изображение</p>
              <div className="banner-crop-area"
                onWheel={e => { e.preventDefault(); applyScale(bannerCropScale + (e.deltaY > 0 ? -0.08 : 0.08)) }}
                onMouseDown={e => { e.preventDefault(); bannerCropDrag.current = { active: true, startX: e.clientX, startY: e.clientY, origX: bannerCropOffset.x, origY: bannerCropOffset.y } }}
                onMouseMove={e => { if (!bannerCropDrag.current.active) return; const d = bannerCropDrag.current; setBannerCropOffset(clamp(bannerCropScale, d.origX + e.clientX - d.startX, d.origY + e.clientY - d.startY)) }}
                onMouseUp={() => { bannerCropDrag.current.active = false }}
                onMouseLeave={() => { bannerCropDrag.current.active = false }}
                onTouchStart={e => { const t = e.touches[0]; bannerCropDrag.current = { active: true, startX: t.clientX, startY: t.clientY, origX: bannerCropOffset.x, origY: bannerCropOffset.y } }}
                onTouchMove={e => { if (!bannerCropDrag.current.active) return; const t = e.touches[0]; const d = bannerCropDrag.current; setBannerCropOffset(clamp(bannerCropScale, d.origX + t.clientX - d.startX, d.origY + t.clientY - d.startY)) }}
                onTouchEnd={() => { bannerCropDrag.current.active = false }}
              >
                <img
                  src={bannerCropModal.imgSrc} alt="" draggable={false}
                  style={{ position:'absolute', top:'50%', left:'50%', height: `${150 * bannerCropScale}px`, width: `${baseW * bannerCropScale}px`, transform: `translate(-50%, -50%) translate(${bannerCropOffset.x}px, ${bannerCropOffset.y}px)`, userSelect:'none', pointerEvents:'none' }}
                />
                <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }} viewBox="0 0 500 150">
                  <defs>
                    <mask id="bannerCropHole">
                      <rect fill="white" width="500" height="150" />
                      <rect fill="black" x="20" y="25" width="460" height="100" rx="4" />
                    </mask>
                  </defs>
                  <rect fill="rgba(0,0,0,0.65)" width="500" height="150" mask="url(#bannerCropHole)" />
                  <rect fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" x="20" y="25" width="460" height="100" rx="4" />
                </svg>
              </div>
              <div className="avatar-crop-zoom">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                <input type="range" min={minScale.toFixed(2)} max="4" step="0.02" value={bannerCropScale} onChange={e => applyScale(parseFloat(e.target.value))} />
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>
              </div>
              <div className="modal-actions">
                <button className="btn-cancel" onClick={() => setBannerCropModal(null)}>Отмена</button>
                <button className="btn-submit" disabled={bannerUploading} onClick={async () => {
                  const imgEl = bannerCropModal.imgEl; if (!imgEl) return
                  setBannerUploading(true)
                  try {
                    const canvas = document.createElement('canvas')
                    canvas.width = 900; canvas.height = 200
                    const ctx = canvas.getContext('2d')
                    const bW = baseW * bannerCropScale
                    const bH = 150 * bannerCropScale
                    const imgX = 250 + bannerCropOffset.x - bW / 2
                    const imgY = 75 + bannerCropOffset.y - bH / 2
                    const srcX = (20 - imgX) / bW * imgEl.width
                    const srcY = (25 - imgY) / bH * imgEl.height
                    const srcW = 460 / bW * imgEl.width
                    const srcH = 100 / bH * imgEl.height
                    ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, 900, 200)
                    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92))
                    const fd = new FormData()
                    fd.append('banner', blob, 'banner.jpg')
                    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
                    const res = await fetch('/api/auth/banner', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
                    const data = await res.json()
                    if (!res.ok) throw new Error(data.error)
                    setProfileForm(f => ({ ...f, bannerImg: data.bannerImg }))
                    setUser(prev => ({ ...prev, bannerImg: data.bannerImg }))
                    setBannerCropModal(null)
                  } catch (err) { setProfileError(err.message) } finally { setBannerUploading(false) }
                }}>{bannerUploading ? 'Сохранение...' : 'Сохранить'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {showBannerGifPicker && (
        <div className="modal-overlay" onClick={() => setShowBannerGifPicker(false)}>
          <div className="modal banner-gif-modal" onClick={e => e.stopPropagation()}>
            <h3>Выбрать GIF для баннера</h3>
            <div className="gif-picker-search" style={{ border:'none', padding:'0 0 10px 0' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
              <input type="text" placeholder="Поиск GIF..." value={bannerGifSearch} autoFocus
                onChange={e => { const q = e.target.value; setBannerGifSearch(q); clearTimeout(bannerGifSearchTimer.current); bannerGifSearchTimer.current = setTimeout(() => fetchBannerGifs(q), 400) }} />
            </div>
            <div className="gif-picker-grid" style={{ height: 320 }}>
              {bannerGifLoading ? (
                <div className="gif-picker-loading"><div className="gif-picker-spinner" /></div>
              ) : bannerGifResults.map(gif => (
                <div key={gif.id} className="gif-item" onClick={() => selectBannerGif(gif)}>
                  <img src={gif.images.fixed_width.url} alt={gif.title} loading="lazy" />
                </div>
              ))}
            </div>
            <div className="gif-picker-footer" style={{ borderTop:'1px solid var(--border)', padding:'8px 0 0', marginTop:8 }}>
              <img src="https://developers.giphy.com/branch/master/static/header-logo-8974b8ae658f704a5b48a2d039b8ad93.gif" alt="Powered by GIPHY" className="giphy-logo" />
            </div>
          </div>
        </div>
      )}

      {serverAvatarCropModal && (() => {
        const baseW = 300 * serverAvatarCropModal.imgEl.width / serverAvatarCropModal.imgEl.height
        const minScale = Math.max(220 / baseW, 220 / 300)
        const maxOX = (s) => baseW * s / 2 - 110
        const maxOY = (s) => 150 * s - 110
        const clampOff = (s, ox, oy) => ({
          x: Math.max(-maxOX(s), Math.min(maxOX(s), ox)),
          y: Math.max(-maxOY(s), Math.min(maxOY(s), oy)),
        })
        const imgVX = 150 + serverCropOffset.x - baseW * serverCropScale / 2
        const imgVY = 150 + serverCropOffset.y - 150 * serverCropScale
        const ps = 100 / 220
        const previewStyle = {
          backgroundImage: `url(${serverAvatarCropModal.imgSrc})`,
          backgroundSize: `${baseW * serverCropScale * ps}px ${300 * serverCropScale * ps}px`,
          backgroundPosition: `${(imgVX - 40) * ps}px ${(imgVY - 40) * ps}px`,
        }
        const applyScale = (newS) => {
          const s = Math.max(minScale, Math.min(3, newS))
          setServerCropScale(s)
          setServerCropOffset(o => clampOff(s, o.x, o.y))
        }
        return (
          <div className="modal-overlay" style={{ zIndex: 400 }} onClick={() => setServerAvatarCropModal(null)}>
            <div className="modal avatar-crop-modal" onClick={e => e.stopPropagation()}>
              <h3>Аватар сервера</h3>
              <p className="avatar-crop-hint">Перетащи и масштабируй изображение</p>
              <div className="avatar-crop-container">
                <div className="avatar-crop-area"
                  onWheel={(e) => { e.preventDefault(); applyScale(serverCropScale + (e.deltaY > 0 ? -0.08 : 0.08)) }}
                  onMouseDown={(e) => { e.preventDefault(); serverCropDrag.current = { active: true, startX: e.clientX, startY: e.clientY, origX: serverCropOffset.x, origY: serverCropOffset.y } }}
                  onMouseMove={(e) => { if (!serverCropDrag.current.active) return; const d = serverCropDrag.current; setServerCropOffset(clampOff(serverCropScale, d.origX + e.clientX - d.startX, d.origY + e.clientY - d.startY)) }}
                  onMouseUp={() => { serverCropDrag.current.active = false }}
                  onMouseLeave={() => { serverCropDrag.current.active = false }}
                  onTouchStart={(e) => { const t = e.touches[0]; serverCropDrag.current = { active: true, startX: t.clientX, startY: t.clientY, origX: serverCropOffset.x, origY: serverCropOffset.y } }}
                  onTouchMove={(e) => { if (!serverCropDrag.current.active) return; const t = e.touches[0]; const d = serverCropDrag.current; setServerCropOffset(clampOff(serverCropScale, d.origX + t.clientX - d.startX, d.origY + t.clientY - d.startY)) }}
                  onTouchEnd={() => { serverCropDrag.current.active = false }}
                >
                  <img className="avatar-crop-img" src={serverAvatarCropModal.imgSrc} alt="" draggable={false}
                    style={{ transform: `translate(-50%, -50%) translate(${serverCropOffset.x}px, ${serverCropOffset.y}px) scale(${serverCropScale})` }} />
                  <svg className="avatar-crop-mask" viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                    <defs>
                      <mask id="srvCropHole">
                        <rect fill="white" width="300" height="300" />
                        <rect fill="black" x="40" y="40" width="220" height="220" rx="16" ry="16" />
                      </mask>
                    </defs>
                    <rect fill="rgba(0,0,0,0.65)" width="300" height="300" mask="url(#srvCropHole)" />
                    <rect fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" x="40" y="40" width="220" height="220" rx="16" ry="16" />
                  </svg>
                </div>
                <div className="avatar-crop-preview">
                  <div className="srv-crop-preview-square" style={previewStyle} />
                  <span className="avatar-crop-preview-label">Предпросмотр</span>
                </div>
              </div>
              <div className="avatar-crop-zoom">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
                <input type="range" min={minScale.toFixed(2)} max="3" step="0.02" value={serverCropScale} onChange={(e) => applyScale(parseFloat(e.target.value))} />
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="11" y1="8" x2="11" y2="14"/></svg>
              </div>
              <div className="modal-actions">
                <button className="btn-cancel" onClick={() => setServerAvatarCropModal(null)}>Отмена</button>
                <button className="btn-submit" disabled={serverAvatarUploading} onClick={async () => {
                  const imgEl = serverAvatarCropModal.imgEl; if (!imgEl) return
                  setServerAvatarUploading(true)
                  try {
                    const canvas = document.createElement('canvas')
                    const outSize = 256
                    canvas.width = outSize; canvas.height = outSize
                    const ctx = canvas.getContext('2d')
                    const baseW = 300 * imgEl.width / imgEl.height
                    const imgW = baseW * serverCropScale
                    const imgH = 300 * serverCropScale
                    const imgX = 150 + serverCropOffset.x - imgW / 2
                    const imgY = 150 + serverCropOffset.y - imgH / 2
                    const srcX = (40 - imgX) / imgW * imgEl.width
                    const srcY = (40 - imgY) / imgH * imgEl.height
                    const srcW = 220 / imgW * imgEl.width
                    const srcH = 220 / imgH * imgEl.height
                    ctx.drawImage(imgEl, srcX, srcY, srcW, srcH, 0, 0, outSize, outSize)
                    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
                    if (!blob) { setServerAvatarUploading(false); return }
                    const fd = new FormData()
                    fd.append('avatar', blob, 'avatar.png')
                    const token = localStorage.getItem('token') || sessionStorage.getItem('token')
                    const res = await fetch(`/api/servers/${activeServer.id}/avatar`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
                    const data = await res.json()
                    if (!res.ok) throw new Error(data.error)
                    setServers(prev => prev.map(s => s.id === activeServer.id ? { ...s, avatar: data.avatar } : s))
                    setActiveServer(prev => prev ? { ...prev, avatar: data.avatar } : prev)
                    setServerAvatarCropModal(null)
                    setServerAvatarUploading(false)
                  } catch { setServerAvatarUploading(false) }
                }}>{serverAvatarUploading ? 'Сохранение...' : 'Сохранить'}</button>
              </div>
            </div>
          </div>
        )
      })()}

      {showUploadDialog && uploadFileObj && (
        <div className="modal-overlay" onClick={closeUploadDialog}>
          <div className="modal modal-upload" onClick={e => e.stopPropagation()}>
            <h3>{t('upload.title')}</h3>
            {uploadPreview && (
              <div className="upload-preview">
                <img src={uploadPreview} alt="Preview" />
              </div>
            )}
            <div className="upload-file-info">
              <span className="upload-file-name">{uploadFileObj.name}</span>
              <span className="upload-file-size">{formatFileSize(uploadFileObj.size)}</span>
            </div>
            {(uploadFileObj.type.startsWith('image/') || uploadFileObj.type.startsWith('video/')) && (
              <div className="upload-send-as">
                <button className={`send-as-btn ${uploadSendAs === 'photo' ? 'active' : ''}`} onClick={() => setUploadSendAs('photo')}>
                  {uploadFileObj.type.startsWith('video/') ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21,15 16,10 5,21"/></svg>
                  )}
                  {uploadFileObj.type.startsWith('video/') ? t('upload.video') : t('upload.photo')}
                </button>
                <button className={`send-as-btn ${uploadSendAs === 'file' ? 'active' : ''}`} onClick={() => setUploadSendAs('file')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                  {t('upload.file')}
                </button>
              </div>
            )}
            <input className="upload-comment" type="text" placeholder={t('upload.comment')} value={uploadComment} onChange={e => setUploadComment(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleUploadSend() } }} autoFocus />
            <div className="modal-actions">
              <button className="btn-cancel" onClick={closeUploadDialog}>{t('common.cancel')}</button>
              <button className="btn-submit" disabled={uploading} onClick={handleUploadSend}>{uploading ? t('upload.uploading') : t('upload.btn')}</button>
            </div>
          </div>
        </div>
      )}

      {lightboxIndex >= 0 && lightboxImages[lightboxIndex] && (
        lightboxImages[lightboxIndex].attachment.fileType === 'video' ? (
          <div className="lightbox-overlay" onClick={() => setLightboxIndex(-1)}>
            <button className="lightbox-close lightbox-close-video" onClick={(e) => { e.stopPropagation(); setLightboxIndex(-1) }}>&times;</button>
            <LightboxVideoPlayer
              key={lightboxImages[lightboxIndex].id}
              src={lightboxImages[lightboxIndex].attachment.url}
              fileName={lightboxImages[lightboxIndex].attachment.fileName}
              counter={lightboxImages.length > 1 ? `${lightboxIndex + 1} / ${lightboxImages.length}` : null}
              hasPrev={lightboxIndex > 0}
              hasNext={lightboxIndex < lightboxImages.length - 1}
              onPrev={() => setLightboxIndex(i => Math.max(0, i - 1))}
              onNext={() => setLightboxIndex(i => Math.min(lightboxImages.length - 1, i + 1))}
            />
          </div>
        ) : (
          <div className="lightbox-overlay" onClick={() => setLightboxIndex(-1)}>
            {lightboxImages.length > 1 && (
              <button className="lightbox-arrow lightbox-arrow-left" onClick={(e) => { e.stopPropagation(); setLightboxIndex(i => Math.max(0, i - 1)) }} disabled={lightboxIndex === 0}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              </button>
            )}
            <div className="lightbox" onClick={e => e.stopPropagation()}>
              <button className="lightbox-close" onClick={() => setLightboxIndex(-1)}>&times;</button>
              <img src={lightboxImages[lightboxIndex].attachment.url} alt="" />
              <div className="lightbox-nav">
                <span className="lightbox-counter">{lightboxIndex + 1} / {lightboxImages.length}</span>
              </div>
              <div className="lightbox-filename">{lightboxImages[lightboxIndex].attachment.fileName}</div>
            </div>
            {lightboxImages.length > 1 && (
              <button className="lightbox-arrow lightbox-arrow-right" onClick={(e) => { e.stopPropagation(); setLightboxIndex(i => Math.min(lightboxImages.length - 1, i + 1)) }} disabled={lightboxIndex === lightboxImages.length - 1}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            )}
          </div>
        )
      )}

      {showCreateChannel && (
        <div className="modal-overlay" onClick={() => { setShowCreateChannel(false); setNewChannelType('text') }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{t('channel.create')}</h3>
            <p>{newChannelType === 'voice' ? t('channel.createVoiceDesc') : t('channel.createDesc')} {activeServer?.name}</p>
            <div className="channel-type-toggle">
              <button className={`channel-type-btn ${newChannelType === 'text' ? 'active' : ''}`} type="button" onClick={() => setNewChannelType('text')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 9h16M4 15h16M7 3l-2 18M17 3l-2 18"/></svg>
                {t('channel.typeText')}
              </button>
              <button className={`channel-type-btn ${newChannelType === 'voice' ? 'active' : ''}`} type="button" onClick={() => setNewChannelType('voice')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
                {t('channel.typeVoice')}
              </button>
            </div>
            <form onSubmit={createChannel}>
              <div className="field">
                <label>{t('channel.name')}</label>
                <input type="text" placeholder={newChannelType === 'voice' ? 'general' : 'new-channel'} value={newChannelName} onChange={e => setNewChannelName(e.target.value.replace(/\s/g, '-').replace(/-{2,}/g, '-').toLowerCase())} onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); const input = e.target; const pos = input.selectionStart; const v = newChannelName; const nv = v.slice(0, pos) + '-' + v.slice(pos); if (!nv.includes('--')) { setNewChannelName(nv); setTimeout(() => input.setSelectionRange(pos + 1, pos + 1), 0) } } }} autoFocus required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn-cancel" onClick={() => { setShowCreateChannel(false); setNewChannelType('text') }}>{t('common.cancel')}</button>
                <button type="submit" className="btn-submit">{t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showCreateVoiceChannel && (
        <div className="modal-overlay" onClick={() => setShowCreateVoiceChannel(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>{t('channel.createVoice')}</h3>
            <p>{t('channel.createVoiceDesc')} {activeServer?.name}</p>
            <form onSubmit={createVoiceChannel}>
              <div className="field">
                <label>{t('channel.name')}</label>
                <input type="text" placeholder="general" value={newVoiceChannelName} onChange={e => setNewVoiceChannelName(e.target.value.replace(/\s/g, '-').replace(/-{2,}/g, '-').toLowerCase())} autoFocus required />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn-cancel" onClick={() => setShowCreateVoiceChannel(false)}>{t('common.cancel')}</button>
                <button type="submit" className="btn-submit">{t('common.create')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Server settings modal */}
      {showServerSettings && activeServer && (() => {
        const isOwner = activeServer.ownerId === user.id
        const myMember = members.find(m => m.id === user.id)
        const isAdmin = myMember?.role === 'admin'
        const perms = activeServer.adminPermissions || {}
        const canManageRoles = isOwner || (isAdmin && perms.manageRoles)
        return (
        <div className="modal-overlay" onClick={() => { setShowServerSettings(false); setServerSettingsTab('general'); setMemberSearchQuery('') }}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <button className="settings-close" onClick={() => { setShowServerSettings(false); setServerSettingsTab('general'); setMemberSearchQuery('') }}>&times;</button>
            <div className="settings-layout">
              <div className="settings-sidebar">
                <div className="settings-sidebar-title">{activeServer.name}</div>
                <button className={`settings-nav-item ${serverSettingsTab === 'general' ? 'active' : ''}`} onClick={() => setServerSettingsTab('general')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                  {t('serverSettings.general')}
                </button>
                <button className={`settings-nav-item ${serverSettingsTab === 'members' ? 'active' : ''}`} onClick={() => setServerSettingsTab('members')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>
                  {t('serverSettings.members')}
                </button>
                {isOwner && (
                  <button className={`settings-nav-item ${serverSettingsTab === 'roles' ? 'active' : ''}`} onClick={() => setServerSettingsTab('roles')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
                    {t('serverSettings.roles') || 'Роли'}
                  </button>
                )}
                {isOwner && (
                  <button className={`settings-nav-item ${serverSettingsTab === 'permissions' ? 'active' : ''}`} onClick={() => setServerSettingsTab('permissions')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                    {t('serverSettings.permissions')}
                  </button>
                )}
                {isOwner && (
                  <button className={`settings-nav-item ${serverSettingsTab === 'emojis' ? 'active' : ''}`} onClick={() => setServerSettingsTab('emojis')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                    Эмодзи
                    {(activeServer.boostLevel > 0) && <span className="nav-badge-boost">🔥</span>}
                  </button>
                )}
              </div>
              <div className="settings-content">
                {serverSettingsTab === 'general' && (
                  <div>
                    <h3>{t('serverSettings.generalTitle')}</h3>
                    {isOwner && (
                      <div className="srv-avatar-settings-row" style={{ marginBottom: 20 }}>
                        <div className="srv-settings-avatar-wrap" onClick={() => document.getElementById('srv-avatar-input').click()} title="Сменить аватар сервера">
                          {activeServer.avatar
                            ? <img src={activeServer.avatar} alt="" className="srv-settings-avatar-img" />
                            : <span className="srv-settings-avatar-text">{activeServer.iconText}</span>}
                          <div className="srv-settings-avatar-overlay"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></div>
                          <input id="srv-avatar-input" type="file" accept="image/*" style={{ display: 'none' }} onChange={e => {
                            const file = e.target.files?.[0]
                            if (!file) return
                            if (file.size > 10 * 1024 * 1024) return
                            const reader = new FileReader()
                            reader.onload = () => {
                              const img = new Image()
                              img.onload = () => {
                                const bW = 300 * img.width / img.height
                                const initScale = Math.max(1, 220 / bW, 220 / 300)
                                setServerCropScale(initScale); setServerCropOffset({ x: 0, y: 0 })
                                setServerAvatarCropModal({ imgSrc: reader.result, imgEl: img })
                              }
                              img.src = reader.result
                            }
                            reader.readAsDataURL(file)
                            e.target.value = ''
                          }} />
                        </div>
                        <div className="srv-settings-avatar-info">
                          <span style={{ fontWeight: 600, fontSize: '.9rem' }}>Аватар сервера</span>
                          <span style={{ fontSize: '.8rem', color: 'var(--text-muted)' }}>PNG, JPG до 10 МБ</span>
                          {activeServer.avatar && (
                            <button type="button" className="profile-avatar-remove" onClick={async () => {
                              try {
                                await API(`/api/servers/${activeServer.id}/avatar`, { method: 'DELETE' })
                                setServers(prev => prev.map(s => s.id === activeServer.id ? { ...s, avatar: null } : s))
                                setActiveServer(prev => prev ? { ...prev, avatar: null } : prev)
                              } catch {}
                            }}>Удалить аватар</button>
                          )}
                        </div>
                      </div>
                    )}
                    <form onSubmit={async (e) => {
                      e.preventDefault()
                      try {
                        const updated = await API(`/api/servers/${activeServer.id}`, { method: 'PUT', body: JSON.stringify({ name: serverSettingsName }) })
                        setServers(prev => prev.map(s => s.id === updated.id ? { ...s, ...updated } : s))
                        setActiveServer(prev => prev && prev.id === updated.id ? { ...prev, ...updated } : prev)
                        setShowServerSettings(false)
                        setServerSettingsTab('general')
                      } catch {}
                    }}>
                      <div className="field">
                        <label>{t('server.name')}</label>
                        <input type="text" value={serverSettingsName} onChange={e => setServerSettingsName(e.target.value)} autoFocus required />
                      </div>
                      <div className="settings-info">
                        <div className="settings-info-row">
                          <span className="settings-label">{t('server.id')}</span>
                          <span className="settings-value copyable" onClick={() => navigator.clipboard.writeText(activeServer.id)}>{activeServer.id}</span>
                        </div>
                        <div className="settings-info-row">
                          <span className="settings-label">{t('server.owner')}</span>
                          <span className="settings-value">{isOwner ? t('server.ownerYou') : t('server.ownerOther')}</span>
                        </div>
                      </div>
                      {isOwner && <div className="modal-actions"><button type="submit" className="btn-submit">{t('common.save')}</button></div>}
                    </form>

                    {/* Boost level block */}
                    {(() => {
                      const lvl = activeServer.boostLevel ?? 0
                      const cnt = activeServer.boostCount ?? 0
                      const thresholds = [0, 5, 15, 30]
                      const nextThreshold = thresholds[lvl + 1] ?? 30
                      const prevThreshold = thresholds[lvl] ?? 0
                      const progress = lvl >= 3 ? 100 : Math.round((cnt - prevThreshold) / (nextThreshold - prevThreshold) * 100)
                      const levelColors = ['#64748b', '#f59e0b', '#a855f7', '#ec4899']
                      const levelNames = ['Нет', 'Уровень 1', 'Уровень 2', 'Уровень 3']
                      return (
                        <div className="srv-boost-section">
                          <div className="srv-boost-header">
                            <span className="srv-boost-title">🔥 Буст сервера</span>
                            <span className="srv-boost-level-badge" style={{ background: levelColors[lvl] }}>
                              {levelNames[lvl]}
                            </span>
                          </div>
                          <div className="srv-boost-bar-wrap">
                            <div className="srv-boost-bar">
                              <div className="srv-boost-bar-fill" style={{ width: `${progress}%`, background: levelColors[Math.min(lvl + 1, 3)] }} />
                            </div>
                            <span className="srv-boost-bar-label">
                              {lvl >= 3 ? `${cnt} голосов — максимальный уровень! 🎉` : `${cnt} / ${nextThreshold} голосов до Уровня ${lvl + 1}`}
                            </span>
                          </div>
                          <div className="srv-boost-perks">
                            {[
                              { lvl: 1, perks: ['Кастомные эмодзи', 'Голосовые каналы 720p'] },
                              { lvl: 2, perks: ['Больше слотов эмодзи', 'Голос 1080p', 'Баннер сервера'] },
                              { lvl: 3, perks: ['Максимум эмодзи', 'Голос 1440p (2K)', 'Кастомный URL сервера'] },
                            ].map(({ lvl: pl, perks }) => (
                              <div key={pl} className={`srv-boost-perk-row ${lvl >= pl ? 'unlocked' : 'locked'}`}>
                                <span className="srv-boost-perk-lvl" style={{ color: levelColors[pl] }}>{'🔥'.repeat(pl)}</span>
                                <span className="srv-boost-perk-list">{perks.join(' · ')}</span>
                                {lvl >= pl && <span className="srv-boost-perk-check">✓</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })()}
                  </div>
                )}
                {serverSettingsTab === 'members' && (
                  <div>
                    <h3>{t('serverSettings.members')} — {members.length}</h3>
                    <div className="srv-members-search">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                      <input type="text" placeholder={t('serverSettings.searchMembers')} value={memberSearchQuery} onChange={e => setMemberSearchQuery(e.target.value)} />
                    </div>
                    <div className="srv-members-list">
                      {members.filter(m => !memberSearchQuery || m.username.toLowerCase().includes(memberSearchQuery.toLowerCase())).map(m => {
                        const mRole = activeServer.ownerId === m.id ? 'owner' : (m.role || 'user')
                        const customRole = (activeServer.customRoles || []).find(r => r.id === mRole)
                        const roleName = mRole === 'owner' ? t('role.owner') : mRole === 'admin' ? t('role.admin') : customRole ? customRole.name : t('role.member')
                        return (
                          <div key={m.id} className="srv-member-row">
                            <div className="srv-member-avatar" style={{ background: m.avatarColor }}><AImg src={m.avatar} />{m.username[0].toUpperCase()}</div>
                            <div className="srv-member-info">
                              <span className="srv-member-name" style={{ color: getMemberRoleColor(m.id) || undefined }}>{m.username}<span className="user-tag">#{m.tag || '0000'}</span></span>
                              <span className={`role-badge role-${mRole}`} style={customRole ? { color: customRole.color } : undefined}>{roleName}</span>
                            </div>
                            {canManageRoles && m.id !== user.id && mRole !== 'owner' && (
                              <div className="srv-role-selector">
                                <button type="button" className="srv-role-current" style={customRole ? { borderColor: customRole.color, color: customRole.color } : undefined} onClick={() => setRoleAssignMember(prev => prev === m.id ? null : m.id)}>
                                  {roleName}
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                                </button>
                                {roleAssignMember === m.id && (
                                  <>
                                    <div className="srv-role-dropdown-backdrop" onClick={() => setRoleAssignMember(null)} />
                                    <div className="srv-role-dropdown">
                                      {['user', 'admin', ...(activeServer.customRoles || []).map(r => r.id)].map(r => {
                                        const cr = (activeServer.customRoles || []).find(cr => cr.id === r)
                                        const label = r === 'admin' ? t('role.admin') : r === 'user' ? t('role.member') : cr?.name
                                        return (
                                          <button key={r} type="button" className={`srv-role-option ${mRole === r ? 'active' : ''}`} style={cr ? { color: cr.color } : undefined} onClick={async () => {
                                            setRoleAssignMember(null)
                                            if (mRole === r) return
                                            try {
                                              await API(`/api/servers/${activeServer.id}/members/${m.id}/role`, { method: 'POST', body: JSON.stringify({ role: r }) })
                                              setMembers(prev => prev.map(mm => mm.id === m.id ? { ...mm, role: r } : mm))
                                            } catch {}
                                          }}>
                                            {mRole === r && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                                            {label}
                                          </button>
                                        )
                                      })}
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                {serverSettingsTab === 'roles' && isOwner && (
                  <div>
                    <h3>{t('serverSettings.rolesTitle') || 'Кастомные роли'}</h3>
                    <p className="perms-desc">{t('serverSettings.rolesDesc') || 'Создавайте роли с индивидуальными правами и назначайте их участникам.'}</p>
                    {!editingRole ? (
                      <>
                        <button className="btn-submit" style={{ marginBottom: 16 }} onClick={() => setEditingRole({ name: '', permissions: {}, color: '#99aab5' })}>
                          + {t('serverSettings.createRole') || 'Создать роль'}
                        </button>
                        <div className="srv-members-list">
                          {(activeServer.customRoles || []).map(role => (
                            <div key={role.id} className="srv-member-row" style={{ cursor: 'pointer' }} onClick={() => setEditingRole({ ...role })}>
                              <div className="srv-member-avatar" style={{ background: role.color, width: 32, height: 32, fontSize: '.8rem' }}>
                                {role.name[0]?.toUpperCase()}
                              </div>
                              <div className="srv-member-info">
                                <span className="srv-member-name" style={{ color: role.color }}>{role.name}</span>
                                <span style={{ fontSize: '.75rem', color: 'var(--text-secondary)' }}>
                                  {members.filter(m => m.role === role.id).length} {t('members.title')?.toLowerCase() || 'участников'}
                                </span>
                              </div>
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2"><path d="M9 18l6-6-6-6"/></svg>
                            </div>
                          ))}
                          {(activeServer.customRoles || []).length === 0 && (
                            <p style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 20 }}>{t('serverSettings.noRoles') || 'Нет кастомных ролей'}</p>
                          )}
                        </div>
                      </>
                    ) : (
                      <div>
                        <button className="btn-cancel" style={{ marginBottom: 12 }} onClick={() => setEditingRole(null)}>
                          ← {t('common.back') || 'Назад'}
                        </button>
                        <div className="field">
                          <label>{t('serverSettings.roleName') || 'Название роли'}</label>
                          <input type="text" value={editingRole.name} onChange={e => setEditingRole(prev => ({ ...prev, name: e.target.value }))} placeholder={t('serverSettings.roleNamePlaceholder') || 'Модератор'} autoFocus />
                        </div>
                        <div className="field">
                          <label>{t('serverSettings.roleColor') || 'Цвет роли'}</label>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input type="color" value={editingRole.color} onChange={e => setEditingRole(prev => ({ ...prev, color: e.target.value }))} style={{ width: 40, height: 32, border: 'none', background: 'none', cursor: 'pointer' }} />
                            <span style={{ color: editingRole.color, fontWeight: 600 }}>{editingRole.name || '...'}</span>
                          </div>
                        </div>
                        <h4 style={{ margin: '16px 0 8px' }}>{t('serverSettings.rolePerms') || 'Права роли'}</h4>
                        {[
                          { key: 'deleteMessages', label: t('perm.deleteMessages') },
                          { key: 'deleteChannels', label: t('perm.deleteChannels') },
                          { key: 'createChannels', label: t('perm.createChannels') },
                          { key: 'kickMembers', label: t('perm.kickMembers') },
                          { key: 'manageRoles', label: t('perm.manageRoles') },
                          { key: 'clearChannel', label: t('perm.clearChannel') || 'Очищать каналы' },
                          { key: 'bypassSlowmode', label: t('perm.bypassSlowmode') },
                        ].map(p => (
                          <div key={p.key} className="perm-toggle-row">
                            <div className="perm-toggle-info"><div className="perm-toggle-label">{p.label}</div></div>
                            <label className="toggle-switch">
                              <input type="checkbox" checked={!!editingRole.permissions?.[p.key]} onChange={e => setEditingRole(prev => ({ ...prev, permissions: { ...prev.permissions, [p.key]: e.target.checked } }))} />
                              <span className="toggle-slider" />
                            </label>
                          </div>
                        ))}
                        <div className="modal-actions" style={{ marginTop: 16 }}>
                          {editingRole.id && (
                            <button className="btn-cancel" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} onClick={async () => {
                              try {
                                await API(`/api/servers/${activeServer.id}/roles/${editingRole.id}`, { method: 'DELETE' })
                                setActiveServer(prev => prev ? { ...prev, customRoles: (prev.customRoles || []).filter(r => r.id !== editingRole.id) } : prev)
                                setServers(prev => prev.map(s => s.id === activeServer.id ? { ...s, customRoles: (s.customRoles || []).filter(r => r.id !== editingRole.id) } : s))
                                setMembers(prev => prev.map(m => m.role === editingRole.id ? { ...m, role: 'user' } : m))
                              } catch {}
                              setEditingRole(null)
                            }}>{t('common.delete') || 'Удалить'}</button>
                          )}
                          <button className="btn-submit" disabled={!editingRole.name.trim()} onClick={async () => {
                            try {
                              if (editingRole.id) {
                                await API(`/api/servers/${activeServer.id}/roles/${editingRole.id}`, { method: 'PUT', body: JSON.stringify({ name: editingRole.name, permissions: editingRole.permissions, color: editingRole.color }) })
                                // Role list will be updated via server-roles-updated socket event
                              } else {
                                await API(`/api/servers/${activeServer.id}/roles`, { method: 'POST', body: JSON.stringify({ name: editingRole.name, permissions: editingRole.permissions, color: editingRole.color }) })
                                // Role list will be updated via server-roles-updated socket event
                              }
                            } catch {}
                            setEditingRole(null)
                          }}>{t('common.save') || 'Сохранить'}</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {serverSettingsTab === 'emojis' && isOwner && (() => {
                  const lvl = activeServer.boostLevel ?? 0
                  const limits = [0, 10, 25, 50]
                  const limit = limits[lvl]
                  const usedCount = serverSettingsEmojis.length
                  return (
                    <div>
                      <h3>Кастомные эмодзи</h3>
                      {lvl === 0 ? (
                        <div className="emojis-locked">
                          <div className="emojis-locked-icon">🔒</div>
                          <div className="emojis-locked-title">Нужен Буст Уровня 1</div>
                          <div className="emojis-locked-desc">Кастомные эмодзи разблокируются при 5+ голосах (Уровень 1). Текущий уровень сервера: 0.</div>
                        </div>
                      ) : (
                        <>
                          <div className="emojis-info">
                            <span>Слоты: <strong>{usedCount}/{limit}</strong></span>
                            <span style={{ color: 'var(--text-muted)', fontSize: '.8rem' }}>🔥 Уровень {lvl} — {limit} эмодзи</span>
                          </div>
                          {usedCount < limit && (
                            <div className="emoji-upload-row">
                              <input
                                ref={emojiUploadRef}
                                type="file"
                                accept="image/png,image/gif,image/webp,image/jpeg"
                                style={{ display: 'none' }}
                                onChange={async e => {
                                  const file = e.target.files?.[0]
                                  if (!file) return
                                  if (!emojiUploadName.trim() || !/^[a-zA-Z0-9_]{2,32}$/.test(emojiUploadName.trim())) {
                                    alert('Введи корректное имя (2-32 символа, только буквы, цифры, _)')
                                    e.target.value = ''
                                    return
                                  }
                                  setEmojiUploading(true)
                                  try {
                                    const fd = new FormData()
                                    fd.append('image', file)
                                    fd.append('name', emojiUploadName.trim())
                                    const res = await fetch(`/api/servers/${activeServer.id}/emojis`, {
                                      method: 'POST',
                                      headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
                                      body: fd
                                    })
                                    if (!res.ok) { const err = await res.json(); alert(err.error); return }
                                    const emoji = await res.json()
                                    setServerSettingsEmojis(prev => [...prev, emoji])
                                    setServerCustomEmojis(prev => [...prev, emoji])
                                    setEmojiUploadName('')
                                  } catch (err) { alert(err.message) }
                                  finally { setEmojiUploading(false); e.target.value = '' }
                                }}
                              />
                              <input
                                type="text"
                                className="emoji-name-input"
                                placeholder="Имя эмодзи (a-z, 0-9, _)"
                                value={emojiUploadName}
                                onChange={e => setEmojiUploadName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                                maxLength={32}
                              />
                              <button
                                type="button"
                                className="btn-submit emoji-upload-btn"
                                disabled={emojiUploading || !emojiUploadName.trim()}
                                onClick={() => emojiUploadRef.current?.click()}
                              >
                                {emojiUploading ? 'Загрузка...' : '+ Добавить'}
                              </button>
                            </div>
                          )}
                          <div className="srv-emojis-grid">
                            {serverSettingsEmojis.length === 0 && (
                              <div style={{ color: 'var(--text-muted)', fontSize: '.85rem', padding: '12px 0' }}>Эмодзи ещё не добавлены. Загрузи первый!</div>
                            )}
                            {serverSettingsEmojis.map(emoji => (
                              <div key={emoji.id} className="srv-emoji-item">
                                <img src={emoji.url} alt={emoji.name} className="srv-emoji-item-img" />
                                <span className="srv-emoji-item-name">:{emoji.name}:</span>
                                <button
                                  type="button"
                                  className="srv-emoji-item-del"
                                  title="Удалить"
                                  onClick={async () => {
                                    try {
                                      await API(`/api/servers/${activeServer.id}/emojis/${emoji.id}`, { method: 'DELETE' })
                                      setServerSettingsEmojis(prev => prev.filter(e => e.id !== emoji.id))
                                      setServerCustomEmojis(prev => prev.filter(e => e.id !== emoji.id))
                                    } catch {}
                                  }}
                                >
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
                                </button>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )
                })()}

                {serverSettingsTab === 'permissions' && isOwner && (
                  <div>
                    <h3>{t('serverSettings.permissionsTitle')}</h3>
                    <p className="perms-desc">{t('serverSettings.permissionsDesc')}</p>
                    {[
                      { key: 'deleteMessages', label: t('perm.deleteMessages'), desc: t('perm.deleteMessagesDesc') },
                      { key: 'deleteChannels', label: t('perm.deleteChannels'), desc: t('perm.deleteChannelsDesc') },
                      { key: 'createChannels', label: t('perm.createChannels'), desc: t('perm.createChannelsDesc') },
                      { key: 'kickMembers', label: t('perm.kickMembers'), desc: t('perm.kickMembersDesc') },
                      { key: 'manageRoles', label: t('perm.manageRoles'), desc: t('perm.manageRolesDesc') },
                      { key: 'clearChannel', label: t('perm.clearChannel') || 'Очищать каналы', desc: t('perm.clearChannelDesc') || 'Админы смогут очищать все сообщения в каналах' },
                      { key: 'bypassSlowmode', label: t('perm.bypassSlowmode'), desc: t('perm.bypassSlowmodeDesc') },
                    ].map(p => (
                      <div key={p.key} className="perm-toggle-row">
                        <div className="perm-toggle-info">
                          <div className="perm-toggle-label">{p.label}</div>
                          <div className="perm-toggle-desc">{p.desc}</div>
                        </div>
                        <label className="toggle-switch">
                          <input type="checkbox" checked={!!perms[p.key]} onChange={async (e) => {
                            const newPerms = { ...perms, [p.key]: e.target.checked }
                            try {
                              await API(`/api/servers/${activeServer.id}/permissions`, { method: 'PUT', body: JSON.stringify(newPerms) })
                              setActiveServer(prev => prev ? { ...prev, adminPermissions: newPerms } : prev)
                              setServers(prev => prev.map(s => s.id === activeServer.id ? { ...s, adminPermissions: newPerms } : s))
                            } catch {}
                          }} />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        )
      })()}

      {/* Channel settings modal */}
      {showChannelSettings && (
        <div className="modal-overlay" onClick={() => setShowChannelSettings(null)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <h3>{t('channel.settings')} {showChannelSettings.type === 'voice' ? '🔊' : '#'}{showChannelSettings.name}</h3>
            <div className="settings-tabs">
              <button className={`settings-tab ${channelSettingsTab === 'general' ? 'active' : ''}`} onClick={() => setChannelSettingsTab('general')}>{t('chSettings.general')}</button>
              <button className={`settings-tab ${channelSettingsTab === 'permissions' ? 'active' : ''}`} onClick={() => setChannelSettingsTab('permissions')}>{t('chSettings.permissions')}</button>
              {showChannelSettings.type !== 'voice' && (
                <button className={`settings-tab ${channelSettingsTab === 'slowmode' ? 'active' : ''}`} onClick={() => setChannelSettingsTab('slowmode')}>{t('chSettings.slowmode')}</button>
              )}
            </div>

            {channelSettingsTab === 'general' && (
              <div className="settings-tab-content">
                <div className="field">
                  <label>{t('channel.name')}</label>
                  <input type="text" value={channelSettingsName} onChange={e => setChannelSettingsName(e.target.value.replace(/\s/g, '-').replace(/-{2,}/g, '-').toLowerCase())} onKeyDown={e => { if (e.key === ' ') { e.preventDefault(); const input = e.target; const pos = input.selectionStart; const v = channelSettingsName; const nv = v.slice(0, pos) + '-' + v.slice(pos); if (!nv.includes('--')) { setChannelSettingsName(nv); setTimeout(() => input.setSelectionRange(pos + 1, pos + 1), 0) } } }} autoFocus />
                </div>
                <div className="settings-info">
                  <div className="settings-info-row">
                    <span className="settings-label">{t('chSettings.channelId')}</span>
                    <span className="settings-value copyable" onClick={() => navigator.clipboard.writeText(showChannelSettings.id)}>{showChannelSettings.id}</span>
                  </div>
                </div>
              </div>
            )}

            {channelSettingsTab === 'permissions' && (
              <div className="settings-tab-content">
                <div className="perm-section">
                  <div className="perm-toggle-row">
                    <span>{t('chSettings.private')}</span>
                    <label className="toggle-switch">
                      <input type="checkbox" checked={chPrivate} onChange={e => setChPrivate(e.target.checked)} />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                  <p className="perm-hint">{t('chSettings.privateHint')}</p>
                </div>

                {chPrivate && (
                  <div className="perm-section">
                    <label className="perm-section-title">{t('chSettings.access')}</label>
                    <div className="perm-user-list">
                      {members.map(m => (
                        <label key={m.id} className="perm-user-row">
                          <input type="checkbox" checked={chAllowedUsers.includes(m.id)} onChange={e => {
                            if (e.target.checked) setChAllowedUsers(prev => [...prev, m.id])
                            else setChAllowedUsers(prev => prev.filter(id => id !== m.id))
                          }} />
                          <div className="perm-user-avatar" style={{ background: m.avatarColor }}><AImg src={m.avatar} />{m.username[0].toUpperCase()}</div>
                          <span>{m.username}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <div className="perm-section">
                  <label className="perm-section-title">{t('chSettings.rolePerms')}</label>
                  <div className="perm-grid">
                    <div className="perm-grid-header">
                      <span>{t('chSettings.action')}</span>
                      <span>{t('chSettings.userRole')}</span>
                      <span>{t('chSettings.adminRole')}</span>
                    </div>
                    {[
                      { key: 'viewChannel', label: t('chSettings.viewChannel') },
                      { key: 'sendMessages', label: t('chSettings.sendMessages') },
                      { key: 'sendMedia', label: t('chSettings.sendMedia') },
                      { key: 'invite', label: t('chSettings.invites') },
                    ].map(perm => (
                      <div key={perm.key} className="perm-grid-row">
                        <span>{perm.label}</span>
                        <label className="toggle-switch small">
                          <input type="checkbox" checked={chPermissions.user?.[perm.key] !== false} onChange={e => setChPermissions(prev => ({ ...prev, user: { ...prev.user, [perm.key]: e.target.checked } }))} />
                          <span className="toggle-slider" />
                        </label>
                        <label className="toggle-switch small">
                          <input type="checkbox" checked={chPermissions.admin?.[perm.key] !== false} onChange={e => setChPermissions(prev => ({ ...prev, admin: { ...prev.admin, [perm.key]: e.target.checked } }))} />
                          <span className="toggle-slider" />
                        </label>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {channelSettingsTab === 'slowmode' && (
              <div className="settings-tab-content">
                <p className="perm-hint">{t('chSettings.slowmodeHint')}</p>
                <div className="slowmode-options">
                  {[
                    { value: 0, label: t('slowmode.off') },
                    { value: 5, label: t('slowmode.5s') },
                    { value: 10, label: t('slowmode.10s') },
                    { value: 15, label: t('slowmode.15s') },
                    { value: 30, label: t('slowmode.30s') },
                    { value: 60, label: t('slowmode.1m') },
                    { value: 600, label: t('slowmode.10m') },
                    { value: 1800, label: t('slowmode.30m') },
                    { value: 3600, label: t('slowmode.1h') },
                    { value: 7200, label: t('slowmode.2h') },
                    { value: 86400, label: t('slowmode.24h') },
                  ].map(opt => (
                    <button key={opt.value} className={`slowmode-btn ${chSlowmode === opt.value ? 'active' : ''} ${opt.value === 0 ? 'off' : ''}`} onClick={() => setChSlowmode(opt.value)} type="button">
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="btn-cancel" onClick={() => setShowChannelSettings(null)}>{t('common.cancel')}</button>
              {activeServer && activeServer.ownerId === user.id && (
                <button type="button" className="btn-danger" onClick={() => { deleteChannel(showChannelSettings); setShowChannelSettings(null) }}>{t('channel.deleteBtn')}</button>
              )}
              <button type="button" className="btn-submit" onClick={async () => {
                try {
                  const body = { name: channelSettingsName, isPrivate: chPrivate, allowedUsers: chAllowedUsers, permissions: chPermissions, slowmode: chSlowmode }
                  const updated = await API(`/api/channels/${showChannelSettings.id}`, { method: 'PUT', body: JSON.stringify(body) })
                  setChannels(prev => prev.map(c => c.id === updated.id ? { ...c, ...updated } : c))
                  setActiveChannel(prev => prev && prev.id === updated.id ? { ...prev, ...updated } : prev)
                  setShowChannelSettings(null)
                } catch {}
              }}>{t('common.save')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Invite modal */}
      {showInviteModal && (
        <div className="modal-overlay" onClick={() => setShowInviteModal(null)}>
          <div className="modal modal-invite" onClick={e => e.stopPropagation()}>
            <h3>{t('invite.title')}</h3>
            <p>{t('invite.desc')} «{showInviteModal.serverName}»</p>
            <div className="invite-friends-list">
              {friends.length === 0 ? (
                <div className="invite-empty">{t('invite.noFriends')}</div>
              ) : friends.map(f => {
                const alreadyMember = (showInviteModal.memberIds || []).includes(f.id)
                return (
                <div key={f.id} className="invite-friend-item">
                  <div className="invite-friend-left">
                    <div className="member-avatar" style={{ background: f.avatarColor }}>
                      <AImg src={f.avatar} />
                      {f.username[0].toUpperCase()}
                      <div className={`status-dot ${f.status}`} />
                    </div>
                    <span className="invite-friend-name">{f.username}<span className="user-tag">#{f.tag}</span></span>
                  </div>
                  {alreadyMember ? (
                    <span className="invite-already-member">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                      {t('invite.alreadyOnServer')}
                    </span>
                  ) : (
                    <button
                      className={`btn-invite ${inviteSending[f.id] === 'done' ? 'sent' : ''}`}
                      disabled={!!inviteSending[f.id]}
                      onClick={() => sendInvite(showInviteModal.serverId, f.id)}
                    >
                      {inviteSending[f.id] === 'done' ? t('invite.sent') : inviteSending[f.id] === true ? '...' : inviteSending[f.id] === 'error' ? t('invite.alreadyMember') : t('invite.send')}
                    </button>
                  )}
                </div>
                )
              })}
            </div>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setShowInviteModal(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Voice invite modal */}
      {showVoiceInviteModal && (
        <div className="modal-overlay" onClick={() => setShowVoiceInviteModal(null)}>
          <div className="modal modal-invite" onClick={e => e.stopPropagation()}>
            <h3>{t('voice.invite')}</h3>
            <p>{t('voice.inviteDesc')} «{showVoiceInviteModal.channelName}»</p>
            <div className="invite-friends-list">
              {friends.length === 0 ? (
                <div className="invite-empty">{t('invite.noFriends')}</div>
              ) : friends.map(f => (
                <div key={f.id} className="invite-friend-item">
                  <div className="invite-friend-left">
                    <div className="member-avatar" style={{ background: f.avatarColor }}>
                      <AImg src={f.avatar} />
                      {f.username[0].toUpperCase()}
                      <div className={`status-dot ${f.status}`} />
                    </div>
                    <span className="invite-friend-name">{f.username}<span className="user-tag">#{f.tag}</span></span>
                  </div>
                  <button
                    className={`btn-invite ${voiceInviteSending[f.id] === 'done' ? 'sent' : ''}`}
                    disabled={!!voiceInviteSending[f.id]}
                    onClick={() => sendVoiceInvite(showVoiceInviteModal.channelId, f.id)}
                  >
                    {voiceInviteSending[f.id] === 'done' ? t('invite.sent') : voiceInviteSending[f.id] === true ? '...' : t('invite.send')}
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn-cancel" onClick={() => setShowVoiceInviteModal(null)}>{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      {reactionPickerMsg && (
        <div className="reaction-picker-fixed" ref={reactionPickerRef} style={{ left: reactionPickerMsg.x, top: reactionPickerMsg.y }}>
          <div className="emoji-picker-search"><input type="text" placeholder={t('emoji.search')} value={reactionSearch} onChange={e => setReactionSearch(e.target.value)} autoFocus /></div>
          <div className="emoji-picker-cats">
            {Object.entries(emojiData).map(([key, cat]) => (
              <button key={key} className={`emoji-cat-btn ${reactionCategory === key ? 'active' : ''}`} onClick={() => setReactionCategory(key)}>{cat.icon}</button>
            ))}
          </div>
          <div className="emoji-picker-grid">
            {(reactionSearch ? Object.values(emojiData).flatMap(c => c.emojis) : emojiData[reactionCategory]?.emojis || []).filter(e => !reactionSearch || e.includes(reactionSearch)).map((emoji, i) => (
              <button key={i} className="emoji-item" onClick={() => toggleReaction(reactionPickerMsg.id, emoji, reactionPickerMsg.isDM)}>{emoji}</button>
            ))}
          </div>
        </div>
      )}

      {reactionUsersPopup && (
        <div className="reaction-users-popup" style={{ left: reactionUsersPopup.x, top: reactionUsersPopup.y }} onMouseDown={e => e.stopPropagation()}>
          <div className="reaction-users-header">
            <span className="reaction-users-emoji">{reactionUsersPopup.emoji}</span>
            <span className="reaction-users-count">{reactionUsersPopup.users.length}</span>
          </div>
          <div className="reaction-users-list">
            {reactionUsersPopup.users.map(u => (
              <div key={u.id} className="reaction-user-item">
                <div className="reaction-user-avatar" style={{ background: u.avatarColor }}><AImg src={u.avatar} />{u.username[0]?.toUpperCase()}</div>
                <span className="reaction-user-name">{u.username}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {confirmDialog && (
        <div className="modal-overlay confirm-overlay" onClick={() => setConfirmDialog(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="confirm-icon-wrap">
              <div className={`confirm-icon ${confirmDialog.danger ? 'danger' : ''}`}>
                {confirmDialog.danger ? (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                ) : (
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                )}
              </div>
            </div>
            <h3 className="confirm-title">{confirmDialog.title}</h3>
            <p className="confirm-message">{confirmDialog.message}</p>
            <div className="confirm-actions">
              <button className="btn-cancel" onClick={() => setConfirmDialog(null)}>{t('confirm.cancel')}</button>
              <button className={`btn-submit ${confirmDialog.danger ? 'btn-danger' : ''}`} onClick={confirmDialog.onConfirm}>{confirmDialog.confirmText}</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notifications */}
      <div className="toast-container">
        {toasts.map((toast, i) => (
          <div key={toast.id} className="toast-item" style={{ '--toast-i': i }} onClick={() => {
            if (toast.type === 'dm') {
              const dm = dmChannels.find(d => d.id === toast.dmChannelId)
              if (dm) { setActiveDM(dm); if (isMobile) setMobileInChat(true) }
            } else if (toast.type === 'channel') {
              const srv = servers.find(s => s.id === toast.serverId)
              if (srv) { setActiveServer(srv); setShowFriends(false); setActiveDM(null) }
              const ch = channels.find(c => c.id === toast.channelId) || { id: toast.channelId }
              setActiveChannel(ch); if (isMobile) setMobileInChat(true)
            }
            removeToast(toast.id)
          }}>
            <div className="toast-avatar" style={{ background: toast.avatarColor }}><AImg src={toast.avatar} />{toast.username[0].toUpperCase()}</div>
            <div className="toast-body">
              {toast.type === 'channel' && toast.serverName && (
                <span className="toast-location">{toast.serverName} › #{toast.channelName}</span>
              )}
              {toast.type === 'dm' && (
                <span className="toast-location">{t('nav.directMessages')}</span>
              )}
              <span className="toast-username">{toast.username}</span>
              <span className="toast-content">{toast.content.length > 80 ? toast.content.slice(0, 80) + '…' : toast.content}</span>
            </div>
            <button className="toast-close" onClick={(e) => { e.stopPropagation(); removeToast(toast.id) }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        ))}
      </div>

      {/* Mobile floating voice bar */}
      {voiceChannel && (
        <div className="mobile-voice-bar" onClick={() => { setVoiceViewChannel(voiceChannel); setActiveChannel(null); setMobileNav(false); setMobileInChat(true) }}>
          <div className="mobile-voice-bar-left">
            <div className="mobile-voice-signal">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#43b581" strokeWidth="2.5" strokeLinecap="round"><path d="M2 20h.01M7 17a5 5 0 013-4.5M12 14a9 9 0 015-8"/></svg>
            </div>
            <div className="mobile-voice-info">
              <span className="mobile-voice-connected">{t('voice.connected')}</span>
              <span className="mobile-voice-channel">{voiceChannel.name}</span>
            </div>
          </div>
          <div className="mobile-voice-bar-controls">
            <button className={`mobile-voice-btn ${voiceMuted ? 'off' : ''}`} onClick={(e) => { e.stopPropagation(); toggleVoiceMute() }}>
              {voiceMuted ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="5" y="1" width="6" height="10" rx="3"/><path d="M13 7v1a5 5 0 01-10 0V7"/><line x1="1" y1="1" x2="15" y2="15"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M19 10v2a7 7 0 01-14 0v-2"/></svg>
              )}
            </button>
            <button className="mobile-voice-btn disconnect" onClick={(e) => { e.stopPropagation(); leaveVoiceChannel() }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M16 2L21 7M21 2L16 7"/><path d="M2 22c2-4 5-6 10-6s8 2 10 6"/></svg>
            </button>
          </div>
        </div>
      )}

      {/* Mobile bottom navigation */}
      <div className={`mobile-bottom-nav ${mobileInChat && (activeDM || activeChannel || voiceViewChannel) ? 'mobile-nav-in-chat' : ''}`}>
        <button className={`mobile-nav-tab ${(mobileTab === 'home' || showFriends) && !activeServer ? 'active' : ''}`} onClick={() => { setMobileTab('home'); setShowFriends(true); setActiveServer(null); setActiveDM(null); setMobileInChat(false); setMobileNav(false) }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>{t('nav.home') || 'Главная'}</span>
          {(totalDMUnread + friendRequests.length) > 0 && <span className="mobile-nav-badge">{totalDMUnread + friendRequests.length}</span>}
        </button>
        <button className={`mobile-nav-tab ${mobileTab === 'notifications' ? 'active' : ''}`} onClick={() => { setMobileTab('notifications'); setShowFriends(true); setActiveDM(null); setActiveServer(null); setFriendsTab('pending'); setMobileInChat(true); setMobileNav(false) }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
          <span>{t('nav.notifications') || 'Уведомления'}</span>
          {friendRequests.length > 0 && <span className="mobile-nav-badge">{friendRequests.length}</span>}
        </button>
        <button className={`mobile-nav-tab ${mobileTab === 'profile' ? 'active' : ''}`} onClick={() => { setMobileTab('profile'); setShowProfileSettings(true) }}>
          <div className="mobile-nav-avatar" style={{ background: user.avatarColor }}>
            <AImg src={user.avatar} />
            {user.username?.[0]?.toUpperCase()}
          </div>
          <span>{t('nav.profile') || 'Вы'}</span>
        </button>
      </div>

      {/* Terms agreement popup for existing users */}
      {showTermsPopup && (
        <div className="terms-popup-overlay">
          <div className="terms-popup">
            {!showDeleteConfirm ? (
              <>
                <h2>Пользовательское соглашение</h2>
                <p>Для продолжения использования сервиса необходимо принять <a href="/terms" target="_blank" rel="noopener noreferrer">Пользовательское соглашение</a> и <a href="/privacy" target="_blank" rel="noopener noreferrer">Политику конфиденциальности</a>.</p>
                <div className="terms-popup-actions">
                  <button className="btn-submit" onClick={async () => {
                    try {
                      await API('/api/auth/agree-terms', { method: 'POST' })
                      setUser(prev => ({ ...prev, agreedToTerms: true }))
                      setShowTermsPopup(false)
                    } catch {}
                  }}>Принимаю</button>
                  <button className="btn-cancel" onClick={() => setShowDeleteConfirm(true)}>Не принимаю</button>
                </div>
              </>
            ) : (
              <>
                <h2>Удаление аккаунта</h2>
                <p>Без принятия соглашения использование сервиса невозможно. Вы можете удалить свой аккаунт — это действие необратимо.</p>
                <p style={{ marginTop: 12, fontSize: '.85rem', color: 'var(--text-muted)' }}>Для подтверждения введите <b>УДАЛИТЬ</b></p>
                <input
                  type="text"
                  className="terms-delete-input"
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder="УДАЛИТЬ"
                  autoFocus
                />
                <div className="terms-popup-actions">
                  <button className="btn-cancel" style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }} disabled={deleteConfirmText !== 'УДАЛИТЬ'} onClick={async () => {
                    try {
                      await API('/api/auth/account', { method: 'DELETE' })
                      logout()
                    } catch {}
                  }}>Удалить аккаунт навсегда</button>
                  <button className="btn-cancel" onClick={() => { setShowDeleteConfirm(false); setDeleteConfirmText('') }}>Назад</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Incoming DM call popup */}
      {incomingDmCall && (
        <div className="dm-incoming-call-overlay">
          <div className="dm-incoming-call-popup">
            <div className="dm-incoming-call-avatar" style={{ background: incomingDmCall.caller.avatarColor }}>
              <AImg src={incomingDmCall.caller.avatar} />
              {incomingDmCall.caller.username[0].toUpperCase()}
            </div>
            <div className="dm-incoming-call-info">
              <span className="dm-incoming-call-name">{incomingDmCall.caller.username}</span>
              <span className="dm-incoming-call-label">Входящий звонок...</span>
            </div>
            <div className="dm-incoming-call-actions">
              <button className="dm-incoming-reject" onClick={() => rejectDmCall(incomingDmCall.dmChannelId)}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.09 8.98 7.27 7 12 7s8.91 1.98 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg>
              </button>
              <button className="dm-incoming-accept" onClick={() => acceptDmCall(incomingDmCall.dmChannelId, incomingDmCall.caller)}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden container for WebRTC audio elements — positioned off-screen instead of display:none so browsers still play audio */}
      <div id="voice-audio-container" style={{ position: 'fixed', top: '-9999px', left: '-9999px', opacity: 0, pointerEvents: 'none' }} />
      {copyTooltip && <div className="copy-toast" style={{ left: copyTooltip.x, top: copyTooltip.y }}>{t('common.copied')}</div>}
      {/* Server drag ghost */}
      {srvDragState && (() => {
        const s = servers.find(x => x.id === srvDragState.id)
        const folderItem = effectiveLayout.find(item => item.type === 'folder' && item.folderId === srvDragState.id)
        return (
          <div className="srv-drag-ghost" style={{ left: srvDragPos.x - 24, top: srvDragPos.y - 24 }}>
            {folderItem ? (
              <div className="folder-mini-grid">
                {folderItem.serverIds.slice(0, 4).map(id => {
                  const fs = servers.find(x => x.id === id)
                  if (!fs) return null
                  return (
                    <div key={id} className="folder-mini-cell" style={{ background: fs.avatarColor }}>
                      {fs.avatar ? <img src={fs.avatar} className="folder-mini-img" alt="" /> : <span>{fs.iconText}</span>}
                    </div>
                  )
                })}
              </div>
            ) : s ? (
              s.avatar ? <img src={s.avatar} alt={s.name} className="server-icon-avatar" /> : <span>{s.iconText}</span>
            ) : null}
          </div>
        )
      })()}

      {voiceUserCtx && (
        <div className="voice-user-ctx-overlay" onClick={() => setVoiceUserCtx(null)} onContextMenu={e => { e.preventDefault(); setVoiceUserCtx(null) }}>
          <div className="voice-user-ctx" ref={voiceUserCtxRef} style={{ top: voiceUserCtx.y, left: voiceUserCtx.x }} onClick={e => e.stopPropagation()}>
            <div className="voice-user-ctx-header">
              <div className="voice-user-ctx-avatar" style={{ background: voiceUserCtx.user.avatarColor }}>{voiceUserCtx.user.username[0].toUpperCase()}</div>
              <span>{voiceUserCtx.user.username}</span>
            </div>
            <div className="voice-user-ctx-volume">
              <label>{t('voice.userVolume')}</label>
              <div className="voice-user-ctx-slider">
                <input type="range" min="0" max="200" value={userVolumes[voiceUserCtx.user.id] ?? 100} onChange={e => applyUserVolume(voiceUserCtx.user.id, +e.target.value)} />
                <span>{userVolumes[voiceUserCtx.user.id] ?? 100}%</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
