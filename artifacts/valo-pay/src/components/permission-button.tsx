import React, { useId } from 'react';
import { Button, type ButtonProps } from './ui/button';
import { permissionReason, type PermissionRequest } from '@/lib/permissions';
import { useWorkspace } from '@/lib/workspace-context';

/** Keep the unavailable action discoverable, with a visible, accessible explanation. */
export const PermissionButton = React.forwardRef<HTMLButtonElement, ButtonProps & PermissionRequest>(
  ({ action, kind, record, payment, instalment, children, ...props }, ref) => {
    const { workspace } = useWorkspace();
    const reason = permissionReason(workspace, { action, kind, record, payment, instalment });
    const id = useId();
    if (!reason) return <Button ref={ref} {...props}>{children}</Button>;
    return <span className="inline-flex max-w-64 flex-col items-start gap-1 align-top">
      {/* aria-disabled keeps the control in the tab order, so a keyboard or screen-reader user reaches the reason. */}
      <Button ref={ref} {...props} aria-disabled="true" className={`${props.className ?? ''} opacity-50 cursor-not-allowed`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} aria-describedby={[props['aria-describedby'], id].filter(Boolean).join(' ')}>{children}</Button>
      <span id={id} className="whitespace-normal text-left text-xs font-normal leading-snug text-muted-foreground">{reason}</span>
    </span>;
  }
);
PermissionButton.displayName = 'PermissionButton';
