import { createContext } from "react";
import type { DesktopAppearanceDensity } from "@pwragent/shared";

/**
 * The density thread rows render for. CSS does the hiding (see the density
 * rules in app.css); this only tells a row whether to mount Minimal's PR
 * rollup chip, so other densities carry no second PR chip in the DOM. The
 * app provides the operator's density; each density preview provides its own.
 */
export const ThreadRowDensityContext =
  createContext<DesktopAppearanceDensity>("mission-control");
