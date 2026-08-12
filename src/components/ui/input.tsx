import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

/**
 * Single-line text input.
 *
 * Wraps Base UI's Input rather than a bare <input> so that a field placed inside a
 * Field gets its label, description and validation wiring for free - the same reason
 * button.tsx wraps ButtonPrimitive instead of styling <button>.
 *
 * `aria-invalid` drives the error ring, so callers signal a validation failure by
 * setting that attribute rather than by swapping className. A screen reader then
 * announces the invalid state; a red border alone says nothing to it.
 */
function Input({ className, ...props }: InputPrimitive.Props) {
  return (
    <InputPrimitive
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border border-border bg-background px-2.5 py-1 text-sm",
        "transition-[color,box-shadow] outline-none",
        "placeholder:text-muted-foreground/60",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        "dark:bg-input/30 dark:border-input dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
