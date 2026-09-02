import ReactMarkdown, { type Components } from "react-markdown";

const MARKDOWN_COMPONENTS: Components = {
  p: ({ ...props }) => <p className="m-0 mb-2 whitespace-pre-wrap break-words" {...props} />,
  ul: ({ ...props }) => <ul className="m-0 mb-2 list-disc pl-5" {...props} />,
  ol: ({ ...props }) => <ol className="m-0 mb-2 list-decimal pl-5" {...props} />,
  li: ({ ...props }) => <li className="mb-0.5" {...props} />,
  a: ({ ...props }) => <a className="underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />,
  code: ({ ...props }) => (
    <code className="rounded bg-[var(--accent-soft)] px-1 py-0.5 font-mono text-[13px]" {...props} />
  ),
  pre: ({ ...props }) => (
    <pre
      className="mb-2 max-w-full overflow-x-auto rounded-button bg-[var(--accent-soft)] p-3 font-mono text-[13px]"
      {...props}
    />
  ),
  strong: ({ ...props }) => <strong className="font-semibold" {...props} />,
  h1: ({ ...props }) => <h1 className="mb-2 mt-1 text-lg font-semibold" {...props} />,
  h2: ({ ...props }) => <h2 className="mb-2 mt-1 text-base font-semibold" {...props} />,
  h3: ({ ...props }) => <h3 className="mb-2 mt-1 text-[15px] font-semibold" {...props} />,
};

/**
 * Renders LLM-authored text as markdown (bold, lists, headings, links, etc.)
 * instead of showing the raw `**syntax**`. Styling is applied via plain
 * element selectors scoped to this wrapper rather than a prose plugin, so it
 * stays in step with the app's existing text-fg / font-sans conventions.
 */
export function MarkdownContent({ content, className = "text-[15px]" }: { content: string; className?: string }) {
  return (
    <div
      className={`markdown-content min-w-0 font-sans leading-relaxed text-fg [&_>*:first-child]:mt-0 [&_>*:last-child]:mb-0 ${className}`}
    >
      <ReactMarkdown components={MARKDOWN_COMPONENTS}>{content}</ReactMarkdown>
    </div>
  );
}
