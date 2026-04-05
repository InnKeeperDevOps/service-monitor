import type { ReactNode } from "react";
import "./components.css";

interface CardProps {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function Card({ title, actions, children, className, style }: CardProps) {
  return (
    <div className={`sm-card${className ? ` ${className}` : ""}`} style={style}>
      {(title || actions) && (
        <div className="sm-card__header">
          {title && <h3 className="sm-card__title">{title}</h3>}
          {actions && <div>{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
