'use client'

import { useEffect, useId, useState, type CSSProperties, type FormEvent } from 'react'

import { defaultText, hatsApi, type HatsMenu, type HatsText } from './api.js'

const v = (name: string, fallback: string) => `var(--hats-${name}, ${fallback})`
const ink = v('ink', 'currentColor')
const line = v('line', 'color-mix(in srgb, currentColor 45%, transparent)')
// Muted text is the surrounding text color, slightly faded, so it keeps its contrast on light and dark pages.
const muted = v('muted', 'color-mix(in srgb, currentColor 78%, transparent)')

const s = {
  list: { listStyle: 'none', margin: '0 0 16px', padding: 0 } as CSSProperties,
  row: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: `1px solid ${line}` } as CSSProperties,
  note: { color: muted, fontSize: '0.9em', margin: '2px 0 0' } as CSSProperties,
  button: { font: 'inherit', color: ink, background: 'transparent', border: `1px solid ${line}`, borderRadius: 6, minHeight: 32, padding: '4px 12px', cursor: 'pointer' } as CSSProperties,
  input: { font: 'inherit', color: ink, background: 'transparent', border: `1px solid ${line}`, borderRadius: 4, padding: '4px 8px', minHeight: 32, minWidth: '16em' } as CSSProperties,
}

/**
 * The account-page section for linking: the accounts in your set and where each stands, a form to ask for another,
 * and unlinking (it ends any session switched through that account straight away).
 */
export function LinkedAccounts({ apiRoute = '/api', text, headingClassName }: { apiRoute?: string; text?: Partial<HatsText>; headingClassName?: string }) {
  const t = { ...defaultText, ...text }
  const api = hatsApi(apiRoute, t)
  const [menu, setMenu] = useState<HatsMenu | null>(null)
  const [email, setEmail] = useState('')
  const [said, setSaid] = useState('')
  const [busy, setBusy] = useState(false)
  const [unlinking, setUnlinking] = useState<string | number | null>(null)
  const id = useId()
  const reload = () => api.menu().then(setMenu)

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiRoute])

  if (!menu?.signedIn || !menu.canLink) return null
  const full = menu.set.length >= menu.maxLinked

  async function request(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    const res = await api.link(email.trim())
    setBusy(false)
    setSaid(res.message)
    if (res.ok) setEmail('')
    await reload()
  }

  async function unlink(account: string | number, you: boolean) {
    setBusy(true)
    const res = await api.unlink(account)
    setBusy(false)
    setUnlinking(null)
    if (res.ok && res.body.signedOut) return window.location.reload()
    setSaid(res.ok ? (you ? t.youUnlinked : t.unlinked) : res.message)
    await reload()
  }

  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className={headingClassName}>
        {t.linkedHeading}
      </h2>
      <p style={s.note}>{t.linkedIntro(menu.maxLinked)}</p>
      {menu.set.length ? (
        <ul style={s.list}>
          {menu.set.map((m) => (
            <li key={String(m.id)} style={s.row}>
              <div>
                <strong>{m.label}</strong>
                {m.you ? ` ${t.thisAccount}` : ''}
                <p style={s.note}>{t.status(m.status, m.you)}</p>
              </div>
              {unlinking === m.id ? (
                <div role="group" aria-label={t.unlinkAsk(m.label)}>
                  <span>{t.unlinkAsk(m.you ? null : m.label)} </span>
                  <button type="button" style={s.button} disabled={busy} onClick={() => void unlink(m.id, m.you)}>
                    {t.unlink}
                  </button>{' '}
                  <button type="button" style={s.button} onClick={() => setUnlinking(null)}>
                    {t.keep}
                  </button>
                </div>
              ) : (
                <button type="button" style={s.button} disabled={busy} onClick={() => setUnlinking(m.id)} aria-label={t.unlinkNamed(m.label)}>
                  {t.unlink}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {full ? (
        <p style={s.note}>{t.setFull}</p>
      ) : (
        <form onSubmit={(e) => void request(e)}>
          <label htmlFor={`${id}-email`} style={{ display: 'block', marginBottom: 6 }}>
            {t.emailLabel}
          </label>
          <input id={`${id}-email`} type="email" autoComplete="off" required style={s.input} value={email} onChange={(e) => setEmail(e.target.value)} />{' '}
          <button type="submit" style={s.button} disabled={busy || !email.trim()}>
            {t.send}
          </button>
        </form>
      )}
      <p role="status" style={s.note}>
        {said}
      </p>
    </section>
  )
}
