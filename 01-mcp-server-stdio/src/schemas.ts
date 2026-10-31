import { z } from 'zod';

export const CUSTOMER_ID_REGEX = /^CUST-[A-Za-z0-9]{5}$/;

export const CustomerIdSchema = z
  .string()
  .regex(CUSTOMER_ID_REGEX, {
    message: 'customer_id must be formatted as CUST-XXXXX (where XXXXX is exactly 5 alphanumeric characters)',
  });

export const GetCustomerRecordInputSchema = z
  .object({
    customer_id: CustomerIdSchema,
  })
  .strict();

export type GetCustomerRecordInput = z.infer<typeof GetCustomerRecordInputSchema>;

export const TriggerRefundInputSchema = z
  .object({
    customer_id: CustomerIdSchema,
    amount: z
      .number()
      .positive({
        message: 'amount must be a positive float greater than 0',
      })
      .finite({
        message: 'amount must be a finite number',
      }),
    reason: z
      .string()
      .min(10, {
        message: 'reason must have a minimum length of 10 characters',
      }),
  })
  .strict();

export type TriggerRefundInput = z.infer<typeof TriggerRefundInputSchema>;


