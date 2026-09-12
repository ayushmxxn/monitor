import React, { useEffect, useRef, useState, memo } from "react";
import { cn } from "@/lib/utils";

export interface SpinningCounterProps {
  /** The full formatted value string to render (e.g. "$77,334.64", "54.55%", "1.3M"). */
  value: string | null | undefined;
  /** Optional head part if the integer portion is styled separately from decimal tail. */
  head?: string | null;
  /** Optional tail part (e.g. ".64") styled with muted color. */
  tail?: string | null;
  /** Custom class for the tail characters (defaults to "text-muted-foreground"). */
  tailClassName?: string;
  /** Optional class for the outer counter container. */
  className?: string;
  /** When true (e.g. while actively scrubbing a chart), animation is skipped. */
  disabled?: boolean;
  /**
   * Timestamp or identifier of the last check (e.g. `monitor.lastCheckedAt`).
   * When provided, animation will ONLY trigger if a new check has actually completed.
   */
  lastCheckedAt?: number | null;
}

const STAGGER_MS = 70;
const DURATION_MS = 1400;
const REEL_SPINS = 3;

/**
 * Transitions.dev "Spinning counter" (P26) component.
 *
 * Each digit reel clips a vertical strip of 0-9 digits that spins multiple loops
 * with Transitions.dev easing cubic-bezier(0.16, 1, 0.3, 1) and decelerates onto
 * the target digit.
 *
 * Invariants:
 * - Animates ONLY when a successful check produces a genuinely different value.
 * - Never animates on click, hover, focus, scrubbing, re-render, navigation, or initial load.
 * - Symbols and decimals stay completely stable.
 * - Respects prefers-reduced-motion.
 * - Zero layout shift.
 */
export const SpinningCounter = memo(function SpinningCounter({
  value,
  head,
  tail,
  tailClassName = "text-muted-foreground",
  className,
  disabled = false,
  lastCheckedAt,
}: SpinningCounterProps) {
  const isFirstRender = useRef(true);
  const prevValueRef = useRef(value);
  const prevCheckedAtRef = useRef(lastCheckedAt);
  const prevDigitsRef = useRef<number[]>([]);
  const [isSpinning, setIsSpinning] = useState(false);
  const [animKey, setAnimKey] = useState(0);

  // Extract digits from a value string
  function extractDigits(val: string | null | undefined): number[] {
    if (!val) return [];
    const digits: number[] = [];
    for (let i = 0; i < val.length; i++) {
      const ch = val[i];
      if (ch >= "0" && ch <= "9") {
        digits.push(parseInt(ch, 10));
      }
    }
    return digits;
  }

  useEffect(() => {
    // 1. Never animate on initial render
    if (isFirstRender.current) {
      isFirstRender.current = false;
      prevValueRef.current = value;
      prevCheckedAtRef.current = lastCheckedAt;
      prevDigitsRef.current = extractDigits(value);
      return;
    }

    // When lastCheckedAt is tracked, animation ONLY triggers if a check completed
    const checkOccurred =
      lastCheckedAt !== undefined
        ? lastCheckedAt !== prevCheckedAtRef.current && lastCheckedAt !== null
        : true;

    // 2. Animate ONLY when a check has occurred AND value is genuinely different
    const isDifferent = value !== prevValueRef.current && value != null;

    if (!disabled && checkOccurred && isDifferent) {
      const oldDigits = prevDigitsRef.current;
      prevValueRef.current = value;
      prevCheckedAtRef.current = lastCheckedAt;
      prevDigitsRef.current = extractDigits(value);

      setIsSpinning(true);
      setAnimKey((k) => k + 1);

      const digitCount = prevDigitsRef.current.length;
      const totalTime = Math.max(0, digitCount - 1) * STAGGER_MS + DURATION_MS + 60;
      const timer = window.setTimeout(() => {
        setIsSpinning(false);
      }, totalTime);

      return () => window.clearTimeout(timer);
    } else {
      prevValueRef.current = value;
      prevCheckedAtRef.current = lastCheckedAt;
      prevDigitsRef.current = extractDigits(value);
      setIsSpinning(false);
    }
  }, [value, disabled, lastCheckedAt]);

  if (!value) {
    return null;
  }

  // Render a segment of characters (e.g. head or tail or full value)
  function renderSegmentContent(
    text: string,
    keyPrefix: string,
    digitStartIndex: number,
    segmentClassName?: string,
  ): { elements: React.ReactNode; digitCount: number } {
    let currentDigitIndex = digitStartIndex;
    const elements: React.ReactNode[] = [];

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch >= "0" && ch <= "9") {
        const targetDigit = parseInt(ch, 10);
        const prevDigit = prevDigitsRef.current[currentDigitIndex] ?? 0;
        const delay = currentDigitIndex * STAGGER_MS;
        currentDigitIndex++;

        if (isSpinning) {
          const delta = (targetDigit - prevDigit + 10) % 10;
          const totalSteps = REEL_SPINS * 10 + delta;
          const cells: number[] = [];
          for (let k = 0; k <= totalSteps; k++) {
            cells.push((prevDigit + k) % 10);
          }

          elements.push(
            <span
              key={`${keyPrefix}-col-${i}`}
              className={cn("t-counter-col is-spinning", segmentClassName)}
            >
              <span className="sr-only">{targetDigit}</span>
              <span
                key={animKey}
                aria-hidden="true"
                className="t-counter-strip"
                style={{
                  ["--delay" as string]: `${delay}ms`,
                  ["--target-y" as string]: `-${totalSteps * 1.1}em`,
                }}
              >
                {cells.map((digit, cIdx) => (
                  <span
                    key={cIdx}
                    className="t-counter-digit"
                    data-digit={digit}
                  />
                ))}
              </span>
            </span>,
          );
        } else {
          elements.push(
            <span
              key={`${keyPrefix}-col-${i}`}
              className={cn("t-counter-col", segmentClassName)}
            >
              <span className="sr-only">{targetDigit}</span>
              <span
                aria-hidden="true"
                className="t-counter-digit"
                data-digit={targetDigit}
              />
            </span>,
          );
        }
      } else {
        // Symbols, decimals, spaces, units stay stable
        elements.push(
          <span
            key={`${keyPrefix}-sep-${i}`}
            className={cn("t-counter-sep", segmentClassName)}
          >
            {ch}
          </span>,
        );
      }
    }

    return {
      elements,
      digitCount: currentDigitIndex - digitStartIndex,
    };
  }

  // When head and tail are provided, style head and tail independently
  if (head != null && tail != null) {
    const headResult = renderSegmentContent(head, "h", 0);
    const tailResult = renderSegmentContent(
      tail,
      "t",
      headResult.digitCount,
      tailClassName,
    );

    return (
      <span
        className={cn(
          "t-counter",
          isSpinning && "is-spinning",
          className,
        )}
      >
        <span>{headResult.elements}</span>
        <span className={cn("text-muted-foreground", tailClassName)}>
          {tailResult.elements}
        </span>
      </span>
    );
  }

  // Otherwise render all characters of the complete formatted value
  const fullResult = renderSegmentContent(value, "f", 0);
  return (
    <span
      className={cn("t-counter", isSpinning && "is-spinning", className)}
    >
      <span>{fullResult.elements}</span>
    </span>
  );
});

export const NumberPopIn = SpinningCounter;
