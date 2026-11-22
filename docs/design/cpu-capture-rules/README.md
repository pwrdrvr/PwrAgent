# CPU capture rules

[Standalone PwrAgent design export](pwragent-cpu-capture-rules.html)

The Capture rules field in Troubleshooting has two groups. High CPU remembers
Spike or Sustained. Slow burn is independent. Each of the three rules keeps
its own threshold and duration. One group must stay enabled, and Start Capture
and Stop Capture control whether the monitor is armed.

Thresholds are whole percentages of one CPU core, from 1 to 400 inclusive.
Sampling uses a two-second cadence unless a one-second Spike is enabled.
Every sample in a rule’s window must meet the threshold. A capture records
each rule that matches the sample that triggered it, with High CPU first.

A fresh profile uses Sustained at 50% over four seconds. The settings reader
carries forward a legacy single trigger and Slow burn threshold, and the writer
keeps a downgrade mirror. Explicit environment overrides appear alongside the
effective rule timing in Settings. Rule-only edits reset measurements and apply
in place while an active capture can finish.
