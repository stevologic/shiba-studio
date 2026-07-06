/**
 * Human-friendly schedule presets → cron (node-cron compatible).
 * UI uses presets; persisted agents still store cron strings.
 */

export type SchedulePresetId =
  | 'every_5m'
  | 'every_15m'
  | 'every_30m'
  | 'every_hour'
  | 'every_2h'
  | 'every_6h'
  | 'every_12h'
  | 'daily'
  | 'weekdays'
  | 'custom';

export interface SchedulePreset {
  id: SchedulePresetId;
  label: string;
  hint: string;
  needsTime?: boolean;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  { id: 'every_5m', label: 'Every 5 minutes', hint: 'Runs often — good for light checks' },
  { id: 'every_15m', label: 'Every 15 minutes', hint: 'Balanced for routine tasks' },
  { id: 'every_30m', label: 'Every 30 minutes', hint: 'Default for most automations' },
  { id: 'every_hour', label: 'Every hour', hint: 'On the hour, every hour' },
  { id: 'every_2h', label: 'Every 2 hours', hint: 'Twelve times per day' },
  { id: 'every_6h', label: 'Every 6 hours', hint: 'Four times per day' },
  { id: 'every_12h', label: 'Every 12 hours', hint: 'Twice per day' },
  { id: 'daily', label: 'Once a day', hint: 'Pick a time below', needsTime: true },
  { id: 'weekdays', label: 'Weekdays only', hint: 'Monday–Friday at your chosen time', needsTime: true },
  { id: 'custom', label: 'Custom (advanced)', hint: 'Raw cron expression for power users' },
];

const CRON_BY_PRESET: Record<Exclude<SchedulePresetId, 'daily' | 'weekdays' | 'custom'>, string> = {
  every_5m: '*/5 * * * *',
  every_15m: '*/15 * * * *',
  every_30m: '*/30 * * * *',
  every_hour: '0 * * * *',
  every_2h: '0 */2 * * *',
  every_6h: '0 */6 * * *',
  every_12h: '0 */12 * * *',
};

export function parseTime24(time: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time?.trim() || '');
  if (!m) return { hour: 9, minute: 0 };
  const hour = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const minute = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return { hour, minute };
}

export function formatTime24(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function presetToCron(preset: SchedulePresetId, time = '09:00', customCron?: string): string {
  if (preset === 'custom') return (customCron || '*/30 * * * *').trim();
  if (preset === 'daily' || preset === 'weekdays') {
    const { hour, minute } = parseTime24(time);
    const dow = preset === 'weekdays' ? '1-5' : '*';
    return `${minute} ${hour} * * ${dow}`;
  }
  return CRON_BY_PRESET[preset];
}

export interface CronPresetMatch {
  preset: SchedulePresetId;
  time?: string;
  customCron?: string;
}

export function cronToPreset(cron: string): CronPresetMatch {
  const c = (cron || '').trim();
  for (const [preset, expr] of Object.entries(CRON_BY_PRESET) as [Exclude<SchedulePresetId, 'daily' | 'weekdays' | 'custom'>, string][]) {
    if (c === expr) return { preset };
  }

  const daily = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(c);
  if (daily) {
    return { preset: 'daily', time: formatTime24(parseInt(daily[2], 10), parseInt(daily[1], 10)) };
  }

  const weekdays = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+1-5$/.exec(c);
  if (weekdays) {
    return { preset: 'weekdays', time: formatTime24(parseInt(weekdays[2], 10), parseInt(weekdays[1], 10)) };
  }

  return { preset: 'custom', customCron: c || '*/30 * * * *' };
}

export function describeCron(cron: string): string {
  const { preset, time, customCron } = cronToPreset(cron);
  const meta = SCHEDULE_PRESETS.find(p => p.id === preset);
  if (preset === 'custom') return customCron || cron || 'Custom schedule';
  if ((preset === 'daily' || preset === 'weekdays') && time) {
    return `${meta?.label ?? preset} at ${time}`;
  }
  return meta?.label ?? cron;
}

/** UI-only fields attached to schedule rows in the agent form */
export interface ScheduleFormEntry {
  id: string;
  enabled: boolean;
  cron: string;
  instructions: string;
  _preset?: SchedulePresetId;
  _time?: string;
  _customCron?: string;
}

export function enrichScheduleForForm(entry: ScheduleFormEntry): ScheduleFormEntry {
  const match = cronToPreset(entry.cron);
  return {
    ...entry,
    _preset: entry._preset ?? match.preset,
    _time: entry._time ?? match.time ?? '09:00',
    _customCron: entry._customCron ?? match.customCron ?? entry.cron,
  };
}

export function schedulesForSave(schedules: ScheduleFormEntry[]) {
  return schedules.map(({ _preset, _time, _customCron, ...rest }) => {
    const preset = _preset ?? cronToPreset(rest.cron).preset;
    const time = _time ?? '09:00';
    const cron =
      preset === 'custom'
        ? (_customCron || rest.cron || '*/30 * * * *').trim()
        : presetToCron(preset, time, _customCron);
    return { ...rest, cron };
  });
}

export function defaultScheduleEntry(): ScheduleFormEntry {
  return enrichScheduleForForm({
    id: 's' + Date.now(),
    enabled: false,
    cron: presetToCron('every_30m'),
    instructions: 'Run scheduled task with your skills.',
  });
}