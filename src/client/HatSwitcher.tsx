'use client'

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'

import { defaultText, hatsApi, type HatsMenu, type HatsText, type MenuHat } from './api.js'

type Choice = { account?: string | number; accountLabel: string; hat: MenuHat }

const v = (name: string, fallback: string) => `var(--hats-${name}, ${fallback})`
const ink = v('ink', 'currentColor')
const paper = v('paper', 'var(--theme-elevation-0, Canvas)')
const line = v('line', 'color-mix(in srgb, currentColor 45%, transparent)')
// Muted text is the surrounding text color, slightly faded, so it keeps its contrast on light and dark pages.
const muted = v('muted', 'color-mix(in srgb, currentColor 78%, transparent)')
const focus = v('focus', '#b85c00')

const s = {
  wrap: { position: 'relative', display: 'inline-block', font: 'inherit', color: ink } as CSSProperties,
  button: { font: 'inherit', color: ink, background: paper, border: `1px solid ${line}`, borderRadius: 6, minHeight: 32, padding: '4px 10px', cursor: 'pointer' } as CSSProperties,
  panel: { position: 'absolute', insetInlineEnd: 0, top: 'calc(100% + 6px)', zIndex: 50, minWidth: 'min(90vw, 320px)', maxWidth: 'min(90vw, 380px)', background: paper, color: ink, border: `1px solid ${line}`, borderRadius: 8, padding: 12, boxShadow: '0 6px 24px rgb(0 0 0 / 0.18)', whiteSpace: 'normal', overflowWrap: 'anywhere', textAlign: 'start' } as CSSProperties,
  heading: { fontSize: '0.85em', fontWeight: 600, margin: '8px 0 4px', color: muted } as CSSProperties,
  list: { listStyle: 'none', margin: 0, padding: 0 } as CSSProperties,
  item: { font: 'inherit', whiteSpace: 'normal', overflowWrap: 'anywhere', color: ink, background: 'transparent', border: 0, borderRadius: 4, width: '100%', textAlign: 'start', padding: '6px 8px', minHeight: 32, cursor: 'pointer' } as CSSProperties,
  note: { fontSize: '0.85em', color: muted } as CSSProperties,
  input: { font: 'inherit', color: ink, background: paper, border: `1px solid ${line}`, borderRadius: 4, padding: '4px 8px', minHeight: 32, width: '9em', letterSpacing: '0.1em' } as CSSProperties,
  error: { color: v('error', '#b00020'), fontSize: '0.9em', margin: '6px 0 0' } as CSSProperties,
}
const focusRing = `.hats-switcher :focus-visible{outline:3px solid ${focus};outline-offset:2px}.hats-switcher [aria-current="true"]{font-weight:600}`

/**
 * The switch: which account and hat you're acting as, and the others you can switch to. Renders nothing for an
 * account with nothing to switch to. A sensitive choice asks for that account's code inline. Reloads after a switch.
 */
export function HatSwitcher({ apiRoute = '/api', onSwitched, text }: { apiRoute?: string; onSwitched?: () => void; text?: Partial<HatsText> }) {
  const t = { ...defaultText, ...text }
  const api = hatsApi(apiRoute, t)
  const [menu, setMenu] = useState<HatsMenu | null>(null)
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState<Choice | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const codeBox = useRef<HTMLInputElement>(null)
  const panelId = useId()

  useEffect(() => {
    void api.menu().then(setMenu)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiRoute])

  const close = useCallback(() => {
    setOpen(false)
    setAsking(null)
    setError('')
    setCode('')
    button.current?.focus()
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const onClick = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && close()
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClick)
    }
  }, [open, close])

  useEffect(() => {
    if (asking) codeBox.current?.focus()
  }, [asking])

  if (!menu?.signedIn || !menu.showSwitch) return null
  const current = menu.hats.find((h) => h.id === menu.hat) ?? menu.hats.at(-1)
  const signedInAs = String(menu.signedInAs) === String(menu.account.id) ? null : menu.linked.find((l) => String(l.id) === String(menu.signedInAs))

  async function go(choice: Choice, withCode?: string) {
    setBusy(true)
    setError('')
    const res = await api.switchTo({ account: choice.account, hat: choice.hat.id, code: withCode })
    setBusy(false)
    if (res.ok) {
      if (onSwitched) onSwitched()
      else window.location.reload()
      return
    }
    if (res.needsCode) {
      setAsking(choice)
      if (withCode) setError(t.enterCode)
      return
    }
    setError(res.message)
  }

  const choose = (choice: Choice) => (choice.hat.needsCode ? (setAsking(choice), setError('')) : void go(choice))
  const hatList = (account: string | number | undefined, accountLabel: string, hats: MenuHat[], isCurrent: boolean) => (
    <ul style={s.list}>
      {hats.map((h) => {
        const on = isCurrent && h.id === current?.id
        return (
          <li key={h.id}>
            <button type="button" style={s.item} aria-current={on ? 'true' : undefined} disabled={busy || on} onClick={() => choose({ account, accountLabel, hat: h })}>
              {on ? '✓ ' : ''}
              {h.label}
              {h.needsCode && !on ? <span style={s.note}> · {t.asksForCode}</span> : null}
            </button>
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="hats-switcher" style={s.wrap} ref={wrap}>
      <style>{focusRing}</style>
      <button ref={button} type="button" style={s.button} aria-expanded={open} aria-controls={panelId} onClick={() => (open ? close() : setOpen(true))}>
        {menu.linked.length ? `${menu.account.label} · ` : ''}
        {current?.label ?? t.switchFallback}
        <span aria-hidden="true"> ▾</span>
        <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>: {t.switchHint}</span>
      </button>
      {open ? (
        <div id={panelId} style={s.panel} role="group" aria-label={t.switchGroup}>
          {signedInAs ? (
            <p style={s.note}>{t.signedInAs(signedInAs.label, menu.account.label)}</p>
          ) : null}
          {asking ? (
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void go(asking, code.trim())
              }}
            >
              <label htmlFor={`${panelId}-code`} style={{ display: 'block', marginBottom: 6 }}>
                {/* Name the account whenever the code isn't for the account you signed in with. */}
                {t.codeLabel(asking.hat.label, asking.account !== undefined || signedInAs ? asking.accountLabel : null)}
              </label>
              <input ref={codeBox} id={`${panelId}-code`} style={s.input} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" required />{' '}
              <button type="submit" style={s.button} disabled={busy}>
                {t.switchButton}
              </button>{' '}
              <button type="button" style={s.button} onClick={() => (setAsking(null), setError(''))}>
                {t.back}
              </button>
            </form>
          ) : (
            <>
              <p style={s.heading}>{menu.linked.length ? menu.account.label : t.actAs}</p>
              {hatList(undefined, menu.account.label, menu.hats, true)}
              {menu.linked.map((l) => (
                <div key={String(l.id)}>
                  <p style={s.heading}>{l.label}</p>
                  {hatList(l.id, l.label, l.hats, false)}
                </div>
              ))}
            </>
          )}
          <p role="alert" style={s.error}>
            {error}
          </p>
        </div>
      ) : null}
    </div>
  )
}
