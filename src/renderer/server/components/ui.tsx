/** Small shared UI primitives for Server Mode. Compact appliance aesthetic. */

import React, { useEffect, useRef } from "react";
import type { SimpleHealthState } from "../bridge/types";

/* --------------------------------- status dot -------------------------------- */

const DOT_TONES: Record<SimpleHealthState, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
  unknown: "bg-zinc-400 dark:bg-zinc-600",
};

export function StatusDot({
  state,
  className = "",
}: {
  state: SimpleHealthState;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${DOT_TONES[state]} ${className}`}
    />
  );
}

/* ----------------------------------- button ---------------------------------- */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-blue-600 text-white hover:bg-blue-500 focus-visible:outline-blue-600 disabled:bg-blue-300 dark:disabled:bg-blue-900",
  secondary:
    "bg-zinc-100 text-zinc-800 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700",
  ghost:
    "bg-transparent text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
  danger: "bg-red-600 text-white hover:bg-red-500",
};

export function Button({
  variant = "secondary",
  className = "",
  type = "button",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}

/* ------------------------------------ card ----------------------------------- */

export function Card({
  children,
  className = "",
  ...rest
}: React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={`rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${className}`}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
      {children}
    </h2>
  );
}

/* --------------------------------- progress bar ------------------------------- */

export function ProgressBar({
  value,
  label,
  tone = "normal",
}: {
  value: number;
  label?: string;
  tone?: "normal" | "alert";
}) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="h-2.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-500 ${
          tone === "alert" ? "bg-red-500" : "bg-blue-500"
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ---------------------------------- text field -------------------------------- */

export function TextField({
  label,
  id,
  hint,
  className = "",
  ...rest
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; hint?: string }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-zinc-700 dark:text-zinc-300">
        {label}
      </label>
      <input
        id={id}
        className={`block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder-zinc-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 ${
          rest.type === "password" ? "font-mono" : ""
        }`}
        {...rest}
      />
      {hint ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
    </div>
  );
}

/* ----------------------------------- toggle ----------------------------------- */

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  ...rest
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
} & Omit<React.HTMLAttributes<HTMLButtonElement>, "onChange" | "disabled" | "aria-checked" | "role">) {
  return (
    <label className={`flex items-start justify-between gap-4 ${disabled ? "opacity-50" : ""}`}>
      <span>
        <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{description}</span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${
          checked ? "bg-blue-600" : "bg-zinc-300 dark:bg-zinc-700"
        }`}
        {...rest}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-4" : ""
          }`}
        />
      </button>
    </label>
  );
}

/* ------------------------------------ modal ----------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Move focus into the dialog when it opens (A11Y): first focusable
    // element, falling back to the panel itself (focusable via tabIndex).
    const panel = panelRef.current;
    if (panel) {
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusables[0] ?? panel).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, input, [href], [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`max-h-[85vh] w-full overflow-y-auto ${wide ? "max-w-lg" : "max-w-md"} rounded-xl border border-zinc-200 bg-white p-5 shadow-xl outline-none dark:border-zinc-700 dark:bg-zinc-900`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close dialog" className="px-2 py-1">
            ✕
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------ banner ---------------------------------- */

export function Banner({
  tone,
  children,
  actions,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & {
  tone: "warn" | "error" | "info";
  actions?: React.ReactNode;
}) {
  const tones = {
    warn: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200",
    error: "border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200",
    info: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200",
  } as const;
  return (
    <div
      role={tone === "info" ? "status" : "alert"}
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}
      {...rest}
    >
      <div>{children}</div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------- row ------------------------------------ */

export function StatusRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: SimpleHealthState;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="flex items-center gap-2 font-medium text-zinc-700 dark:text-zinc-300">
        <StatusDot state={state} />
        {label}
      </span>
      <span className="text-zinc-600 dark:text-zinc-400">{detail}</span>
    </div>
  );
}
