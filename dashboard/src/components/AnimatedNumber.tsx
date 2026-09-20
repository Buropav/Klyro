import { useEffect, useState } from 'react';
import { useSpring, useMotionValueEvent } from 'motion/react';
import { cn } from '@/lib/utils';

export type AnimatedNumberUnit = 'ms' | '%' | 'req/s' | 'count' | 'none';

export interface AnimatedNumberProps {
  /** Target value to animate to. Changing this counts up or down from the current displayed value. */
  value: number;
  /** Starting value to animate FROM on mount (e.g. a baseline value, so the "after" number visibly counts in). Defaults to `value` (no animation on mount). */
  initialValue?: number;
  unit?: AnimatedNumberUnit;
  /** Decimal places to display. Defaults per-unit (0 for count/req-s-ish integers, 2 for ms/%). */
  decimals?: number;
  className?: string;
  /** Spring stiffness/damping preset — "snappy" for small deltas, "smooth" for large jumps like p95 before/after. */
  motionPreset?: 'snappy' | 'smooth';
}

const UNIT_SUFFIX: Record<AnimatedNumberUnit, string> = {
  ms: ' ms',
  '%': '%',
  'req/s': ' req/s',
  count: '',
  none: '',
};

const DEFAULT_DECIMALS: Record<AnimatedNumberUnit, number> = {
  ms: 1,
  '%': 1,
  'req/s': 1,
  count: 0,
  none: 0,
};

const SPRING_PRESETS = {
  snappy: { stiffness: 140, damping: 18, mass: 0.6 },
  smooth: { stiffness: 60, damping: 16, mass: 0.9 },
};

/**
 * Count-up/count-down numeric readout. Every metric value in the
 * dashboard should render through this instead of a plain string, per
 * CLAUDE.md's Dashboard section (font-mono for every numeric value).
 */
export function AnimatedNumber({
  value,
  initialValue,
  unit = 'none',
  decimals,
  className,
  motionPreset = 'snappy',
}: AnimatedNumberProps) {
  const resolvedDecimals = decimals ?? DEFAULT_DECIMALS[unit];
  const startValue = initialValue ?? value;
  const spring = useSpring(startValue, SPRING_PRESETS[motionPreset]);
  const [display, setDisplay] = useState(startValue);

  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  useMotionValueEvent(spring, 'change', (latest) => {
    setDisplay(latest);
  });

  const formatted = Number.isFinite(display)
    ? display.toLocaleString(undefined, {
        minimumFractionDigits: resolvedDecimals,
        maximumFractionDigits: resolvedDecimals,
      })
    : '—';

  return (
    <span className={cn('font-mono tabular-nums', className)}>
      {formatted}
      {UNIT_SUFFIX[unit]}
    </span>
  );
}
