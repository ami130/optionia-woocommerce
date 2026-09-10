'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { AuthForm, Field } from '@/components/forms/auth-form';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { ApiError } from '@/lib/api/error';
import { signIn } from '@/lib/auth/session';
import { safeNextPath } from '@/lib/auth/next-path';
import { loginSchema, type LoginInput } from '@/lib/schemas/auth';

function LoginContent() {
  const router = useRouter();
  const params = useSearchParams();

  /**
   * Where to go after signing in.
   *
   * A merchant clicking **Connect** in WordPress may not be signed in, and
   * sending them to a bare `/login` would discard `request` and `state` — the
   * handshake would have to be restarted from WordPress, with nothing on screen
   * explaining why. `safeNextPath` refuses anything but a same-origin path, so
   * this cannot become an open redirect.
   */
  const next = safeNextPath(params.get('next'));

  /**
   * The address that could not sign in because it is unverified.
   *
   * 🔴 **Sign-in *refuses* an unverified account** — `403 EMAIL_NOT_VERIFIED`,
   * not a session with `emailVerified: false`. So the merchant never reaches
   * `/verify-email`, where the resend button lives, and that button is disabled
   * without a session anyway. Measured during the Stage 2 audit: a merchant who
   * missed the verification email had **no path forward from the UI at all**.
   *
   * Keeping the address here is what makes the offer below possible.
   */
  const [unverified, setUnverified] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="text-muted-foreground text-sm">Welcome back to Optionia.</p>
      </div>

      {unverified === null ? null : (
        <Alert>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>
              {resent
                ? 'A new verification link is on its way. Open it, then sign in again.'
                : 'That account still needs verifying. We can send the link again.'}
            </span>
            {resent ? null : (
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await api.post('/auth/resend-verification', { email: unverified });
                  } catch {
                    /*
                     * Swallowed deliberately. The endpoint answers identically
                     * whether or not the address needs verifying, so reporting a
                     * failure would leak what it is careful not to say.
                     */
                  } finally {
                    setResent(true);
                  }
                }}
              >
                Send it again
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <AuthForm<LoginInput>
        schema={loginSchema}
        defaultValues={{ email: '', password: '' }}
        fields={['email', 'password']}
        submitLabel="Sign in"
        pendingLabel="Signing in…"
        onSubmit={async (values) => {
          setUnverified(null);
          setResent(false);

          try {
            await signIn(values.email, values.password);
          } catch (error) {
            if (error instanceof ApiError && error.code === 'EMAIL_NOT_VERIFIED') {
              setUnverified(values.email);
            }

            // Re-thrown so `AuthForm` still shows the reason above the form. The
            // panel offers the remedy; the message says what went wrong.
            throw error;
          }

          /*
           * Only a verified account gets here -- the API refuses the rest -- so
           * the destination is unconditional. An earlier version branched on
           * `emailVerified`, which was dead code.
           */
          router.replace(next);
        }}
      >
        {(form) => (
          <>
            <Field label="Email" error={form.formState.errors.email?.message}>
              <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
            </Field>

            <Field label="Password" error={form.formState.errors.password?.message}>
              <Input type="password" autoComplete="current-password" {...form.register('password')} />
            </Field>
          </>
        )}
      </AuthForm>

      <div className="text-muted-foreground space-y-2 text-sm">
        <p>
          <Link href="/forgot-password" className="underline">
            Forgot your password?
          </Link>
        </p>
        <p>
          New to Optionia?{' '}
          <Link href="/register" className="underline">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}

/** `useSearchParams` needs a Suspense boundary, or the route opts out of static rendering. */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}
