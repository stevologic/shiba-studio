import { NextResponse } from 'next/server';
import { initScheduler, loadAndScheduleAll } from '@/lib/scheduler';
import { loadConfig } from '@/lib/persistence';

export async function GET() {
  // Ensure Grok key is loaded
  await loadConfig();
  // Start the scheduler
  initScheduler();
  await loadAndScheduleAll();
  return NextResponse.json({ ok: true, scheduler: 'running' });
}
