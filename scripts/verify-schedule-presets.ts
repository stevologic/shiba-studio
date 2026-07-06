import {
  presetToCron,
  cronToPreset,
  describeCron,
  schedulesForSave,
} from '../lib/schedule-presets';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(presetToCron('every_15m') === '*/15 * * * *', 'every_15m');
assert(presetToCron('daily', '14:30') === '30 14 * * *', 'daily time');
assert(presetToCron('weekdays', '08:00') === '0 8 * * 1-5', 'weekdays');

assert(cronToPreset('*/30 * * * *').preset === 'every_30m', 'detect 30m');
assert(cronToPreset('30 14 * * *').preset === 'daily', 'detect daily');
assert(cronToPreset('0 8 * * 1-5').time === '08:00', 'detect weekday time');

assert(describeCron('*/15 * * * *') === 'Every 15 minutes', 'describe interval');
assert(describeCron('0 9 * * 1-5') === 'Weekdays only at 09:00', 'describe weekdays');

const saved = schedulesForSave([
  { id: 'a', enabled: true, cron: 'old', instructions: 'x', _preset: 'every_hour' },
]);
assert(saved[0].cron === '0 * * * *', 'schedulesForSave');

console.log('verify-schedule-presets: OK');