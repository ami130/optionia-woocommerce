'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { ErrorState } from '@/components/layout/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  createRule,
  deleteRule,
  listRules,
  publishCheck,
  testRules,
  updateRule,
  type AuthoringRule,
  type AuthoringSet,
  type RuleCondition,
} from '@/lib/option-sets/api';
import { ruleSchema } from '@/lib/rules/schema';
import { labelsIn, ruleSentence } from '@/lib/rules/summary';
import {
  ACTION_PHRASING,
  OPERATOR_PHRASING,
  RULE_ACTIONS,
  RULE_OPERATORS,
  operandShape,
  type RuleAction,
  type RuleOperator,
} from '@/lib/rules/vocabulary';

import { answerableIn, choicesFor, targetsIn } from './rule-targets';

/**
 * Conditional rules, authored (M17.6).
 *
 * 🔴 **The Phase 17 exit criterion this closes is "merchants can author rules
 * without documentation."** Rule CRUD has existed since 17-2 and nothing had
 * ever called it — a merchant could not create a rule at all except through the
 * API directly.
 *
 * ## Why every rule is shown as a sentence
 *
 * `target_id` and `option_id` are UUIDs. A list of them is a list nobody can
 * check, and a merchant who cannot read a rule cannot tell whether it is the one
 * they meant to write. `ruleSentence()` is tested separately, against the
 * sentence rather than against "something non-empty came back".
 */
export function RulesPanel({
  set,
  canEdit,
}: {
  set: AuthoringSet;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();

  const rules = useQuery({
    queryKey: ['option-set', set.id, 'rules'],
    queryFn: () => listRules(set.id),
  });

  /*
   * ⚠️ **The publish check, asked here as well as in the publish panel.**
   *
   * Every rule validator — cycles, conflicting payloads, `set_price` against
   * option-level pricing, out-of-set targets — already reports through it. A
   * merchant writing a second `set_price` on one target should learn at the
   * moment they create the conflict, not after clicking Publish and being sent
   * back to find it.
   *
   * The same request the publish panel makes, under its own key so one does not
   * serve the other a stale answer.
   */
  const findings = useQuery({
    queryKey: ['option-set', set.id, 'publish-check', 'rules'],
    queryFn: () => publishCheck(set.id),
  });

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: ['option-set', set.id, 'rules'] });
    void queryClient.invalidateQueries({ queryKey: ['option-set', set.id, 'publish-check'] });
  };

  const labels = useMemo(() => labelsIn(set), [set]);

  const ruleFindings = (findings.data ?? []).filter((finding) =>
    finding.subject.startsWith('rule:'),
  );

  return (
    <div className="space-y-4 border-t pt-6">
      <div className="space-y-1">
        <h2 className="font-medium">Rules</h2>
        <p className="text-muted-foreground text-sm">
          Show, hide or require an option depending on what a customer has already chosen.
        </p>
      </div>

      {ruleFindings.length > 0 ? (
        <Alert variant={ruleFindings.some((f) => f.severity === 'blocker') ? 'destructive' : undefined}>
          <AlertTitle>About these rules</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {ruleFindings.map((finding) => (
                <li key={`${finding.subject}:${finding.code}`}>{finding.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      {rules.error !== null && rules.error !== undefined ? (
        <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />
      ) : null}

      {rules.data !== undefined && rules.data.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No rules yet. Every option is always shown.
        </p>
      ) : null}

      <ul className="space-y-2">
        {(rules.data ?? []).map((rule) => (
          <RuleRow key={rule.id} rule={rule} labels={labels} canEdit={canEdit} onChanged={reload} />
        ))}
      </ul>

      {canEdit ? <AddRule set={set} onAdded={reload} /> : null}

      <RuleTester set={set} labels={labels} />
    </div>
  );
}

/** One rule, as a sentence, with the two things a merchant can do to it. */
function RuleRow({
  rule,
  labels,
  canEdit,
  onChanged,
}: {
  rule: AuthoringRule;
  labels: Map<string, string>;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const toggle = useMutation({
    mutationFn: () => updateRule(rule.id, { isEnabled: !rule.isEnabled }),
    onSuccess: onChanged,
  });

  const remove = useMutation({
    mutationFn: () => deleteRule(rule.id),
    onSuccess: onChanged,
  });

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
      <span className={rule.isEnabled ? 'flex-1 text-sm' : 'text-muted-foreground flex-1 text-sm'}>
        {ruleSentence(rule, labels)}
      </span>

      {/*
       * ⚠️ **Why a rule the system disabled says so.** The cascade switches off a
       * rule whose target was deleted rather than removing it, and a merchant
       * looking at a rule that is off for a reason they did not choose needs to
       * be told which — otherwise the only remedy they can see is re-enabling
       * it, which will not work.
       */}
      {rule.disabledReason !== null ? (
        <span className="text-muted-foreground text-xs">
          Switched off automatically: its target was deleted.
        </span>
      ) : null}

      {canEdit ? (
        <>
          <Button
            variant="outline"
            disabled={toggle.isPending || rule.disabledReason !== null}
            onClick={() => toggle.mutate()}
          >
            {rule.isEnabled ? 'Disable' : 'Enable'}
          </Button>
          <Button variant="outline" disabled={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </Button>
        </>
      ) : null}

      {toggle.error === null || toggle.error === undefined ? null : <ErrorState error={toggle.error} />}
      {remove.error === null || remove.error === undefined ? null : <ErrorState error={remove.error} />}
    </li>
  );
}

/** The builder: one action, one target, and one or more conditions. */
function AddRule({ set, onAdded }: { set: AuthoringSet; onAdded: () => void }) {
  const targets = useMemo(() => targetsIn(set), [set]);
  const answerable = useMemo(() => answerableIn(set), [set]);

  const [action, setAction] = useState<RuleAction>('hide');
  const [targetId, setTargetId] = useState('');
  const [matchType, setMatchType] = useState<'all' | 'any'>('all');
  const [conditions, setConditions] = useState<RuleCondition[]>([]);

  const targetKind = targets.find((t) => t.id === targetId)?.kind ?? 'option';

  const draft = {
    targetType: targetKind,
    targetId,
    action,
    matchType,
    conditions,
  };

  const parsed = ruleSchema.safeParse(draft);

  const add = useMutation({
    mutationFn: () =>
      createRule(set.id, {
        targetType: targetKind,
        targetId,
        action,
        matchType,
        conditions,
      }),
    onSuccess: () => {
      setTargetId('');
      setConditions([]);
      onAdded();
    },
  });

  const issue = (field: string) =>
    parsed.success ? undefined : parsed.error.issues.find((i) => i.path[0] === field)?.message;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <h3 className="text-sm font-medium">New rule</h3>

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="rule-action">
              Do this
            </label>
            <select
              id="rule-action"
              className="h-9 rounded-md border px-3 text-sm"
              value={action}
              onChange={(event) => setAction(event.target.value as RuleAction)}
            >
              {/*
                * ⚠️ **`set_price` is offered by the vocabulary and not by this
                * picker.** It carries a payload the builder has no field for,
                * and what it does to a quoted total is ADR-054's open question.
                * Offering an action a merchant cannot complete is worse than
                * omitting one — and the vocabulary still lists it, so the
                * cross-repo parity gate keeps watching it.
                *
                * ✏️ `set_default` used to be filtered here too, and is now
                * simply gone: ADR-055 withdrew the action.
                */}
              {RULE_ACTIONS.filter((value) => value !== 'set_price').map((value) => (
                <option key={value} value={value}>
                  {ACTION_PHRASING[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1 space-y-1.5">
            <label className="text-sm font-medium" htmlFor="rule-target">
              To this
            </label>
            <select
              id="rule-target"
              className="h-9 w-full rounded-md border px-3 text-sm"
              value={targetId}
              onChange={(event) => setTargetId(event.target.value)}
            >
              <option value="">Choose…</option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </select>
            {issue('targetId') === undefined ? null : (
              <p className="text-destructive text-xs">{issue('targetId')}</p>
            )}
          </div>
        </div>

        <ConditionList
          set={set}
          answerable={answerable}
          conditions={conditions}
          matchType={matchType}
          onMatchType={setMatchType}
          onChange={setConditions}
          issue={issue('conditions')}
        />

        <Button disabled={!parsed.success || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? 'Adding…' : 'Add rule'}
        </Button>

        {add.error === null || add.error === undefined ? null : <ErrorState error={add.error} />}
      </CardContent>
    </Card>
  );
}

/** The conditions, and the connective that joins them. */
function ConditionList({
  set,
  answerable,
  conditions,
  matchType,
  onMatchType,
  onChange,
  issue,
}: {
  set: AuthoringSet;
  answerable: Array<{ id: string; label: string }>;
  conditions: RuleCondition[];
  matchType: 'all' | 'any';
  onMatchType: (value: 'all' | 'any') => void;
  onChange: (next: RuleCondition[]) => void;
  issue?: string;
}) {
  const replace = (index: number, next: RuleCondition) =>
    onChange(conditions.map((condition, i) => (i === index ? next : condition)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">When</span>
        {conditions.length > 1 ? (
          <select
            aria-label="How these conditions combine"
            className="h-8 rounded-md border px-2 text-sm"
            value={matchType}
            onChange={(event) => onMatchType(event.target.value as 'all' | 'any')}
          >
            <option value="all">all of these are true</option>
            <option value="any">any of these is true</option>
          </select>
        ) : null}
      </div>

      {conditions.map((condition, index) => (
        <ConditionRow
          key={index}
          set={set}
          answerable={answerable}
          condition={condition}
          onChange={(next) => replace(index, next)}
          onRemove={() => onChange(conditions.filter((_, i) => i !== index))}
        />
      ))}

      {issue === undefined ? null : <p className="text-destructive text-xs">{issue}</p>}

      <Button
        variant="outline"
        onClick={() =>
          onChange([
            ...conditions,
            { optionId: answerable[0]?.id ?? '', operator: 'equals', value: '' },
          ])
        }
      >
        Add condition
      </Button>
    </div>
  );
}

/** One condition: an option, a comparison, and whatever that comparison needs. */
function ConditionRow({
  set,
  answerable,
  condition,
  onChange,
  onRemove,
}: {
  set: AuthoringSet;
  answerable: Array<{ id: string; label: string }>;
  condition: RuleCondition;
  onChange: (next: RuleCondition) => void;
  onRemove: () => void;
}) {
  const shape = operandShape(condition.operator);
  const choices = choicesFor(set, condition.optionId);

  /*
   * 🔴 **Changing the operator changes what `value` may be**, so it is reset
   * rather than carried. The API's schema is a discriminated union: a string
   * left behind on a switch to `greater_than` is a 400, and one left behind on
   * a switch to `is_empty` is a 400 for the opposite reason — the field must be
   * absent entirely.
   */
  const changeOperator = (operator: RuleOperator) => {
    const next = operandShape(operator);

    if (next === 'none') {
      onChange({ optionId: condition.optionId, operator });

      return;
    }

    onChange({
      optionId: condition.optionId,
      operator,
      value: next === 'list' ? [] : next === 'number' ? 0 : '',
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border p-2">
      <select
        aria-label="Which answer"
        className="h-8 rounded-md border px-2 text-sm"
        value={condition.optionId}
        onChange={(event) => onChange({ ...condition, optionId: event.target.value })}
      >
        {answerable.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>

      <select
        aria-label="Comparison"
        className="h-8 rounded-md border px-2 text-sm"
        value={condition.operator}
        onChange={(event) => changeOperator(event.target.value as RuleOperator)}
      >
        {RULE_OPERATORS.map((operator) => (
          <option key={operator} value={operator}>
            {OPERATOR_PHRASING[operator]}
          </option>
        ))}
      </select>

      {/*
       * ⚠️ **No field at all for a unary operator.** Offering one invites a
       * merchant to fill it in, and the API's `.strict()` schema refuses the
       * extra key outright rather than ignoring it.
       */}
      {shape === 'none' ? null : shape === 'list' ? (
        <ChoiceList
          choices={choices}
          selected={Array.isArray(condition.value) ? condition.value.map(String) : []}
          onChange={(next) => onChange({ ...condition, value: next })}
        />
      ) : shape === 'number' ? (
        <Input
          aria-label="Value"
          type="number"
          className="h-8 w-28"
          value={typeof condition.value === 'number' ? String(condition.value) : ''}
          onChange={(event) =>
            /*
             * An empty box is not zero. `Number('')` is 0, which would make a
             * half-deleted "10" mean "greater than 0" — so a blank stays blank
             * and the schema reports it as missing.
             */
            onChange({
              ...condition,
              value: event.target.value === '' ? undefined : Number(event.target.value),
            })
          }
        />
      ) : choices.length > 0 ? (
        <select
          aria-label="Value"
          className="h-8 rounded-md border px-2 text-sm"
          value={typeof condition.value === 'string' ? condition.value : ''}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
        >
          <option value="">Choose…</option>
          {choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : (
        <Input
          aria-label="Value"
          className="h-8 w-40"
          value={typeof condition.value === 'string' ? condition.value : ''}
          onChange={(event) => onChange({ ...condition, value: event.target.value })}
        />
      )}

      <Button variant="outline" className="h-8" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

/** Several value keys, for `in` and `not_in`. */
function ChoiceList({
  choices,
  selected,
  onChange,
}: {
  choices: Array<{ key: string; label: string }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (key: string) =>
    onChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);

  if (choices.length === 0) {
    return (
      <span className="text-muted-foreground text-xs">
        That option has no choices to pick from.
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {choices.map((choice) => (
        <button
          key={choice.key}
          type="button"
          aria-pressed={selected.includes(choice.key)}
          onClick={() => toggle(choice.key)}
          className={[
            'rounded-md border px-2 py-1 text-xs transition',
            selected.includes(choice.key) ? 'border-foreground bg-accent' : 'hover:bg-accent/50',
          ].join(' ')}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/**
 * "What would a customer see?" (ADR-053).
 *
 * 🔴 **The server evaluates, not this.** Three rule engines already exist, and
 * the third was added deliberately in 17-9 because AC3 forbids the storefront
 * asking a server. The dashboard has no such constraint — and a merchant
 * testing a rule wants *the storefront's answer*, which only the thing that
 * decides can give.
 */
function RuleTester({ set, labels }: { set: AuthoringSet; labels: Map<string, string> }) {
  const answerable = useMemo(() => answerableIn(set), [set]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const run = useMutation({
    mutationFn: () =>
      testRules(
        set.id,
        /* A blank box is an unanswered question, not an empty answer. */
        Object.fromEntries(Object.entries(answers).filter(([, value]) => value !== '')),
      ),
  });

  const result = run.data;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Try it</h3>
          <p className="text-muted-foreground text-sm">
            Answer as a customer would, and see what your rules do.
          </p>
        </div>

        <div className="space-y-2">
          {answerable.map((option) => {
            const choices = choicesFor(set, option.id);

            return (
              <div key={option.id} className="flex flex-wrap items-center gap-2">
                <label className="w-40 text-sm" htmlFor={`try-${option.id}`}>
                  {option.label}
                </label>
                {choices.length > 0 ? (
                  <select
                    id={`try-${option.id}`}
                    className="h-8 rounded-md border px-2 text-sm"
                    value={answers[option.id] ?? ''}
                    onChange={(event) =>
                      setAnswers({ ...answers, [option.id]: event.target.value })
                    }
                  >
                    <option value="">Not answered</option>
                    {choices.map((choice) => (
                      <option key={choice.key} value={choice.key}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    id={`try-${option.id}`}
                    className="h-8 w-40"
                    value={answers[option.id] ?? ''}
                    onChange={(event) =>
                      setAnswers({ ...answers, [option.id]: event.target.value })
                    }
                  />
                )}
              </div>
            );
          })}
        </div>

        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Checking…' : 'See what happens'}
        </Button>

        {run.error === null || run.error === undefined ? null : <ErrorState error={run.error} />}

        {result === undefined ? null : result.refused !== null ? (
          /*
           * ADR-050: a refusal carries no partial state, so nothing is listed.
           * Showing what the last pass reached would let a merchant tune a rule
           * against a picture the storefront will never draw.
           */
          <Alert variant="destructive">
            <AlertTitle>These rules do not settle</AlertTitle>
            <AlertDescription>
              They depend on each other in a loop, so a storefront cannot work out what to
              show. Simplify them before publishing.
            </AlertDescription>
          </Alert>
        ) : (
          <TestOutcome result={result} labels={labels} />
        )}
      </CardContent>
    </Card>
  );
}

/** What the tester found, in the same words the rules are written in. */
function TestOutcome({
  result,
  labels,
}: {
  result: {
    hiddenOptionIds: string[];
    hiddenGroupIds: string[];
    hiddenValueIds: string[];
    requiredOptionIds: string[];
  };
  labels: Map<string, string>;
}) {
  const name = (id: string) => labels.get(id) ?? 'a deleted option';

  const hidden = [
    ...result.hiddenGroupIds,
    ...result.hiddenOptionIds,
    ...result.hiddenValueIds,
  ].map(name);

  const required = result.requiredOptionIds.map(name);

  if (hidden.length === 0 && required.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing changes — a customer sees every option.
      </p>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      {hidden.length > 0 ? <p>Hidden: {hidden.join(', ')}</p> : null}
      {required.length > 0 ? <p>Required: {required.join(', ')}</p> : null}
    </div>
  );
}
