/**
 * Where each Slack credential lives, named the way Slack's app settings name
 * it. The bot token appears on Install App only after installing, and the
 * app-level token needs exactly one scope, picked in a dialog; the old
 * one-line checklist said neither.
 *
 * Slack's own labels are bold so they can be matched against the page.
 */
export function SlackBotTokenSteps() {
  return (
    <ol className="slack-connect__checklist">
      <li>
        In your Slack app&rsquo;s sidebar, under <strong>Settings</strong>,
        open <strong>Install App</strong>.
      </li>
      <li>
        Click <strong>Install to Workspace</strong>, then{" "}
        <strong>Allow</strong>.
      </li>
      <li>
        Under <strong>OAuth Tokens</strong>, copy the{" "}
        <strong>Bot User OAuth Token</strong>. It starts with{" "}
        <code>xoxb-</code>.
      </li>
    </ol>
  );
}

export function SlackAppTokenSteps() {
  return (
    <ol className="slack-connect__checklist">
      <li>
        Open <strong>Basic Information</strong> and find{" "}
        <strong>App-Level Tokens</strong>.
      </li>
      <li>
        Click <strong>Generate Token and Scopes</strong> and name the token,
        e.g. <code>PwrAgent Socket Mode</code>.
      </li>
      <li>
        Click <strong>Add Scope</strong> and choose{" "}
        <code>connections:write</code>. It is the only scope this token needs.
      </li>
      <li>
        Click <strong>Generate</strong> and copy the token. It starts with{" "}
        <code>xapp-</code>.
      </li>
    </ol>
  );
}

/**
 * Socket Mode does not need Slack's signing secret; PwrAgent signs the buttons
 * it posts with it. Without one it falls back to the app-level token, so
 * regenerating that token breaks every button already posted.
 */
export function SlackSigningSecretSteps() {
  return (
    <p className="slack-connect__step">
      On <strong>Basic Information</strong>, under{" "}
      <strong>App Credentials</strong>, click <strong>Show</strong> beside{" "}
      <strong>Signing Secret</strong> and copy it. PwrAgent signs its buttons
      with it, so they keep working if you regenerate the app token.
    </p>
  );
}
