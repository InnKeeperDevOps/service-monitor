import type { InputHTMLAttributes } from "react";
import "./components.css";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export function Input({ label, error, id, className, ...rest }: InputProps) {
  const inputId = id ?? (label ? `sm-input-${label.toLowerCase().replace(/\s+/g, "-")}` : undefined);
  return (
    <div className="sm-input-wrapper">
      {label && (
        <label className="sm-input-label" htmlFor={inputId}>
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={`sm-input${error ? " sm-input--error" : ""}${className ? ` ${className}` : ""}`}
        {...rest}
      />
      {error && <span className="sm-input-error">{error}</span>}
    </div>
  );
}
