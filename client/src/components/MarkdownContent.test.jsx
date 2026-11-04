// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MarkdownContent } from "./MarkdownContent.jsx";

describe("MarkdownContent component", () => {
  it("renders bold text properly", () => {
    render(<MarkdownContent content="This is **bold text**." />);
    const strong = screen.getByText("bold text");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders headings with correct hierarchy", () => {
    const { container } = render(
      <MarkdownContent content="# Top Heading&#10;## Sub Heading" />
    );
    const h1 = container.querySelector("h1");
    const h2 = container.querySelector("h2");

    expect(h1).toHaveTextContent("Top Heading");
    expect(h2).toHaveTextContent("Sub Heading");
  });

  it("renders bullet lists cleanly", () => {
    const markdown = "* First feature\n* Second feature\n* Third feature";
    const { container } = render(<MarkdownContent content={markdown} />);
    const listItems = container.querySelectorAll("li");

    expect(listItems).toHaveLength(3);
    expect(listItems[0]).toHaveTextContent("First feature");
    expect(listItems[1]).toHaveTextContent("Second feature");
  });

  it("renders inline code and code blocks", () => {
    const markdown = "Use `console.log()` to debug:\n```js\nconst x = 1;\n```";
    const { container } = render(<MarkdownContent content={markdown} />);
    const inlineCode = container.querySelector("code");
    const pre = container.querySelector("pre");

    expect(inlineCode).toBeInTheDocument();
    expect(pre).toBeInTheDocument();
  });

  it("unescapes backslash-escaped markdown markers", () => {
    // Model output sometimes contains literal \* or \*\*
    const escaped = "\\*\\*Bold item\\*\\*:\n\\* bullet point";
    const { container } = render(<MarkdownContent content={escaped} />);
    const strong = container.querySelector("strong");
    const li = container.querySelector("li");

    expect(strong).toHaveTextContent("Bold item");
    expect(li).toHaveTextContent("bullet point");
  });

  it("does not render raw unsafe HTML elements as active markup", () => {
    const unsafe = '<script>alert("xss")</script><img src="x" onerror="alert(1)">';
    const { container } = render(<MarkdownContent content={unsafe} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});
