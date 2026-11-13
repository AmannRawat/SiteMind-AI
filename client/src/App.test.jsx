// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "./App.jsx";

// Mock posthog and vercel analytics
vi.mock("./posthog.js", () => ({
  default: {
    capture: vi.fn(),
    logger: { info: vi.fn() },
  },
}));

vi.mock("@vercel/analytics/react", () => ({
  Analytics: () => null,
}));

describe("App cold-start experience integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders landing page, workflow cards and cold-start banner without blocking UI when backend is waking", async () => {
    // Simulate sleeping backend by rejecting initial health check
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("/health")) {
        return Promise.reject(new Error("Failed to fetch"));
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      });
    });

    render(
      <App
        healthOptions={{
          retryDelays: [100, 200],
          wakingNoticeDelay: 50,
        }}
      />
    );

    // Branding and static content render immediately
    expect(screen.getByText("SiteMind AI")).toBeInTheDocument();
    expect(screen.getByText(/Understand any/i)).toBeInTheDocument();
    expect(screen.getByText("01")).toBeInTheDocument();
    expect(screen.getByText("02")).toBeInTheDocument();
    expect(screen.getByText("03")).toBeInTheDocument();

    // Waking banner appears once initial probe fails
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Demo server is waking up" })
      ).toBeInTheDocument();
    });

    const statusBanner = screen.getByRole("status");
    expect(
      within(statusBanner).getByText(
        "Our free demo server may take a moment to start after a period of inactivity. We're establishing a connection. Thank you for your patience."
      )
    ).toBeInTheDocument();
    expect(within(statusBanner).getByText("Waking up server...")).toBeInTheDocument();

    // Crawl button is guarded while waking
    const submitBtn = screen.getByRole("button", { name: /Waking up server.../i });
    expect(submitBtn).toBeDisabled();

    // URL input remains accessible
    const input = screen.getByLabelText(/Target Website URL/i);
    expect(input).toBeEnabled();
  });

  it("preserves user URL input while backend is waking and guards submission without raw errors", async () => {
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("/health")) {
        return Promise.reject(new Error("Failed to fetch"));
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      });
    });

    render(
      <App
        healthOptions={{
          retryDelays: [100, 200],
          wakingNoticeDelay: 50,
        }}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Demo server is waking up" })
      ).toBeInTheDocument();
    });

    const input = screen.getByLabelText(/Target Website URL/i);
    fireEvent.change(input, { target: { value: "https://my-docs-site.com" } });
    expect(input.value).toBe("https://my-docs-site.com");

    // Attempting submit while waking does not wipe input
    const form = input.closest("form");
    fireEvent.submit(form);

    expect(input.value).toBe("https://my-docs-site.com");
    expect(
      screen.getByText(
        "Demo server is currently waking up. Please wait a moment until connection is established before starting a crawl."
      )
    ).toBeInTheDocument();
  });

  it("automatically dismisses waking banner and enables crawl controls when /health responds 200", async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes("/health")) {
        callCount++;
        if (callCount === 1) {
          // First attempt fails immediately (sleeping)
          return Promise.reject(new Error("Cold start in progress"));
        }
        // Second attempt succeeds (backend awake)
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok" }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({}),
      });
    });

    render(
      <App
        healthOptions={{
          retryDelays: [50, 100],
          wakingNoticeDelay: 20,
        }}
      />
    );

    // Initially waking
    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Demo server is waking up" })
      ).toBeInTheDocument();
    });

    // When backend responds ok on retry, banner disappears and button becomes "Start crawl"
    await waitFor(() => {
      expect(screen.getByText("API connected")).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("heading", { name: "Demo server is waking up" })
    ).not.toBeInTheDocument();

    const startBtn = screen.getByRole("button", { name: /Start crawl/i });
    expect(startBtn).toBeEnabled();
  });
});
