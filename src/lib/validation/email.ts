// Single fact source for the deliberately permissive mailbox shape. Keep this
// identical in spirit to the former admin/actions.ts EMAIL_SHAPE: one @, non-empty
// sides, at least one dot in the domain, no whitespace or list separators. A
// stricter regex rejects legitimate intranet addresses (D-150).
const EMAIL_SHAPE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function isLikelyEmailAddress(value: string): boolean {
  return EMAIL_SHAPE.test(value);
}
