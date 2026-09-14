import * as React from 'react';
import { cn } from '@/lib/utils';

const VARIANT_CLASS: Record<string, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 dark:hover:bg-accent',
  destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm',
  outline: 'border border-input bg-transparent hover:bg-accent hover:text-accent-foreground',
  ghost: 'hover:bg-accent hover:text-accent-foreground',
  link: 'text-foreground underline-offset-4 hover:underline',
};

const SIZE_CLASS: Record<string, string> = {
  default: 'h-9 px-4 py-2',
  sm: 'h-8 rounded-md px-3 text-xs',
  lg: 'h-10 rounded-md px-6',
  icon: 'h-8 w-8',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANT_CLASS;
  size?: keyof typeof SIZE_CLASS;
}

/**
 * Fully custom button - no Radix, no cva. Variants are plain lookup
 * tables so the whole thing stays a few hundred bytes of source and
 * zero runtime deps beyond `cn`.
 */
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium',
        'transition-[background-color,color,transform,opacity] duration-150 ease-out active:scale-[0.97]',
        'disabled:pointer-events-none disabled:opacity-40 disabled:active:scale-100',
        '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button };
