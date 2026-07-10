/**
 * Brand mark for the Grok Voice toggle — agent / shiba face with radio arcs.
 * Reads as "voice agent" rather than a generic speaker cone.
 */

interface GrokVoiceIconProps {
  size?: number;
  /** Hands-free voice mode is on */
  active?: boolean;
  className?: string;
}

export default function GrokVoiceIcon({
  size = 16,
  active = false,
  className,
}: GrokVoiceIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* Agent / shiba head (compact, lucide-weight) */}
      <path d="M7.2 9.2 6.5 5.2l3.2 1.6" />
      <path d="M16.8 9.2l.7-4-3.2 1.6" />
      <path d="M9.5 6.8c.8-.35 1.6-.5 2.5-.5s1.7.15 2.5.5" />
      <path d="M7.2 9.2C6.4 10.3 6 11.5 6 12.8 6 16.2 8.7 18.6 12 18.6s6-2.4 6-5.8c0-1.3-.4-2.5-1.2-3.6" />
      {/* Sunglasses */}
      <rect x="7" y="11" width="3.6" height="2.4" rx="0.8" />
      <rect x="13.4" y="11" width="3.6" height="2.4" rx="0.8" />
      <path d="M10.6 12.1h2.8" />
      {/* Nose */}
      <circle cx="12" cy="15.2" r="0.45" fill="currentColor" stroke="none" />

      {/* Voice / radio arcs — the "agent is listening & speaking" cue */}
      {active ? (
        <>
          <path d="M19.2 9.6c1.1 1.1 1.7 2.5 1.7 4s-.6 2.9-1.7 4" opacity="0.95" />
          <path d="M17.4 11.2c.55.6.85 1.35.85 2.2s-.3 1.6-.85 2.2" opacity="0.75" />
          <path d="M4.8 9.6C3.7 10.7 3.1 12.1 3.1 13.6s.6 2.9 1.7 4" opacity="0.95" />
          <path d="M6.6 11.2c-.55.6-.85 1.35-.85 2.2s.3 1.6.85 2.2" opacity="0.75" />
        </>
      ) : (
        <>
          {/* Quiet state: faint arcs + mute slash so it still reads as voice-capable */}
          <path d="M19.2 9.6c1.1 1.1 1.7 2.5 1.7 4s-.6 2.9-1.7 4" opacity="0.28" />
          <path d="M4.8 9.6C3.7 10.7 3.1 12.1 3.1 13.6s.6 2.9 1.7 4" opacity="0.28" />
          <path d="M4.5 4.5 19.5 19.5" opacity="0.85" />
        </>
      )}
    </svg>
  );
}
