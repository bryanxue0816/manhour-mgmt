import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"

import { cn } from "@/lib/utils"

/**
 * Checkbox with a check indicator.
 *
 * Base UI renders the box as a <span> with the real input hidden, which is why this is
 * a wrapper rather than a styled <input type="checkbox">: it keeps the native form and
 * a11y semantics (role, keyboard, form submission) while allowing the box itself to be
 * styled, something a native checkbox does not reliably permit across browsers.
 *
 * The indicator is rendered as inline SVG rather than pulling in an icon dependency for
 * one glyph. It is hidden until `data-checked`, so the unchecked box is genuinely empty
 * rather than holding a transparent mark that would still be read by some tooling.
 *
 * NOTE for callers: a checkbox alone is not a label. Every use on /admin pairs it with
 * visible text stating what each state means ("排除" / "计入"), because colour and a
 * tick shape carry no meaning for a screen-reader user and little for a colour-blind
 * one - the same rule D-124's status dots follow.
 */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background",
        "transition-[color,box-shadow,background-color] outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground",
        "disabled:pointer-events-none disabled:opacity-50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        "dark:bg-input/30 dark:border-input",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
        <svg
          viewBox="0 0 14 14"
          fill="none"
          aria-hidden="true"
          className="size-3"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M2.5 7.5L5.5 10.5L11.5 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
