'use client';

import Link from 'next/link';
import { useState } from 'react';

import { AuthForm, Field } from '@/components/forms/auth-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@/lib/schemas/auth';

/**
 * Ask for a reset link.
 *
 * ⚠️ **The confirmation says the same thing whether or not the account exists.**
 * The API answers identically by design — a different message would turn this
 * form into a membership oracle, letting anyone test which addresses have
 * accounts — so the screen must not undo that by being more helpful.
 */
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertTitle>Check your email</AlertTitle>
          <AlertDescription>
            If that address has an account, a reset link is on its way. The link expires shortly,
            so use it soon.
          </AlertDescription>
        </Alert>

        <p className="text-muted-foreground text-sm">
          <Link href="/login" className="underline">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Reset your password</h1>
        <p className="text-muted-foreground text-sm">
          We will email you a link to choose a new one.
        </p>
      </div>

      <AuthForm<ForgotPasswordInput>
        schema={forgotPasswordSchema}
        defaultValues={{ email: '' }}
        fields={['email']}
        submitLabel="Send reset link"
        pendingLabel="Sending…"
        onSubmit={async (values) => {
          await api.post('/auth/request-password-reset', values);

          setSent(true);
        }}
      >
        {(form) => (
          <Field label="Email" error={form.formState.errors.email?.message}>
            <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
          </Field>
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
