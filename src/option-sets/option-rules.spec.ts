import { AUTHORING_LIMITS } from './authoring-limits';
import { AuditAction } from '../audit/audit.service';
import { RuleAction, RuleMatchType, RuleTargetType } from '../common/database/enums';
import { OptionRulesService } from './option-rules.service';

/**
 * Rule authoring (M17.1).
 *
 * 🔴 **These drive the service, not `assertWithinLimit` directly.**
 *
 * The sibling spec for `itemsPerGroup` asserts the *helper* throws — which is
 * true whether or not `create` ever calls it. Deleting the call from
 * `PresentationalItemsService` would leave that suite green. The limit that
 * matters is the one the service applies, so these stub the repository and check
 * what the service does with it.
 */
describe('OptionRulesService', () => {
  const setId = '0199b8c2-0000-7000-8000-000000000001';
  const optionId = '0199b8c2-0000-7000-8000-000000000002';

  const validInput = {
    targetType: RuleTargetType.OPTION,
    targetId: optionId,
    action: RuleAction.SHOW,
    matchType: RuleMatchType.ALL,
    conditions: [{ optionId, operator: 'equals', value: 'yes' }],
  };

  function build(ruleCount: number) {
    const created: Record<string, unknown>[] = [];

    const rules = {
      countBySet: jest.fn().mockResolvedValue(ruleCount),
      listBySet: jest.fn().mockResolvedValue([]),
      nextSortOrder: jest.fn().mockResolvedValue(10),
      create: jest.fn().mockImplementation((_setId: string, row: Record<string, unknown>) => {
        created.push(row);

        return Promise.resolve({ id: 'new-rule', ...row });
      }),
    };
    const sets = { findById: jest.fn().mockResolvedValue({ id: setId }) };
    const parents = { touchSet: jest.fn().mockResolvedValue(undefined) };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };

    const service = new OptionRulesService(
      rules as never,
      sets as never,
      parents as never,
      audit as never,
      {} as never,
    );

    return { service, rules, sets, parents, audit, created };
  }

  describe('rulesPerSet', () => {
    it('refuses a set that is already full', async () => {
      const { service } = build(AUTHORING_LIMITS.rulesPerSet);

      await expect(service.create(setId, validInput)).rejects.toThrow();
    });

    it('allows the last rule that fits', async () => {
      const { service } = build(AUTHORING_LIMITS.rulesPerSet - 1);

      await expect(service.create(setId, validInput)).resolves.toBeDefined();
    });

    /**
     * ⚠️ Counted, not listed. `MAX_CONDITIONS_BYTES` allows 16 KB per rule, so
     * loading two hundred of them to answer a question about a number would read
     * three megabytes to decide whether one more may be created.
     */
    it('counts rather than loading every rule to decide', async () => {
      const { service, rules } = build(0);

      await service.create(setId, validInput);

      expect(rules.countBySet).toHaveBeenCalledWith(setId);
    });
  });

  describe('conditions', () => {
    /*
     * 🔴 The `freeUnits: 5` shape, at the service boundary.
     *
     * `OptionTypeValidator.check` returns NO errors for `undefined` or `null` —
     * right where it lives, wrong here, because a rule with no conditions always
     * fires. The service runs the schema itself for exactly this reason.
     */
    it('refuses an empty condition list, which would always fire', async () => {
      const { service } = build(0);

      await expect(service.create(setId, { ...validInput, conditions: [] })).rejects.toThrow();
    });

    it('refuses a condition the schema does not recognise', async () => {
      const { service } = build(0);

      await expect(
        service.create(setId, {
          ...validInput,
          conditions: [{ optionId, operator: 'starts_with', value: 'A' }],
        }),
      ).rejects.toThrow();
    });

    it('refuses an operand the operator cannot compare', async () => {
      const { service } = build(0);

      await expect(
        service.create(setId, {
          ...validInput,
          /* No ordering for text that two languages agree on. */
          conditions: [{ optionId, operator: 'greater_than', value: 'blue' }],
        }),
      ).rejects.toThrow();
    });

    it('names the offending condition by index, so a dashboard can point at it', async () => {
      const { service } = build(0);

      try {
        await service.create(setId, {
          ...validInput,
          conditions: [
            { optionId, operator: 'equals', value: 'ok' },
            { optionId, operator: 'is_empty', value: 'not allowed here' },
          ],
        });
        throw new Error('expected a validation failure');
      } catch (error) {
        expect(JSON.stringify(error)).toContain('conditions.1');
      }
    });
  });

  describe('what a new rule starts as', () => {
    /**
     * A rule is created enabled, with no `disabledReason`. Both are absent from
     * the DTO deliberately: the only writer is the cascade, recording that a
     * target was deleted.
     */
    it('is enabled, with no disabled reason', async () => {
      const { service, created } = build(0);

      await service.create(setId, validInput);

      expect(created[0]).toMatchObject({ isEnabled: true, disabledReason: null });
    });

    it('records the creation, because a rule decides what a customer pays', async () => {
      const { service, audit } = build(0);

      await service.create(setId, validInput);

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.OPTION_RULE_CREATED }),
      );
    });

    /**
     * The set's `updatedAt` and `rowVersion` move even though `config_version`
     * does not — a draft rule is invisible to storefronts until a publish writes
     * a new snapshot, but optimistic locking still needs to know the set changed.
     */
    it('touches the set without republishing anything', async () => {
      const { service, parents } = build(0);

      await service.create(setId, validInput);

      expect(parents.touchSet).toHaveBeenCalledWith(setId);
    });
  });

  it('refuses to create a rule under a set this tenant cannot see', async () => {
    const { service, sets } = build(0);

    sets.findById.mockResolvedValue(null);

    await expect(service.create(setId, validInput)).rejects.toThrow();
  });
});
