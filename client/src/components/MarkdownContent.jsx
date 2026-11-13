import React from "react";
import ReactMarkdown from "react-markdown";

function normalizeMarkdown(text) {
  if (typeof text !== "string") return "";
  // Unescape backslash-escaped markdown markers (e.g. \* -> *, \_ -> _, \# -> #)
  return text.replace(/\\([*_#[\]()`>~+-])/g, "$1");
}

export function MarkdownContent({ content }) {
  const normalized = normalizeMarkdown(content);

  return (
    <div className="markdown-content text-sm leading-relaxed text-[#F5F5F5]">
      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="mt-3 mb-1.5 text-base font-bold text-white border-b border-[#292929] pb-1">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-2.5 mb-1 text-sm font-semibold text-white">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2 mb-1 text-xs font-semibold text-[#E5E5E5] uppercase tracking-wider">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="my-1.5 leading-relaxed text-sm text-[#E5E5E5] last:mb-0">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="my-2 ml-4 list-disc space-y-1 text-sm text-[#D4D4D4]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-2 ml-4 list-decimal space-y-1 text-sm text-[#D4D4D4]">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="leading-relaxed pl-0.5">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="font-semibold text-white">{children}</strong>
          ),
          em: ({ children }) => (
            <em className="italic text-[#D4D4D4]">{children}</em>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-[#FF2A2A] pl-3 italic text-xs text-[#A3A3A3]">
              {children}
            </blockquote>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg border border-[#292929] bg-[#111111] p-3 text-xs text-[#F5F5F5] font-mono">
              {children}
            </pre>
          ),
          code: ({ _className, children, ...props }) => {
            return (
              <code
                className="rounded bg-[#262626] px-1.5 py-0.5 font-mono text-xs text-[#FF6B6B]"
                {...props}
              >
                {children}
              </code>
            );
          },
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-[#FF5C5C] underline hover:text-[#FF8080] transition-colors"
            >
              {children}
            </a>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

export default MarkdownContent;
