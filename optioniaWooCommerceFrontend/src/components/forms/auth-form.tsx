'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { cloneElement, isValidElement, useId, useState, type ReactNode } from 'react';
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type Resolver,
  type UseFormReturn,
} from 'react-hook-form';
import type { ZodType } from 'zod';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { applyApiErrors, formLevelMessage } from '@/lib/forms/api-errors';

/**
 * One submit pipeline, for every auth form.
 *
 * The sequence is identical on all five screens and easy to get subtly wrong on
 * one of them:
 *
 * 1. Zod validates locally — a round trip avoided, never enforcement.
 * 2. The request runs.
 * 3. On `ApiError`, field details go to their inputs by dotted path.
 * 4. Anything left over is shown **above** the form.
 *
 * Step 4 is the one that gets skipped, and skipping it leaves a merchant with a
 * form that refuses to submit and says nothing. `applyApiErrors` returns whether
 * every detail found a home precisely so this component can tell.
 */
export function AuthForm<T extends FieldValues>({
  schema,
  defaultValues,
  fields,
  onSubmit,
  submitLabel,
  pendingLabel,
  children,
}: {
  schema: ZodType<T>;
  defaultValues: DefaultValues<T>;
  /** The paths this form renders. A detail naming anything else is shown above. */
  fields: ReadonlyArray<Path<T>>;
  onSubmit: (values: T) => Promise<void>;
  submitLabel: string;
  pendingLabel: string;
  children: (form: UseFormReturn<T>) => ReactNode;
}) {
  const form = useForm<T>({
    resolver: zodResolver(schema) as Resolver<T>,
    defaultValues,
    // On blur rather than on every keystroke: an email flagged invalid while it
    // is still being typed is noise, not help.
    mode: 'onBlur',
  });

  const [formError, setFormError] = useState<string | null>(null);

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={form.handleSubmit(async (values) => {
        setFormError(null);

        try {
          await onSubmit(values as T);
        } catch (error) {
          const placed = applyApiErrors<T>(error, form.setError, fields);

          if (!placed) {
            setFormError(formLevelMessage(error) ?? 'Something went wrong.');
          }
        }
      })}
    >
      {formError === null ? null : (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      {children(form)}

      <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting ? pendingLabel : submitLabel}
      </Button>
    </form>
  );
}

/** A labelled input with its error, so no screen re-derives the markup. */
export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  /*
   * 🔴 **The label was bound to nothing until M19.1'.** Every screen a merchant
   * meets before they are signed in — login, register, forgot-password, reset —
   * renders its fields through here, so one unbound `<label>` left **all** of
   * them announced as unlabelled by a screen reader, and clicking the text did
   * not focus the input.
   *
   * `useId()` rather than a prop: the id has to be unique per instance (two
   * `Field`s with the same id make `htmlFor` bind to whichever came first), and
   * making callers invent one is a rule six call sites can forget. The child
   * keeps an `id` it sets itself, so a caller that needs a specific one wins.
   */
  const generatedId = useId();
  const controlId =
    isValidElement<{ id?: string }>(children) && children.props.id !== undefined
      ? children.props.id
      : generatedId;

  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={controlId}>
        {label}
      </label>
      {isValidElement<{ id?: string }>(children)
        ? cloneElement(children, { id: controlId })
        : children}
      {hint === undefined || error !== undefined ? null : (
        <p className="text-muted-foreground text-xs">{hint}</p>
      )}
      {error === undefined ? null : (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
