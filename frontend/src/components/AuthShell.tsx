import { Sparkles } from 'lucide-react'
import { motion } from 'framer-motion'
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import PageTransition from './PageTransition'
import AuthMascot from './AuthMascot'
import { useSession } from '../lib/useSession'

type AuthShellProps = {
  mode: 'login' | 'signup'
}

// ---------------------------------------------------------------------------
// AuthShell — the /login and /signup screen.
//
// An already-authenticated visitor who lands here is sent straight into the
// app (/library, or /admin for an admin) instead of being shown a sign-in
// screen. The mascot, layout, animations and Arabic copy are unchanged.
// ---------------------------------------------------------------------------
export default function AuthShell({ mode }: AuthShellProps) {
  const isSignup = mode === 'signup'

  const session = useSession()
  useEffect(() => {
    if (session.authenticated && session.destination) {
      window.location.replace(session.destination)
    }
  }, [session.authenticated, session.destination])

  return (
    <PageTransition>
      <section className="auth-page page-pad flex items-start justify-center px-5 pb-16 pt-32 sm:pt-40 lg:items-center">
        <div className="auth-layout mx-auto grid w-full max-w-6xl items-center gap-10 lg:grid-cols-[0.85fr_1.15fr]">
          <motion.aside
            className="hidden lg:block"
            initial={{ opacity: 0, x: 35 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2, duration: 0.8 }}
          >
            <span className="eyebrow"><Sparkles size={14} /> قرار صغير. فرق كبير.</span>
            <h1 className="mt-7 text-5xl font-black leading-[1.2] xl:text-6xl">
              {isSignup ? <>اقترب خطوة من<br /><span className="text-gradient">النتيجة التي تحلم بها.</span></> : <>مرحبًا بعودتك،<br /><span className="text-gradient">طريق التفوق ينتظرك.</span></>}
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-9 text-white/55">
              {isSignup ? 'أنشئ حسابك، واجمع دروسك وتمارينك ومواضيعك في مكان واحد هادئ ومنظم.' : 'عد إلى مساحتك في تيسير، أكمل من حيث توقفت، وحوّل كل ساعة مراجعة إلى خطوة محسوبة نحو النجاح.'}
            </p>
            <div className="quote-mark mt-10">
              <span>“</span>
              <p>لا تحتاج إلى وقت أكثر، بل إلى طريق أوضح.</p>
            </div>
          </motion.aside>

          <motion.div
            className="auth-card auth-card--simple"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <div className="auth-card__glow" />

            <div className="auth-card__mascot">
              <AuthMascot state="idle" />
            </div>

            <div className="relative z-10 text-center">
              <p className="mb-2 text-sm font-bold text-cyan">
                {isSignup ? 'أنشئ حسابك في تيسير' : 'سجّل دخولك إلى تيسير'}
              </p>
              <h2 className="text-3xl font-black md:text-4xl">أهلًا بك في تيسير</h2>
              <p className="mt-3 text-sm leading-7 text-white/45">
                {isSignup
                  ? 'أنشئ حسابك للوصول إلى مكتبة تيسير كاملة.'
                  : 'عد إلى حسابك وأكمل من حيث توقفت.'}
              </p>

              <div className="auth-card__actions mt-9">
                <Link className="button-primary" to="/subscription">
                  تعرّف على الاشتراك
                </Link>
                <Link className="button-ghost" to={isSignup ? '/login' : '/signup'}>
                  {isSignup ? 'لديك حساب؟ سجّل الدخول' : 'ليس لديك حساب؟ أنشئ واحدًا'}
                </Link>
              </div>
            </div>
          </motion.div>
        </div>
      </section>
    </PageTransition>
  )
}
