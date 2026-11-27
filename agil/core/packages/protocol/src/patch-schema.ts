import { z } from 'zod';

type OptionalShape<Shape extends z.ZodRawShape> = {
  [Key in keyof Shape]: z.ZodOptional<PatchValue<Shape[Key]>>;
};

type PatchValue<Schema extends z.core.SomeType> =
  Schema extends z.ZodObject<infer Shape> ? z.ZodObject<OptionalShape<Shape>> :
  Schema extends z.ZodArray<infer Item> ? z.ZodArray<PatchValue<Item>> :
  Schema extends z.ZodOptional<infer Inner> ? z.ZodOptional<PatchValue<Inner>> :
  Schema extends z.ZodNullable<infer Inner> ? z.ZodNullable<PatchValue<Inner>> :
  Schema extends z.ZodDefault<infer Inner> ? PatchValue<Inner> :
  Schema;

function patchValue(schema: z.core.$ZodType): z.core.$ZodType {
  if (schema instanceof z.ZodObject) return deepPartialObject(schema);
  if (schema instanceof z.ZodArray) return z.array(patchValue(schema.element));
  if (schema instanceof z.ZodOptional) return z.optional(patchValue(schema.unwrap()));
  if (schema instanceof z.ZodNullable) return z.nullable(patchValue(schema.unwrap()));
  if (schema instanceof z.ZodDefault) return patchValue(schema.removeDefault());
  return schema;
}

/** Validate only fields supplied by a PATCH. Defaults are applied after merging. */
export function deepPartialObject<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
): z.ZodObject<OptionalShape<Shape>> {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, value]) => [key, z.optional(patchValue(value))]),
  ) as OptionalShape<Shape>;
  return z.object(shape);
}
