import { useState } from "react";

type ComposerProps = {
  disabled?: boolean;
};

export function Composer(props: ComposerProps) {
  const [draft, setDraft] = useState("");

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <label className="composer__label" htmlFor="thread-composer">
        Reply
      </label>
      <textarea
        id="thread-composer"
        className="composer__input"
        placeholder="Reply to this thread"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="composer__actions">
        <button
          className="button button--primary"
          disabled={props.disabled}
          type="submit"
        >
          Send
        </button>
      </div>
    </form>
  );
}
