# Discord brand assets

The SVG files in this directory are **official, unaltered** Discord
Symbol variants from Discord's downloadable brand assets:

- `symbol-white.svg` - white Symbol for dark surfaces
- `symbol-black.svg` - black Symbol for light surfaces
- `symbol-blurple.svg` - Blurple Symbol (`#5865F2`)

## Source

- Brand guidelines: <https://discord.com/branding?lang=en>
- Brand kit: <https://my.corebook.io/1zObrQ89Q4wHhgFCfYIUhMUvmNf4XjxO?access_token=0VvKnNkZ891L2IQ34uW6F5TdAJDzRtBcqpxgYSrOebshwlHmXafPCMGU7Eoijy>
- White Symbol zip: <https://cdn.discordapp.com/assets/content/80af2c38f13b4a7d2cb3572e1220f6e958d3c3aedccc7c7d3ddc9832f6b3d725.zip>
- Black Symbol zip: <https://cdn.discordapp.com/assets/content/aecd9009fd6a24c06c8ce71f6bb84463eaf7252bc5259022fb887b381a428250.zip>
- Blurple Symbol zip: <https://cdn.discordapp.com/assets/content/a736b95923ddbc155e828651c92471292e40727655d770a06cec89c48ba0b41f.zip>

## Usage rules

Discord's branding page allows digital use of Discord marks to inform
people that you use Discord or to direct users to a Discord server,
provided the use follows the guidelines and does not imply Discord
sponsorship or representation.

Discord publishes the logo in color, black, and white, and says not to
edit, change, distort, recolor, or reconfigure it. The page also says
the Symbol should be used only when the Discord brand is clearly visible
or has been established elsewhere.

PwrAgent uses the Symbol only inside explicit messaging-platform UI:
Settings labels, connection-test rows, status chips with accessible
platform labels, activity rows, and thread binding chips with tooltips.
The full wordmark is too small to read at 12-14px. We therefore render
Discord's official Symbol SVGs verbatim via `<img>`, do not apply
`currentColor`, CSS filters, effects, or path edits, and default to the
white variant on the desktop app's dark surfaces.

## Updating these files

If Discord publishes new Symbol assets, update by re-downloading from
the source above rather than editing the existing files:

```bash
rm -rf /tmp/discord-brand
mkdir -p /tmp/discord-brand
curl -sSL -o /tmp/discord-symbol-white.zip "https://cdn.discordapp.com/assets/content/80af2c38f13b4a7d2cb3572e1220f6e958d3c3aedccc7c7d3ddc9832f6b3d725.zip"
curl -sSL -o /tmp/discord-symbol-black.zip "https://cdn.discordapp.com/assets/content/aecd9009fd6a24c06c8ce71f6bb84463eaf7252bc5259022fb887b381a428250.zip"
curl -sSL -o /tmp/discord-symbol-blurple.zip "https://cdn.discordapp.com/assets/content/a736b95923ddbc155e828651c92471292e40727655d770a06cec89c48ba0b41f.zip"
unzip -q /tmp/discord-symbol-white.zip -d /tmp/discord-brand
unzip -q /tmp/discord-symbol-black.zip -d /tmp/discord-brand
unzip -q /tmp/discord-symbol-blurple.zip -d /tmp/discord-brand
cp /tmp/discord-brand/Discord_Symbol_White/Discord-Symbol-White.svg ./symbol-white.svg
cp /tmp/discord-brand/Discord_Symbol_Black/Discord-Symbol-Black.svg ./symbol-black.svg
cp /tmp/discord-brand/Discord_Symbol_Color/Discord-Symbol-Blurple.svg ./symbol-blurple.svg
```

If any zip URL changes, start from Discord's brand page or Corebook
brand kit and download the Symbol files again.
