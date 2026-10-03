import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import { Loader2 } from "lucide-react"
import * as React from "react"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex min-w-0 max-w-full items-center justify-center gap-2 whitespace-normal text-center rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-10 px-4 py-2",
        sm: "min-h-9 rounded-md px-3 py-1.5",
        lg: "min-h-11 px-8 py-2",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  /**
   * While the button's action is in flight: disabled, aria-busy, and the
   * label says what is happening ("Saving…") beside a spinner that stops
   * under reduced motion, so a click is seen to do something and cannot be
   * repeated (Nielsen 1; Shneiderman: informative feedback). Ignored with
   * asChild, whose child owns its content.
   */
  busy?: boolean
  busyLabel?: string
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, busy = false, busyLabel, disabled, type, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    const content = busy && !asChild
      ? <><Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{busyLabel ?? children}</>
      : children
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || busy}
        aria-busy={busy || undefined}
        // A button submits the form it is in only when it says so (type="submit"): a pager, a retry or any other
        // control there never sends the form. With asChild the child, such as a link, is no button and keeps its own.
        type={asChild ? type : type ?? "button"}
        {...props}
      >
        {content}
      </Comp>
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
