import { ArrowLeft, BookOpenCheck, Menu, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import ThemeToggle from './ThemeToggle'
import { LazyAnimatePresence, M } from '../lib/lazyMotion'
import { useSession } from '../lib/useSession'

const links = [
  { to: '/', label: 'الرئيسية' },
  { to: '/subscription', label: 'ماذا ستحصل؟' },
]

export default function SiteHeader() {
  const [open, setOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const location = useLocation()
  // Fix #1: restore + reflect the server session on load. When a valid
  // bac_session cookie exists the header shows a "go to library" affordance and
  // hides the login/signup buttons, so a refresh / return no longer looks like
  // a logout. Hitting /me here also slides the session + cookie forward.
  const session = useSession()
  // Signed-in destination (admins → console, everyone else → library).
  const dest = session.destination || '/library'

  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    // rAF-throttled scroll listener that flips `scrolled` only when the 30px
    // threshold is actually crossed. This avoids a React state update (and the
    // header's backdrop-filter transition) firing on every scroll frame — the
    // main cause of scroll jank on mobile.
    let ticking = false
    let last = window.scrollY > 30
    setScrolled(last)
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        const next = window.scrollY > 30
        if (next !== last) {
          last = next
          setScrolled(next)
        }
        ticking = false
      })
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <header className={`site-header ${scrolled ? 'site-header--scrolled' : ''}`}>
      {/* MIRRORED ROW. `flex-row-reverse` is the single mechanism: it flips the
          main-axis direction of this one flex container, so the four clusters
          (brand, desktop nav, desktop actions, mobile toggle+hamburger) all
          land on the opposite side from before. DOM order, the Arabic labels,
          `justify-between`, the gaps, the px/py padding and every button's
          internals are untouched — only the axis direction changes. */}
      <nav className="mx-auto flex flex-row-reverse max-w-7xl items-center justify-between px-5 py-4 lg:px-10" aria-label="التنقل الرئيسي">
        <Link to="/" className="brand-lockup group relative z-10" aria-label="تيسير — الرئيسية">
          <span className="brand-word">تيسير</span>
          <span className="brand-underscore" aria-hidden="true" />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          {links.map((link) => (
            <NavLink key={link.to} to={link.to} className={({ isActive }) => `nav-link ${isActive ? 'nav-link--active' : ''}`}>
              {link.label}
            </NavLink>
          ))}
        </div>

        <div className="hidden items-center gap-2 md:flex">
          <ThemeToggle className="ml-1" />
          {session.authenticated ? (
            // Logged-in: a single affordance back into the internal experience.
            // A full navigation hands control to the Hono-rendered library/console.
            <a href={dest} className="button-primary button-primary--small">
              <BookOpenCheck size={16} /> {session.user?.role === 'admin' ? 'لوحة التحكم' : 'إلى المكتبة'}
            </a>
          ) : (
            // Logged-out (or still resolving): show sign-in / start actions.
            <>
              <Link to="/login" className="button-ghost">تسجيل الدخول</Link>
              <Link to="/signup" className="button-primary button-primary--small">
                ابدأ الآن <ArrowLeft size={16} />
              </Link>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 md:hidden">
          <ThemeToggle />
          <button className="menu-button" onClick={() => setOpen((value) => !value)} aria-label="فتح القائمة" aria-expanded={open}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </nav>

      <LazyAnimatePresence>
        {open && (
          <>
            {/* Dimming backdrop — tap outside to close. Fades only (opacity). */}
            <M.div
              key="menu-scrim"
              className="mobile-menu__scrim md:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />
            {/* Menu panel: pinned to the absolute top and revealed with a
                premium scale-fade + slide-down. Only transform + opacity
                animate (GPU-composited), transform-origin at the top so it
                grows downward from under the header bar. */}
            <M.div
              key="menu-panel"
              className="mobile-menu md:hidden"
              initial={{ opacity: 0, y: -16, scaleY: 0.92 }}
              animate={{ opacity: 1, y: 0, scaleY: 1 }}
              exit={{ opacity: 0, y: -12, scaleY: 0.96 }}
              transition={{ type: 'spring', stiffness: 420, damping: 34, mass: 0.7 }}
            >
              {(session.authenticated
                // Logged-in: primary nav + a single "go to library/console" link,
                // login/signup hidden.
                ? [...links, { to: dest, label: session.user?.role === 'admin' ? 'لوحة التحكم' : 'إلى المكتبة' }]
                // Logged-out: primary nav + login/signup.
                : [...links, { to: '/login', label: 'تسجيل الدخول' }, { to: '/signup', label: 'إنشاء حساب' }]
              ).map((link, i) => (
                <M.div
                  key={link.to}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.05 + i * 0.05, duration: 0.3, ease: 'easeOut' }}
                >
                  {link.to === dest && session.authenticated ? (
                    // Full navigation into the Hono-rendered internal area.
                    <a href={link.to} className="mobile-menu__link">{link.label}</a>
                  ) : (
                    <Link to={link.to} className="mobile-menu__link">{link.label}</Link>
                  )}
                </M.div>
              ))}
            </M.div>
          </>
        )}
      </LazyAnimatePresence>
    </header>
  )
}
