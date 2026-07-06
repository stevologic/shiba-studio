import { NextResponse } from 'next/server';
import { buildGlobalUploadsChatContext, listGlobalUploadFiles } from '@/lib/workspace';

export async function GET() {
  const files = await listGlobalUploadFiles();
  const context = await buildGlobalUploadsChatContext();
  return NextResponse.json({ ok: true, context, fileCount: files.length });
}