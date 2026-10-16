import type { ButtonHTMLAttributes } from 'react';

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'quiet' };

const VARIANTS = {
  primary: 'bg-ink text-bg hover:bg-gray-700 disabled:bg-gray-300 disabled:text-gray-600',
  quiet: 'border border-gray-200 bg-bg text-ink hover:border-gray-300 disabled:text-gray-500',
};

export function Button({ variant = 'quiet', className = '', type = 'button', ...rest }: Props) {
  return (
    <button
      type={type}
      className={`micro inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 transition-colors duration-200 disabled:cursor-not-allowed ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
