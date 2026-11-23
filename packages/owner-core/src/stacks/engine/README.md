# Stack engine

Copied from [PwrGit #648](https://github.com/pwrdrvr/PwrGit/pull/648) at
`58674528699f0048d960c94fda78eac86f168d4a`.

The engine uses the `GitRunner` and `CatalogStore` ports. PwrAgent owns the
`refs/pwragent/undo/` namespace and the host journal.
