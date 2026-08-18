import { Fragment, type ReactNode } from "react";

/*
 * A tiny, dependency-free markdown renderer — just enough for the catalog's
 * authored specs (headings, bullet/numbered lists, paragraphs, and inline
 * bold / italic / code). It builds React elements (never dangerouslySetInnerHTML),
 * so the authored text can't inject markup. Anything it doesn't recognise falls
 * through as a plain paragraph, so unknown syntax degrades to readable text.
 */

// Inline spans: **bold**, *italic*, `code`. Split on the three markers in one pass,
// keeping the delimiters so we can re-wrap each captured run in its element.
function inline(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i} className="font-semibold text-txt">{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`"))
      return <code key={i} className="rounded bg-panel2 px-1 py-0.5 text-[12px] text-accent">{part.slice(1, -1)}</code>;
    if (part.startsWith("*") && part.endsWith("*"))
      return <em key={i}>{part.slice(1, -1)}</em>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

// One heading level → its size. Deeper levels look progressively smaller/quieter.
const headingClass = (level: number): string =>
  level <= 1 ? "mt-4 mb-2 text-[15px] font-semibold text-txt"
  : level === 2 ? "mt-4 mb-1.5 text-[13.5px] font-semibold text-txt"
  : "mt-3 mb-1 text-[12.5px] font-semibold text-muted";

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];

  // Accumulate consecutive non-structural lines into one paragraph, flushing when a
  // heading / list / blank line ends the run.
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={`p${blocks.length}`} className="my-1.5 leading-relaxed text-txt">{inline(para.join(" "))}</p>);
    para = [];
  };

  // Accumulate consecutive list items, flushing when the list ends.
  let list: string[] = [];
  let ordered = false;
  const flushList = () => {
    if (!list.length) return;
    const items = list.map((it, i) => <li key={i} className="my-0.5 leading-relaxed">{inline(it)}</li>);
    blocks.push(
      ordered
        ? <ol key={`l${blocks.length}`} className="my-1.5 list-decimal pl-5 text-txt">{items}</ol>
        : <ul key={`l${blocks.length}`} className="my-1.5 list-disc pl-5 text-txt">{items}</ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);

    if (heading) {
      flushPara(); flushList();
      const level = heading[1].length;
      const Tag = (`h${Math.min(level + 1, 6)}`) as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={`h${blocks.length}`} className={headingClass(level)}>{inline(heading[2])}</Tag>);
    } else if (bullet || numbered) {
      flushPara();
      const wantOrdered = !!numbered;
      if (list.length && wantOrdered !== ordered) flushList(); // switching list type starts a new list
      ordered = wantOrdered;
      list.push((bullet ?? numbered)![1]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();

  return <div className="text-[13px]">{blocks}</div>;
}
