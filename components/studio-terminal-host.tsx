'use client';

/**
 * Root-layout mount for the Studio terminal so the shell UI survives
 * client navigations between /chat, /agents, etc.
 */
import dynamic from 'next/dynamic';

const StudioTerminal = dynamic(() => import('@/components/studio-terminal'), {
  ssr: false,
});

export default function StudioTerminalHost() {
  return <StudioTerminal />;
}
