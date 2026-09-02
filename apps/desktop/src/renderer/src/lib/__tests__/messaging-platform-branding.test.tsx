import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordIcon, MattermostIcon } from "../../icons";
import { MESSAGING_PLATFORM_ICONS } from "../messaging-platform-branding";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("MESSAGING_PLATFORM_ICONS", () => {
  it("uses the light-safe Discord blurple mark across shared surfaces", () => {
    const { container: blurpleContainer } = render(
      <DiscordIcon variant="blurple" />,
    );
    const blurpleSrc = blurpleContainer
      .querySelector("img")
      ?.getAttribute("src");
    cleanup();

    document.documentElement.setAttribute("data-theme", "light");
    const Discord = MESSAGING_PLATFORM_ICONS.discord;
    const { container } = render(Discord ? <Discord size={14} /> : null);

    expect(container.querySelector("img")).toHaveAttribute("src", blurpleSrc);
  });

  it("uses the light-safe Mattermost mark across shared messaging surfaces", () => {
    const { container: denimContainer } = render(
      <MattermostIcon variant="denim" />,
    );
    const denimSrc = denimContainer.querySelector("img")?.getAttribute("src");
    cleanup();

    document.documentElement.setAttribute("data-theme", "light");
    const Mattermost = MESSAGING_PLATFORM_ICONS.mattermost;
    const { container } = render(Mattermost ? <Mattermost size={14} /> : null);

    expect(container.querySelector("img")).toHaveAttribute("src", denimSrc);
  });
});
