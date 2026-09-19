import { Suspense, lazy } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import AmbientBackdrop from './components/AmbientBackdrop'
import ScrollToTop from './components/ScrollToTop'
import SiteHeader from './components/SiteHeader'
import { LazyAnimatePresence } from './lib/lazyMotion'

// ── Route-based code splitting ────────────────────────────────────────────
// Each page is loaded in its own lazy chunk so the initial bundle only carries
// the shell (header, backdrop, router) plus whatever the first route needs.
// The remaining pages are fetched on demand, keeping first paint fast on
// mobile. No features or animations are removed — they are only deferred.
const HomePage = lazy(() => import('./pages/HomePage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const SignupPage = lazy(() => import('./pages/SignupPage'))

export default function App() {
  const location = useLocation()

  // The prototype home page ships its own header inside HomePage, so the
  // app-shell header would render twice on "/". Hide the shell header there
  // only — /login and /signup still need it.
  const isHomeRoute = location.pathname === '/'

  return (
    <div className="app-shell min-h-screen overflow-x-hidden bg-ink text-white" dir={isHomeRoute ? 'ltr' : 'rtl'} lang={isHomeRoute ? 'en' : 'ar'}>
      <ScrollToTop />
      <AmbientBackdrop />
      {!isHomeRoute && <SiteHeader />}
      <Suspense fallback={<div className="route-loading" aria-hidden="true" />}>
        <LazyAnimatePresence mode="wait">
          <Routes location={location} key={location.pathname}>
            <Route path="/" element={<HomePage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="*" element={<HomePage />} />
          </Routes>
        </LazyAnimatePresence>
      </Suspense>
    </div>
  )
}
