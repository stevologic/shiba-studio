'use client';

import { usePathname } from 'next/navigation';
import StudioTerminalHost from '@/components/studio-terminal-host';
import VoiceAgentHost from '@/components/voice-agent-host';

/** Keep privileged local-only hosts out of the narrow Companion client. */
export function PrivilegedHostBoundary() {
  const pathname = usePathname();
  if (pathname.startsWith('/companion')) return null;
  return (
    <>
      <StudioTerminalHost />
      <VoiceAgentHost />
    </>
  );
}
