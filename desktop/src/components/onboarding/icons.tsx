// Onboarding glyphs. Provider marks (GitHub / GitLab / Google) keep their
// real brand silhouettes so the sign-in row reads instantly; the rest are
// drawn on `currentColor` so they inherit Aura's text tokens. No external
// icon dependency — these are the only marks the first-run flow needs.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    ...props,
  };
}

export function GitHubMark({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...props}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

export function GitLabMark({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden {...props}>
      <path fill="#E24329" d="M8 15.2l2.95-9.07H5.05L8 15.2z" />
      <path fill="#FC6D26" d="M8 15.2L5.05 6.13H.92L8 15.2z" />
      <path fill="#FCA326" d="M.92 6.13L.02 8.88a.61.61 0 00.22.68L8 15.2.92 6.13z" />
      <path fill="#E24329" d="M.92 6.13h4.13L3.27.66a.31.31 0 00-.59 0L.92 6.13z" />
      <path fill="#FC6D26" d="M8 15.2l2.95-9.07h4.13L8 15.2z" />
      <path fill="#FCA326" d="M15.08 6.13l.9 2.75a.61.61 0 01-.22.68L8 15.2l7.08-9.07z" />
      <path fill="#E24329" d="M15.08 6.13h-4.13l1.78-5.47a.31.31 0 01.59 0l1.76 5.47z" />
    </svg>
  );
}

export function GoogleMark({ size = 18, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden {...props}>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 009 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 013.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 000 9c0 1.45.35 2.83.96 4.05l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 00.96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <svg {...base({ size: 20, ...props })}>
      <path
        d="M1.5 4.5A1.5 1.5 0 013 3h3.2l1.3 1.6H13a1.5 1.5 0 011.5 1.5v5.4A1.5 1.5 0 0113 13H3a1.5 1.5 0 01-1.5-1.5v-7z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base({ size: 14, ...props })}>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyRepoIcon(props: IconProps) {
  return (
    <svg {...base({ size: 18, ...props })}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 5.5v5M5.5 8h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function CloneIcon(props: IconProps) {
  return (
    <svg {...base({ size: 18, ...props })}>
      <circle cx="4.5" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="4.5" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.5" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 5.6v4.8M4.5 8h4.2a1.4 1.4 0 001.4-1.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function TemplateIcon(props: IconProps) {
  return (
    <svg {...base({ size: 18, ...props })}>
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 6.2h11M6.2 6.2v7.3" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function BackArrow(props: IconProps) {
  return (
    <svg {...base({ size: 15, ...props })}>
      <path d="M9.5 3.5L5 8l4.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Spinner({ size = 15, ...props }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="animate-spin" {...props}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
      <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base({ size: 14, ...props })}>
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
