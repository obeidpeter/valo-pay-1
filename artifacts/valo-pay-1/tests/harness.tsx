// Renders the real console at a route: the same providers, layout and pages
// production mounts, against whatever fake API the test installed.
import { render } from "@testing-library/react";
import App from "@/App";

export function renderApp(path = "/") {
  window.history.replaceState({}, "", path);
  return render(<App />);
}

export { screen, waitFor, within } from "@testing-library/react";
export { default as userEvent } from "@testing-library/user-event";
