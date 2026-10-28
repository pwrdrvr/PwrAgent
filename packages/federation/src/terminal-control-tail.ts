/** A framebuffer serializer cannot encode the VT parser's unfinished control
 * sequence. Carry only that prefix across a live attach. String payloads are
 * deliberately omitted: an OSC/DCS prefix is enough to consume the remainder
 * as control data, and clipboard/title payloads must not enter saved history. */
export class TerminalControlTail {
  private mode: "ground" | "escape" | "csi" | "string" | "stringEscape" = "ground";
  private prefix = "";

  append(data: string): string {
    for (const char of data) {
      if (this.mode === "string" || this.mode === "stringEscape") {
        if (char === "\x07" || char === "\x9c" || (this.mode === "stringEscape" && char === "\\")) {
          this.mode = "ground";
          this.prefix = "";
        } else this.mode = char === "\x1b" ? "stringEscape" : "string";
        continue;
      }
      if (char === "\x18" || char === "\x1a") {
        this.mode = "ground";
        this.prefix = "";
      } else if (char === "\x1b") {
        this.mode = "escape";
        this.prefix = char;
      } else if (this.mode === "escape") {
        this.prefix += char;
        if (char === "[") this.mode = "csi";
        else if ("]P_X^".includes(char)) this.mode = "string";
        else if (char < " " || char > "/") { this.mode = "ground"; this.prefix = ""; }
      } else if (this.mode === "csi") {
        this.prefix += char;
        if (char >= "@" && char <= "~") { this.mode = "ground"; this.prefix = ""; }
      }
      if (this.prefix.length > 256) this.prefix = this.mode === "csi" ? "\x1b[" : "\x1b";
    }
    return this.prefix + (this.mode === "stringEscape" ? "\x1b" : "");
  }
}
