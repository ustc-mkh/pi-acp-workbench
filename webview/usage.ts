import type { ChatState } from '../src/shared';
export function contextUsage(usage: ChatState['usage']) {
  if (
    !usage ||
    !Number.isFinite(usage.used) ||
    !Number.isFinite(usage.size) ||
    usage.used < 0 ||
    usage.size <= 0
  ) {
    return { known: false, percent: 0, label: '上下文占用暂不可用' };
  }
  const format = (value: number) => `${Number((value / 1000).toFixed(1))}k`;
  return {
    known: true,
    percent: Math.min(100, (usage.used / usage.size) * 100),
    label: `${format(usage.used)}/${format(usage.size)}`,
  };
}
