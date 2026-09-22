'use client';

import Link from 'next/link';
import { useState } from 'react';

import { AuthForm, Field } from '@/components/forms/auth-form';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api/client';
import { AUTH_LIMITS, registerSchema, type RegisterInput } from '@/lib/schemas/auth';

/**
 * Create an account.
 *
 * ⚠️ **Registration does not sign anyone in.** `POST /auth/register` answers
 * `202` with `{ message }` and no tokens — deliberately, so sign-in stays one
 * path — which means the success state is a "check your email" panel rather than
 * a redirect into the app.
 */
export default function RegisterPage() {
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  if (registeredEmail !== null) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertTitle>Check your email</AlertTitle>
          <AlertDescription>
            We sent a verification link to {registeredEmail}. Open it to finish setting up your
            account.
          </AlertDescription>
        </Alert>

        <p className="text-muted-foreground text-sm">
          Already verified?{' '}
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
        <h1 className="text-2xl font-semibold">Create your account</h1>
        <p className="text-muted-foreground text-sm">
          Advanced product options for WooCommerce.
        </p>
      </div>

      <AuthForm<RegisterInput>
        schema={registerSchema}
        defaultValues={{ name: '', email: '', password: '', tenantName: '' }}
        fields={['name', 'email', 'password', 'tenantName']}
        submitLabel="Create account"
        pendingLabel="Creating…"
        onSubmit={async (values) => {
          await api.post('/auth/register', values);

          setRegisteredEmail(values.email);
        }}
      >
        {(form) => (
          <>
            <Field label="Your name" error={form.formState.errors.name?.message}>
              <Input autoComplete="name" autoFocus {...form.register('name')} />
            </Field>

            <Field label="Workspace name" error={form.formState.errors.tenantName?.message}>
              <Input autoComplete="organization" {...form.register('tenantName')} />
            </Field>

            <Field label="Email" error={form.formState.errors.email?.message}>
              <Input type="email" autoComplete="email" {...form.register('email')} />
            </Field>

            <Field
              label="Password"
              hint={`At least ${AUTH_LIMITS.MIN_PASSWORD_LENGTH} characters. Length beats symbols.`}
              error={form.formState.errors.password?.message}
            >
              <Input type="password" autoComplete="new-password" {...form.register('password')} />
            </Field>
          </>
        )}
      </AuthForm>

      <p className="text-muted-foreground text-sm">
        Already have an account?{' '}
        <Link href="/login" className="underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
