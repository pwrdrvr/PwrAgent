import type { ReactElement } from "react";

/**
 * The sidebar's "reveal more rows" control.
 *
 * Every paging affordance in the rail routes through here. Seven of the twelve
 * call sites used to render a bare `<button>` with no class at all — both
 * sub-thread controls in DirectoriesList, both in RecentsList, and all three
 * lens controls in Sidebar — so they came out as native Chromium buttons: an
 * opaque grey slab, centre-aligned, stretched to the full width of the
 * `display: grid` list that held them. Beside a rail built from transparent
 * 12px text buttons, that read as the loudest element on screen.
 *
 * The five styled ones carried `directory-row__show-more`, a name that reads
 * as private to one parent, which is a good part of why nobody reached for it
 * from the other two files. The class is `sidebar-show-more` now and this
 * component is the only thing that applies it.
 */
export function SidebarShowMore(props: {
  label: string;
  onClick: () => void;
  /** In flight. Blocks the click and shows the control is working. */
  busy?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className="sidebar-show-more"
      // Load-bearing in the directories lens: `data-hover-stable-row="directory"`
      // wraps a whole directory including its paging controls, so the pointer
      // never leaves the frozen row on the way here and `onPointerOut` never
      // releases the snapshot — without this the rows the click just loaded
      // stay hidden until the pointer leaves the directory. In the flat lenses
      // the control sits outside any hover-stable row and the move releases on
      // its own; applied unconditionally so no call site has to know which it
      // is in. Five of the twelve were missing it.
      data-hover-stable-release="pagination"
      // Reported instead of a label swap: the visible text is the accessible
      // name here, so renaming it to "Loading…" mid-flight would move the
      // control out from under anyone searching for it by name.
      aria-busy={props.busy ? true : undefined}
      // `aria-disabled`, not `disabled`, per the house pattern in
      // `FederationTargetMenuSection` and `NewThreadButton`. Disabling a
      // FOCUSED control blurs it: the browser moves focus to `body` the
      // moment the property lands and clearing it puts focus back nowhere.
      // A page arrives in well under a second, so a keyboard user who
      // pressed this and kept hold of it was dropped out of the rail
      // entirely — with the rows they had just asked for now somewhere above
      // them and nothing on screen to say why. Measured at an 88ms busy
      // window on the Star Map's equivalent chip (pwrdrvr/PwrAgent#2176);
      // every one of this component's call sites had the same defect.
      aria-disabled={props.busy || undefined}
      onClick={() => {
        // `aria-disabled` does not stop a real click the way the property
        // did, so the block this prop promises has to live here.
        if (props.busy) return;
        props.onClick();
      }}
    >
      {props.label}
    </button>
  );
}
