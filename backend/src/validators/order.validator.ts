import { z } from 'zod';

const addressSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(6).max(20),
  email: z.string().email().optional(),
  addressLine1: z.string().min(1).max(500),
  addressLine2: z.string().max(500).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  pincode: z.string().min(3).max(20),
  country: z.string().min(2).max(100),
});

const packageSchema = z.object({
  weightGrams: z.number().positive(),
  lengthCm: z.number().positive(),
  widthCm: z.number().positive(),
  heightCm: z.number().positive(),
  declaredValue: z.number().nonnegative(),
  currency: z.string().length(3).optional(),
  description: z.string().max(500).optional(),
});

const paymentSchema = z
  .object({
    mode: z.enum(['PREPAID', 'COD']),
    codAmount: z.number().nonnegative().optional(),
  })
  .refine(
    (v) => v.mode !== 'COD' || (typeof v.codAmount === 'number' && v.codAmount > 0),
    { message: 'codAmount must be > 0 when mode = COD', path: ['codAmount'] },
  );

export const createOrderSchema = z.object({
  orderId: z.string().min(1).max(100),
  courierName: z.string().min(1).max(100),
  pickup: addressSchema,
  delivery: addressSchema,
  package: packageSchema,
  payment: paymentSchema,
  productType: z.enum(['FORWARD', 'REVERSE']).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateOrderRequest = z.infer<typeof createOrderSchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelOrderRequest = z.infer<typeof cancelOrderSchema>;

export const bulkCreateSchema = z.object({
  orders: z.array(createOrderSchema).min(1),
});
export type BulkCreateRequest = z.infer<typeof bulkCreateSchema>;

export const orderIdParamSchema = z.object({
  id: z.string().min(1),
});
