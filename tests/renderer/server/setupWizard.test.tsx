// @vitest-environment jsdom
/**
 * Setup wizard component tests: step rendering, Radmin states, qBittorrent
 * error copy, secret handling, and the ready gate.
 */

import React, { useEffect, useReducer } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockServerBridge } from "../../../src/renderer/server/bridge/mockServerBridge";
import type { VikingRelayServerBridge } from "../../../src/renderer/server/bridge/types";
import {
  initialSetupState,
  setupReducer,
  type SetupAction,
  type SetupState,
} from "../../../src/renderer/server/state/setupMachine";
import { SetupWizard } from "../../../src/renderer/server/screens/setup/SetupWizard";
import { FOLDER_EXPLANATION } from "../../../src/renderer/server/screens/setup/steps/StepFolder";
import { StepQbit } from "../../../src/renderer/server/screens/setup/steps/StepQbit";
import { StepRadmin, RADMIN_NOT_DETECTED } from "../../../src/renderer/server/screens/setup/steps/StepRadmin";

type Dispatch = (action: SetupAction) => void;

afterEach(cleanup);

function Harness({
  bridge,
  children,
}: {
  bridge: VikingRelayServerBridge;
  children: (args: { state: SetupState; dispatch: Dispatch }) => React.ReactNode;
}) {
  const [state, dispatch] = useReducer(setupReducer, undefined, initialSetupState);

  // Mirror the wizard's hydration so isolated steps see loaded statuses.
  useEffect(() => {
    void bridge.getRadminStatus().then((status) => dispatch({ type: "RADMIN_STATUS", status }));
    void bridge.getVikingConfig().then((config) => dispatch({ type: "VIKING_CONFIG", config }));
    void bridge
      .getWorkingFolderStatus()
      .then((status) => dispatch({ type: "FOLDER_STATUS", status }));
  }, [bridge]);

  return <>{children({ state, dispatch })}</>;
}

function renderStep(
  bridge: VikingRelayServerBridge,
  body: (args: { state: SetupState; dispatch: Dispatch }) => React.ReactElement,
) {
  return render(<Harness bridge={bridge}>{body}</Harness>);
}

describe("StepFolder", () => {
  it("explains the folder purpose and shows drive capacity once loaded", async () => {
    const bridge = new MockServerBridge();
    render(
      <SetupWizard
        bridge={bridge}
        onComplete={() => undefined}
      />,
    );
    expect(screen.getByText(FOLDER_EXPLANATION)).toBeTruthy();
    const driveInfo = await screen.findByTestId("drive-info");
    expect(driveInfo.textContent).toContain("Drive D:");
    expect(driveInfo.textContent).toMatch(/TB/); // total + free rendered in TB scale
    expect((screen.getByTestId("next-step") as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps Next disabled while no folder is chosen", async () => {
    const bridge = new MockServerBridge();
    bridge.getWorkingFolderStatus = vi.fn(async () => ({
      path: null,
      drive: null,
      writable: false,
      error: null,
    }));
    render(<SetupWizard bridge={bridge} onComplete={() => undefined} />);
    await waitFor(() =>
      expect((screen.getByTestId("next-step") as HTMLButtonElement).disabled).toBe(true),
    );
  });
});

describe("StepRadmin", () => {
  it("shows the not-detected message and Retry when disconnected", async () => {
    const bridge = new MockServerBridge({
      radmin: { detected: false, connected: false, problem: "disconnected" },
    });
    renderStep(bridge, ({ state, dispatch }) => <StepRadmin bridge={bridge} state={state} dispatch={dispatch} />);
    await screen.findByText(RADMIN_NOT_DETECTED);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("shows adapter + IPv4 + server address when connected", async () => {
    const bridge = new MockServerBridge();
    renderStep(bridge, ({ state, dispatch }) => <StepRadmin bridge={bridge} state={state} dispatch={dispatch} />);
    await screen.findByTestId("server-address");
    expect(screen.getByTestId("server-address").textContent).toBe("26.14.203.87:47821");
    expect(screen.getByText(/Adapter found/)).toBeTruthy();
    expect(screen.getByText(/IPv4 address/)).toBeTruthy();
  });

  it("offers safe interface choice when ambiguous and connects after selection", async () => {
    const bridge = new MockServerBridge({
      radmin: {
        detected: true,
        connected: false,
        problem: "ambiguous",
        candidates: [
          { id: "radmin1", name: "Radmin VPN", ipv4: "26.14.203.87" },
          { id: "eth0", name: "Ethernet", ipv4: "192.168.1.10" },
        ],
      },
    });
    renderStep(bridge, ({ state, dispatch }) => <StepRadmin bridge={bridge} state={state} dispatch={dispatch} />);
    await screen.findByText(/Pick the Radmin VPN one/);
    fireEvent.click(screen.getByTestId("radmin-candidate-radmin1"));
    await screen.findByTestId("server-address");
    expect(screen.getByTestId("server-address").textContent).toBe("26.14.203.87:47821");
  });
});

describe("StepQbit", () => {
  it("reports specific errors per failure reason", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ok: false, reason: "not_running" }, /isn't running/i],
      [{ ok: false, reason: "auth" }, /Wrong API key/i],
      [{ ok: false, reason: "version_too_old" }, /too old/i],
      [{ ok: false, reason: "invalid_url" }, /doesn't look valid/i],
    ];
    for (const [probe, pattern] of cases) {
      const { unmount } = render(
        <Harness bridge={new MockServerBridge()}>
          {({ state, dispatch }) => (
            <StepQbit
              bridge={new MockServerBridge({ qbitProbe: probe as never })}
              state={{ ...state, qbitUrl: "http://127.0.0.1:8080" }}
              dispatch={dispatch}
            />
          )}
        </Harness>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Test" }));
      const error = await screen.findByTestId("qbit-probe-error");
      expect(error.textContent).toMatch(pattern);
      unmount();
    }
  });

  it("shows success rows and clears the API key input after saving", async () => {
    const bridge = new MockServerBridge();
    renderStep(bridge, ({ state, dispatch }) => <StepQbit bridge={bridge} state={state} dispatch={dispatch} />);
    const keyInput = (await screen.findByLabelText("API Key")) as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "super-secret-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await screen.findByTestId("qbit-probe-ok");
    expect(screen.getByTestId("qbit-probe-ok").textContent).toContain("qBittorrent connected");
    expect(screen.getByTestId("qbit-probe-ok").textContent).toContain("5.2.1");
    await waitFor(() => expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe(""));
    // plaintext must not appear anywhere in the DOM after save
    expect(document.body.textContent).not.toContain("super-secret-key");
  });

  it("rejects invalid URLs with specific copy", async () => {
    const bridge = new MockServerBridge();
    renderStep(bridge, ({ state, dispatch }) => <StepQbit bridge={bridge} state={state} dispatch={dispatch} />);
    fireEvent.change(await screen.findByLabelText("Web API"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    const error = await screen.findByTestId("qbit-probe-error");
    expect(error.textContent).toMatch(/doesn't look valid/i);
  });
});
