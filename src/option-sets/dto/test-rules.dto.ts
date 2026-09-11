import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject } from 'class-validator';

/**
 * "What would a customer see, given these answers?" (M17.6).
 *
 * ⚠️ **`POST` for a request that mutates nothing, and the body is why.** Answers
 * may carry an operand up to `MAX_OPERAND_LENGTH` (5000 characters) against any
 * number of options — past what a query string should hold. A `POST` that
 * changes nothing is the lesser oddity, and ADR-053 records the trade.
 */
export class TestRulesDto {
  /**
   * Option id -> what a customer answered.
   *
   * ⚠️ **`@Type(() => Object)` for the reason `conditions` needs it**, even
   * though this one is an object rather than an array. `main.ts` sets
   * `enableImplicitConversion: true`, and the sibling DTO's note records what
   * that does to a field whose element type it has to infer. An object survives
   * it today; naming the type means the answer does not depend on that staying
   * true.
   *
   * 🔴 **Deliberately unvalidated beyond "is an object".** These are *hypothetical*
   * answers a merchant is trying out — not a submission. Refusing an option id
   * the set does not contain would stop a merchant testing a rule they are
   * midway through authoring, and the evaluator already treats an unknown id as
   * an answer nothing reads. Nothing is stored, nothing is charged, and the
   * response says only what would be shown.
   */
  @IsObject()
  @Type(() => Object)
  @ApiProperty({
    type: Object,
    description: 'Option id to answer. Values may be strings, numbers or booleans.',
  })
  answers!: Record<string, unknown>;
}
