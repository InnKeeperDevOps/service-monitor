import type { ReactNode } from "react";
import "./components.css";

type BadgeVariant = "success" | "warning" | "danger" | "info" | "muted";

interface BadgeProps {
  variant: BadgeVariant;
  children: ReactNode;
}

export function Badge({ variant, children }: BadgeProps) {
  return (
    <span className={`sm-badge sm-badge--${variant}`}>
      {children}
    </span>
  );
}
