import { z } from "zod";

export const applicationIdentifierSchema = z
  .string()
  .trim()
  .min(1, "Application identifier must not be empty");

export const validateApplicationIdentifier = (value: string): string =>
  applicationIdentifierSchema.parse(value);
