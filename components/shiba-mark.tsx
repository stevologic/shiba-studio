// Monochrome line-art shiba (with sunglasses) drawn in the same stroke style
// as the lucide icon set — used where the brand mark should read as an icon,
// e.g. the Grok Chat empty-state orb.

interface ShibaMarkProps {
  size?: number;
  className?: string;
}

export default function ShibaMark({ size = 24, className }: ShibaMarkProps) {
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
      {/* ears */}
      <path d="M5.6 8.6 4.7 3.6l4.2 2" />
      <path d="M18.4 8.6l.9-5-4.2 2" />
      {/* crown between the ears */}
      <path d="M8.9 5.6c1-.5 2-.7 3.1-.7s2.1.2 3.1.7" />
      {/* head */}
      <path d="M5.6 8.6C4.6 10 4 11.5 4 13.1 4 17.5 7.5 20.6 12 20.6s8-3.1 8-7.5c0-1.6-.6-3.1-1.6-4.5" />
      {/* sunglasses */}
      <rect x="5.7" y="10.2" width="5" height="3.4" rx="1.1" />
      <rect x="13.3" y="10.2" width="5" height="3.4" rx="1.1" />
      <path d="M10.7 11.7h2.6" />
      {/* nose + smile */}
      <circle cx="12" cy="16.1" r="0.55" fill="currentColor" stroke="none" />
      <path d="M12 16.8c-.3.9-1.1 1.3-2 1.1" />
      <path d="M12 16.8c.3.9 1.1 1.3 2 1.1" />
    </svg>
  );
}
