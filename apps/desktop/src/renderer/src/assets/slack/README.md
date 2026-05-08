# Slack Brand Asset

`icon-color.svg` is the Slack app icon, downloaded from Wikimedia Commons'
mirror of the Slack logo asset. Slack's media kit points operators to the
Slack Brand Center for current logo files and usage rules:

https://slack.com/media-kit

Update procedure:

1. Re-download the current icon from Slack's Brand Center / media kit.
2. Replace `icon-color.svg` without recoloring or editing the mark.
3. Keep `SlackIcon.tsx` rendering it as an `<img>` so the asset stays a
   standalone brand file.
