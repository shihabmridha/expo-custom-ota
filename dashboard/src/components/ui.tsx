import type { ReactNode } from 'react';

/**
 * A handful of local primitives.
 *
 * Deliberately not a design system: the admin UI is operational, and a
 * component library would be more infrastructure than the screens justify.
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{description}</p>
        )}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900',
  secondary:
    'border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800',
  danger: 'bg-red-600 text-white hover:bg-red-700',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  errors,
  children,
}: {
  label: string;
  hint?: string;
  errors?: string[];
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children and does wrap correctly at runtime.
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
      {errors?.map((error) => (
        <span key={error} className="mt-1 block text-xs text-red-600">
          {error}
        </span>
      ))}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-400"
      {...props}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className="w-full rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
      {...props}
    />
  );
}

const BADGE_STYLES: Record<string, string> = {
  draft: 'bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-200',
  published: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  archived: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
  ready: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  processing: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  uploaded: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  assets_uploaded: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
};

export function Badge({ value }: { value: string }) {
  const style = BADGE_STYLES[value] ?? 'bg-neutral-200 text-neutral-800 dark:bg-neutral-700';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${style}`}>
      {value.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm whitespace-pre-wrap text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
      {children}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center dark:border-neutral-700">
      <p className="font-medium">{title}</p>
      {hint && <p className="mt-1 text-sm text-neutral-500">{hint}</p>}
    </div>
  );
}

/** A copyable code block — most of this UI exists to hand over config snippets. */
export function CopyBlock({ value, label }: { value: string; label?: string }) {
  return (
    <div className="relative">
      {label && <div className="mb-1 text-sm font-medium">{label}</div>}
      <pre className="max-h-96 overflow-auto rounded-md border border-neutral-200 bg-neutral-100 p-3 font-mono text-xs dark:border-neutral-800 dark:bg-neutral-950">
        {value}
      </pre>
      <Button
        className="absolute top-0 right-0"
        onClick={() => void navigator.clipboard.writeText(value)}
      >
        Copy
      </Button>
    </div>
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}
