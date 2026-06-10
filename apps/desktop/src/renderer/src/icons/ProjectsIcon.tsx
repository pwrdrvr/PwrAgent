import { resolveIconSvgProps, type IconProps } from "./icon-types";

/** Stacked folders — the cross-repo "linked projects" surface. */
export function ProjectsIcon(props: IconProps) {
  return (
    <svg {...resolveIconSvgProps(props)}>
      <path d="M3 8.5a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M7 6.5V5a2 2 0 0 1 2-2h3l2 2h3a2 2 0 0 1 2 2v1.5" />
    </svg>
  );
}
