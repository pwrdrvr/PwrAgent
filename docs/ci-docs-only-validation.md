# Documentation-only CI validation

This temporary document exercises the documentation-only pull-request path in
the CI workflow. Its validation pull request targets the workflow change branch,
so the pull request's complete diff relative to its base contains documentation
only while GitHub evaluates the modified workflow.

The validation pull request is disposable and must not be merged.
