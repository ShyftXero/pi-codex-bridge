// Render gateway state without owning discovery, configuration, or transport.
import {
  getSettingsListTheme,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth } from "@earendil-works/pi-tui";

export interface ConnectorPickerState {
  connectors: Array<{ id: string; label: string; enabled: boolean }>;
  discovering: boolean;
  error?: string;
}

export interface ConnectorPickerModel {
  snapshot(): ConnectorPickerState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  toggle(id: string, enabled: boolean): Promise<void>;
}

export async function showConnectorPicker(
  ctx: ExtensionContext, model: ConnectorPickerModel,
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    let list: SettingsList;
    let state = model.snapshot();
    let busy = false;
    let error: string | undefined;
    let selected: string | undefined;
    let closed = false;
    let unsubscribe = () => {};

    function close() {
      closed = true;
      unsubscribe();
      done();
    }

    // Actions update the model; the subscriber below receives new state.
    // Keep one screen mounted throughout, including on errors or Escape
    // during an outstanding action. Never reopen it from a continuation.
    function run(task: () => Promise<void>) {
      busy = true;
      error = undefined;
      tui.requestRender();
      void task().catch(reason => {
        error = String(reason);
      }).finally(() => {
        busy = false;
        if (!closed) update();
      });
    }

    function update() {
      state = model.snapshot();
      list = new SettingsList([
        ...state.connectors.map(connector => ({
          id: connector.id,
          label: connector.label,
          currentValue: connector.enabled ? "enabled" : "disabled",
          values: ["enabled", "disabled"],
        })),
        {
          id: "__refresh",
          label: "Refresh available connectors",
          currentValue: "refresh",
          values: ["refresh"],
        },
      ], 15, getSettingsListTheme(), (id, value) => {
        selected = id;
        run(() => id === "__refresh" ? model.refresh() :
          model.toggle(id, value === "enabled"));
      }, close);
      if (selected) list.selectItem(selected);
      tui.requestRender();
    }

    update();
    unsubscribe = model.subscribe(() => { if (!closed) update(); });
    return {
      capturesViewportInput: true,
      render(width: number) {
        const failure = error ?? state.error;
        const status = failure ? `Error: ${failure}` :
          state.discovering ? "Discovering connectors…" :
          busy ? "Saving changes…" : "Enter/Space toggles; Esc closes.";
        return [
          theme.fg("accent", theme.bold("Codex connectors")),
          "",
          ...list.render(width),
          "",
          theme.fg(failure ? "error" : "dim", status),
        ].map(line => truncateToWidth(line, width));
      },
      invalidate() { list.invalidate(); },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) {
          close();
        } else if (!busy && !state.discovering) {
          list.handleInput(data);
          tui.requestRender();
        }
      },
    };
  }, { blocked: { kind: "question", message: "Manage Codex connectors" } });
}
