'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';

import { AuthForm, Field } from '@/components/forms/auth-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { clearSession } from '@/lib/auth/token-store';
import { AUTH_LIMITS, resetPasswordSchema, type ResetPasswordInput } from '@/lib/schemas/auth';

/**
 * Choose a new password.
 *
 * ⚠️ **The token comes from the URL**, not from a field: the email built by
 * `AuthService.link()` points at `${APP_URL}/reset-password?token=…`. It is
 * carried through the form as a hidden value so one schema validates both halves
 * — a truncated link is then a form error rather than a confusing 400.
 *
 * 🔴 **This route did not exist until Phase 13 Stage 2.** The email has pointed
 * here since Phase 6, so every reset link sent before now landed on a 404.
 */
function ResetPasswordContent() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [done, setDone] = useState(false);

  if (token === '') {
    return (
      <div className="space-y-4">
        <Alert variant="destructive">
          <AlertTitle>That link is incomplete</AlertTitle>
          <AlertDescription>
            Open the link from your email again, or ask for a new one.
          </AlertDescription>
        </Alert>

        <p className="text-muted-foreground text-sm">
          <Link href="/forgot-password" className="underline">
            Send a new link
          </Link>
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertTitle>Password changed</AlertTitle>
          <AlertDescription>
            You can sign in with your new password. Any other sessions have been signed out.
          </AlertDescription>
        </Alert>

        <p className="text-muted-foreground text-sm">
          <Link href="/login" className="underline">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Choose a new password</h1>
        <p className="text-muted-foreground text-sm">
          At least {AUTH_LIMITS.MIN_PASSWORD_LENGTH} characters. Length beats symbols.
        </p>
      </div>

      <AuthForm<ResetPasswordInput>
        schema={resetPasswordSchema}
        defaultValues={{ token, password: '', confirmPassword: '' }}
        fields={['token', 'password', 'confirmPassword']}
        submitLabel="Change password"
        pendingLabel="Changing…"
        onSubmit={async (values) => {
          await api.post('/auth/reset-password', {
            token: values.token,
            password: values.password,
          });

          /*
           * The API revokes every session for this user
           * (`revokeAllForUser(PASSWORD_CHANGED)`), so any tokens this browser
           * holds are already dead. Clearing them now means the next navigation
           * goes to sign-in deliberately, rather than through a failed request
           * that discovers the session is gone.
           */
          clearSession();

          setDone(true);
        }}
      >
        {(form) => (
          <>
            <input type="hidden" {...form.register('token')} />

            <Field label="New password" error={form.formState.errors.password?.message}>
              <Input type="password" autoComplete="new-password" autoFocus {...form.register('password')} />
            </Field>

            <Field label="Confirm password" error={form.formState.errors.confirmPassword?.message}>
              <Input type="password" autoComplete="new-password" {...form.register('confirmPassword')} />
            </Field>
          </>
        )}
      </AuthForm>

      <p className="text-muted-foreground text-sm">
        <Link href="/login" className="underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<p className="text-muted-foreground text-sm">Loading…</p>}>
      <ResetPasswordContent />
    </Suspense>
  );
}
