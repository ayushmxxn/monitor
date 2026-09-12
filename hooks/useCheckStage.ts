import { useState, useEffect } from 'react';

export type CheckStage = 'connecting' | 'loading' | 'finding' | 'checking' | 'almost_there';

export interface CheckStageInfo {
  stage: CheckStage;
  text: string;
  atMs: number;
}

export const CHECK_STAGES: readonly CheckStageInfo[] = [
  { stage: 'connecting', text: 'Connecting…', atMs: 0 },
  { stage: 'loading', text: 'Loading page…', atMs: 800 },
  { stage: 'finding', text: 'Finding value…', atMs: 2200 },
  { stage: 'checking', text: 'Checking value…', atMs: 4200 },
  { stage: 'almost_there', text: 'Almost there…', atMs: 6500 },
] as const;

export function getCheckStageText(elapsedMs: number): string {
  for (let i = CHECK_STAGES.length - 1; i >= 0; i--) {
    if (elapsedMs >= CHECK_STAGES[i].atMs) {
      return CHECK_STAGES[i].text;
    }
  }
  return CHECK_STAGES[0].text;
}

export function useCheckStage(isActive: boolean): string | null {
  const [stageText, setStageText] = useState<string | null>(() =>
    isActive ? CHECK_STAGES[0].text : null,
  );

  useEffect(() => {
    if (!isActive) {
      setStageText(null);
      return;
    }

    setStageText(CHECK_STAGES[0].text);
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    for (let i = 1; i < CHECK_STAGES.length; i++) {
      const { text, atMs } = CHECK_STAGES[i];
      const timer = setTimeout(() => {
        setStageText(text);
      }, atMs);
      timers.push(timer);
    }

    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [isActive]);

  return isActive ? (stageText ?? CHECK_STAGES[0].text) : null;
}
