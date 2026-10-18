import type { Action, View } from "./session";
import { formatRemaining } from "./session";

export function terminalView(): View {
  const input = process.stdin;
  const output = process.stdout;
  const interactive = Boolean(input.isTTY && output.isTTY && process.env.TERM !== "dumb");
  let wasRaw = false;
  let opened = false;
  let listening = false;
  let outputFailed = false;
  let lastLine = "";
  let onAction: (action: Action) => void;
  let onError: (error: Error) => void;
  const onData = (data: Buffer) => {
    try {
      const key = data.toString();
      if (key === "s") onAction("toggle");
      else if (key === "q" || key === "\x04") onAction("stop");
      else if (key === "\x03") onAction("interrupt");
      else if (key === "\x1a") onAction("suspend");
      else if (key === "?") {
        output.write("\r\x1b[2K s  toggle display sleep prevention\n q  stop    Ctrl-C  interrupt\n");
        lastLine = "";
      }
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const onEnd = () => onAction("stop");
  const onResize = () => { lastLine = ""; };
  const onOutputError = (error: Error) => { outputFailed = true; onError(error); };
  return {
    open(handler, errorHandler) {
      onAction = handler;
      onError = errorHandler;
      input.on("error", onError);
      output.on("error", onOutputError);
      listening = true;
      if (!interactive) return;
      opened = true;
      wasRaw = input.isRaw;
      input.setRawMode(true);
      input.on("data", onData);
      input.on("end", onEnd);
      output.on("resize", onResize);
      input.resume();
      output.write("  doppio\n  s  toggle display sleep | q  stop | ?  help | Ctrl-C  interrupt\n");
    },
    render({ remaining, displayAwake }) {
      const line = `  ${formatRemaining(remaining)}  system awake / display ${displayAwake ? "awake" : "sleep allowed"}`;
      if (!interactive) {
        if (!lastLine) output.write(`doppio:${line}\n`);
        lastLine = line;
        return;
      }
      const clipped = line.slice(0, Math.max(0, (output.columns || 80) - 1));
      if (lastLine !== clipped) {
        output.write(`\r\x1b[2K${clipped}`);
        lastLine = clipped;
      }
    },
    async close() {
      try {
        if (!opened) return;
        opened = false;
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        output.removeListener("resize", onResize);
        try {
          input.setRawMode(wasRaw);
        } finally {
          input.pause();
        }
        if (!outputFailed) {
          await new Promise<void>((resolve, reject) => {
            output.write("\r\x1b[2K\n", error => error ? reject(error) : resolve());
          });
        }
      } finally {
        if (listening) {
          listening = false;
          input.removeListener("error", onError);
          output.removeListener("error", onOutputError);
        }
      }
    },
  };
}
