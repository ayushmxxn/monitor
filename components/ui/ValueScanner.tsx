import React, { useId, memo } from 'react';
import { cn } from '@/lib/utils';

interface ValueScannerProps {
  className?: string;
}

export const ValueScanner = memo(function ValueScanner({ className }: ValueScannerProps) {
  const rawId = useId();
  const gradId = `v-scan-grad-${rawId.replace(/[^a-zA-Z0-9-_]/g, '')}`;

  return (
    <span
      className={cn('inline-flex items-center justify-center relative select-none', className)}
      aria-hidden="true"
      data-testid="value-scanner"
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-full w-full overflow-visible"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.2" />
            <stop offset="50%" stopColor="currentColor" stopOpacity="1" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.2" />
          </linearGradient>
        </defs>

        {/* Reticle corner brackets */}
        <g className="v-scanner-reticle" style={{ transformOrigin: '8px 8px' }}>
          <path
            d="M 2.5 5.5 V 3.5 C 2.5 2.95 2.95 2.5 3.5 2.5 H 5.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path
            d="M 10.5 2.5 H 12.5 C 13.05 2.5 13.5 2.95 13.5 3.5 V 5.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path
            d="M 2.5 10.5 V 12.5 C 2.5 13.05 2.95 13.5 3.5 13.5 H 5.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <path
            d="M 10.5 13.5 H 12.5 C 13.05 13.5 13.5 13.05 13.5 12.5 V 10.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </g>

        {/* Center target dot */}
        <circle
          cx="8"
          cy="8"
          r="1.2"
          fill="currentColor"
          className="v-scanner-center"
          style={{ transformOrigin: '8px 8px' }}
        />

        {/* Active scanning laser beam */}
        <line
          x1="3"
          y1="8"
          x2="13"
          y2="8"
          stroke={`url(#${gradId})`}
          strokeWidth="1.3"
          strokeLinecap="round"
          className="v-scanner-beam"
          style={{ transformOrigin: '8px 8px' }}
        />
      </svg>
      <style>{`
        .v-scanner-reticle {
          animation: v-reticle-focus 1.6s ease-in-out infinite;
        }
        .v-scanner-beam {
          animation: v-scan-beam 1.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
        }
        .v-scanner-center {
          animation: v-center-ping 1.6s ease-in-out infinite;
        }
        @keyframes v-reticle-focus {
          0%, 100% {
            transform: scale(1);
            opacity: 0.65;
          }
          50% {
            transform: scale(0.92);
            opacity: 0.95;
          }
        }
        @keyframes v-scan-beam {
          0%, 100% {
            transform: translateY(-3.2px);
            opacity: 0.45;
          }
          50% {
            transform: translateY(3.2px);
            opacity: 1;
          }
        }
        @keyframes v-center-ping {
          0%, 100% {
            transform: scale(0.8);
            opacity: 0.35;
          }
          50% {
            transform: scale(1.25);
            opacity: 1;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .v-scanner-reticle,
          .v-scanner-beam,
          .v-scanner-center {
            animation: none !important;
            transform: none !important;
          }
          .v-scanner-reticle {
            opacity: 0.75;
          }
          .v-scanner-beam {
            opacity: 0.4;
          }
          .v-scanner-center {
            opacity: 0.8;
          }
        }
      `}</style>
    </span>
  );
});
