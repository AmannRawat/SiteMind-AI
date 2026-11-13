// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { BackendStatusBanner } from "./BackendStatusBanner.jsx";

describe("BackendStatusBanner", () => {
  it("renders nothing when status is online", () => {
    const { container } = render(<BackendStatusBanner status="online" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when status is checking", () => {
    const { container } = render(<BackendStatusBanner status="checking" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders exact recruiter-friendly copy and status when waking", () => {
    render(<BackendStatusBanner status="waking" retryCount={2} />);

    // Exact title
    expect(
      screen.getByRole("heading", { name: "Demo server is waking up" })
    ).toBeInTheDocument();

    // Exact description
    expect(
      screen.getByText(
        "Our free demo server may take a moment to start after a period of inactivity. We're establishing a connection. Thank you for your patience."
      )
    ).toBeInTheDocument();

    // Exact status text
    expect(screen.getByText("Waking up server...")).toBeInTheDocument();

    // Displays retry count
    expect(screen.getByText(/Check 2 in progress/)).toBeInTheDocument();

    // Has accessible status role
    const statusRegion = screen.getByRole("status");
    expect(statusRegion).toHaveAttribute("aria-live", "polite");
  });

  it("renders unavailable state with fallback copy and a working Retry connection button", () => {
    const handleRetry = vi.fn();
    render(<BackendStatusBanner status="unavailable" onRetry={handleRetry} />);

    // Fallback description
    expect(
      screen.getByText(
        "We're having trouble connecting to the demo server. Please try again in a moment."
      )
    ).toBeInTheDocument();

    // Retry button
    const retryButton = screen.getByRole("button", {
      name: /Retry connection/i,
    });
    expect(retryButton).toBeInTheDocument();

    fireEvent.click(retryButton);
    expect(handleRetry).toHaveBeenCalledTimes(1);

    // Has alert role for failure state
    const alertRegion = screen.getByRole("alert");
    expect(alertRegion).toBeInTheDocument();
  });
});

