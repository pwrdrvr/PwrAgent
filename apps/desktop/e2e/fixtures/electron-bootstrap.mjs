// Electron does not honor Node's --require preload option. Import the stubs
// before any application module can capture fetch or arm an update timer.
// Keep this entry in process.argv: profile helpers relaunch the same entry.
import "./github-release-stubs.cjs";
import "../../out/main/index.js";
